# Research: Moving `request` from TanStack `ServerContext` into an Effect service

## Goal

Move request access out of TanStack `ServerContext` and into an Effect service, while keeping worker runtimes split by execution environment:

- `makeHttpRunEffect(env, request)` for the HTTP path
- `makeScheduledRunEffect(env)` for cron/background path

`ServerContext` should carry only request-context data that TanStack handlers/middleware actually need to pass around, not mechanical `Request` plumbing for inner Effect code.

## Usage Analysis

The old `ServerContext.request` usage was narrow and mechanical: handlers destructured `request`, then only used `request.headers` or `request.url` inside `runEffect`.

Representative call sites:

- `src/routes/login.tsx:50` -> `auth.api.signInMagicLink({ headers: request.headers, ... })`
- `src/routes/app.$organizationId.tsx:41` -> `auth.api.setActiveOrganization({ headers: request.headers, ... })`
- `src/routes/app.$organizationId.billing.tsx:261` -> `new URL(request.url).origin`
- `src/routes/admin.users.tsx:118` -> `auth.api.unbanUser({ headers: request.headers, ... })`
- `src/lib/Auth.ts:361` -> `auth.api.signOut({ headers: request.headers })`

One important boundary: not all request usage came from `ServerContext`.

`src/routes/api/auth/$.tsx` uses the route handler request argument directly:

```ts
GET: async ({ request, context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.handler(request);
    }),
  ),
```

So the migration target is: remove `request` from `ServerContext` and make request-dependent Effect code read from a service instead.

## Effect v4 Pattern

This matches Effect's service model.

Effect defines request-scoped HTTP request access as a service:

```ts
export const HttpServerRequest: ServiceMap.Service<
  HttpServerRequest,
  HttpServerRequest
> = ServiceMap.Service("effect/http/HttpServerRequest");
```

Source: `refs/effect4/packages/effect/src/unstable/http/HttpServerRequest.ts:74`

And the Node HTTP server injects the request by extending the current service map before running the handled effect:

```ts
const map = new Map(services.mapUnsafe);
map.set(
  HttpServerRequest.key,
  new ServerRequestImpl(nodeRequest, nodeResponse),
);
const fiber = Fiber.runIn(
  Effect.runForkWith(ServiceMap.makeUnsafe<any>(map))(handled),
  options.scope,
);
```

Source: `refs/effect4/packages/platform-node/src/NodeHttpServer.ts:161`

So a local app-level request service is idiomatic.

## Proposed Service

New file: `src/lib/Request.ts`

```ts
import { ServiceMap } from "effect";

export const Request = ServiceMap.Service<globalThis.Request>("app/Request");
```

`app/Request` follows Effect guidance to use a stable string identifier scoped to the app/package. See the naming guidance in `refs/effect4/LLMS.md:117`.

## Recommended Wiring

Use two runner constructors.

- `makeHttpRunEffect(env, request)`
  - builds only HTTP runtime
  - provides `Request`
  - adapts failures for TanStack Start
- `makeScheduledRunEffect(env)`
  - builds only scheduled runtime
  - does not provide `Request`
  - uses plain Effect promise execution

Key design points:

- provide `Request` in the final HTTP runtime path
- keep scheduled and HTTP dependency graphs separate
- do not build both runtimes in one helper per Worker invocation

## Runtime Split

`makeScheduledRunEffect` should be smaller than `makeHttpRunEffect`.

From `src/worker.ts:181-194`, the current scheduled path only does:

```ts
Effect.gen(function* () {
  const repository = yield* Repository;
  const deletedCount = yield* repository.deleteExpiredSessions();
  yield* Effect.logInfo("session.cleanup.expired", { deletedCount });
});
```

That means the current scheduled runtime needs:

- `Repository`
- `D1`
- env/config services
- logger services

It does not currently need:

- `Auth`
- `Stripe`
- `KV`
- `Request`

So the runners should not be modeled as "scheduled is the base runtime, HTTP adds more," and they should not be modeled as one helper that eagerly constructs both runtimes per invocation.

Final shape:

1. keep only small shared layer helpers where reuse is real
2. `makeScheduledRunEffect(env)` builds scheduled runtime from env/config + logger + repository/d1
3. `makeHttpRunEffect(env, request)` builds HTTP runtime from env/config + logger + full HTTP app layer + `Request`

This keeps the runtime names aligned to execution environment and also keeps dependency provisioning honest.

## Runner Error Semantics

The HTTP runner and scheduled runner should use different execution semantics.

### What Effect itself does

`Effect.runPromise` is implemented in terms of `runPromiseExit` plus `causeSquash`:

```ts
return runPromiseExit(effect, options).then((exit) => {
  if (exit._tag === "Failure") {
    throw causeSquash(exit.cause);
  }
  return exit.value;
});
```

Source: `refs/effect4/packages/effect/src/internal/effect.ts:5066-5079`

And `Cause.squash` is explicitly lossy:

```ts
 * This is the function used by `Effect.runPromise` and `Effect.runSync` to
 * decide what to throw. It is lossy
```

Source: `refs/effect4/packages/effect/src/Cause.ts:704-706`

So plain `Effect.runPromise` is the right default for scheduled work.

### What HTTP needs

HTTP is special because `src/worker.ts` is adapting Effect failures into TanStack Start expectations.

Current behavior that matters on the HTTP path:

- preserve TanStack control-flow objects thrown via `Effect.die`, especially `redirect()` and `notFound()`
- normalize non-`Error` / empty-message failures into a thrown `Error` with a usable `.message`

That is why the HTTP runner still needs `runPromiseExit`, cause inspection, `isRedirect`, `isNotFound`, and `Cause.pretty`-based normalization.

### What scheduled needs

The scheduled path is different:

- it does not run inside TanStack Start
- it does not need redirect/notFound preservation
- it does not need error-shape massaging for TanStack serialization

So the scheduled runner should be simpler and use plain `Effect.runPromise(Effect.provide(effect, scheduledRuntimeLayer))`. The current HTTP-specific exit/squash/pretty logic should not be shared with scheduled.

## Worker Changes

`fetch()` uses the HTTP runner, `scheduled()` uses the scheduled runner.

```ts
async fetch(request, env, _ctx) {
  const runEffect = makeHttpRunEffect(env, request);
  const response = await serverEntry.fetch(request, {
    context: {
      env,
      runEffect,
      session: session ?? undefined,
    },
  });
  return response;
}

async scheduled(scheduledEvent, env, _ctx) {
  const runEffect = makeScheduledRunEffect(env);
  // unchanged
}
```

## Scheduled Path

This is the main design constraint for the migration.

`src/worker.ts:177` currently does:

```ts
async scheduled(scheduledEvent, env, _ctx) {
  const runEffect = makeScheduledRunEffect(env);
  // ... cleanup effects
}
```

There is no HTTP `Request` in this path. So `scheduled()` should use a runner that does not provide `Request`.

Why:

- closest to the actual boundary: scheduled jobs are not HTTP requests
- avoids default/sentinel request values leaking into real code
- avoids widening the request type to `Request | undefined`
- preserves strong failure if some scheduled code accidentally reaches for `Request`

## Route Changes

Handlers stop destructuring `request` from context and instead read it inside the effect.

Before:

```ts
.handler(({ data, context: { runEffect, request } }) =>
  runEffect(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* Effect.tryPromise(() =>
        auth.api.unbanUser({ headers: request.headers, body: { userId: data.userId } }),
      );
    }),
  ),
);
```

After:

```ts
.handler(({ data, context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const request = yield* Request;
      const auth = yield* Auth;
      return yield* Effect.tryPromise(() =>
        auth.api.unbanUser({ headers: request.headers, body: { userId: data.userId } }),
      );
    }),
  ),
);
```

## `api/auth/$` Impact

`src/routes/api/auth/$.tsx` can also use the service for its inner Effect code:

```ts
GET: async ({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const request = yield* Request;
      const auth = yield* Auth;
      return yield* auth.handler(request);
    }),
  ),
```

## Allowlist Middleware

The allowlist middleware does not force `request` to stay in TanStack request context.

Current code in `src/routes/api/auth/$.tsx:6` is:

```ts
const authAllowlistMiddleware = createMiddleware().server(
  ({ next, request }) =>
    new Set([...]).has(`${request.method} ${new URL(request.url).pathname}`)
      ? next()
      : new Response("Not Found", { status: 404 }),
)
```

TanStack Start server middleware receives both `request` and `context` directly. Per docs:

```ts
createMiddleware().server(({ next, context, request }) => {
  return next();
});
```

And request context from the server entry point is "accessible throughout the server-side middleware chain. This includes ... server routes [and] server functions."

Implications:

- middleware `request` is a TanStack-provided server middleware argument, not `Register.server.requestContext.request`
- removing `request` from `ServerContext` does not remove middleware access to the incoming request
- if middleware ever needs app Effect services, it can use `context.runEffect` because request context is available in middleware too

Recommendation:

- remove `request` from `ServerContext`
- keep the allowlist middleware using its direct `request` argument
- only switch middleware to `context.runEffect(...)` if the middleware actually needs Effect services or shared app logic

Why keep the allowlist check direct:

- it is a cheap route gate on `request.method` and `request.url`
- wrapping it in `runEffect` adds ceremony without improving the boundary
- the migration goal is to remove mechanical request plumbing from app Effect code, not to ban TanStack middleware from using its own request API

## Implementation

Implemented:

1. added `src/lib/Request.ts`
2. added `makeHttpRunEffect(env, request)` in `src/worker.ts`
3. added `makeScheduledRunEffect(env)` in `src/worker.ts`
4. removed `request` from `ServerContext`
5. migrated `createServerFn` handlers and `signOutServerFn` to `yield* Request`
6. migrated `src/routes/api/auth/$.tsx` inner effects to `yield* Request`
7. ran `pnpm typecheck` and `pnpm lint`
