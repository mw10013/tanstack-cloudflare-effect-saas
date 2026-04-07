# Organization Bootstrap Fault Tolerance Research

## TL;DR

- We have to use Better Auth APIs for the writes that create auth, organization, and membership state.
- We should assume any Better Auth API call can fail after partially succeeding.
- That means blind retries are unsafe.
- The viable solution is not atomicity. The viable solution is convergence.
- Convergence here means: after any failure, re-read authoritative D1 state, decide what is still missing, and continue from the first unmet invariant.
- The DO-local `Member` table cannot be authoritative. It has to be a repairable projection of D1.
- A background reconciler is required, because [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L121-L191) starts bootstrap from a post-commit Better Auth hook, so the trigger itself can be lost.

## Current Failure

Current bootstrap logic in [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L121-L191):

1. Better Auth creates the user.
2. `databaseHooks.user.create.after` runs.
3. It calls `organizationApiCreate(...)`.
4. It backfills `activeOrganizationId` for sessions.
5. It sends `MembershipSync` to the queue.

Observed failure in [src/organization-agent.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/organization-agent.ts#L510-L527):

```txt
Forbidden: userId=... not in Member table
```

That happens because D1 can already contain the org and owner membership while the DO-local cache has not been updated yet.

The current queue consumer in [src/worker.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/worker.ts#L232-L285) already treats D1 as truth before updating the DO:

```ts
const d1Member = yield* repository.getMemberByUserAndOrg({
  userId: notification.userId,
  organizationId: notification.organizationId,
});
```

That is the right instinct. The problem is that authorization still treats the DO cache as authoritative.

## Constraints

These are the constraints that matter:

- We must use Better Auth APIs for the writes.
- Better Auth organization and membership writes are separate API calls, not one atomic bootstrap call.
- Any Better Auth API call can fail after side effects.
- The first session may already exist before the org exists, so session state needs repair.
- Queue publish can fail.
- Queue delivery can lag.
- DO state can be stale.

Those constraints rule out a simple transactional solution.

## What Has To Be True

The bootstrap is done when these invariants are true in source-of-truth order:

1. The user has an owner organization in D1.
2. Sessions for that user have `activeOrganizationId` set.
3. The organization DO can authorize the user, either because the local `Member` row is present or because it can be repaired from D1.
4. The system can resume from crashes without guessing whether a previous Better Auth call already succeeded.

If the workflow always moves toward these invariants, then it is fault tolerant enough even without atomic cross-system commit.

## Recommended Solution

## Use Better Auth For Writes, D1 For Reconciliation

The practical pattern is:

1. Use Better Auth APIs for writes.
2. Use D1 reads to check what already exists.
3. After any uncertain failure, re-read D1 before deciding whether to retry.
4. Never retry a Better Auth write blindly.

This is the key point.

If `createOrganization()` throws, the next move should not be "call `createOrganization()` again". The next move should be "check D1 and see whether the org and owner member already exist".

## Convergent Bootstrap Orchestrator

The bootstrap runner should evaluate invariants step by step.

Each step should follow this shape:

1. Read D1.
2. If the invariant is already true, skip the write.
3. If the invariant is false, perform exactly one write action.
4. Re-read D1.
5. If the invariant is now true, continue.
6. If the invariant is still false or the result is unclear, retry later.

That gives us safe recovery from ambiguous failures.

## Concrete Step Logic

## Step 1: Ensure the owner organization exists

Use D1 to check whether the user already owns an org. The existing helper in [src/lib/Repository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Repository.ts#L64-L79) already does this:

```ts
select o.* from Organization o where o.id in (
  select organizationId from Member where userId = ?1 and role = 'owner'
)
```

Algorithm:

1. Query D1 for an owner org by `userId`.
2. If found, use it.
3. If not found, call Better Auth `createOrganization(...)`.
4. If that call succeeds, re-read D1 and get the org.
5. If that call fails or times out, re-read D1 before retrying.
6. Only call `createOrganization(...)` again if D1 still shows no owner org.

This is safe even if `createOrganization(...)` is non-idempotent, because the retry decision is based on D1, not on the exception alone.

## Step 2: Ensure session active organization is set

This is already implemented as an idempotent D1 repair in [src/lib/Repository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Repository.ts#L81-L106):

```ts
update Session
set activeOrganizationId = ?1
where userId = ?2 and activeOrganizationId is null
```

Keep this shape.

It is good because:

- it is idempotent
- it only repairs missing session state
- it does not overwrite later user choices

## Step 3: Ensure membership projection reaches the DO

After D1 confirms the membership exists, send `MembershipSync` as best effort.

Current send logic is in [src/lib/MembershipSync.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/MembershipSync.ts#L6-L20).

This queue send should not be treated as required for correctness. It should be treated as a fast path.

If queue send fails, the system still has enough information in D1 to repair later.

## The Critical Change: Read-Repair In Auth

The current fatal flaw is that [src/organization-agent.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/organization-agent.ts#L510-L527) does this:

1. check DO-local `Member`
2. fail if missing

That should become:

1. check DO-local `Member`
2. if found, continue
3. if missing, query D1 membership
4. if D1 says the user is a member, seed or repair the local DO `Member` row and continue
5. only fail if D1 also says the user is not a member

This is the single most important runtime fix because it turns the DO cache into a repairable projection instead of a hard dependency.

Without this, queue lag will always be user-visible even if the bootstrap orchestrator is otherwise correct.

## Why A Background Reconciler Is Required

Even a perfect bootstrap runner is not enough if its trigger can be lost.

The bootstrap currently starts from Better Auth `databaseHooks.user.create.after` in [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L121-L191). That hook runs after Better Auth commits the user creation.

So this can happen:

1. user row commits
2. process crashes before org bootstrap is scheduled or finished

At that point the system needs a way to rediscover unfinished bootstrap work from D1 itself.

That is what the reconciler does.

## Reconciler Responsibilities

The reconciler should periodically scan D1 for unmet invariants such as:

- user exists but has no owner org
- user has owner org but sessions still have `activeOrganizationId is null`
- D1 membership exists but DO cache is missing or stale

The reconciler can be run by:

- Cloudflare Workflow
- Durable Object alarm
- scheduled Worker trigger

Any of those is fine. The important property is that it re-derives required work from D1, not from an in-memory assumption that the original hook completed.

## Optional Job Table

A bootstrap job table is useful, but it is not sufficient by itself.

If we add one, it should track things like:

- `userId`
- current status
- last error
- next retry time
- attempt count

That helps observability and backoff.

But correctness should not depend only on that table, because the job row itself can be missed if the process dies at the wrong time. The real safety net is the invariant scanner over actual auth and org state.

## What To Avoid

## Do not blind retry Better Auth writes

This is the main trap.

If `createOrganization()` or future member-add APIs can partially succeed, then retrying just because the call threw is unsafe.

Always re-read D1 before retrying.

## Do not make the queue part of the correctness boundary

The queue is useful for propagating state. It is not safe to make first-request authorization depend on the queue finishing first.

## Do not try to compensate by deleting partial state

Forward convergence is much safer than trying to roll back partial Better Auth writes.

If the org already exists and the member already exists, the right move is usually to finish the remaining repair work, not to delete the org and start over.

## Viable End State

The viable end state looks like this:

1. Better Auth APIs remain the only write path for auth and org creation.
2. Bootstrap runs as a convergent workflow, not a one-shot chain.
3. Each uncertain failure is resolved by re-reading D1.
4. Session repair stays idempotent.
5. Queue sync becomes best-effort acceleration.
6. Authorization can repair the DO cache from D1 on miss.
7. A background reconciler scans D1 for unfinished bootstrap and repairs it.

That combination is practical and compatible with the current architecture.

## Recommended Plan

1. Change organization-agent authorization to read-repair from D1 on local cache miss.
2. Extract bootstrap into an explicit runner that evaluates invariants instead of chaining writes inline.
3. Keep using Better Auth `createOrganization(...)` for the org write.
4. Before every retry of that call, check D1 first for an owner org.
5. Keep the existing idempotent session backfill.
6. Treat `MembershipSync` as best effort and retriable, not required for correctness.
7. Add a periodic reconciler that scans D1 for users missing owner org bootstrap or session repair.

## Bottom Line

Given the constraint that we must call Better Auth APIs and those calls may fail after side effects, the workable solution is:

> make bootstrap converge from D1 invariants, not from API-call success responses.

That is the real fault-tolerant approach available here.
