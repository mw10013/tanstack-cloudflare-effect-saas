# Organization Agent Stub Helpers Research

## Scope

Investigate current usage and necessity of:

- `getOrganizationAgentStubForSession` (note: request mentioned `ForSeesion`, current symbol is `ForSession`)
- `getOrganizationAgentStubTrusted`

## Current State (Implemented)

- `getOrganizationAgentStubTrusted` is removed from `src/lib/Q.ts`.
- trusted/server flows now inline stub creation with `idFromName` + `get`.
- `getOrganizationAgentStubForSession` moved to `src/organization-agent.ts:122`.

Current session helper definition:

```ts
export const getOrganizationAgentStubForSession = Effect.fn(
  "getOrganizationAgentStubForSession",
)(function* (organizationId: Domain.Organization["id"]) {
  const request = yield* AppRequest;
  const auth = yield* Auth;
  yield* auth.getSession(request.headers).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.filterOrFail(
      (s) => s.session.activeOrganizationId === organizationId,
      () => new Cause.NoSuchElementError(),
    ),
  );
  const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
  const id = ORGANIZATION_AGENT.idFromName(organizationId);
  return ORGANIZATION_AGENT.get(id);
});
```

Current trusted inline shape (example in `src/routes/app.$organizationId.index.tsx:99`):

```ts
const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
const id = ORGANIZATION_AGENT.idFromName(invitation.value.organizationId);
const stub = ORGANIZATION_AGENT.get(id);
```

## Definitions (Before Refactor)

### `getOrganizationAgentStubForSession`

Defined in `src/lib/Invoices.ts:10`:

```ts
export const getOrganizationAgentStubForSession = Effect.fn(
  "getOrganizationAgentStubForSession",
)(function* (organizationId: Organization["id"]) {
  const request = yield* AppRequest;
  const auth = yield* Auth;
  yield* auth.getSession(request.headers).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.filterOrFail(
      (s) => s.session.activeOrganizationId === organizationId,
      () => new Cause.NoSuchElementError(),
    ),
  );
  const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
  const id = ORGANIZATION_AGENT.idFromName(organizationId);
  return ORGANIZATION_AGENT.get(id);
});
```

Key behavior:

- validates caller session is active for the target org
- returns named DO stub (`idFromName`)

### `getOrganizationAgentStubTrusted`

Before refactor it was defined in `src/lib/Q.ts:55`:

```ts
export const getOrganizationAgentStubTrusted = Effect.fn("getOrganizationAgentStubTrusted")(
  function* (organizationId: Domain.Organization["id"]) {
    const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
    const id = ORGANIZATION_AGENT.idFromName(organizationId);
    return ORGANIZATION_AGENT.get(id);
  },
);
```

Key behavior:

- no session/auth check
- returns named DO stub (`idFromName`)

Current status: deleted and inlined at trusted call sites.

## Usage Map

### `getOrganizationAgentStubForSession`

Used in:

- `src/lib/Invoices.ts:30` (`getInvoicesWithViewUrl` -> `stub.getInvoices()`)
- `src/lib/Invoices.ts:82` (`getInvoice` -> `stub.getInvoice(...)`)
- `src/routes/app.$organizationId.invoices.$invoiceId.tsx:49` (invoice detail loader calls `stub.getInvoice(...)` directly)

Interpretation:

- this helper is tied to server loaders that run in request/session context
- the auth check here is the main value, not the stub construction lines

## Caller Session Audit (`getOrganizationAgentStubForSession`)

Question: are callers already checking session anyway?

Short answer: yes at route level, but not always at local function level.

Parent route `src/routes/app.$organizationId.tsx:65` has a `beforeLoad` server fn with:

```ts
const sessionUser = yield* auth.getSession(request.headers).pipe(
  Effect.flatMap(Effect.fromOption),
  Effect.filterOrFail(
    (s) => s.session.activeOrganizationId === organizationId,
    () => new Cause.NoSuchElementError(),
  ),
);
```

This parent guard runs for nested `/app/$organizationId/*` routes, including invoice routes.

But invoice loaders themselves do not perform their own session check before DO read; they rely on helper/parent:

```ts
const invoices = yield* getInvoicesWithViewUrl(organizationId);
const invoice = yield* getInvoice(organizationId, selectedInvoice.id);
```

and:

```ts
const stub = yield* getOrganizationAgentStubForSession(organizationId);
const invoice = yield* Effect.tryPromise(() => stub.getInvoice({ invoiceId }));
```

Implication:

- with current routing shape, there is overlap (parent `beforeLoad` + helper check)
- helper still acts as local defense-in-depth and protects future reuse of invoice helpers outside guarded routes

### `getOrganizationAgentStubTrusted`

Current trusted call sites now inline stub creation in:

- `src/lib/Q.ts:68` (`processInvoiceUpload` -> `stub.onInvoiceUpload(...)`)
- `src/lib/Q.ts:82` (`processFinalizeMembershipSync` -> `stub.onFinalizeMembershipSync(...)`)
- `src/routes/app.$organizationId.index.tsx:99` (`acceptInvitation` -> `stub.syncMembership(...)`)
- `src/routes/app.$organizationId.members.tsx:123` (`removeMember` eager sync)
- `src/routes/app.$organizationId.members.tsx:162` (`leaveOrganization` eager sync)
- `src/routes/app.$organizationId.members.tsx:200` (`updateMemberRole` eager sync)

Related direct stub creation (not using helper):

- `src/user-provisioning-workflow.ts:142` builds stub inline and calls `stub.syncMembership(...)`

## Why `idFromName` Matters

Organization agent logic reads org id from Durable Object name:

```ts
const organizationId = yield* Schema.decodeUnknownEffect(
  Domain.Organization.fields.id,
)(this.ctx.id.name);
```

Seen in:

- `src/organization-agent.ts:290`
- `src/organization-agent.ts:360`
- `src/organization-agent.ts:594`

So both helpers enforce the same important invariant: named stub lookup by organization id.

## Are They Necessary?

### `getOrganizationAgentStubForSession`

Short answer: mostly yes.

- The helper centralizes a non-trivial security check (`activeOrganizationId === organizationId`) before DO access.
- Replacing it with inline code would duplicate session/auth validation logic across loaders.
- If removed, equivalent guard must still exist somewhere else at every session-scoped call site.

### `getOrganizationAgentStubTrusted`

Short answer: functionally optional, semantically useful.

- It is a one-liner around stub creation, so runtime value is small.
- It does provide boundary intent in call sites: this path is trusted/internal (queue/server sync), not user-scoped session validation.
- It keeps the `idFromName` requirement from being retyped repeatedly.

Practical tradeoff:

- removing it is safe if all callers inline the same two lines correctly
- keeping it improves readability and reduces boundary mistakes

## "Defined In Weird Places" Assessment

Before refactor, placement was mixed:

- `getOrganizationAgentStubForSession` in `src/lib/Invoices.ts` (invoice-focused module)
- `getOrganizationAgentStubTrusted` in `src/lib/Q.ts` (queue module), but imported by non-queue routes

After refactor, session helper now lives in `src/organization-agent.ts` and trusted helper no longer exists.

## Recommendation

1. Keep `getOrganizationAgentStubForSession` because it carries real auth logic.
2. Keep trusted calls inlined unless duplication starts hurting readability.
3. If future dedupe is needed, use a neutral `getOrganizationAgentStubByName` helper in a non-queue module.

Net: your instinct is solid — inline trusted helper is low risk; session helper is the one with real security value.

## Direction From Discussion

Proposed direction now:

1. Inline `getOrganizationAgentStubTrusted` at call sites.
2. Keep session-scoped helper logic.
3. Move session helper to `src/organization-agent.ts` for discoverability.

## Notes On Moving Session Helper To `organization-agent.ts`

This is workable, with one caveat.

Why workable:

- `src/organization-agent.ts` already hosts cross-boundary organization-agent helpers used by worker/routing code (`organizationAgentAuthHeaders`, `extractAgentInstanceName`).
- centralizing the session-scoped stub helper there can make "agent access rules" easier to find.

Caveat (dependency direction):

- `src/organization-agent.ts` currently imports from `src/lib/Q.ts` (`MembershipSyncChange` type and `enqueue`).
- If `src/lib/Q.ts` later imports session helper back from `src/organization-agent.ts`, that would create a cycle (`organization-agent -> Q -> organization-agent`).
- Inlining trusted stub creation (instead of helper import) avoids this cycle risk.

Practical guardrail:

- keep queue code (`src/lib/Q.ts`) free of imports from `src/organization-agent.ts` except where absolutely necessary
- keep trusted stub creation local in queue/server flows

## Refactor Shape (No Behavior Change)

If executed, expected shape:

- remove `getOrganizationAgentStubTrusted` export from `src/lib/Q.ts`
- replace trusted helper call sites with:

```ts
const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
const id = ORGANIZATION_AGENT.idFromName(organizationId);
const stub = ORGANIZATION_AGENT.get(id);
```

- move `getOrganizationAgentStubForSession` from `src/lib/Invoices.ts` to `src/organization-agent.ts`
- update imports in `src/lib/Invoices.ts` and `src/routes/app.$organizationId.invoices.$invoiceId.tsx`

Security semantics remain the same as long as this check remains intact:

```ts
(s) => s.session.activeOrganizationId === organizationId
```
