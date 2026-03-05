# D1 Retry + Effect v4 Research

## Scope

Analyze `src/lib/D1.ts` L28-51:

```ts
const NON_RETRYABLE = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause =
        Cause.isUnknownError(error) && error.cause instanceof Error
          ? error.cause
          : error instanceof Error
            ? error
            : new Error(String(error));
      return new D1Error({ message: cause.message, cause });
    }),
    Effect.tapError((error) => Effect.log(error)),
    Effect.retry({
      while: (error) => !NON_RETRYABLE.some((p) => error.message.includes(p)),
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
  );
```

Source: `src/lib/D1.ts:28-51`

## What This Code Does

1. Defines a deny-list of SQLite message fragments that should not retry.
2. Wraps a Promise D1 operation into `Effect` via `Effect.tryPromise`.
3. Normalizes unknown failure shapes into `D1Error`.
4. Logs every error.
5. Retries up to 2 times with exponential delay starting at 1s, unless error message contains one of deny-listed strings.

Source excerpts:
- Retry options API exists in v4: `while`, `until`, `times`, `schedule` (`refs/effect4/packages/effect/src/Effect.ts:3921-3926`).
- `times` is enforced via schedule metadata attempt check (`refs/effect4/packages/effect/src/internal/schedule.ts:242-244`).

## Is This "Effect v3" or v4?

Short answer: mostly valid v4, but mixed-era style.

What is v4-valid:
- `Effect.tryPromise(...)` function form is valid (`refs/effect4/packages/effect/src/Effect.ts:1152-1156`).
- `Effect.retry({ while, times, schedule })` options object is valid (`refs/effect4/packages/effect/src/Effect.ts:3921-3926`).
- `ServiceMap.Service(..., { make })` style is valid (`refs/effect4/packages/effect/src/ServiceMap.ts:123-138`).
- `Data.TaggedError` still exists (`refs/effect4/packages/effect/src/Data.ts:764-768`).

What is less idiomatic in v4 docs/examples:
- v4 AI docs consistently model typed errors with `Schema.TaggedErrorClass`, not `Data.TaggedError`.
  - Examples: `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:9-19`, `refs/effect4/ai-docs/src/06_schedule/10_schedules.ts:8-12`.
- v4 examples usually prefer `Effect.tryPromise({ try, catch })` for direct typed mapping (`refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:47-56`).
- v4 schedule guidance favors composed schedule policies (retryable filter, cap, jitter) (`refs/effect4/ai-docs/src/06_schedule/10_schedules.ts:50-58`).

## What D1 Already Does (Automatic Retries)

Cloudflare D1 docs explicitly state:

- "D1 automatically retries read-only queries up to two more times" (`refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`).
- Automatic retries apply to read-only query keywords `SELECT`, `EXPLAIN`, `WITH` (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:91-92`).
- D1 retry safety mechanism rolls back if retry path would write (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:88`).
- Retrying operations is only safe if query is idempotent (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`).
- App-level retries should use exponential backoff + jitter (`refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:21`).

D1 `run()` / `batch()` results include `meta.total_attempts` (includes retries), useful for observability (`refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`).

## Interaction Risk: Current `tryD1` + D1 Auto-Retry

Current wrapper applies app-level retries to all wrapped methods (`run`, `first`, `batch`).

Potential consequence for read-only operations:
- D1 internal retries: up to 3 attempts total per app call.
- Wrapper retries: up to 3 app calls total (`times: 2`).
- Worst-case total physical attempts can become multiplicative.

Potential consequence for writes:
- D1 will not auto-retry write queries.
- Wrapper currently may retry writes unless message contains one of only 3 SQLite fragments.
- This can be unsafe for non-idempotent writes.

## Better v4 Pattern / Idiom

1. Prefer allow-list retry predicate for transient D1 failures (not deny-list).
2. Split retry policy by operation kind:
- read-only: minimal/no app retry since D1 already retries.
- idempotent writes: retry with strict transient allow-list + capped exponential + jitter.
- non-idempotent writes: default no retry.
3. Use `Effect.tryPromise({ try, catch })` to type/map errors at source.
4. Keep schedule composition explicit in v4 style (`Schedule.exponential(...).pipe(..., Schedule.jittered, ...)`).

D1 transient examples from docs that are retry candidates:
- `Network connection lost.` (`debug-d1.mdx:72`)
- `...object to be reset.` (`debug-d1.mdx:70-71,73`)
- `Cannot resolve D1 DB due to transient issue on remote node.` (`debug-d1.mdx:74`)

## Specific Assessment of `src/lib/D1.ts` L28-51

- Correct: wrapping Promise API in Effect; typed domain error boundary; retry combinator usage is v4-compatible.
- Not ideal: retry classifier is too broad for writes and not aligned to D1’s documented transient retry messages.
- Not ideal: no jitter.
- Mixed-era compatibility logic: D1 docs say detailed `error.cause.message` behavior is mainly for older Wrangler (< 3.1.1), while this repo uses Wrangler 4.69.0 (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:37-40`, `package.json:147`).
- Mixed-style: `Data.TaggedError` + manual unknown-error extraction is valid but not the dominant v4 docs idiom.

## Practical Strategy for `tryD1`

1. Add two wrappers, not one:
- `tryD1Read` for read-only operations (`first`, read `run` paths).
- `tryD1Write` for writes / `batch` with explicit idempotency flag.
2. Use retry allow-list based on D1 documented transient messages.
3. Add jitter to reduce synchronized retry spikes.
4. Record `meta.total_attempts` from successful `run` / `batch` responses in logs/metrics.

## Sources

- `src/lib/D1.ts:28-51`
- `refs/effect4/packages/effect/src/Effect.ts:1104-1109`
- `refs/effect4/packages/effect/src/Effect.ts:1152-1156`
- `refs/effect4/packages/effect/src/Effect.ts:3921-3926`
- `refs/effect4/packages/effect/src/internal/schedule.ts:242-244`
- `refs/effect4/packages/effect/src/ServiceMap.ts:123-138`
- `refs/effect4/packages/effect/src/Data.ts:764-768`
- `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:47-56`
- `refs/effect4/ai-docs/src/06_schedule/10_schedules.ts:50-58`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`
- `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:21`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:57-63`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:37-40`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:86-92`
- `refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:70-75`
- `refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx:42`
- `package.json:147`
