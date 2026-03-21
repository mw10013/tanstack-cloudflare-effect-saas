# Organization Repository Research

## Context

OrganizationAgent has inline SQL + schema decoding spread across its methods. Goal: extract an OrganizationRepository service with `@effect/sql-sqlite-do` (Effect v4 unstable SQL) as the SQL dependency, plus an OrganizationDomain module for shared schemas.

## Current State

### Where SQL lives today (`organization-agent.ts`)

| Method | SQL Operation |
|---|---|
| `constructor` | `create table if not exists Invoice` |
| `onInvoiceUpload` | `select * from Invoice where id = ?` → `insert ... on conflict(id) do update` → `update Invoice set status = 'extracting'` |
| `onInvoiceDelete` | `delete from Invoice where id = ? and r2ActionTime <= ?` |
| `saveExtractedJson` | `update Invoice set status = 'extracted', extractedJson = ?` |
| `onWorkflowError` | `update Invoice set status = 'error', error = ?` |
| `getInvoices` | `select * from Invoice order by createdAt desc` |

All operations use the Agent base class `this.sql` tagged template, which wraps `ctx.storage.sql: SqlStorage`. Synchronous — no `await` needed.

### Existing service layering

```
CloudflareEnv  →  D1  →  Repository
```

`Repository` depends on our custom `D1` service which wraps Cloudflare's raw D1 API with retry/error handling.

---

## Approach: `@effect/sql-sqlite-do` as SQL Dependency

### What `@effect/sql-sqlite-do` provides

Effect v4 ships a complete DO SQLite adapter at `refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts`. It's a **separate package** (`@effect/sql-sqlite-do@4.0.0-beta.27`), not bundled with `effect`. Peer dep: `effect`. Dev dep: `@cloudflare/workers-types`.

The unstable SQL **core** modules (`SqlClient`, `SqlError`, `Statement`) ARE bundled in the `effect` package at `effect/unstable/sql/...`. Only the DO adapter is a separate install.

**Config interface:**

```ts
// refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts:56-62
export interface SqliteClientConfig {
  readonly db: SqlStorage
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: ((str: string) => string)
  readonly transformQueryNames?: ((str: string) => string)
}
```

**How it wraps synchronous DO SQL:**

```ts
// refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts:96-103
const runStatement = (sql: string, params: ReadonlyArray<unknown> = []):
  Effect.Effect<ReadonlyArray<any>, SqlError, never> =>
  Effect.try({
    try: () => Array.from(runIterator(sql, params)),
    catch: (cause) => new SqlError({ cause, message: `Failed to execute statement` })
  })
```

Uses `Effect.try` (not `Effect.tryPromise`) — preserves synchronous semantics. Write coalescing still works: multiple `yield*` of sync Effects in sequence don't introduce `await`, so they execute atomically.

**Layer construction — dual service registration:**

```ts
// refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts:209-217
export const layer = (config: SqliteClientConfig):
  Layer.Layer<SqliteClient | Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(
        ServiceMap.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
```

Provides both the specific `SqliteClient` and the generic `SqlClient` — repository depends on `SqlClient.SqlClient` (portable).

**Key internals:**
- Semaphore(1) for connection serialization (`SqliteClient.ts:153`)
- Transaction acquirer with scope-based release (`SqliteClient.ts:157-167`)
- Iterator-based row materialization with ArrayBuffer→Uint8Array conversion (`SqliteClient.ts:80-94`)
- `Statement.makeCompilerSqlite` for `?` placeholder compilation (`SqliteClient.ts:72`)

### What `SqlClient` gives us

The `SqlClient` interface (`effect/unstable/sql/SqlClient.ts`) is a tagged template constructor:

```ts
const sql = yield* SqlClient.SqlClient;
const rows = yield* sql`select * from Invoice order by createdAt desc`;
```

The template literal compiles through `Statement.Compiler` → `[sqlString, params[]]` → `Connection.execute()`. This replaces the Agent's `this.sql` tagged template with Effect-managed, traced, error-typed queries returning `Effect<ReadonlyArray<unknown>, SqlError>`.

### Why NOT `SqlSchema`

Effect v4 includes `SqlSchema` (`effect/unstable/sql/SqlSchema.ts`) — combinators like `findAll`, `findOneOption`, `void` that wire encode-request → execute-sql → decode-result. Evaluated and rejected:

- **Request side**: `SqlSchema` encodes inputs via `Schema.encodeEffect(RequestSchema)`. Our inputs are already typed TS values — no encoding needed. Using it would require creating Schema objects (`UpsertInvoice`, `DeleteInvoice`, etc.) that just re-express typed interfaces. Unnecessary ceremony.
- **Result side**: decodes `unknown[]` rows through a Schema. Useful, but we can call `Schema.decodeUnknownEffect(Schema.Array(InvoiceRow))` directly — no need for the `SqlSchema` wrapper.
- **Net**: `SqlSchema` is valuable when schemas have transformations (Date↔string, branded types). For our simple InvoiceRow (all primitives, matching column names), direct `sql` template + domain schema decoding is simpler and clearer.

---

## 1. OrganizationRepository

Depends on `SqlClient.SqlClient`. Uses tagged template for queries, domain schema for result decoding.

```ts
// src/lib/OrganizationRepository.ts
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrganizationDomain from "./OrganizationDomain";

const decodeInvoiceRow = Schema.decodeUnknownEffect(OrganizationDomain.InvoiceRow);
const decodeInvoices = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.InvoiceRow)),
);

export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
        function* (invoiceId: string) {
          const rows = yield* sql`select * from Invoice where id = ${invoiceId}`;
          return rows.length > 0
            ? yield* Effect.asSome(decodeInvoiceRow(rows[0]))
            : Option.none<OrganizationDomain.InvoiceRow>();
        },
      );

      const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(
        function* () {
          const rows = yield* sql`select * from Invoice order by createdAt desc`;
          return yield* decodeInvoices(rows);
        },
      );

      const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
        function* (input: {
          invoiceId: string;
          fileName: string;
          contentType: string;
          r2ActionTime: number;
          idempotencyKey: string;
          r2ObjectKey: string;
        }) {
          yield* sql`
            insert into Invoice (
              id, fileName, contentType, createdAt, r2ActionTime,
              idempotencyKey, r2ObjectKey, status,
              extractedJson, error
            ) values (
              ${input.invoiceId}, ${input.fileName}, ${input.contentType},
              ${input.r2ActionTime}, ${input.r2ActionTime}, ${input.idempotencyKey},
              ${input.r2ObjectKey}, 'uploaded',
              ${null}, ${null}
            )
            on conflict(id) do update set
              fileName = excluded.fileName,
              contentType = excluded.contentType,
              r2ActionTime = excluded.r2ActionTime,
              idempotencyKey = excluded.idempotencyKey,
              r2ObjectKey = excluded.r2ObjectKey,
              status = 'uploaded',
              extractedJson = null,
              error = null
          `;
        },
      );

      const setExtracting = Effect.fn("OrganizationRepository.setExtracting")(
        function* (invoiceId: string, idempotencyKey: string) {
          yield* sql`
            update Invoice
            set status = 'extracting'
            where id = ${invoiceId} and idempotencyKey = ${idempotencyKey}
          `;
        },
      );

      const deleteInvoice = Effect.fn("OrganizationRepository.deleteInvoice")(
        function* (invoiceId: string, r2ActionTime: number) {
          return yield* sql`
            delete from Invoice
            where id = ${invoiceId} and r2ActionTime <= ${r2ActionTime}
            returning id
          `;
        },
      );

      const saveExtractedJson = Effect.fn("OrganizationRepository.saveExtractedJson")(
        function* (input: { invoiceId: string; idempotencyKey: string; extractedJson: string }) {
          return yield* sql`
            update Invoice
            set status = 'extracted',
                extractedJson = ${input.extractedJson},
                error = ${null}
            where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
            returning id, fileName
          `;
        },
      );

      const setError = Effect.fn("OrganizationRepository.setError")(
        function* (workflowId: string, error: string) {
          return yield* sql`
            update Invoice
            set status = 'error',
                error = ${error}
            where idempotencyKey = ${workflowId}
            returning id, fileName
          `;
        },
      );

      return {
        findInvoice,
        getInvoices,
        upsertInvoice,
        setExtracting,
        deleteInvoice,
        saveExtractedJson,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### How the agent wires it up

```ts
// organization-agent.ts constructor
import * as SqliteDo from "@effect/sql-sqlite-do/SqliteClient";

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  void this.sql`create table if not exists Invoice (...)`;
  const sqliteLayer = SqliteDo.layer({ db: ctx.storage.sql });
  const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
  const loggerLayer = makeLoggerLayer(env);
  this.runEffect = (effect) =>
    Effect.runPromise(Effect.provide(effect, Layer.merge(repoLayer, loggerLayer)));
}
```

DDL stays in the constructor — runs once per DO instantiation, synchronous.

Mirrors the worker.ts pattern:

```ts
// worker.ts (existing)
const envLayer = makeEnvLayer(env);
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
```

### How agent methods look after

```ts
@callable()
getInvoices() {
  return this.runEffect(
    Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      return yield* repo.getInvoices();
    }),
  );
}

@callable()
onInvoiceUpload(upload: { ... }) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const r2ActionTime = Date.parse(upload.r2ActionTime);
      if (!Number.isFinite(r2ActionTime))
        return yield* new OrganizationAgentError({ message: `Invalid r2ActionTime: ${upload.r2ActionTime}` });

      const repo = yield* OrganizationRepository;
      const existing = yield* repo.findInvoice(upload.invoiceId);
      // existing is Option<InvoiceRow>
      if (Option.isSome(existing) && r2ActionTime < existing.value.r2ActionTime) return;

      const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
      if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) return;
      if (Option.isSome(existing)
        && existing.value.idempotencyKey === upload.idempotencyKey
        && (existing.value.status === "extracting" || existing.value.status === "extracted")) return;

      yield* repo.upsertInvoice({ ...upload, r2ActionTime });
      yield* broadcastActivity(this, { level: "info", text: `Invoice uploaded: ${upload.fileName}` });
      yield* Effect.tryPromise({
        try: () => this.runWorkflow("INVOICE_EXTRACTION_WORKFLOW", { ... }, { id: upload.idempotencyKey, ... }),
        catch: (cause) => new OrganizationAgentError({ message: ... }),
      });
      yield* repo.setExtracting(upload.invoiceId, upload.idempotencyKey);
    }),
  );
}
```

### Error handling

`@effect/sql-sqlite-do` wraps all SQL in `Effect.try` returning `SqlError` — structured, tagged, with `cause` and `message`. Replaces manual `Effect.try` → `OrganizationAgentError` per SQL call. `OrganizationAgentError` stays for non-SQL agent errors (invalid input, workflow failures).

Result decoding uses `Schema.decodeUnknownEffect` returning `Schema.SchemaError` on decode failures — replacing manual sync decoders.

### Write coalescing preserved

From `do-sqlite-storage-research.md`: "Effect generators that `yield*` synchronous Effects don't break coalescing." The `@effect/sql-sqlite-do` adapter uses `Effect.try` (synchronous) — no microtask boundary. Multiple sequential repo calls without intervening `await` remain atomic.

---

## 2. OrganizationDomain

Extract from `organization-agent.ts` into `src/lib/OrganizationDomain.ts`. Contains schemas shared between agent and repository. `InvoiceStatus` stays in `Domain.ts` (already shared with UI).

```ts
// src/lib/OrganizationDomain.ts
import * as Schema from "effect/Schema";

import { InvoiceStatus } from "./Domain";

export const InvoiceRow = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  r2ActionTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  extractedJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type InvoiceRow = typeof InvoiceRow.Type;

export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

export const activeWorkflowStatuses = new Set(["queued", "running", "waiting"]);
```

---

## Proposed File Structure

```
src/lib/
  OrganizationDomain.ts        # InvoiceRow schema, error class, workflow statuses
  OrganizationRepository.ts    # ServiceMap.Service, depends on SqlClient.SqlClient
  Domain.ts                    # Unchanged (InvoiceStatus stays here)
  Repository.ts                # Unchanged
```

```
src/
  organization-agent.ts        # Slimmed down — orchestrates repo + broadcast + workflow
```

### Layering

```
CloudflareEnv       SqliteDo.layer({ db: ctx.storage.sql })
    ↓                     ↓
    D1              SqlClient.SqlClient (+ SqliteClient)
    ↓                     ↓
Repository        OrganizationRepository
```

---

## Trade-offs vs Custom AgentSql Value Service

The previous version of this document proposed a custom `AgentSql` value service wrapping `this.sql`. Here's what changes with `@effect/sql-sqlite-do`:

### Gains

- **Typed tagged template** — `SqlClient` template literals compile through `Statement.Compiler` with `?` placeholders, span tracing, and `SqlError` — no manual `Effect.try` wrapping per call
- **`withTransaction`** — semaphore-based transaction support if needed later
- **Portability** — repository depends on generic `SqlClient`, not DO-specific API
- **Consistency with Effect ecosystem** — same patterns as `@effect/sql-d1`, `@effect/sql-pg`, etc.

### Costs

- **Unstable API** — lives in `effect/unstable/sql/`. May change between Effect v4 releases. Mitigation: the adapter is small (~200 LOC), and we can vendor/fork if needed.
- **Separate package** — need `pnpm add @effect/sql-sqlite-do@4.0.0-beta.27`.
- **Heavier than a value service** — semaphore, compiler, reactivity layer. Though the layer construction is lazy and the runtime overhead is negligible for our use case.

### Recommendation

**Use `@effect/sql-sqlite-do`.** The typed `SqlError` and traced tagged template eliminate enough boilerplate to justify the dependency. The adapter is stable in practice, small enough to vendor if needed, and aligns with the broader Effect SQL ecosystem.

---

## Open Questions

1. **`Reactivity.layer`** — `SqliteDo.layer()` internally provides `Reactivity.layer`. We don't use reactive queries, but the layer is provided automatically. No action needed — just noting it's there.

2. **`returning` clause typing** — `sql` tagged template returns `ReadonlyArray<unknown>`. For `returning id, fileName` results, we'd need to decode through a schema or cast. Could add small result schemas (e.g., `Schema.Struct({ id: Schema.String, fileName: Schema.String })`) just for those queries, or accept `unknown` and narrow inline.
