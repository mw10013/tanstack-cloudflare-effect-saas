# D1 Retry Research (Retry-Focused)

## Current Code Snapshot

Current `src/lib/D1.ts` retry path (`src/lib/D1.ts:28-49`):

```ts
const NON_RETRYABLE = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new D1Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.retry({
      while: (error) => !NON_RETRYABLE.some((p) => error.message.includes(p)),
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
  );
```

`D1Error` is now `Schema.TaggedErrorClass` (`src/lib/D1.ts:6-9`).

## Direct Answers To Your Questions

These are good answers. Just write up the answers as research and leave the questions out. Make it concise and doesn't need a lot of explanation.

### 1) Does D1 always auto-retry read-only queries?

Short answer: D1 auto-retry is built-in behavior for read-only queries when the failure is retryable.

Evidence:
- "D1 detects read-only queries and automatically attempts up to two retries..." (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:86`).
- "Only read-only queries ... `SELECT`, `EXPLAIN`, `WITH` are retried" (`.../debug-d1.mdx:91-92`).

Interpretation:
- "Always" = no app opt-in needed.
- It does not mean every read query gets retried; retries happen on retryable failures.

### 2) Is there a setting/toggle to enable/disable that auto-retry?

I did not find any D1 retry setting in D1 docs. Automatic retries are documented as default behavior, not configuration.

Evidence:
- Auto-retry docs describe behavior directly, no config params in that section (`.../debug-d1.mdx:84-92`).
- Retry best-practice page also states it as behavior, not setup (`.../retry-queries.mdx:13-15`).

### 3) Does D1 document its internal backoff/jitter strategy for those automatic retries?

Not in these D1 docs. Docs specify count (up to two retries) and safety behavior, but not timing algorithm.

Evidence:
- Count + read-only scope + rollback safety are documented (`.../debug-d1.mdx:86-92`).
- No statement of D1-internal backoff/jitter policy in those sections.

### 4) So app-level retry should focus on writes?

Mostly yes.

Evidence:
- D1 docs explicitly frame app retry need around writes/transient errors (`.../retry-queries.mdx:11`).
- D1 already retries read-only queries (`.../retry-queries.mdx:14`, `.../debug-d1.mdx:86`).
- D1 warns retries are only safe for idempotent operations (`.../debug-d1.mdx:57-63`).

## Important Nuances

Remove these nuances. We'll address them in our discussion but no need to enumerate these specific ones here.

### Read-only retry still might be needed at app level in some cases

Possible cases:
- You want more than D1's built-in retry budget.
- Failure is outside D1's retry classification path.
- You want request-level policy (total deadline, circuit-breaking, fallback source).

Tradeoff:
- Extra app-level retries can multiply attempts and latency.

### Multiplicative retry budget with current `tryD1`

For a read-only call:
- D1 internal: up to 3 attempts total (1 + up to 2 retries).
- App wrapper: up to 3 attempts total (`times: 2`).
- Worst case: up to 9 physical attempts.

## Why Current `tryD1` Is Risky For Writes

Current policy retries anything except three SQLite message fragments.

Issues:
- Deny-list is too small; many non-idempotent write failures can still be retried.
- Retries on writes can duplicate side effects unless query is idempotent.
- No jitter in app schedule increases herd risk under contention.

Docs grounding:
- Retry only safe for idempotent operations (`.../debug-d1.mdx:57-63`).
- App retries should use exponential backoff + jitter (`.../retry-queries.mdx:21`).

## D1 Error Signals To Allow-List For Retry

Yes, we need ot really nail down errors can be retried in both read and write queries. I'm confused about the errors not marked as simple retry. Is cloudflare being too vague. What the hell should we do in those cases?

From D1 error table, these are explicitly marked retryable:
- `D1 DB reset because its code was updated.` (`.../debug-d1.mdx:70`)
- `Internal error while starting up D1 DB storage caused object to be reset.` (`.../debug-d1.mdx:71`)
- `Network connection lost.` (`.../debug-d1.mdx:72`)
- `Internal error in D1 DB storage caused object to be reset.` (`.../debug-d1.mdx:73`)
- `Cannot resolve D1 DB due to transient issue on remote node.` (`.../debug-d1.mdx:74`)
- `Can't read from request stream because client disconnected.` (`.../debug-d1.mdx:75`, app action suggests retry)

Not marked as simple retry fixes (optimize/shard/load-manage instead):
- Overload / queued too long / too many queued / timeout / memory / CPU (`.../debug-d1.mdx:76-80`).

## Method-Level Considerations In This Codebase

`D1` service wraps:
- `run` (`src/lib/D1.ts:18-19`): can be read or write depending SQL text.
- `first` (`src/lib/D1.ts:20-21`): usually read, but still depends on SQL text. Also returns no metadata (`refs/cloudflare-docs/src/content/docs/d1/worker-api/prepared-statements.mdx:346-347`).
- `batch` (`src/lib/D1.ts:16-17`): transaction semantics; failures abort/rollback sequence (`refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-97`).

Observability:
- `run` / `batch` have `meta.total_attempts` for successful calls (`refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`).
- `first` has no metadata (`.../prepared-statements.mdx:346-347`).

## Concrete Policy Options

### Option A (Conservative, recommended baseline)

- Read-only SQL: no app retry, trust D1 auto-retry.
- Writes: no retry by default.
- Explicit per-call opt-in for idempotent writes with transient allow-list + jitter.

Pros:
- Lowest duplicate-write risk.
- Predictable latency.

Cons:
- Some transient write failures bubble to caller.

### Option B (Balanced)

- Read-only SQL: at most 1 app retry, only for transient allow-list.
- Idempotent writes: at most 2 app retries, transient allow-list, exponential + jitter, capped max delay.
- Non-idempotent writes: no retry.

Pros:
- Better resilience.

Cons:
- More complexity and latency.

### Option C (Aggressive)

- Generic retries for most operations with allow-list.

Pros:
- Highest automatic recovery.

Cons:
- Highest risk of write anomalies and tail-latency blowup.

## Proposed Next Discussion Targets

1. How to classify operations as read-only/idempotent/non-idempotent in this repo.
2. Whether we want SQL-string classification or API-level explicit retry mode per call.

I don't understand sql-string classification. Example?

3. Desired max retry budget and max wall-clock per request path.
4. Whether to drop app retry for `first` reads entirely.

## Sources

- `src/lib/D1.ts:6-9`
- `src/lib/D1.ts:28-49`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:11`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:21`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:84-92`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:70-80`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/prepared-statements.mdx:346-347`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-97`
