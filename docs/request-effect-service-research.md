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

## Single `makeRunEffect(env, request?)`

Yes, one constructor can work.

Sketch:

```ts
function makeRunEffect(
  env: Env,
): <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
) => Promise<A>;
function makeRunEffect(
  env: Env,
  request: Request,
): <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Layer.Success<typeof appLayer> | globalThis.Request
  >,
) => Promise<A>;
function makeRunEffect(env: Env, request?: Request) {
  const runtimeLayer = request
    ? Layer.merge(
        runtimeBaseLayer,
        Layer.succeedServices(ServiceMap.make(Request, request)),
      )
    : runtimeBaseLayer;

  return <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
}
```

This fits the current worker shape because `src/worker.ts:157` and `src/worker.ts:178` already call the same factory in both HTTP and scheduled paths; the only difference is whether a real `Request` exists.

### Trade-offs

- `pro`: one place to build env/app/logger layers; avoids a thin `makeRequestRunEffect` wrapper
- `pro`: caller ergonomics are simple in `fetch()` - `makeRunEffect(env, request)`
- `con`: with a plain optional parameter, the returned runner type is easy to widen too far, and then scheduled code can accidentally compile while depending on `Request`
- `con`: to preserve the strong boundary, you usually need overloads or a conditional generic, which makes the single-function version more subtle than it first appears
- `con`: implementation gets slightly denser because runtime construction and typing now branch in the same function

### Recommendation

If optimizing for clarity, keep two entrypoints:

- `makeRunEffect(env)` for request-free execution
- `makeRequestRunEffect(env, request)` for HTTP execution

Reason: the code has a real domain split, not just an incidental parameter split. `src/worker.ts:177` is genuinely non-HTTP, and keeping a separate request-aware wrapper makes that boundary obvious in both runtime behavior and types.

If you strongly prefer one symbol, use one `makeRunEffect` with overloads, not just `request?: Request` plus a single broad return type. That preserves the main benefit of the two-function design: scheduled effects still fail at compile time if they try to `yield* Request`.

So the recommendation is:

1. best readability/safety: two functions
2. acceptable compromise: one overloaded `makeRunEffect(env, request?)`
3. not recommended: one loosely typed optional-argument runner
