# Auth → Repository Refactor Research

## Problem

`Auth.ts` has 3 direct D1 queries that work with domain objects (Member, Organization, Session) at too low a level. These should go through `Repository` to work with proper domain objects instead of raw SQL primitives like `select 1`.

## Direct D1 Queries in Auth.ts

### 1. `authorizeReference` (L253-259)

```sql
select 1 from Member where userId = ? and organizationId = ? and role = 'owner'
```

Returns `Boolean` via `select 1`. Should return a `Member` domain object and let the caller derive the boolean.

### 2. `databaseHookSessionCreateBefore` (L439-446)

```sql
select id from Organization where id in (
  select organizationId from Member where userId = ? and role = 'owner'
)
```

Returns `{ id: string }`. Should return a full `Organization` domain object.

### 3. `databaseHookUserCreateAfter` (L417-423)

```sql
update Session set activeOrganizationId = ? where userId = ? and activeOrganizationId is null
```

Write operation on Session table. Could be a Repository function.

## Proposed Repository Functions

### `getMemberByUserAndOrg`

```ts
getMemberByUserAndOrg: Effect.fn("Repository.getMemberByUserAndOrg")(
  function* ({ userId, organizationId }: { userId: string; organizationId: string }) {
    const result = yield* d1.first(
      d1.prepare("select * from Member where userId = ?1 and organizationId = ?2")
        .bind(userId, organizationId),
    );
    return yield* Effect.fromNullishOr(result).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Domain.Member)),
      Effect.catchNoSuchElement,
    );
  }
)
```

Auth usage: `authorizeReference` calls this, checks `Option.isSome(member) && member.value.role === "owner"`.

### `getOwnerOrganizationByUserId`

```ts
getOwnerOrganizationByUserId: Effect.fn("Repository.getOwnerOrganizationByUserId")(
  function* (userId: string) {
    const result = yield* d1.first(
      d1.prepare(
        "select o.* from Organization o where o.id in (select organizationId from Member where userId = ?1 and role = 'owner')"
      ).bind(userId),
    );
    return yield* Effect.fromNullishOr(result).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Domain.Organization)),
      Effect.catchNoSuchElement,
    );
  }
)
```

Auth usage: `databaseHookSessionCreateBefore` calls this, uses `Option.map(org => org.id).pipe(Option.getOrUndefined)` for `activeOrganizationId`.

### `setActiveOrganizationForUser`

```ts
setActiveOrganizationForUser: Effect.fn("Repository.setActiveOrganizationForUser")(
  function* ({ organizationId, userId }: { organizationId: string; userId: string }) {
    return yield* d1.run(
      d1.prepare(
        "update Session set activeOrganizationId = ?1 where userId = ?2 and activeOrganizationId is null"
      ).bind(organizationId, userId),
    );
  }
)
```

## Domain Schema Addition

`Member` schema needed in `Domain.ts`:

```ts
export const Member = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  organizationId: Schema.String,
  role: MemberRole,
  createdAt: isoDatetimeToDate,
});
export type Member = typeof Member.Type;
```

Table definition (`migrations/0001_init.sql:86-92`):
```sql
create table Member (
  id text primary key,
  userId text not null references User (id) on delete cascade,
  organizationId text not null references Organization (id) on delete cascade,
  role text not null references MemberRole (memberRoleId),
  createdAt text not null default (datetime('now'))
);
```

## Layer Graph

### Current

```
envLayer
├── D1.layer
├── KV.layer
├── Repository.layer ← D1
├── Stripe.layer ← D1, KV (no Repository dependency)
└── Auth.layer ← D1, KV, Stripe (uses D1 directly for domain queries)
```

worker.ts L61-66:
```ts
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const kvLayer = Layer.provideMerge(KV.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
const d1KvLayer = Layer.merge(d1Layer, kvLayer);
const stripeLayer = Layer.provideMerge(Stripe.layer, Layer.merge(repositoryLayer, d1KvLayer));
const appLayer = Layer.provideMerge(Auth.layer, stripeLayer);
```

### After Refactor

```
envLayer
├── D1.layer
├── KV.layer
├── Repository.layer ← D1
├── Stripe.layer ← D1, KV, Repository (if Stripe needs domain objects later)
└── Auth.layer ← D1, KV, Stripe, Repository
```

Why would D1 need to be a dependency of Auth.layer? It would need CloudflareEnv to get the D1 binding to pass to better-auth, but I don't think it needs the D1 serverice, right?

**No circular dependency risk.** Repository depends only on D1. Auth and Stripe both depend on Repository — this is a clean DAG.

worker.ts change: `stripeLayer` already merges `repositoryLayer` into its provider (L65). Auth.layer is provided with `stripeLayer` (L66), so Repository is already transitively available. **No worker.ts changes needed** — Repository is already in Auth's dependency graph via Stripe's layer.

### Auth.ts Changes

Auth.make needs `yield* Repository` alongside existing `yield* D1` usage:

```ts
// In Auth.make Effect.gen:
const repository = yield* Repository;
```

Why do we need to do this in make. I think the pattern we're using is we yield in the runEffect/

Then replace the 3 direct D1 calls with repository calls.

**Auth.ts `runEffect` type signature** currently requires `D1 | KV | Stripe`. Since Repository is available through the same layer graph, the `runEffect` calls from better-auth hooks can use Repository directly — it's already provided. The `CreateBetterAuthOptions` interface and `createBetterAuthOptions` function don't use `runEffect` for these queries (they use `d1` directly in the closures). The repository calls would go through `runEffect` which needs its type widened:

```ts
// CreateBetterAuthOptions.runEffect type:
runEffect: <A, E>(
  effect: Effect.Effect<A, E, D1 | KV | Stripe | Repository>,
) => Promise<A>;
```

Or better: since the repository instance is captured in the closure (like `d1` is currently), the hooks can call repository methods directly without going through `runEffect`.

Why do you think we should capture the repository instance in the closure? I'm not sure that is good pattern here. Also, we shouldn't need a dependency on D1 service here, right?

## Auth.ts Refactored Hooks (Sketch)

### authorizeReference

```ts
authorizeReference: ({ user, referenceId, action }) =>
  runEffect(
    Effect.gen(function* () {
      const member = yield* repository.getMemberByUserAndOrg({
        userId: user.id,
        organizationId: referenceId,
      });
      const result = Option.isSome(member) && member.value.role === "owner";
      yield* Effect.logDebug("stripe.subscription.authorizeReference", {
        userId: user.id, referenceId, action, authorized: result,
      });
      return result;
    }).pipe(
      Effect.annotateLogs({ ... }),
    ),
  ),
```

Wait — `repository.getMemberByUserAndOrg` returns `Effect<Option<Member>, ..., never>` (dependencies already resolved at service creation). But it's called inside `runEffect` which provides `D1 | KV | Stripe`. The repository methods are already bound to the D1 instance at construction time, so they have no unsatisfied dependencies — the Effect returned is `Effect<Option<Member>, ParseError, never>`. This works inside `runEffect` without needing to widen its type.

### databaseHookSessionCreateBefore

```ts
databaseHookSessionCreateBefore: (session) =>
  runEffect(
    Effect.gen(function* () {
      const org = yield* repository.getOwnerOrganizationByUserId(session.userId);
      return {
        data: {
          ...session,
          activeOrganizationId: Option.map(org, (o) => o.id).pipe(Option.getOrUndefined),
        },
      };
    }).pipe(
      Effect.annotateLogs({ ... }),
    ),
  ),
```

### databaseHookUserCreateAfter

```ts
// Inside the existing Effect.gen:
yield* repository.setActiveOrganizationForUser({
  organizationId: org.id,
  userId: user.id,
});
```

## Summary

| Aspect | Assessment |
|---|---|
| Domain alignment | ✅ Queries return domain objects (`Member`, `Organization`) instead of raw SQL primitives |
| Layer graph | ✅ No changes to worker.ts — Repository already in Auth's transitive deps |
| Circular deps | ✅ None — Repository → D1, Auth → Repository is a clean DAG |
| `runEffect` type | ✅ No change needed — repository methods are pre-bound, return `Effect<..., never>` |
| New Domain schema | `Member` struct needed in Domain.ts |
| New Repository fns | `getMemberByUserAndOrg`, `getOwnerOrganizationByUserId`, `setActiveOrganizationForUser` |
