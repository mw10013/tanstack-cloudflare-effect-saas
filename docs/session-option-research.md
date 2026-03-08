# Research: `Auth.getSession` should return `Option`; `Session` service likely not needed

## Recommendation

Preferred direction:

- change `src/lib/Auth.ts` `getSession` to return Effect v4 `Option`
- remove `src/lib/Session.ts`
- call `auth.getSession(request.headers)` directly at route/server-fn sites

This keeps optionality normalized at the Better Auth boundary and removes a service that currently adds little behavior.

## Current code

`src/lib/Auth.ts:47`-`src/lib/Auth.ts:50`:

```ts
const getSession = Effect.fn("auth.getSession")(function* (headers: Headers) {
  return yield* Effect.tryPromise(() => auth.api.getSession({ headers }));
});
```

`src/lib/Session.ts:5`-`src/lib/Session.ts:12`:

```ts
export class Session extends ServiceMap.Service<Session>()("Session", {
  make: Effect.gen(function* () {
    const request = yield* Request;
    const auth = yield* Auth;
    return (yield* auth.getSession(request.headers)) ?? undefined;
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

So today `Session` is just:

- read `Request`
- read `Auth`
- call `auth.getSession(request.headers)`
- normalize nullable to `undefined`

That is a very thin wrapper.

## Effect v4 grounding

Effect v4 models optional values with `Option`.

`refs/effect4/packages/effect/src/Option.ts:2`-`refs/effect4/packages/effect/src/Option.ts:4`:

```ts
 * The `Option` module provides a type-safe way to represent values that may or
 * may not exist. An `Option<A>` is either `Some<A>` (containing a value) or
 * `None` (representing absence).
```

The correct conversion from Better Auth's nullable result is `Option.fromNullishOr(...)`.

`refs/effect4/packages/effect/src/Option.ts:861`-`refs/effect4/packages/effect/src/Option.ts:863`:

```ts
export const fromNullishOr = <A>(a: A): Option<NonNullable<A>> =>
  a == null ? none() : some(a as NonNullable<A>);
```

For required-session flows, `Effect.fromOption(...)` is the matching conversion back into the effect channel.

`refs/effect4/packages/effect/src/Effect.ts:1915`-`refs/effect4/packages/effect/src/Effect.ts:1928`:

```ts
const effect1 = Effect.fromOption(some);
const effect2 = Effect.fromOption(none);
```

## Why `Auth.getSession` should return `Option`

This is the cleanest normalization boundary.

Recommended rewrite in `src/lib/Auth.ts`:

```ts
import * as Option from "effect/Option";

const getSession = Effect.fn("auth.getSession")(function* (headers: Headers) {
  return Option.fromNullishOr(
    yield* Effect.tryPromise(() => auth.api.getSession({ headers })),
  );
});
```

Why here:

- `Auth` is the direct wrapper around Better Auth
- nullable/optional translation happens once
- every downstream caller gets one consistent Effect-native shape
- avoids mixing `null | undefined` semantics in app code

## Why `Session` service is probably unnecessary

The current service does not add app-specific behavior beyond plumbing.

Trade-offs:

Keep `Session`

- pros: shorter call sites; one place to add future session-specific logic
- cons: duplicates `Auth.getSession`; hides dependency on request headers; extra service/layer with little value today

Remove `Session`

- pros: simpler mental model; fewer abstractions; one obvious auth/session API; no duplicate boundary
- cons: each caller needs `Request` and `Auth`, so a few more lines per route

Given the current implementation, removing it looks better.

## Recommended caller shape

Instead of:

```ts
const session = yield * Session;
```

Use:

```ts
const request = yield * Request;
const auth = yield * Auth;
const session = yield * auth.getSession(request.headers);
```

This makes the dependency explicit: session lookup depends on auth and request headers.

## Blast radius

Current direct `yield* Session` call sites:

- `src/routes/magic-link.tsx:10`
- `src/routes/app.tsx:10`
- `src/routes/app.index.tsx:10`
- `src/routes/app.$organizationId.tsx:63`
- `src/routes/app.$organizationId.index.tsx:49`
- `src/routes/admin.tsx:42`
- `src/routes/_mkt.pricing.tsx:51`
- `src/routes/_mkt.tsx:16`

Current direct `auth.getSession(...)` app call sites:

- `src/lib/Session.ts:9`

So if we:

- change `Auth.getSession` to return `Option`
- remove `Session`

then route blast radius is still those same 8 call sites. The difference is the route code now binds `Request` and `Auth` explicitly.

## What changes at callers

### Nullable checks become `Option` checks

Current pattern:

```ts
if (!session) {
  return yield * Effect.die(redirect({ to: "/login" }));
}
```

Becomes:

```ts
if (Option.isNone(session)) {
  return yield * Effect.die(redirect({ to: "/login" }));
}
```

### Required session becomes `Effect.fromOption(session)`

Current pattern:

```ts
const validSession = yield * Effect.fromNullishOr(session);
```

Becomes:

```ts
const validSession = yield * Effect.fromOption(session);
```

### Optional projection becomes `Option.match` / `Option.map`

Current pattern:

```ts
return { sessionUser: session?.user };
```

Becomes:

```ts
return {
  sessionUser: Option.match(session, {
    onNone: () => undefined,
    onSome: (value) => value.user,
  }),
};
```

## Tricky parts

- `yield* auth.getSession(request.headers)` still returns the `Option` value; no issue there
- do not accidentally `yield* session` later; `Option` is yieldable and `None` short-circuits

`refs/effect4/packages/effect/src/Option.ts:13` and `refs/effect4/packages/effect/src/Option.ts:37`:

```ts
 * - `Option` is yieldable in `Effect.gen`, producing the inner value or short-circuiting with `NoSuchElementError`
 * - When yielded in `Effect.gen`, a `None` becomes a `NoSuchElementError` defect
```

- use `Option.fromNullishOr(...)`, not `Option.some(...)`, around Better Auth results

`refs/effect4/packages/effect/src/Option.ts:33`:

```ts
 * - `Option.some(null)` is a valid `Some`; use {@link fromNullishOr} to treat `null`/`undefined` as `None`
```

## Recommendation summary

- normalize Better Auth session absence in `src/lib/Auth.ts`
- remove `src/lib/Session.ts` unless it gains real app-specific behavior
- update the 8 route call sites to use `Request` + `Auth` explicitly
- keep auth flow exactly the same; only change representation from nullable to `Option`

## Open question

- Should `src/lib/Auth.ts` also export a named session type alias for readability, or just rely on inference at use sites?

Rely on inference.
