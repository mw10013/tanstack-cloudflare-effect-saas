# Research: Moving `session` from TanStack `ServerContext` into an Effect service

## Current State

`Request` has already been moved out of `ServerContext` and into an Effect service.

Current HTTP worker flow in `src/worker.ts:184`-`src/worker.ts:197`:

```ts
const runEffect = makeHttpRunEffect(env, request);

const session = await runEffect(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* auth.getSession(request.headers);
  }),
);

const response = await serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
    session: session ?? undefined,
  },
});
```

And `ServerContext` in `src/worker.ts:151`-`src/worker.ts:155` is now:

```ts
export interface ServerContext {
  env: Env;
  runEffect: ReturnType<typeof makeHttpRunEffect>;
  session?: AuthInstance["$Infer"]["Session"];
}
```

So current behavior is:

- eager `auth.getSession(request.headers)` in the worker fetch path
- `session` passed through TanStack request context
- route/server-fn code reads `session` from context, not from an Effect service

## What Changed Since The Old Research

The old draft assumed `request` was still in `ServerContext`. That is stale.

`src/lib/Request.ts:1`-`src/lib/Request.ts:3`:

```ts
import { ServiceMap } from "effect";

export const Request = ServiceMap.Service<globalThis.Request>("app/Request");
```

`src/worker.ts:104`-`src/worker.ts:110` now provides request at the runtime boundary:

```ts
const requestLayer = Layer.succeedServices(
  ServiceMap.make(AppRequest, request),
);
const runtimeLayer = Layer.merge(
  Layer.merge(authLayer, requestLayer),
  makeLoggerLayer(env),
);
```

That means a lazy `Session` service can depend on `Request` directly.

## Usage Analysis

Current `context.session` reads in route modules are only 8 call sites:

- `src/routes/app.tsx:6`
- `src/routes/admin.tsx:38`
- `src/routes/magic-link.tsx:6`
- `src/routes/app.index.tsx:6`
- `src/routes/_mkt.tsx:12`
- `src/routes/_mkt.pricing.tsx:48`
- `src/routes/app.$organizationId.tsx:59`
- `src/routes/app.$organizationId.index.tsx:46`

Representative patterns:

- auth guard in `src/routes/app.tsx:9`: `if (!session?.user) return yield* Effect.die(redirect({ to: "/login" }));`
- role guard in `src/routes/admin.tsx:43`: `if (session.user.role !== "admin")`
- optional projection in `src/routes/_mkt.tsx:14`: `sessionUser: session?.user`
- active org validation in `src/routes/app.$organizationId.tsx:64`: `s.session.activeOrganizationId === organizationId`

This is structurally similar to the completed `Request` migration: route logic already reads `session` inside `runEffect(...)` programs.

## Effect v4 Grounding

Effect v4's default service abstraction is `ServiceMap.Service`.

`refs/effect4/migration/services.md:24`-`refs/effect4/migration/services.md:34`:

```ts
import { ServiceMap } from "effect";

interface Database {
  readonly query: (sql: string) => string;
}

const Database = ServiceMap.Service<Database>("Database");
```

Effect's own HTTP stack models request access as a service too.

`refs/effect4/packages/effect/src/unstable/http/HttpServerRequest.ts:74`-`refs/effect4/packages/effect/src/unstable/http/HttpServerRequest.ts:76`:

```ts
export const HttpServerRequest: ServiceMap.Service<
  HttpServerRequest,
  HttpServerRequest
> = ServiceMap.Service("effect/http/HttpServerRequest");
```

And the Node server injects that service at the request boundary.

`refs/effect4/packages/platform-node/src/NodeHttpServer.ts:161`-`refs/effect4/packages/platform-node/src/NodeHttpServer.ts:163`:

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

So a local `Session` service is idiomatic.

## Candidate Service

New file:

```ts
import type { AuthInstance } from "@/lib/Auth";
import { ServiceMap } from "effect";

export const Session = ServiceMap.Service<
  AuthInstance["$Infer"]["Session"] | undefined
>("app/Session");
```

`undefined` matches current semantics, where missing session is normal for public routes.

## Preferred Direction: Lazy `Session`

The desired direction is lazy session access: if a route does not need session, it should not trigger `auth.getSession(...)`.

Sketch:

```ts
const sessionLayer = Layer.effect(
  Session,
  Effect.gen(function* () {
    const request = yield* Request;
    const auth = yield* Auth;
    return (yield* auth.getSession(request.headers)) ?? undefined;
  }),
);
```

This is valid Effect code. `Layer.effect(...)` is the standard pattern for constructing a service from an effect; see `refs/effect4/LLMS.md:121`-`refs/effect4/LLMS.md:138` and `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:23`-`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:29`.

## Important Caveat

Lazy is the direction, but one behavior detail still needs to be made explicit: what call count is acceptable if multiple `runEffect(...)` executions happen during one page request.

`refs/effect4/migration/layer-memoization.md:8`-`refs/effect4/migration/layer-memoization.md:11`:

```md
In v4, the underlying `MemoMap` data structure which facilitates memoization of
`Layer`s is shared between `Effect.provide` calls...
```

And the managed runtime docs make shared memo-map ownership explicit when you want controlled reuse across framework boundaries.

`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:60`-`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:68`:

```ts
export const appMemoMap = Layer.makeMemoMapUnsafe();

export const runtime = ManagedRuntime.make(TodoRepo.layer, {
  memoMap: appMemoMap,
});
```

Current runner in `src/worker.ts:114`-`src/worker.ts:116`:

```ts
const exit = await Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
```

So this doc should not claim more than we know. The migration target is lazy session loading. The remaining question is whether repeated top-level `runEffect(...)` calls within one HTTP navigation may trigger repeated `auth.getSession(...)` calls, and whether that is acceptable.

## Route Migration Shape

Before:

```ts
({ context: { runEffect, session } }) =>
  runEffect(
    Effect.gen(function* () {
      if (!session?.user) return yield* Effect.die(redirect({ to: "/login" }));
      return { sessionUser: session.user };
    }),
  );
```

After:

```ts
({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const session = yield* Session;
      if (!session?.user) return yield* Effect.die(redirect({ to: "/login" }));
      return { sessionUser: session.user };
    }),
  );
```

The route-level change is straightforward. The main open issue is runtime/provisioning shape, not route code.

## Recommendation

Updated recommendation:

1. move `session` to an Effect service
2. make it lazy via `Layer.effect(Session, ...)`
3. keep `undefined` semantics for now
4. do not introduce guard helper abstractions yet

This aligns with the current app direction better than preserving eager worker prefetch.

## Questions To Annotate

1. If multiple top-level `runEffect(...)` executions happen during one HTTP navigation, is it acceptable for lazy `Session` to call `auth.getSession(...)` more than once?

2. Do you want the implementation to accept that behavior as-is, or do you want additional runtime work to try to coalesce/memoize session reads across the whole HTTP request?

3. We currently model public-route session as `AuthInstance["$Infer"]["Session"] | undefined`. Keep that exact shape for the new `Session` service, or change it?

4. Do you want the final research doc to include a small implementation sketch in `src/worker.ts`, or keep it conceptual and route-focused?

5. After the lazy `Session` service lands, should we immediately remove all `context.session` usage in the same change, or stage it in two steps?
