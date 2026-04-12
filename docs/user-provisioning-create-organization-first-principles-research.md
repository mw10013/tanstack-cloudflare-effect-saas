# User Provisioning `createOrganization` First-Principles Research

Scope: `src/user-provisioning-workflow.ts` org provisioning behavior.

## Better Auth behavior we should rely on

### `createOrganization` already enforces slug uniqueness

Source: `refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:149-157`

```ts
const existingOrganization = await adapter.findOrganizationBySlug(ctx.body.slug);
if (existingOrganization) {
  throw APIError.from(
    "BAD_REQUEST",
    ORGANIZATION_ERROR_CODES.ORGANIZATION_ALREADY_EXISTS,
  );
}
```

Implication: caller should treat `ORGANIZATION_ALREADY_EXISTS` as the idempotency signal for org creation.

### `createOrganization` does two writes (org, then member)

Source: `refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:179-213`

```ts
const organization = await adapter.createOrganization({ ... });
member = await adapter.createMember(data);
```

Implication: if failure happens between those writes, org can exist without owner membership. Retry logic must repair membership.

### `addMember` already detects duplicates

Source: `refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-members.ts:113-123`

```ts
const alreadyMember = await adapter.findMemberByEmail({ ... });
if (alreadyMember) {
  throw APIError.from(
    "BAD_REQUEST",
    ORGANIZATION_ERROR_CODES.USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION,
  );
}
```

Implication: caller should call `addMember` directly and treat `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` as idempotent success.

## First-principles workflow shape

1. Call `auth.api.createOrganization({ name, slug, userId })`.
2. If success, take returned `organizationId`.
3. If error code is `ORGANIZATION_ALREADY_EXISTS`, resolve `organizationId` by slug.
4. Call `auth.api.addMember({ userId, organizationId, role: "owner" })`.
5. If error code is `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION`, treat as success.

This is the minimum reliable flow. No pre-check read paths are required before API calls.

## Why pre-checks are unnecessary here

- Pre-checks duplicate server logic that Better Auth already executes.
- Pre-checks add branch complexity without improving correctness.
- Idempotency should be encoded at operation boundaries (handle known duplicate errors), not in speculative reads.

## Constraint to keep

The fallback in step 3 depends on deterministic slug derivation for the same user. Current implementation uses `slug: userId` in `src/lib/UserProvisioning.ts:32`, which satisfies that requirement.
