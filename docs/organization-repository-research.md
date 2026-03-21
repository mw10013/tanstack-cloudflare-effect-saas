# Organization Repository Research

## Context

OrganizationAgent currently has inline SQL + schema decoding spread across its methods. Goal: extract a repository service following existing Effect v4 patterns. Related question: do we need an OrganizationDomain.ts for the agent's domain objects?

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

### Where schemas live today (`organization-agent.ts`)

- `InvoiceRowSchema` — full row schema (lines 14-25)
- `InvoiceStatus` — imported from `Domain.ts` (shared enum)
- `decodeInvoiceRow` / `decodeInvoices` — sync decoders (lines 29-32)
- `OrganizationAgentError` — tagged error class (lines 34-37)
- `activeWorkflowStatuses` — set of workflow status strings (line 27)

### Key difference from Repository.ts

Repository.ts depends on **D1** (Cloudflare D1 via prepared statements + `d1.first()` / `d1.run()`).

OrganizationAgent uses **Durable Object SQLite** via `this.sql` tagged template — synchronous, no prepare/bind, returns arrays directly. This is a fundamentally different data access layer.

## Approach E: Module-level Effect.fn functions + thin tag (recommended)

Effect v4 idiom from the source: export plain `Effect.fn` functions at the module level that `yield*` a service tag for their dependency. No `ServiceMap.Service` class needed — just functions and a tag.

This is the pattern used in `@effect/platform` (e.g., `NodeHttpClient.ts` exports `makeUndici` as a plain `Effect.gen` that `yield*`s a `Dispatcher` tag, `PgClient.ts` exports `fromPool` as `Effect.fnUntraced`).

```ts
// src/lib/OrganizationRepository.ts
import { Context, Effect, Schema } from "effect";
import { InvoiceRowSchema, OrganizationRepositoryError } from "./OrganizationDomain";

// ── thin tag for the DO's sql tagged template ──
type DoSqlFn = DurableObjectState["storage"]["sql"];
export class DoSql extends Context.Tag("DoSql")<DoSql, DoSqlFn>() {}

// ── decoders (private to module) ──
const decodeInvoiceRow = Schema.decodeUnknownSync(Schema.NullOr(InvoiceRowSchema));
const decodeInvoices = Schema.decodeUnknownSync(Schema.Array(InvoiceRowSchema));

// ── repository functions ──
export const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(function* () {
  const sql = yield* DoSql;
  return yield* Effect.try({
    try: () => decodeInvoices(sql`select * from Invoice order by createdAt desc`),
    catch: (cause) => new OrganizationRepositoryError({ message: ... }),
  });
});

export const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
  function* (invoiceId: string) {
    const sql = yield* DoSql;
    return decodeInvoiceRow(
      sql`select * from Invoice where id = ${invoiceId}`[0] ?? null,
    );
  },
);

export const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
  function* (invoice: { invoiceId: string; fileName: string; /* ... */ }) {
    const sql = yield* DoSql;
    yield* Effect.try({
      try: () => void sql`insert into Invoice (...) values (...) on conflict(id) do update set ...`,
      catch: (cause) => new OrganizationRepositoryError({ message: ... }),
    });
  },
);

export const setExtracting = Effect.fn("OrganizationRepository.setExtracting")(
  function* (invoiceId: string, idempotencyKey: string) {
    const sql = yield* DoSql;
    // ...
  },
);

// etc.
```

### How the agent provides DoSql

```ts
// organization-agent.ts constructor
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  void this.sql`create table if not exists Invoice (...)`;
  const doSqlLayer = Layer.succeed(DoSql, this.sql);
  const loggerLayer = makeLoggerLayer(env);
  this.runEffect = (effect) =>
    Effect.runPromise(Effect.provide(effect, Layer.merge(doSqlLayer, loggerLayer)));
}
```

### How the agent calls repository functions

```ts
@callable()
getInvoices() {
  return this.runEffect(OrganizationRepository.getInvoices());
}

@callable()
onInvoiceUpload(upload: { ... }) {
  return this.runEffect(
    Effect.gen(function* () {
      // orchestration stays in the agent
      const existing = yield* OrganizationRepository.findInvoice(upload.invoiceId);
      if (existing && r2ActionTime < existing.r2ActionTime) return;
      yield* OrganizationRepository.upsertInvoice(upload);
      yield* broadcastActivity(this, { level: "info", text: `Invoice uploaded: ${upload.fileName}` });
      yield* Effect.tryPromise({ try: () => this.runWorkflow(...), catch: ... });
      yield* OrganizationRepository.setExtracting(upload.invoiceId, upload.idempotencyKey);
    }),
  );
}
```

**Pros:**
- Idiomatic Effect v4 — this is how `@effect/platform` packages structure their code
- Each function has automatic tracing via `Effect.fn` name
- No class boilerplate, no `ServiceMap.Service`, no `.of()`, no `make`
- `DoSql` tag is the only DI surface — minimal, explicit
- Functions compose naturally with other Effects (`yield*` in generators)
- Agent orchestration (broadcast, workflow) stays cleanly separated
- Testable: provide a mock `DoSql` in tests

**Cons:**
- Each function call `yield* DoSql` independently (minor — tag lookup is cheap)
- Slightly different from Repository.ts pattern (but arguably more idiomatic for v4)

---

## Approach F: Closure factory (no DI, no tag)

Simplest possible extraction. A function takes `sql` and returns an object of Effect values/functions. No tags, no layers, no DI.

```ts
// src/lib/OrganizationRepository.ts
export const make = (sql: DurableObjectState["storage"]["sql"]) => ({
  getInvoices: Effect.fn("OrganizationRepository.getInvoices")(function* () {
    return yield* Effect.try({
      try: () => decodeInvoices(sql`select * from Invoice order by createdAt desc`),
      catch: (cause) => new OrganizationRepositoryError({ message: ... }),
    });
  }),
  findInvoice: Effect.fn("OrganizationRepository.findInvoice")(function* (invoiceId: string) {
    return decodeInvoiceRow(sql`select * from Invoice where id = ${invoiceId}`[0] ?? null);
  }),
  // ...
});
```

```ts
// organization-agent.ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  void this.sql`create table if not exists Invoice (...)`;
  this.repo = OrganizationRepository.make(this.sql);
  const loggerLayer = makeLoggerLayer(env);
  this.runEffect = (effect) => Effect.runPromise(Effect.provide(effect, loggerLayer));
}

@callable()
getInvoices() {
  return this.runEffect(this.repo.getInvoices());
}
```

**Pros:**
- Zero ceremony — no tags, no layers, no context
- Natural JavaScript closure over `sql`
- Trivially testable: pass a mock sql function
- `Effect.fn` still gives tracing

**Cons:**
- Not part of Effect's DI graph — can't compose with other Effect services inside the functions
- If a repository function later needs another service (logging, metrics), you'd need to refactor
- `this.repo` is a plain object on the agent, not an Effect service

---

## Comparison Matrix

| | E: Module Effect.fn + tag | F: Closure factory |
|---|---|---|
| Follows Effect v4 idioms | Yes (`@effect/platform` pattern) | Partially (Effect.fn yes, DI no) |
| DI / testable via Effect | Yes (provide mock DoSql) | No (pass mock sql directly) |
| Composable with other services | Yes (yield* other tags inside fns) | No (closed over sql only) |
| Ceremony | Low (one tag + exports) | Lowest (just a function) |
| Agent constructor change | Add DoSql layer | Store repo instance |
| Tracing | Effect.fn names | Effect.fn names |

## Recommendation

**Approach E** for the best balance of idiomatic Effect v4, composability, and low ceremony. The `DoSql` tag costs one line to define and one line to provide, but unlocks full Effect DI for all repository functions.

**Approach F** if we want absolute simplicity and are confident the repository functions won't need other Effect services.

---

## OrganizationDomain.ts — Do We Need It?

### What would go in it?

| Schema | Currently in | Notes |
|---|---|---|
| `InvoiceRowSchema` | `organization-agent.ts` | Full row shape |
| `InvoiceRow` type | `organization-agent.ts` | Derived from schema |
| `InvoiceStatus` | `Domain.ts` | Already shared — used by both agent and UI |
| `OrganizationAgentError` | `organization-agent.ts` | Tagged error |
| `activeWorkflowStatuses` | `organization-agent.ts` | Runtime set |
| `decodeInvoiceRow` / `decodeInvoices` | `organization-agent.ts` | Sync decoders |
| `WorkflowProgressSchema` | `Activity.ts` | Stays there — used across concerns |

### Analysis

`InvoiceStatus` is already in `Domain.ts` because it's shared (UI renders it, agent writes it). The remaining schemas (`InvoiceRowSchema`, decoders, error class) are currently only used by OrganizationAgent.

**If we introduce OrganizationRepository**, these schemas become shared between the agent and the repository — that's the natural trigger for extracting them.

### Options

1. **Add to existing `Domain.ts`** — keeps one file for all domain schemas. Risk: Domain.ts grows large and mixes primary DB schemas with DO-specific schemas.

2. **Create `OrganizationDomain.ts`** — clean separation. Contains `InvoiceRowSchema`, `InvoiceRow` type, decoders, `OrganizationAgentError`, `activeWorkflowStatuses`. `InvoiceStatus` stays in `Domain.ts` (already there, already shared).

3. **Co-locate in `OrganizationRepository.ts`** — schemas live next to the code that uses them. Only extract to a separate domain file if something else (like the agent or UI) also needs them.

### Recommendation

**Option 2** (`OrganizationDomain.ts`) if creating `OrganizationRepository.ts` — the two files form a natural pair. The agent imports both. Keeps `Domain.ts` focused on the primary D1-backed domain.

If not creating a separate repository, **Option 3** (co-locate) is fine since the schemas are only used internally.

---

## Proposed File Structure (Approach E)

```
src/lib/
  Domain.ts                    # Primary domain (User, Org, Member, etc.) — unchanged
  OrganizationDomain.ts        # InvoiceRow schema, decoders, error class
  OrganizationRepository.ts    # DoSql tag + exported Effect.fn functions
  Repository.ts                # Primary D1 repository — unchanged
```

```
src/
  organization-agent.ts        # Slimmed down — orchestrates repo + broadcast + workflow
```

No separate `DoSql.ts` — the tag is small enough to live in `OrganizationRepository.ts`.

---

## Open Questions

1. **Table creation** — should the `create table if not exists` DDL move into the repository (e.g., an `initialize` effect), or stay in the agent constructor? The constructor is the natural place since it runs once per DO instantiation. But if the repository "owns" the schema, it's arguably more cohesive there.

2. **`broadcastActivity`** — this uses `agent.broadcast()` which is an Agent method, not a data operation. It should stay in the agent, not the repository. But it's interleaved with SQL operations (e.g., `onInvoiceUpload` does insert → broadcast → run workflow → update status). How to split?
   - Repository handles pure data operations (insert, update, select)
   - Agent orchestrates: calls repo, broadcasts, runs workflow, calls repo again

3. **`this.sql` vs `this.ctx.storage.sql`** — the Agent base class exposes `this.sql` as a convenience. Need to verify that `this.ctx.storage.sql` is the same thing for the `DoSql` tag, or if we should pass `this.sql` bound from the agent.

4. **Workflow operations** — `this.runWorkflow()` and `this.getWorkflow()` are agent methods. These stay in the agent. The repository is purely data access.

5. **Multiple DOs** — if we later add more Durable Object types with their own SQLite, `DoSql` becomes a shared utility. If OrganizationAgent is the only one, it could be inlined into `OrganizationRepository.ts`.
