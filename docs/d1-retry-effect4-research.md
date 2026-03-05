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

Does a read-only batch automatically retry? Can we get evidence for this either way?

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

D1 error table does not recommend plain retry as primary fix for these:

- storage op timeout reset
- overloaded / queued too long / too many queued
- isolate memory reset
- CPU limit reset

(`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:76-80`)

## What To Do For "Not Marked As Simple Retry"

Recommended app behavior:

1. Treat them as `retry-limited` (not `retry-forever`).
2. Retry at most once for idempotent operations only.
3. If still failing, surface error immediately.
4. Emit high-signal logs/metrics to trigger load/query tuning.

Reason:
- docs point to capacity/query-shape mitigation (optimize/shard/spread load), not aggressive retry loops.

Would it be far to say that if a retry is attempted, it should be done after a long delay? We may also just want to fail since it seems we're hitting capacity issues and don't want to exacerbate.

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

## Classification Approach Options

Get rid of this section. There is no way we're going to inspect sql. We'll figure out opt-in approach as we continue discussion.

### SQL-string classification

Determine retry mode by inspecting SQL text.

Example:

- SQL starts with `select` / `with` / `explain` => treat as read.
- SQL starts with `insert`, `update`, `delete`, `replace`, `create`, `drop`, `alter`, `pragma` => treat as write.

Pros:
- centralized behavior, no per-call manual flags.

Cons:
- brittle for complex SQL and CTEs; parser edge cases.

### API-level explicit retry mode

Call site declares retry mode.

Example API shape:

- `d1.run(stmt, { retry: "none" | "read" | "idempotent-write" })`
- `d1.batch(stmts, { retry: "none" | "idempotent-write" })`

Pros:
- explicit intent, fewer false assumptions.

Cons:
- more call-site decisions.

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
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-97`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`
