# D1 `idempotentWrite` Callsite Research

Date: 2026-03-06

## Scope

Searched app code for `D1` service write paths that can pass `{ idempotentWrite }`:

- `d1.run(...)` in [src/lib/Repository.ts](src/lib/Repository.ts)
- `d1.batch(...)` in [src/routes/api/e2e/delete/user/$email.tsx](src/routes/api/e2e/delete/user/$email.tsx)

Excluded: direct test-only `env.D1.batch(...)` in [test/test-utils.ts](test/test-utils.ts:4) because it does not use the `D1` service wrapper.

## Ground Truth

Code: `D1.run` and `D1.batch` both accept `idempotentWrite` and only retry when that flag is true.

```ts
batch: (...) => tryD1(() => d1.batch<T>(statements)).pipe(
  retryIfIdempotentWrite(options?.idempotentWrite),
),
run: (...) => tryD1(() => statement.run<T>()).pipe(
  retryIfIdempotentWrite(options?.idempotentWrite),
),
```

Docs:

- Cloudflare: retrying write queries is useful for transient errors (`refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:11`).
- Cloudflare: retry is safe only when query is idempotent (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:58-63`).
- Cloudflare: read-only queries already get automatic retries (`refs/cloudflare-docs/src/content/docs/d1/observability/debug-d1.mdx:86-92`, `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx:14`).

## Callsite Recommendations

| Query | Location | Idempotent under retry? | Recommendation |
| --- | --- | --- | --- |
| `update Session set activeOrganizationId = ?1 where userId = ?2 and activeOrganizationId is null` | `src/lib/Repository.ts:75` via call at `src/lib/Repository.ts:72` | Yes. Second execution does nothing because predicate requires `activeOrganizationId is null`. | Set `{ idempotentWrite: true }`. |
| `update Invitation set role = ?1 where id = ?2` | `src/lib/Repository.ts:549` via call at `src/lib/Repository.ts:547` | Yes for this schema. `Invitation` has no `updatedAt` column/trigger, so repeating same `role` assignment is a no-op state-wise (`migrations/0001_init.sql:101-110`). | Set `{ idempotentWrite: true }`. |
| `delete from Session where expiresAt < datetime('now')` | `src/lib/Repository.ts:556` via call at `src/lib/Repository.ts:555`; scheduled in `src/worker.ts:174-183` | Not strictly idempotent because `datetime('now')` changes between attempts; retries can expand delete scope by a few seconds. | Conditional. Prefer query rewrite to fixed cutoff (`expiresAt < ?1`) then set `{ idempotentWrite: true }`. |
| Batch: `delete Organization ...` + `delete from User where id = ? returning *` | `src/routes/api/e2e/delete/user/$email.tsx:46-69` | Yes for this endpoint behavior. If first attempt committed, retry becomes a no-op (rows already gone). Batch semantics are transactional (`refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:94-97`). | Set `{ idempotentWrite: true }` for better e2e resilience to transient D1 errors. |

## Summary

Recommended to enable now:

1. `Repository.initializeActiveOrganizationForUserSessions` (`src/lib/Repository.ts:72`)
2. `Repository.updateInvitationRole` (`src/lib/Repository.ts:547`)
3. E2E delete-user batch route (`src/routes/api/e2e/delete/user/$email.tsx:46`)

Recommended after small query change:

1. `Repository.deleteExpiredSessions` (`src/lib/Repository.ts:555-556`) after replacing `datetime('now')` with a bound cutoff timestamp.
