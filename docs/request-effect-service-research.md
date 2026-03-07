# Research: Moving `request` from TanStack `ServerContext` into an Effect service

## Current State

`src/worker.ts` builds a single per-entrypoint `runEffect` factory:

```ts
const makeRunEffect = (env: Env) => {
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );
  // ...
  const runtimeLayer = Layer.merge(appLayer, loggerLayer);
  return async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
  ) => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(effect, runtimeLayer),
    );
    // ...
  };
};
```

Request data is then passed through TanStack Start request context:

```ts
export interface ServerContext {
  env: Env;
  runEffect: ReturnType<typeof makeRunEffect>;
  request: Request;
  session?: AuthInstance["$Infer"]["Session"];
}
```

And injected in `fetch`:

```ts
const response = await serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
    request,
    session: session ?? undefined,
  },
});
```

## Usage Analysis

Current `ServerContext.request` usage is narrow and mechanical: handlers destructure `request`, then only use `request.headers` or `request.url` inside `runEffect`.

Representative call sites:

- `src/routes/login.tsx:50` -> `auth.api.signInMagicLink({ headers: request.headers, ... })`
- `src/routes/app.$organizationId.tsx:41` -> `auth.api.setActiveOrganization({ headers: request.headers, ... })`
- `src/routes/app.$organizationId.billing.tsx:261` -> `new URL(request.url).origin`
- `src/routes/admin.users.tsx:118` -> `auth.api.unbanUser({ headers: request.headers, ... })`
- `src/lib/Auth.ts:361` -> `auth.api.signOut({ headers: request.headers })`

One important boundary: not all request usage comes from `ServerContext`.

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

So the migration target is specifically: remove `request` from `ServerContext` and make request-dependent Effect code read from a service instead.

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

### `makeScheduledRunEffect`

Use a smaller runtime for scheduled execution:

```ts
const makeScheduledRunEffect = (env: Env) => {
  // env + logger + only scheduled dependencies
};
```

### `makeHttpRunEffect`

Use a separate HTTP runtime that adds request-scoped services and HTTP-only app services:

```ts
const makeHttpRunEffect = (env: Env, request: Request) => {
  // http runtime + Request layer
};
```

The exact type aliases need to match the actual `appLayer` shape in `src/worker.ts`, but the key design point is this:

- provide `Request` in the final effect execution path
- keep scheduled and HTTP dependency graphs separate

This matters because today `envLayer` is only an intermediate construction layer in `src/worker.ts:56-69`; `runtimeLayer` is what `Effect.provide` receives in `src/worker.ts:86-88`.

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

So the runners should not be modeled as "scheduled is the base runtime, HTTP adds more" if that forces scheduled code to pay for HTTP-oriented dependencies. Better shape:

1. extract shared infra layers: env/config + logger
2. build a scheduled runtime from shared infra + repository/d1
3. build an HTTP runtime from shared infra + full HTTP app layer + `Request`

This keeps the runtime names aligned to execution environment and also keeps dependency provisioning honest.

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

This is the main design constraint for the request migration.

`src/worker.ts:177` currently does:

```ts
async scheduled(scheduledEvent, env, _ctx) {
  const runEffect = makeScheduledRunEffect(env);
  // ... cleanup effects
}
```

There is no HTTP `Request` in this path. That means request service provisioning must satisfy one of these constraints:

1. `scheduled()` uses a runner that does not provide `Request`
2. `Request` is a `ServiceMap.Reference` with a default, and scheduled-safe effects never touch it
3. a synthetic request is fabricated for scheduled jobs

Recommendation: use option 1.

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

The allowlist middleware still receives TanStack's `request` argument directly. That middleware is outside the app Effect runtime and does not need to change.

We need research on the allowlist middleware. Because it uses request, does that mean we would need to keep stuffing the tanstack context with request? We are trying to stop that. I think we want the middleware to use runEffect or some such. Research this.


## Implementation Checklist

1. Add `src/lib/Request.ts`
2. Add `makeHttpRunEffect(env, request)` in `src/worker.ts`
3. Add `makeScheduledRunEffect(env)` in `src/worker.ts`
4. Factor shared infra layers so scheduled and HTTP runtimes can diverge cleanly
5. Remove `request` from `ServerContext`
6. Migrate `createServerFn` handlers and `signOutServerFn` to `yield* Request`
7. Optionally migrate `api/auth/$` inner effects to `yield* Request`
8. Run `pnpm typecheck` and `pnpm lint`
