# Research: Replacing D1 Service with @effect/sql-d1

## Current D1 Service (`src/lib/D1.ts`)

Thin ServiceMap wrapper over Cloudflare's raw D1 API:

```
prepare(query)        → D1PreparedStatement
batch(stmts, opts?)   → Effect<D1Result<T>[], D1Error>  (calls d1.batch())
run(stmt, opts?)      → Effect<D1Result<T>, D1Error>
first(stmt)           → Effect<Option<T>, D1Error>
```

- `idempotentWrite` option on `batch`/`run` enables retry with exponential backoff + jitter (2 retries) for 6 known transient D1 error signals
- `D1Error` wraps cause with `Schema.TaggedErrorClass`
- All errors logged via `Effect.tapError`

**Usage stats across codebase:**
- `d1.first()` — 13+ instances (reads)
- `d1.run()` — 3 instances (writes, all with `idempotentWrite: true`)
- `d1.batch()` — 2 instances (multi-statement writes, all with `idempotentWrite: true`)
- All queries use raw SQL strings with positional `?1`, `?2` params

## @effect/sql-d1 Implementation

Source: `refs/effect4/packages/sql/d1/src/D1Client.ts`

### API Surface

Template-literal SQL builder returning Effect-wrapped results:

```ts
const sql = yield* SqlClient

// query execution
const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`

// helpers
yield* sql`INSERT INTO users ${sql.insert({ name: "alice", email: "a@b.com" })}`
yield* sql`INSERT INTO users ${sql.insert([row1, row2])} RETURNING *`
yield* sql`UPDATE users SET ${sql.update(changes)} WHERE id = ${id}`

// composition
sql.and([...clauses])
sql.or([...clauses])
sql.in([1, 2, 3])
sql.in("id", [1, 2, 3])
sql.literal("CAST(? AS TEXT)")

// escape hatches
sql.unsafe("SELECT * FROM users", [])
stmt.compile()  // → [sqlString, params] tuple
```

### Layer Setup

```ts
import * as D1Client from "@effect/sql-d1/D1Client"

const SqlLayer = D1Client.layer({
  db: d1Database,                          // required
  prepareCacheSize: 200,                   // default
  prepareCacheTTL: Duration.minutes(10),   // default
  transformResultNames: camelCase,         // optional snake_case → camelCase
  transformQueryNames: snakeCase,          // optional camelCase → snake_case
})
// provides: D1Client | SqlClient
```

### What It Does NOT Support

| Feature | Status |
|---------|--------|
| `d1.batch()` | **Not used.** Each statement executes individually |
| Transactions (`BEGIN`/`COMMIT`) | `Effect.die("transactions are not supported in D1")` |
| Streaming (`executeStream`) | `Effect.die` — not implemented |
| Multi-row UPDATE (`updateValues`) | Returns empty — SQLite limitation |

### What It Provides Instead of batch()

**SqlResolver** — Effect's request batching/deduplication:

```ts
const FindById = SqlResolver.findById({
  Id: Schema.Number,
  Result: UserSchema,
  ResultId: (r) => r.id,
  execute: (ids) => sql`SELECT * FROM users WHERE id IN ${sql.in(ids)}`.asEffect()
})

// concurrent requests auto-batched into single query
yield* Effect.all({
  a: request(FindById)(1),
  b: request(FindById)(2),
  c: request(FindById)(3),
}, { concurrency: "unbounded" })
// → SELECT * FROM users WHERE id IN (?, ?, ?)
```

This batches **reads of the same shape** into one query. It is NOT the same as D1's `batch()` which executes **multiple different statements** in a single round-trip as a transaction.

### Additional Features

- **SqlSchema** — schema-validated query helpers (`findAll`, `findOne`, `void`)
- **SqlModel** — CRUD repository generator with insert/update/delete/findById
- **Migrator** — migration runner with tracking table
- **Prepared statement cache** — LRU, 200 capacity, 10min TTL
- **Row transforms** — automatic snake_case ↔ camelCase
- **Tracing** — span attributes on all queries

## D1 batch() — Why It Matters

From Cloudflare docs (`refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx`):

> "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."

D1 has **no user-initiated transactions** (`BEGIN`/`COMMIT` are rejected). `batch()` is the **only way to get transactional atomicity** in D1. This is critical for multi-statement writes like:

```ts
// current usage: transactional delete
d1.batch([
  d1.prepare("delete from Organization where ..."),
  d1.prepare("delete from User where id = ? returning *"),
], { idempotentWrite: true })
```

Without `batch()`, these would be two separate implicit transactions — if the second fails, the first is already committed.

## Trade-off Analysis

### What We'd Gain

1. **Template-literal SQL builder** — composable, type-safe query construction; no more string concatenation for dynamic queries
2. **SqlResolver** — automatic read batching/deduplication for concurrent requests (useful for data loaders)
3. **SqlSchema/SqlModel** — schema-validated queries, generated CRUD repos
4. **Row transforms** — automatic column name case conversion
5. **Prepared statement cache** — built-in LRU with TTL (we currently don't cache)
6. **Ecosystem alignment** — standard Effect SQL interface; swap D1 for Postgres later with minimal changes
7. **Tracing** — automatic spans on queries

### What We'd Lose

1. **`d1.batch()` support** — @effect/sql-d1 does NOT call `d1.batch()`. Every statement is a separate round-trip. **No transactional atomicity for multi-statement writes.**
2. **`idempotentWrite` retry** — no built-in retry for transient D1 errors. We'd need to reimplement this as a wrapper/middleware.
3. **`first()` → `Option`** — our current `first()` returns `Option`. SqlClient returns `ReadonlyArray` (we'd use `SqlSchema.findOneOption` instead — minor).
4. **Access to D1 metadata** — `D1Result.meta` (changes, rows_read, last_row_id) is hidden behind the abstraction. Our `deleteExpiredSessions` reads `result.meta.changes`.
5. **Raw D1 control** — lose ability to use D1-specific APIs as they evolve.

### Migration Effort

| Area | Effort | Notes |
|------|--------|-------|
| Repository queries (45 SQL statements) | **Medium** | Rewrite as template literals; mostly mechanical but ~45 queries |
| Layer composition (`worker.ts`) | **Low** | Swap `D1.layer` for `D1Client.layer` |
| `idempotentWrite` retry | **Medium** | Reimplement as Effect middleware wrapping SqlClient |
| `d1.batch()` usage (2 sites) | **High** | No direct replacement — need raw D1 escape hatch or accept non-atomic |
| `D1Result.meta` access (1 site) | **Low** | Use `sql.unsafe()` + raw result, or restructure query |
| Error type migration | **Low** | `D1Error` → `SqlError` |
| Test utilities | **Low** | Already use raw D1Database |

## Augmenting @effect/sql-d1 with batch()

### Key Insight: `statement.compile()` is Synchronous

Every statement built via SqlClient has a `.compile()` method that **synchronously** returns `[sql: string, params: ReadonlyArray<unknown>]` without executing anything. The compiler is pure — no connection, no Effect runtime needed.

```ts
const sql = yield* SqlClient

const stmt = sql`DELETE FROM Organization WHERE id IN (
  SELECT o.id FROM Organization o
  INNER JOIN Member m ON m.organizationId = o.id
  WHERE m.userId = ${userId}
  GROUP BY o.id HAVING COUNT(*) = 1
)`

const [query, params] = stmt.compile()
// query: "DELETE FROM Organization WHERE id IN (SELECT o.id FROM ...)"
// params: [userId]
```

This works with all SqlClient helpers — `sql.insert()`, `sql.update()`, `sql.in()`, `sql.and()`, etc. The full template-literal query builder is available for construction, and `.compile()` extracts the raw SQL + params.

### Approach: Build with SqlClient, Execute with d1.batch()

Use SqlClient as a **query builder only** for batch operations. Build statements, compile them, feed the compiled SQL+params to raw `d1.batch()`.

```ts
import * as SqlClient from "effect/unstable/sql/SqlClient"

class D1Batch extends ServiceMap.Service<D1Batch>()("D1Batch", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { D1: rawD1 } = yield* CloudflareEnv

    const batch = Effect.fn("D1Batch.batch")(function* <T = Record<string, unknown>>(
      statements: ReadonlyArray<Statement.Statement<any>>,
      options?: { readonly idempotentWrite?: boolean },
    ) {
      const prepared = statements.map((stmt) => {
        const [query, params] = stmt.compile()
        return rawD1.prepare(query).bind(...params)
      })
      return yield* tryD1(() => rawD1.batch<T>(prepared)).pipe(
        retryIfIdempotentWrite(options?.idempotentWrite),
      )
    })

    return { batch }
  }),
}) {}
```

Usage at call sites:

```ts
const sql = yield* SqlClient.SqlClient
const d1Batch = yield* D1Batch

yield* d1Batch.batch([
  sql`DELETE FROM Organization WHERE id IN (
    SELECT o.id FROM Organization o
    INNER JOIN Member m ON m.organizationId = o.id
    WHERE m.userId = ${userId}
    GROUP BY o.id HAVING COUNT(*) = 1
  )`,
  sql`DELETE FROM User WHERE id = ${userId} RETURNING *`,
], { idempotentWrite: true })
```

**What this achieves:**
- All queries (single + batch) use the same SqlClient template-literal builder
- batch() gets transactional atomicity via raw D1 API
- `idempotentWrite` retry preserved
- No two query syntaxes — everything is `sql\`...\``

### Approach Variations

#### Variation A: Standalone compiler (no SqlClient dependency for batch)

Create a SQLite compiler independently of SqlClient for batch-only use:

```ts
import * as Statement from "effect/unstable/sql/Statement"

const compiler = Statement.makeCompilerSqlite()

const compileBatch = (fragments: ReadonlyArray<Statement.Fragment>) =>
  fragments.map((frag) => {
    const [query, params] = compiler.compile(frag, false)
    return rawD1.prepare(query).bind(...params)
  })
```

**Pro:** No SqlClient dependency for batch path. **Con:** Lose SqlClient helpers (`sql.insert()`, `sql.in()`, etc.) — you'd only have raw `Statement.literal()` and `Statement.parameter()`.

**Verdict:** Not practical. The whole point is using SqlClient's ergonomic builder. Use SqlClient.

Remove this option.

#### Variation B: Thin compile-and-batch utility function

Instead of a full service, a simple utility:

```ts
const batchCompile = (
  rawD1: D1Database,
  statements: ReadonlyArray<Statement.Statement<any>>,
) => {
  const prepared = statements.map((stmt) => {
    const [query, params] = stmt.compile()
    return rawD1.prepare(query).bind(...params)
  })
  return tryD1(() => rawD1.batch(prepared))
}
```

**Pro:** Minimal abstraction. **Con:** Caller must source `rawD1` themselves; retry logic not encapsulated.

remove this option.

#### Variation C: Extend SqlClient with batch via wrapper service (recommended)

A service that depends on both SqlClient and CloudflareEnv, re-exports SqlClient and adds batch:

```ts
class Sql extends ServiceMap.Service<Sql>()("Sql", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { D1: rawD1 } = yield* CloudflareEnv

    const batch = Effect.fn("Sql.batch")(function* <T = Record<string, unknown>>(
      statements: ReadonlyArray<Statement.Statement<any>>,
      options?: { readonly idempotentWrite?: boolean },
    ) {
      const prepared = statements.map((stmt) => {
        const [query, params] = stmt.compile()
        return rawD1.prepare(query).bind(...params)
      })
      return yield* tryD1(() => rawD1.batch<T>(prepared)).pipe(
        retryIfIdempotentWrite(options?.idempotentWrite),
      )
    })

    return { ...sql, batch }
  }),
}) {}
```

Usage becomes uniform:

```ts
const sql = yield* Sql

// single queries — delegates to SqlClient
const users = yield* sql`SELECT * FROM users WHERE id = ${id}`

// batch — compiles + d1.batch()
yield* sql.batch([
  sql`INSERT INTO orders ${sql.insert(order)}`,
  sql`UPDATE inventory SET stock = stock - ${qty} WHERE product_id = ${productId}`,
], { idempotentWrite: true })
```

**Pro:** Single `Sql` service for everything. Callers don't know or care about the SqlClient/D1 split. **Con:** Spreading SqlClient's interface means we're coupling to its shape — if upstream adds a `batch` property, we'd shadow it.

Present this as the way we would do it if we proceeded with this functionality. No discussion of the other approaches.

### Handling idempotentWrite and D1 Metadata

**idempotentWrite:** All variations above preserve our existing retry logic. The `retryIfIdempotentWrite` function works on any `Effect<A, D1Error>` — we just wrap the batch call.

**D1 metadata (`result.meta.changes`, etc.):** `d1.batch()` returns `D1Result[]` which includes `.meta`. Since we're calling raw `d1.batch()`, metadata is fully accessible:

```ts
const [deleteOrgsResult, deleteUserResult] = yield* sql.batch([
  sql`DELETE FROM Organization WHERE ...`,
  sql`DELETE FROM User WHERE id = ${userId} RETURNING *`,
], { idempotentWrite: true })

const changesCount = deleteOrgsResult.meta.changes
```

For single queries via SqlClient, metadata is hidden. If we need `meta` for single queries, we'd use `sql.unsafe()` with raw execution or add a `runRaw` method to our wrapper.

### Compile Behavior with SqlClient Helpers

All helpers produce `Fragment` segments that compile cleanly:

| Helper | Compiled Output |
|--------|----------------|
| `sql.insert({ name: "alice", age: 30 })` | `("name", "age") VALUES (?, ?)` with `["alice", 30]` |
| `sql.insert([row1, row2])` | `("name") VALUES (?), (?)` with `["a", "b"]` |
| `sql.update({ name: "bob" })` | `"name" = ?` with `["bob"]` |
| `sql.in([1, 2, 3])` | `(?, ?, ?)` with `[1, 2, 3]` |
| `sql.and([a, b])` | `(clause1) AND (clause2)` with merged params |
| `sql("columnName")` | `"columnName"` (escaped identifier) |

All produce valid SQLite with positional `?` placeholders — compatible with `d1.prepare().bind()`.

### Transform Considerations

If `transformQueryNames` is configured (e.g., camelCase → snake_case), the compiler applies it to identifiers in helpers like `sql.insert()` and `sql.update()`. When compiling for batch, the **same compiler** is used (it's attached to each statement), so transforms are consistent.

`transformResultNames` (snake_case → camelCase on results) does NOT apply when we bypass SqlClient execution and use raw `d1.batch()`. If we need result transforms on batch results, we'd apply them manually or use Effect's `Schema.decodeUnknown`.

## The batch() Problem — Full Options Summary

### Option A: Hybrid — raw D1 for batch, SqlClient for everything else
Two separate interfaces. Batch calls use raw `d1.prepare()` strings.

**Pro:** Simple. **Con:** Two query syntaxes.

### Option B: Compile-and-batch — SqlClient builds, d1.batch() executes
Use SqlClient template literals for all queries. For batch, call `.compile()` on each statement and feed to `d1.batch()`. Wrapped in a service (Variation C above).

**Pro:** Single query syntax, transactional batch, full SqlClient ergonomics. **Con:** Thin custom wrapper needed; result transforms on batch results require manual handling.

### Option C: Stay with current D1 service
No migration. Keep raw SQL strings.

**Pro:** Zero migration cost, full D1 control. **Con:** No template-literal composition, no SqlResolver, no ecosystem alignment.

### Option D: Upstream contribution
Add batch() to @effect/sql-d1 itself.

**Pro:** Clean. **Con:** Upstream dependency on acceptance timeline.

## Recommendation

**Option B: Compile-and-batch (Variation C — wrapper service).**

1. **Single query syntax.** All queries — reads, single writes, batched writes — use `sql\`...\`` template literals. No context-switching between raw SQL strings and template literals.

2. **batch() preserved with full atomicity.** `.compile()` extracts SQL+params, `d1.batch()` executes transactionally. The abstraction cost is one small wrapper service.

3. **idempotentWrite preserved.** Retry logic wraps the batch call identically to today.

4. **Incremental migration path.** Convert queries one at a time. The wrapper service can coexist with the current D1 service during migration.

5. **Future-proof.** If @effect/sql-d1 adds native batch(), we drop our wrapper. If we migrate to Postgres, SqlClient queries transfer with minimal changes.

6. **SqlResolver available.** For future N+1 optimization, SqlResolver works naturally with SqlClient — no additional integration needed.

**Trade-off accepted:** Result transforms on batch results need manual handling (or Schema decode). This is minor — batch operations are writes, not reads, so result shape is usually simple (RETURNING clauses, meta).

**Migration effort revised:**

| Area | Effort | Notes |
|------|--------|-------|
| Create Sql wrapper service | **Low** | ~30 lines |
| Repository queries (45 statements) | **Medium** | Mechanical rewrite to template literals |
| Layer composition | **Low** | Add D1Client.layer, compose with Sql.layer |
| idempotentWrite | **Low** | Move existing logic into wrapper |
| batch() call sites | **Low** | Same pattern, just `sql\`...\`` instead of `d1.prepare()` |
| D1Result.meta access | **Low** | Available from batch; single-query meta via `sql.unsafe()` if needed |

## Open Questions

- Are there upcoming features that would benefit specifically from SqlModel/CRUD generation?
- Is the SqlResolver read-batching pattern useful for any current N+1 query patterns?
- Should we track the @effect/sql-d1 repo for batch() support additions?
- Should we apply `transformResultNames`/`transformQueryNames` or keep our current naming convention?
