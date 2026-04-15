# Better Auth ↔ Domain branded IDs: decode smell at the boundary

## The smell

Repeated `Schema.decodeUnknownEffect` / `Schema.decodeUnknownSync` calls whose only job is to coerce a `string` returned by Better Auth into a branded `Domain.User["id"]` / `Domain.Organization["id"]`. The decode doesn't add runtime safety — the value already lives in D1 as that brand — it just appeases TypeScript.

## Known sites

`src/worker.ts:147-148` — `authorizeAgentRequest`:

```ts
const d1Member = yield* repository.getMemberByUserAndOrg({
  userId: yield* Schema.decodeUnknownEffect(Domain.User.fields.id)(session.value.user.id),
  organizationId: yield* Schema.decodeUnknownEffect(Domain.Organization.fields.id)(activeOrganizationId),
});
```

`src/lib/Auth.ts:156` — `databaseHooks.session.create.before`:

```ts
yield* repository.getOwnerOrganizationByUserId(
  Schema.decodeUnknownSync(Domain.User.fields.id)(session.userId),
);
```

`src/lib/Auth.ts:287-290` — `authorizeReference` in the Stripe plugin:

```ts
const member = yield* repository.getMemberByUserAndOrg({
  userId: Schema.decodeUnknownSync(Domain.User.fields.id)(user.id),
  organizationId: Schema.decodeUnknownSync(Domain.Organization.fields.id)(referenceId),
});
```

All three patterns are the same shape: Better Auth hands back a plain `string`, the Repository signature demands a brand, the decode bridges the gap.

## Root cause

`src/lib/Domain.ts:88-119` declares:

```ts
export const User = Schema.Struct({
  id: Schema.NonEmptyString.pipe(Schema.brand("UserId")),
  ...
});
export const Session = Schema.Struct({
  ...
  userId: Schema.NonEmptyString.pipe(Schema.brand("UserId")),
  activeOrganizationId: Schema.NullOr(
    Schema.NonEmptyString.pipe(Schema.brand("OrganizationId")),
  ),
});
```

Repository functions (`src/lib/Repository.ts`) consume these branded types:

```ts
getMemberByUserAndOrg(function* ({
  userId,
  organizationId,
}: {
  userId: Domain.User["id"];
  organizationId: Domain.Organization["id"];
}) { ... })
```

Better Auth's `auth.api.getSession(...)` returns the raw row shape inferred from its internal schema. Its `User.id` / `Session.userId` / `Session.activeOrganizationId` surface as plain `string` (no brand), so the call sites above have three options at the boundary:

1. Decode through Effect Schema (current).
2. Cast (`as Domain.User["id"]`).
3. Retype the Better Auth surface so branded types flow through directly.

## Why decoding here is wasted work

- The D1 rows that Better Auth reads already satisfy the brand — rows were written through the same `Domain.User` / `Domain.Session` schemas during earlier flows (provisioning, session creation). The runtime check adds no invariant.
- `Schema.NonEmptyString` is the only non-trivial refinement, and Better Auth won't hand us an empty string for these IDs (they are PK columns).
- Each decode allocates a fresh parse result and, in the Effect variant, yields through the Effect runtime just to surface a branded type. It's ceremony tax.

What the decode *does* buy: if a future schema change tightens the brand (e.g. adds a UUID pattern), the decode would re-validate. That's a vanishingly small benefit for the cost, and the re-validation belongs at the D1 read boundary, not at every Better Auth callsite.

## Fix options

### Option 1 — Local cast at the boundary

```ts
const d1Member = yield* repository.getMemberByUserAndOrg({
  userId: session.value.user.id as Domain.User["id"],
  organizationId: activeOrganizationId as Domain.Organization["id"],
});
```

- **Pros**: one line, zero runtime cost, obviously the current behavior.
- **Cons**: `as` casts bypass type-checking — if the shape ever drifts (e.g. Better Auth returns a `UserId` object), the cast silently compiles. Spreading casts through every callsite is the same ceremony in a different font.

### Option 2 — Typed session accessor in `Auth` service

Wrap `auth.api.getSession` so it returns `Domain.Session` + `Domain.User` shapes directly, doing the decode *once* inside the service:

```ts
// src/lib/Auth.ts
const getSession = Effect.fn("auth.getSession")(function* (headers: Headers) {
  const raw = yield* Effect.tryPromise(() => auth.api.getSession({ headers }));
  if (!raw) return Option.none<{
    session: Domain.Session;
    user: Domain.User;
  }>();
  const session = yield* Schema.decodeUnknownEffect(Domain.Session)(raw.session);
  const user = yield* Schema.decodeUnknownEffect(Domain.User)(raw.user);
  return Option.some({ session, user });
});
```

Then `worker.ts` simplifies to:

```ts
const d1Member = yield* repository.getMemberByUserAndOrg({
  userId: session.value.user.id,                         // already Domain.User["id"]
  organizationId: activeOrganizationId,                  // already Domain.Organization["id"]
});
```

- **Pros**: decode runs exactly once per request; callsites stay clean; the domain type is the *only* shape that ever escapes the `Auth` service, enforcing the boundary.
- **Cons**: one decode per `getSession` call (cheap — only runs when a handler asks for the session). Bigger payoff is that the Better Auth row shape (with `banExpires` as ISO string, `emailVerified` as int, etc.) needs the `Domain.*` schemas to already handle those transforms. Quick scan of `Domain.ts:88-119` shows `isoDatetimeToDate` and `intToBoolean` in use, so this should just work.
- **Risk**: if Better Auth ever returns a field the domain schema doesn't model (e.g. a new plugin-added column), the decode fails. Easy to diagnose and fix in one place.

### Option 3 — Module augmentation of Better Auth types

Better Auth types `User.id`, `Session.userId` etc. as plain `string`. You could augment their module declaration to re-brand:

```ts
declare module "better-auth" {
  interface User { id: Domain.User["id"] }
  interface Session {
    userId: Domain.User["id"];
    activeOrganizationId: Domain.Organization["id"] | null;
  }
}
```

- **Pros**: no runtime cost whatsoever; TypeScript infers brands straight through.
- **Cons**: lies to the type system — the values are still raw `string` at runtime; a brand mismatch never surfaces. If Better Auth changes its public types, the augmentation can silently shadow or conflict. Also, the `better-auth` package's type layout (nested `auth.api` methods, plugin extension types) makes the exact augmentation target non-obvious — brittle.

### Option 4 — Drop brands for IDs that come from Better Auth

Accept that `UserId` / `OrganizationId` are owned by Better Auth's D1 schema, not ours, and stop branding them. Repository signatures change to `string`. Brands survive for IDs the app mints itself (e.g. `Invoice["id"]`).

- **Pros**: eliminates the entire category of boundary friction.
- **Cons**: loses the type-level protection against accidentally passing an `OrganizationId` where a `UserId` is expected — a real bug the brand prevents. The current design paid for that protection; removing it is regression.

## Recommendation

**Option 2** (typed `getSession` in the `Auth` service) is the right structural fix. It:

- Pays the decode cost exactly once per session-resolving callsite instead of at every use of the resolved fields.
- Makes the `Auth` service the sole producer of branded domain types, so downstream code (repositories, worker auth gate, Stripe `authorizeReference`) never sees raw strings.
- Keeps brands, keeps runtime validation, removes scattered ceremony.

As a tactical tidy for hot paths where the session is already in hand (e.g. Stripe plugin callbacks that receive `user` from Better Auth's callback signature, not from `getSession`), Option 1 casts are acceptable — the callback signature is fixed by Better Auth and wrapping it would be disproportionate.

## Out of scope

- Rebranding `src/lib/Domain.ts` schemas to drop `NonEmptyString` in favor of `UUID` / similar — orthogonal concern.
- Reworking `authorizeReference` to avoid re-resolving membership (it's a Better Auth plugin contract, not something we can bypass).
- Broader question of whether Better Auth's row shapes should feed an intermediate "external" schema before being decoded to `Domain.*` (overkill given current scope).
