# D1 Retry Research

## Current Code

`src/lib/D1.ts` currently applies one retry policy to `run`, `first`, and `batch` (`src/lib/D1.ts:15-49`):

- retries up to 2 times (`times: 2`)
- exponential backoff from 1s (`Schedule.exponential("1 second")`)
- deny-list based retry stop (`SQLITE_CONSTRAINT`, `SQLITE_ERROR`, `SQLITE_MISMATCH`)

## D1 Built-in Retry Behavior (Cloudflare)

Cloudflare documents these facts:

- D1 automatically retries read-only queries up to 2 more times on retryable failures (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:86`, `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`).
- Read-only retry scope is limited to queries containing only `SELECT`, `EXPLAIN`, `WITH` (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:91-92`).
- D1 does not document any configuration toggle for this automatic read retry behavior in D1 docs.
- D1 docs do not specify internal backoff/jitter algorithm for built-in read retries.
- App-level retries are specifically called out as useful for write queries with transient errors, and should use exponential backoff + jitter (`refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:11,21`).
- Retry safety is tied to idempotency (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`).

Read-only `batch` behavior is not explicitly called out in one sentence, but docs imply query-level behavior:

- auto-retry wording is query-based (`.../debug-d1.mdx:86,91-92`).
- `batch()` executes a list of statements sequentially (`refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-98`).
- `run` and `batch` both return `D1Result`, and `D1Result.meta.total_attempts` includes retries (`refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:14,19,42`).

Practical interpretation: if a `batch` statement is read-only, it should be eligible for the same query retry behavior. Cloudflare docs do not provide a stricter batch-specific retry contract beyond that.

## Practical Implication

- Read-only: D1 already retries. App-level read retry is optional and should be minimal.
- Write: app-level retry policy is required if you want transient-failure resilience.

## Retryable Error Signals From D1 Docs

D1 error table marks these as retry candidates:

- `D1 DB reset because its code was updated.` (`.../debug-d1.mdx:70`)
- `Internal error while starting up D1 DB storage caused object to be reset.` (`.../debug-d1.mdx:71`)
- `Network connection lost.` (`.../debug-d1.mdx:72`)
- `Internal error in D1 DB storage caused object to be reset.` (`.../debug-d1.mdx:73`)
- `Cannot resolve D1 DB due to transient issue on remote node.` (`.../debug-d1.mdx:74`)
- `Can't read from request stream because client disconnected.` (`.../debug-d1.mdx:75`)

Policy: still no retry for non-idempotent writes, even for these transient/reset errors.

Reason:
- D1 docs explicitly tie retry safety to idempotency (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`).
- non-idempotent write retry can duplicate side effects when commit state is uncertain at failure boundary.

D1 error table does not recommend plain retry as primary fix for these:

- storage op timeout reset
- overloaded / queued too long / too many queued
- isolate memory reset
- CPU limit reset

(`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:76-80`)

Policy for this class: no app retry (both idempotent and non-idempotent) to avoid exacerbating capacity pressure; handle via fail-fast + operational mitigation.

## Codebase Method Notes

- `run`: can be read or write depending SQL (`src/lib/D1.ts:18-19`).
- `first`: typically read path; no metadata return (`src/lib/D1.ts:20-21`, `refs/cloudflare-docs/src/content/docs/d1/worker-api/prepared-statements.mdx:346-347`).
- `batch`: transactional sequence; statement failure aborts/rolls back sequence (`src/lib/D1.ts:16-17`, `refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-97`).
- `run` / `batch` expose `meta.total_attempts` on success (`refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`).

## Recommended Retry Strategy (Baseline)

- `first` (read): no app retry by default.
- `run` read queries: no app retry by default.
- `run` write queries:
  - non-idempotent: no retry
  - idempotent: retry on transient allow-list only, with capped exponential + jitter
- `batch`:
  - non-idempotent batch: no retry
  - idempotent batch: retry on transient allow-list only, max 1-2 attempts

## Opt-in API Direction

Scope: opt-in only for `run` and `batch`.

### Option 1: Boolean flag

- `d1.run(stmt, { idempotentWrite: true })`
- `d1.batch(stmts, { idempotentWrite: true })`

Trade-offs:
- simplest call-site API
- optional and explicit for write retries
- read-only semantics are straightforward: omit flag (or set `idempotentWrite: false`) and rely on D1 built-in read retry

### Option 2: Literal retry mode

- `d1.run(stmt, { retry: "none" | "idempotent-write" })`
- `d1.batch(stmts, { retry: "none" | "idempotent-write" })`

Trade-offs:
- explicit intent at call site
- extensible without API break
- slightly more verbose

Recommendation:
- use optional `idempotentWrite` flag.
- keep `first` without retry options for now.
- keep default behavior as no app-level write retry unless flag is set.
- use `idempotentWrite` (not `isIdempotentWrite`).

Naming note:
- Effect option objects typically use concise capability keys (`concurrent`, `times`, `schedule`, `while`) rather than `is*` naming (`refs/effect4/packages/effect/src/Effect.ts:2535`, `refs/effect4/packages/effect/src/Effect.ts:3914-3925`).

## Source List

- `src/lib/D1.ts:15-49`
- `src/lib/D1.ts:6-9`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:11`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:21`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:86`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:91-92`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:70-80`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/prepared-statements.mdx:346-347`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-98`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:14,19,42`
