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

Effect v4 ships a complete DO SQLite adapter at `refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts`.

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

Provides both the specific `SqliteClient` and the generic `SqlClient` — repository methods can depend on `SqlClient.SqlClient` (portable) or `SqliteClient` (DO-specific).

**Key internals:**
- Semaphore(1) for connection serialization (`SqliteClient.ts:153`)
- Transaction acquirer with scope-based release (`SqliteClient.ts:157-167`)
- Iterator-based row materialization with ArrayBuffer→Uint8Array conversion (`SqliteClient.ts:80-94`)
- `Statement.makeCompilerSqlite` for `?` placeholder compilation (`SqliteClient.ts:72`)

### What `SqlClient` gives us

The `SqlClient` interface (`refs/effect4/packages/effect/src/unstable/sql/SqlClient.ts`) is a tagged template constructor:

```ts
// SqlClient.ts:27-66
export interface SqlClient extends Constructor {
  readonly safe: this
  readonly withoutTransforms: () => this
  readonly reserve: Effect.Effect<Connection, SqlError, Scope.Scope>
  readonly withTransaction: <R, E, A>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>
  readonly reactive: (keys, effect) => Stream<A, E, R>
}
```

Used as a tagged template:

```ts
const sql = yield* SqlClient.SqlClient;
const rows = yield* sql`select * from Invoice order by createdAt desc`;
```

The template literal compiles through `Statement.Compiler` → `[sqlString, params[]]` → `Connection.execute()`. This replaces the Agent's `this.sql` tagged template with Effect-managed, traced, error-typed queries.

### `SqlSchema` — typed query builders

`refs/effect4/packages/effect/src/unstable/sql/SqlSchema.ts` provides Schema-validated query builders:

```ts
// SqlSchema.ts:16-31 — findAll
export const findAll = <Req, Res, E, R>(options: {
  readonly Request: Req
  readonly Result: Res
  readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
}) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(options.Result)))
  return (request) => Effect.flatMap(Effect.flatMap(encodeRequest(request), options.execute), decode)
}
```

Also: `findOne`, `findOneOption`, `findNonEmpty`, `void`. These encode requests and decode results through Schema — replacing our manual `decodeInvoiceRow`/`decodeInvoices`.

---

## 1. OrganizationRepository

Depends on `SqlClient.SqlClient` (the generic interface). Repository methods use the tagged template for queries and `SqlSchema` for typed decoding.

```ts
// src/lib/OrganizationRepository.ts
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as OrganizationDomain from "./OrganizationDomain";

export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findInvoice = SqlSchema.findOneOption({
        Request: OrganizationDomain.InvoiceId,
        Result: OrganizationDomain.InvoiceRow,
        execute: (id) => sql`select * from Invoice where id = ${id}`,
      });

      const getInvoices = SqlSchema.findAll({
        Request: OrganizationDomain.Void,
        Result: OrganizationDomain.InvoiceRow,
        execute: () => sql`select * from Invoice order by createdAt desc`,
      });

      const upsertInvoice = SqlSchema.void({
        Request: OrganizationDomain.UpsertInvoice,
        execute: (input) => sql`
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
        `,
      });

      const setExtracting = SqlSchema.void({
        Request: OrganizationDomain.InvoiceIdempotencyKey,
        execute: (input) => sql`
          update Invoice
          set status = 'extracting'
          where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
        `,
      });

      const deleteInvoice = SqlSchema.findAll({
        Request: OrganizationDomain.DeleteInvoice,
        Result: OrganizationDomain.InvoiceIdOnly,
        execute: (input) => sql`
          delete from Invoice
          where id = ${input.invoiceId} and r2ActionTime <= ${input.r2ActionTime}
          returning id
        `,
      });

      const saveExtractedJson = SqlSchema.findAll({
        Request: OrganizationDomain.SaveExtractedJson,
        Result: OrganizationDomain.InvoiceIdFileName,
        execute: (input) => sql`
          update Invoice
          set status = 'extracted',
              extractedJson = ${input.extractedJson},
              error = ${null}
          where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
          returning id, fileName
        `,
      });

      const setError = SqlSchema.findAll({
        Request: OrganizationDomain.SetError,
        Result: OrganizationDomain.InvoiceIdFileName,
        execute: (input) => sql`
          update Invoice
          set status = 'error',
              error = ${input.error}
          where idempotencyKey = ${input.workflowId}
          returning id, fileName
        `,
      });

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
      return yield* repo.getInvoices(undefined);
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
      // ... guard logic using Option ...

      yield* repo.upsertInvoice({ ...upload, r2ActionTime });
      yield* broadcastActivity(this, { level: "info", text: `Invoice uploaded: ${upload.fileName}` });
      yield* Effect.tryPromise({
        try: () => this.runWorkflow("INVOICE_EXTRACTION_WORKFLOW", { ... }, { id: upload.idempotencyKey, ... }),
        catch: (cause) => new OrganizationAgentError({ message: ... }),
      });
      yield* repo.setExtracting({ invoiceId: upload.invoiceId, idempotencyKey: upload.idempotencyKey });
    }),
  );
}
```

### Error handling

`@effect/sql-sqlite-do` wraps all operations in `Effect.try` returning `SqlError` — a structured, tagged error with `cause` and `message`. This replaces our manual `Effect.try` → `OrganizationAgentError` wrapping per SQL call. `OrganizationAgentError` stays for non-SQL agent errors (invalid input, workflow failures).

`SqlSchema` query builders add `Schema.SchemaError` for decode failures — replacing our manual `decodeInvoiceRow`/`decodeInvoices`.

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

export const InvoiceId = Schema.Struct({ invoiceId: Schema.String });
export const InvoiceIdOnly = Schema.Struct({ id: Schema.String });
export const InvoiceIdFileName = Schema.Struct({ id: Schema.String, fileName: Schema.String });
export const Void = Schema.Void;

export const InvoiceIdempotencyKey = Schema.Struct({
  invoiceId: Schema.String,
  idempotencyKey: Schema.String,
});

export const UpsertInvoice = Schema.Struct({
  invoiceId: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  r2ActionTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
});

export const DeleteInvoice = Schema.Struct({
  invoiceId: Schema.String,
  r2ActionTime: Schema.Number,
});

export const SaveExtractedJson = Schema.Struct({
  invoiceId: Schema.String,
  idempotencyKey: Schema.String,
  extractedJson: Schema.String,
});

export const SetError = Schema.Struct({
  workflowId: Schema.String,
  error: Schema.String,
});

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
  OrganizationDomain.ts        # InvoiceRow schema, request/result schemas, error class
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
- **`SqlSchema` query builders** — `findAll`, `findOneOption`, `void` etc. encode requests + decode results through Schema, replacing manual decoders
- **`withTransaction`** — semaphore-based transaction support if needed later
- **Portability** — repository depends on generic `SqlClient`, not DO-specific API
- **Consistency with Effect ecosystem** — same patterns as `@effect/sql-d1`, `@effect/sql-pg`, etc.

### Costs

- **Unstable API** — lives in `effect/unstable/sql/`. May change between Effect v4 releases. Mitigation: the adapter is small (~200 LOC), and we can vendor/fork if needed.
- **New dependency** — need to add `@effect/sql-sqlite-do` package. Currently not in `package.json`.
- **Heavier than a value service** — semaphore, compiler, reactivity layer. Though the layer construction is lazy and the runtime overhead is negligible for our use case.
- **Different query pattern** — `yield* sql\`...\`` instead of `this.sql\`...\``. Repository methods already encapsulate this, so the agent doesn't see the difference.

### Recommendation

**Use `@effect/sql-sqlite-do`.** The `SqlSchema` query builders and typed `SqlError` eliminate enough boilerplate to justify the unstable dependency. The adapter is stable in practice (unchanged since v4 beta), small enough to vendor if needed, and aligns with the broader Effect SQL ecosystem.

---

## Open Questions

1. **Package installation** — `@effect/sql-sqlite-do` is a separate package, not bundled with `effect`. Need to verify it's published for the Effect v4 beta version we're on (`4.0.0-beta.27`) and check for any peer dependency requirements.

I think it's bundled with the beta but certainly check.

2. **Table creation** — DDL stays in agent constructor (runs once per DO instantiation, synchronous). Repository is purely query methods.

Leave as is for now.

3. **`SqlSchema` vs direct tagged template** — for simple queries (e.g., `setExtracting`), `SqlSchema.void` adds encode/decode overhead on inputs that are already typed. Could mix: use `SqlSchema` for reads (where result decoding matters), plain `sql\`...\`` for writes. Or keep uniform for consistency.

Need research on SqlSchema. Have no idea what it is. Confusing to me that we'll also have our domain schemas. why do we need schema's specifically for sql?

4. **`Reactivity.layer`** — `SqliteDo.layer()` internally provides `Reactivity.layer`. We don't use reactive queries, but the layer is provided automatically. No action needed — just noting it's there.

5. **`findInvoice` return type** — with `SqlSchema.findOneOption`, returns `Option<InvoiceRow>`. Agent code currently checks `existing && ...`. Would change to `Option.match` or `Option.getOrNull`. Cleaner but different pattern.

Yes, Option is better.
