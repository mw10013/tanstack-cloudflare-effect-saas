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

Use two runner constructors, not one overloaded runner.

### Base runner for non-HTTP entrypoints

Keep a request-free runner for `scheduled()` and any future non-request code:

```ts
const makeRunEffect = (env: Env) => {
  // existing env + app + logger layers
};
```

### Request runner for HTTP fetch path

Add a small wrapper that merges a request layer into the final runtime actually provided to each effect:

```ts
const makeRequestRunEffect = (env: Env, request: Request) => {
  const runEffect = makeRunEffect(env);
  const requestLayer = Layer.succeedServices(ServiceMap.make(Request, request));

  return <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Layer.Success<typeof RequestLayer | typeof AppLayer>
    >,
  ) => runEffect(effect.pipe(Effect.provide(requestLayer)));
};
```

The exact type aliases need to match the actual `appLayer` shape in `src/worker.ts`, but the key design point is this:

- provide `Request` in the final effect execution path
- do not only add it to `envLayer` unless `envLayer` is also part of the final provided runtime

This matters because today `envLayer` is only an intermediate construction layer in `src/worker.ts:56-69`; `runtimeLayer` is what `Effect.provide` receives in `src/worker.ts:86-88`.

## Worker Changes

`fetch()` becomes request-aware, `scheduled()` stays request-free.

```ts
async fetch(request, env, _ctx) {
  const runEffect = makeRequestRunEffect(env, request);
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
  const runEffect = makeRunEffect(env);
  // unchanged
}
```

## Scheduled Path

This is the main design constraint for the request migration.

`src/worker.ts:177` currently does:

```ts
async scheduled(scheduledEvent, env, _ctx) {
  const runEffect = makeRunEffect(env);
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

## Implementation Checklist

1. Add `src/lib/Request.ts`
2. Add `makeRequestRunEffect(env, request)` in `src/worker.ts`
3. Keep `makeRunEffect(env)` for `scheduled()`
4. Remove `request` from `ServerContext`
5. Migrate `createServerFn` handlers and `signOutServerFn` to `yield* Request`
6. Optionally migrate `api/auth/$` inner effects to `yield* Request`
7. Run `pnpm typecheck` and `pnpm lint`

## Recommendation

This change is sound and implementation-ready.

Why this version is lower risk than the earlier combined research:

- no lazy fetch behavior to reason about
- no memoization dependency across multiple `runEffect` calls
- no semantic change to session fetching
- `scheduled()` has a clear separation point

The only hard requirement is to ensure the request layer is provided in the final runtime path, not only in an intermediate construction layer.

## Runner Naming

Given the scheduled constraint, keep two runners.

The remaining question is naming.

### Options

- `makeRunEffect` + `makeRequestRunEffect`
- `makeRequestRunEffect` + `makeScheduledRunEffect`
- `makeFetchRunEffect` + `makeScheduledRunEffect`
- `makeHttpRunEffect` + `makeScheduledRunEffect`

### Trade-offs

- `makeRunEffect` + `makeRequestRunEffect`
  - `pro`: smallest diff from `src/worker.ts:54` and current call sites
  - `pro`: treats request-scoped execution as the special case layered on top
  - `con`: the base name is a little vague once there are now two concrete execution modes
- `makeRequestRunEffect` + `makeScheduledRunEffect`
  - `pro`: symmetric, explicit, and maps to the real runtime distinction: request-backed vs scheduled
  - `pro`: easiest to understand when scanning `src/worker.ts:137` and `src/worker.ts:177`
  - `con`: slightly longer; `Request` names the available service, not the outer platform entrypoint
- `makeFetchRunEffect` + `makeScheduledRunEffect`
  - `pro`: mirrors Cloudflare handler names exactly
  - `con`: `fetch` describes the entrypoint, not the semantic capability the effect gains
  - `con`: a reader may read it as "does network fetches" rather than "runs inside the HTTP request path"
- `makeHttpRunEffect` + `makeScheduledRunEffect`
  - `pro`: semantically closer than `fetch`; describes protocol/runtime shape
  - `con`: less grounded in actual app terminology than `Request`
  - `con`: slightly more abstract than the service being introduced

### Recommendation

Recommend `makeRequestRunEffect` + `makeScheduledRunEffect`.

Why:

- names the actual boundary that matters to the Effect runtime: whether `Request` is available
- keeps the pair symmetric, so neither path reads as the "default" by accident
- avoids the ambiguity of `fetch`, which is a worker handler name but not the capability being modeled
- avoids the vagueness of a single generic `makeRunEffect` once there are two distinct runtimes

If minimizing churn matters more than naming symmetry, `makeRunEffect` + `makeRequestRunEffect` is still reasonable. But for long-term readability, the explicit pair is better.

Ok, one makeRunEffect looks like not a good idea. Remove all discussion about one makeRunEffect. We are going with two. We need naming that reflects where the effect runs. Perhaps fetch vs scheduled? Characterizing it as fetch is a little confusing though since overloaded. Scheduled is very clear and not overloaded. These both run in a workers function so while it's tempting to use workers instead of fetch, it's not really accurate. Thoughts, trade-offs, recommendation?
