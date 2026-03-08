# Magic Link Redirect Effect v4 Research

## Intent

Current route logic in `src/routes/magic-link.tsx:15`-`src/routes/magic-link.tsx:29` is trying to do 3 things:

1. Read the session after Better Auth completes the magic-link callback.
2. Redirect admins to `/admin` and users to `/app`.
3. Render an error payload for every other case.

The awkward part is that it collapses multiple cases into sentinel strings:

```ts
const role = pipe(
  session,
  Option.map(({ user }) => user.role ?? "unknown"),
  Option.getOrElse(() => "unknown"),
);

switch (role) {
  case "admin":
    return yield * Effect.die(redirect({ to: "/admin" }));
  case "user":
    return yield * Effect.die(redirect({ to: "/app" }));
  default:
    return { error: `Invalid role: ${role}` };
}
```

That loses intent:

- `None` session becomes `"unknown"`
- unexpected role becomes `"unknown"` if `role` is nullish
- error text says `Invalid role` even when there may be no session at all

## Existing Repo Signals

The rest of the app already treats auth as two separate concerns: session existence, then role check.

`src/routes/app.tsx:14`-`src/routes/app.tsx:19`:

```ts
const session = yield * auth.getSession(request.headers);
if (Option.isNone(session))
  return yield * Effect.die(redirect({ to: "/login" }));
if (session.value.user.role !== "user")
  return yield * Effect.die(redirect({ to: "/" }));
return { sessionUser: session.value.user };
```

`src/routes/admin.tsx:45`-`src/routes/admin.tsx:50` uses the same shape.

That matches the actual domain in `src/lib/Domain.ts:43`-`src/lib/Domain.ts:45`:

```ts
export const UserRoleValues = ["user", "admin"] as const;
export const UserRole = Schema.Literals(UserRoleValues);
```

So the domain is already closed over `"user" | "admin"`. `"unknown"` is not a real domain value.

## Effect v4 Findings

### `Effect.fromOption` is the direct Option -> failure bridge

`refs/effect4/packages/effect/src/Effect.ts:1915`-`refs/effect4/packages/effect/src/Effect.ts:1928`:

```ts
const effect1 = Effect.fromOption(some);
const effect2 = Effect.fromOption(none);

export const fromOption: <A>(
  option: Option<A>,
) => Effect<A, Cause.NoSuchElementError>;
```

This is the cleanest way to say: "session is required from here on; if missing, fail the effect instead of inventing a fake string."

### `filterOrFail` is the direct validation/narrowing tool

`refs/effect4/packages/effect/src/Effect.ts:4927`-`refs/effect4/packages/effect/src/Effect.ts:4947`:

```ts
const filtered = Effect.filterOrFail(
  program,
  (n) => n % 2 === 0,
  (n) => `Expected even number, got ${n}`,
);
```

This is the idiomatic way to keep validation in the effect channel instead of turning invalid states into fallback values.

### Avoid leaning on yieldable `Option` when you want an explicit error path

`refs/effect4/packages/effect/src/Option.ts:13` and `refs/effect4/packages/effect/src/Option.ts:37`:

```ts
- Option is yieldable in Effect.gen, producing the inner value or short-circuiting with NoSuchElementError
- When yielded in Effect.gen, a None becomes a NoSuchElementError defect
```

That is a useful warning. For this flow, `Effect.fromOption` is better than relying on `yield* someOption`, because it makes the missing-session branch explicit and recoverable.

### v4 error recovery naming

`refs/effect4/migration/error-handling.md:21`-`refs/effect4/migration/error-handling.md:40`:

```ts
// v4
const program = Effect.fail("error").pipe(
  Effect.catch((error) => Effect.succeed(`recovered: ${error}`)),
);
```

So if we convert `None` to a failure, `Effect.catch(...)` is the right v4 recovery point for producing `{ error }`.

## Recommended Shape

Best fit here: keep redirects as the terminal side effect, but model missing/invalid auth state as typed effect failures until the end.

Sketch:

```ts
const destination =
  yield *
  auth.getSession(request.headers).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.map(({ user }) => user.role),
    Effect.filterOrFail(
      (role): role is "admin" | "user" => role === "admin" || role === "user",
      () => new Error("Magic link sign-in could not be completed."),
    ),
    Effect.map((role) => (role === "admin" ? "/admin" : "/app")),
    Effect.catch(() =>
      Effect.succeed({
        error: "Magic link sign-in could not be completed.",
      } as const),
    ),
  );
```

Then branch once on the result shape and call `redirect` only for the success path.

## Why This Reads Better

- No ad hoc `"unknown"` values.
- No misleading `Invalid role` message when the real problem is missing session or failed callback state.
- Session absence and invalid state stay in the effect channel, where Effect v4 wants them.
- Role redirect logic stays aligned with the closed domain in `src/lib/Domain.ts:43`.

## Practical Recommendation

For this route, return one generic message for all non-success cases, something like:

```ts
{
  error: "Magic link sign-in could not be completed.";
}
```

That matches the real intent better than exposing a synthetic role error.

If we update the code next, I would use:

1. `Effect.fromOption` for missing session.
2. `Effect.filterOrFail` or a small role-to-destination mapping for role validation.
3. A single `Effect.catch` to collapse all non-redirect cases into one user-facing error payload.
