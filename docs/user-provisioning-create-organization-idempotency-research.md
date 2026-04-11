# `ensureOrganization` → `createOrganization` — idempotency research

Scope: the `ensure-organization` workflow step in `src/user-provisioning-workflow.ts:35`. Questions being answered:

1. Can `ensure` be renamed `createOrganization` and the step `create-organization`?
2. Is `auth.api.createOrganization` actually idempotent, or does it leave partial state on failure?
3. Is the current "catch `ORGANIZATION_ALREADY_EXISTS` → look up by slug → add member" fallback correct?
4. Does slug (derived from email) belong in this flow given the rest of the app keys everything on `organizationId`?

## 1. How `auth.api.createOrganization` works

Endpoint: `refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:57`.

Execution order inside the handler (`crud-org.ts:100`–`291`):

1. Resolve user from session or `ctx.body.userId` (`:101`–`:115`).
2. `allowUserToCreateOrganization` check (`:117`–`:131`).
3. `adapter.listOrganizations(user.id)` → enforce `organizationLimit` (`:134`–`:147`).
4. `adapter.findOrganizationBySlug(ctx.body.slug)` → if found, throw `ORGANIZATION_ALREADY_EXISTS` (`:149`–`:157`).
5. `beforeCreateOrganization` hook (`:165`).
6. `adapter.createOrganization({ organization: { ...orgData, createdAt } })` (`:179`).
7. `beforeAddMember` hook (`:195`).
8. `adapter.createMember({ userId, organizationId, role: 'owner' })` (`:212`).
9. `afterAddMember` hook (`:213`).
10. Teams block — skipped because we don't enable `teams` (`:220`).
11. `afterCreateOrganization` hook (`:265`).
12. `setActiveOrganization` on the current session token — **only when there is a `ctx.context.session`** (`:273`). Our workflow uses `userId` without a session, so this is skipped.

### No transaction

`adapter.createOrganization` (`adapter.ts:54`) and `adapter.createMember` (`adapter.ts:288`) are two independent `adapter.create` calls. There is no `db.transaction(...)` wrapping them, and no compensating delete on failure. Any crash between steps 6 and 8 leaves an `Organization` row with **no** `Member` row for the creator.

### The slug collision check is pre-insert, not a DB unique constraint

Step 4 is a SELECT-then-INSERT, so it is racy in theory. In our workflow it's run serially from a single instance so races aren't the concern — **durable orphan state** is.

### `organizationLimit` counts via `Member`, not `Organization`

`listOrganizations` (`adapter.ts:585`) does `findMany({ model: 'member', where: userId }, join: { organization })`. So an orphan org (no member) does **not** count against the user's limit — the limit check would let us retry the create. But step 4's slug check still blocks us, throwing `ORGANIZATION_ALREADY_EXISTS`.

## 2. Failure windows that break naive retry

| Point of failure                | `Organization` row | `Member` row for user | Retry via `createOrganization` | Retry via `getOwnerOrganizationByUserId` |
| --- | --- | --- | --- | --- |
| Before step 6                   | no                 | no                    | succeeds                       | returns none, proceeds                   |
| Between steps 6 and 8           | yes                | no                    | throws `ORGANIZATION_ALREADY_EXISTS` | returns none, proceeds                   |
| After step 8                    | yes                | yes                   | throws `ORGANIZATION_ALREADY_EXISTS` | returns some, short-circuits             |

The middle row is the interesting one and is the reason the current code has a fallback branch.

## 3. What the current `ensureOrganization` actually does

`src/user-provisioning-workflow.ts:35`–`92`:

```ts
const ownerOrganization =
  yield* repository.getOwnerOrganizationByUserId(userId);
if (Option.isSome(ownerOrganization)) return ownerOrganization.value.id;
const { name, slug } = getUserProvisioningOrganization({ email });
const createdOrganization = yield* Effect.tryPromise(() =>
  auth.api.createOrganization({ body: { name, slug, userId } }),
).pipe(
  Effect.catch((error) =>
    isAPIError(error) &&
    error.body?.code === "ORGANIZATION_ALREADY_EXISTS"
      ? Effect.gen(function* () {
          const organizationBySlug =
            yield* repository.getOrganizationBySlug(slug);
          if (Option.isNone(organizationBySlug)) {
            return yield* Effect.fail(error);
          }
          const existingMember = yield* repository.getMemberByUserAndOrg({
            userId,
            organizationId: organizationBySlug.value.id,
          });
          if (Option.isNone(existingMember)) {
            yield* Effect.tryPromise(() =>
              auth.api.addMember({
                body: {
                  userId,
                  organizationId: organizationBySlug.value.id,
                  role: "owner",
                },
              }),
            ).pipe(
              Effect.catch((addMemberError) =>
                isAPIError(addMemberError) &&
                addMemberError.body?.code ===
                  "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"
                  ? Effect.void
                  : Effect.fail(addMemberError),
              ),
            );
          }
          return { id: organizationBySlug.value.id };
        })
      : Effect.fail(error),
  ),
);
```

Walking it against the table in §2:

- **No row**: `getOwnerOrganizationByUserId` → none → `createOrganization` succeeds. ✓
- **Org + Member both exist** (full retry of a completed run): `getOwnerOrganizationByUserId` → some → early return. ✓
- **Org exists, no Member for this user**: `getOwnerOrganizationByUserId` → none → `createOrganization` throws `ORGANIZATION_ALREADY_EXISTS` → look up by slug → no member for this user → call `addMember` with role `owner`. ✓

So the logic **is** correct for a single-user-per-slug world. That's why it reads as defensive and branchy — it is reconstructing transactional semantics better-auth does not provide.

## 4. The latent bug: slug is not user-unique

`getUserProvisioningOrganization` (`src/lib/UserProvisioning.ts:12`):

```ts
name: `${email.charAt(0).toUpperCase() + email.slice(1)}'s Organization`,
slug: email.replaceAll(/[^a-z0-9]/g, "-").toLowerCase(),
```

The slug is a lossy projection of email: `a.b@x.com` and `a-b@x.com` both collapse to `a-b-x-com`. Nothing in `Domain` or `Repository` joins org ↔ user by slug — we look up owners via `Member.userId + role='owner'` (`Repository.ts:64`). So the slug serves exactly one purpose today: it is the **idempotency key** the fallback branch uses to find the org that already exists.

Put user A and user B through the workflow with slug-colliding emails:

1. A: `getOwnerOrganizationByUserId(A)` → none → `createOrganization` → creates org O(A), member (A, O(A), owner). ✓
2. B: `getOwnerOrganizationByUserId(B)` → none → `createOrganization` → slug check trips → `ORGANIZATION_ALREADY_EXISTS` → `getOrganizationBySlug(slug)` → returns **O(A)** → `getMemberByUserAndOrg(B, O(A))` → none → `addMember(B, O(A), 'owner')` → **B is now owner of A's org**.

This is the scariest property of the current design. It only kicks in if two distinct users normalize to the same slug, which is rare but fully reachable by user input. The slug isn't used anywhere else, so there is no other safety net.

### Related name concern

The organization `name` is also email-derived and will be similarly duplicated across users — less dangerous, just confusing in the UI. Not in scope for this research.

## 5. Can the endpoint take a pre-chosen `id`?

`baseOrganizationSchema` (`crud-org.ts:22`–`55`) exposes `name`, `slug`, `userId`, `logo`, `metadata`, `keepCurrentActiveOrganization`. **There is no `id` field**, so the API does not let us inject a stable org id (e.g., derived from `userId`) as the idempotency key. The adapter itself uses `forceAllowId: true` (`adapter.ts:71`) so it *could* accept one, but the HTTP endpoint drops anything not in the schema. Pre-picking the id would require bypassing the endpoint and talking to the adapter directly — not worth it.

## 6. Plan

### A. Rename

- `ensureOrganization` → `createOrganization`.
- step `ensure-organization` → `create-organization`.
- Fallback branch stays — it correctly handles the "org created, member not" window that better-auth leaves open (§2, §3).

### B. Make the slug user-unique

Change `getUserProvisioningOrganization` so `slug` is derived from `userId` instead of `email`. Then:

- `ORGANIZATION_ALREADY_EXISTS` means **this user's** own org already exists → fallback is safe.
- `getOrganizationBySlug` in the fallback cannot return a different user's org.
- No cross-user capture possible.
- Display `name` stays email-derived — it's only cosmetic and the app doesn't key on it.

Slug is not read anywhere else in `src/`, so switching its shape is free.

## 7. Resolved questions

- **Slug shape:** slug is not used outside this workflow — safe to make it `userId`-derived.
- **Name backfill:** no. User may rename later; don't overwrite.
- **`addMember` fallback error handling:** leave as-is. Re-raising anything other than `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` lets Workflow retry the step, which is the right default.
