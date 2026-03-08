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

So current behavior is still:

- one eager `auth.getSession(request.headers)` fetch per HTTP request
- `session` passed through TanStack request context
- route/server-fn code reads `session` from context, not from an Effect service

## What Changed Since The Old Research

The old draft assumed `request` was still in `ServerContext`. That is now stale.

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

That matters for `Session`: a lazy session service can now depend on `Request` directly instead of taking headers from TanStack context.

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

- auth guard: `if (!session?.user) return yield* Effect.die(redirect({ to: "/login" }));` in `src/routes/app.tsx:9`
- role guard: `if (session.user.role !== "admin")` in `src/routes/admin.tsx:43`
- optional projection: `sessionUser: session?.user` in `src/routes/_mkt.tsx:14`
- active org validation: `s.session.activeOrganizationId === organizationId` in `src/routes/app.$organizationId.tsx:64`

This is structurally similar to the completed `Request` migration: route logic already reads `session` only inside `runEffect(...)` programs.

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

`undefined` matches current semantics in `ServerContext`, where missing session is normal for public routes.

## Provisioning Models

### Model A: eager worker fetch, then provide `Session`

Preserve current semantics exactly.

Sketch:

```ts
const runEffect = makeHttpRunEffect(env, request);

const session = await runEffect(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* auth.getSession(request.headers);
  }),
);

const runRequestEffect = <A, E>(effect: Effect.Effect<A, E, Session | any>) =>
  runEffect(effect.pipe(Effect.provideService(Session, session ?? undefined)));
```

Grounding: Effect exposes `Effect.provideService(...)` for this exact shape.

`refs/effect4/packages/effect/src/Effect.ts:5832`-`refs/effect4/packages/effect/src/Effect.ts:5834`:

```ts
const result = Effect.provideService(program, Counter, { count: 0 });
Effect.runPromise(result).then(console.log);
```

Pros:

- preserves one session fetch per HTTP request
- preserves current fetch timing before `serverEntry.fetch(...)`
- removes `session` from `ServerContext` without changing auth behavior
- keeps scheduled runtime free of fake session values

Cons:

- still keeps a worker prefetch phase before route execution
- session is request-scoped but not constructed as a layer

### Model B: lazy `Session` layer derived from `Request`

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

But call-count semantics are still the hard part.

`refs/effect4/migration/layer-memoization.md:8`-`refs/effect4/migration/layer-memoization.md:11`:

```md
In v4, the underlying `MemoMap` data structure which facilitates memoization of
`Layer`s is shared between `Effect.provide` calls...
```

And the managed runtime guide makes shared memo-map ownership explicit when you want reuse across framework boundaries.

`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:60`-`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:68`:

```ts
export const appMemoMap = Layer.makeMemoMapUnsafe();

export const runtime = ManagedRuntime.make(TodoRepo.layer, {
  memoMap: appMemoMap,
});
```

In this repo, each `runEffect(...)` currently does a fresh top-level run:

```ts
const exit = await Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
```

Source: `src/worker.ts:114`-`src/worker.ts:116`.

So this research should not assume that a lazy `Session` layer yields exactly one `auth.getSession(...)` call across all server functions/loaders participating in one HTTP page request.

Pros:

- lines up cleanly with the new `Request` service
- avoids eager worker fetch for routes that never touch session
- makes `Session` a normal runtime dependency

Cons:

- may change call-count semantics from once-per-request to once-per-`runEffect`
- needs explicit proof before claiming parity with current behavior

## Scheduled Path

Same conclusion as the request migration: `scheduled()` should not provide `Session`.

Current scheduled path in `src/worker.ts:203`-`src/worker.ts:223` only does repository cleanup and logging. There is no HTTP request and no auth session.

So:

- `Session` should be HTTP-only
- scheduled code that accidentally reaches for `Session` should fail loudly
- do not widen the service to fake defaults for non-HTTP paths

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

The route-level change is straightforward. The only real design choice is how `Session` gets provided.

## Recommendation

The old "not implementation-ready" conclusion is stale.

Updated recommendation:

1. if the goal is only to remove `session` from `ServerContext`, use Model A first
2. keep current eager worker fetch semantics unless the team explicitly wants to trade them away
3. revisit Model B only if reducing unused session fetches matters enough to justify call-count verification work

Model A is now the low-risk path because:

- `Request` service plumbing is already in place
- all current route reads are already inside `runEffect(...)`
- current auth behavior is centered on one eager fetch in `src/worker.ts`

## Questions To Annotate

1. Is preserving exactly one `auth.getSession(request.headers)` call per HTTP request a hard requirement, or is once-per-`runEffect` acceptable?

You keep getting tied up in knots about this. We want session to be lazy. Does that address your concerns?

2. Should the migration optimize for semantic parity first (Model A), or for deferred session fetching first (Model B)?

We want lazy. If a session is not needed then it should never be gotten.

3. Do you want `Session` to keep current `undefined` semantics for public routes, or should missing-session access fail harder in some locations?

Hmmm, maybe undefined for now. May consider Option in future

4. If we keep Model A, do you want `src/worker.ts` to wrap `runEffect` with `Effect.provideService(Session, session ?? undefined)`, or do you want a session layer merged into the HTTP runtime after prefetch?

Is this question still relevant? We want sessiont to be lazy

5. After `Session` moves into Effect, do you want follow-up guard helpers (`requireUserSession`, `requireAdminSession`, etc.), or keep direct inline checks in routes?

No guard helpers for now.


Remove anything about scheduled. It's not relevant and just adds noise.
