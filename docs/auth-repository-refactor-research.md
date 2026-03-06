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
├── Stripe.layer ← KV, Repository (if Stripe needs domain objects later)
└── Auth.layer ← KV, Stripe, Repository
```

Auth.layer needs `CloudflareEnv` (for the raw `D1Database` binding to pass to better-auth's `database` option) but does **not** need the `D1` Effect service. Currently Auth.make includes D1 in `Effect.services<D1 | KV | Stripe>()` and the hooks do `yield* D1` inside `runEffect` — but after this refactor, all D1 access goes through Repository. Auth's direct D1 service dependency can be dropped.

**No circular dependency risk.** Repository depends only on D1. Auth and Stripe both depend on Repository — this is a clean DAG.

worker.ts change: `stripeLayer` already merges `repositoryLayer` into its provider (L65). Auth.layer is provided with `stripeLayer` (L66), so Repository is already transitively available. **No worker.ts changes needed** — Repository is already in Auth's dependency graph via Stripe's layer.

### Auth.ts Changes

The hooks currently do `yield* D1` inside `runEffect` to access D1 as a service dependency — not captured in a closure. The same pattern applies to Repository: hooks will do `yield* Repository` inside `runEffect`.

`runEffect` type signature needs to widen from `D1 | KV | Stripe` to `KV | Stripe | Repository` (D1 dropped since all D1 access now goes through Repository):

```ts
// Auth.make:
const services = yield* Effect.services<KV | Stripe | Repository>();
const runEffectBase = Effect.runPromiseWith(services);
const runEffect = <A, E>(effect: Effect.Effect<A, E, KV | Stripe | Repository>) =>
  runEffectBase(effect.pipe(Effect.annotateLogs({ service: "Auth" })));
```

`CreateBetterAuthOptions.runEffect` type updates to match:

```ts
runEffect: <A, E>(
  effect: Effect.Effect<A, E, KV | Stripe | Repository>,
) => Promise<A>;
```

## Auth.ts Refactored Hooks (Sketch)

### authorizeReference

```ts
authorizeReference: ({ user, referenceId, action }) =>
  runEffect(
    Effect.gen(function* () {
      const repository = yield* Repository;
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

### databaseHookSessionCreateBefore

```ts
databaseHookSessionCreateBefore: (session) =>
  runEffect(
    Effect.gen(function* () {
      const repository = yield* Repository;
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
const repository = yield* Repository;
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
| Auth D1 dep | ✅ Dropped — Auth no longer needs `D1` service; `runEffect` type becomes `KV \| Stripe \| Repository` |
| Access pattern | ✅ `yield* Repository` inside `runEffect` — consistent with existing `yield* D1` pattern |
| New Domain schema | `Member` struct needed in Domain.ts |
| New Repository fns | `getMemberByUserAndOrg`, `getOwnerOrganizationByUserId`, `setActiveOrganizationForUser` |
