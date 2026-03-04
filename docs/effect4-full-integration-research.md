# Effect 4 Full Integration Research

Date: 2026-03-02

## Objective

Integrate Effect 4 more fully with consistent `runEffect` usage, cleaner Better Auth callback execution, correct upload decode boundaries, and clearer layer composition.

## Scope

In scope:

1. make route/server-fn usage of `runEffect` fully consistent,
2. improve Better Auth hook/callback integration with Effect,
3. resolve upload decode boundary policy,
4. simplify layer composition readability without changing semantics.

Deferred:

1. broad `organization-agent.ts` refactor,
2. Google/OAuth service extraction and caching redesign,
3. full migration away from all remaining `Effect.runPromise` calls.

## Current Status

Phase 1 complete:

1. route `createServerFn` consistency fixed (`_mkt`, `__root` now use `runEffect`),
2. upload route now keeps validator minimal and decodes via Effect in handler,
3. Better Auth callbacks now use one shared runner (`runEffect`) instead of inline `Effect.runPromise(...)`.

Phase 2 complete:

1. app layer composition refactored to named intermediate layers,
2. dependency wiring remains explicit and equivalent.

## Evidence

- total `Effect.runPromise(` in `src`: `4`
- `Effect.runPromise(` in `src/lib/Auth.ts`: `0`
- route files with `createServerFn` and no `runEffect`: none
- upload route decode path now uses `Schema.decodeUnknownEffect(uploadFormSchema)`

## Findings and Decisions

### 1) `createServerFn` consistency

Previously missing:

1. `src/routes/_mkt.tsx`
2. `src/routes/__root.tsx`

Now both run through `runEffect`, matching the rest of route-level server-fn usage.

### 2) Upload decode boundary

TanStack Start `inputValidator` is server-only:

From `refs/tan-start/packages/start-client-core/src/createServerFn.ts`:

```ts
if (
  'inputValidator' in nextMiddleware.options &&
  nextMiddleware.options.inputValidator &&
  env === 'server'
) {
  ctx.data = await execValidator(...)
}
```

From `refs/tan-start/packages/start-plugin-core/src/start-compiler-plugin/handleCreateServerFn.ts`:

```ts
if (context.env === 'client') {
  stripMethodCall(inputValidator.callPath)
}
```

Implemented upload code shape:

```ts
const uploadFile = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return data;
  })
  .handler(({ context: { runEffect, session }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const upload = yield* Schema.decodeUnknownEffect(uploadFormSchema)(
          Object.fromEntries(data),
        );
        // ... use upload.name / upload.file
      }),
    ),
  );
```

Decision:

1. keep validator as shape gate,
2. perform schema decode in Effect pipeline,
3. keep validation failures in Effect error channel.

### 3) Better Auth callback runner strategy

Better Auth callbacks are async lifecycle hooks (`hooks`, `databaseHooks`), so they need Promise-based bridging.

Relevant Effect APIs:

```ts
export const services: <R>() => Effect<ServiceMap.ServiceMap<R>, never, R>
export const runPromiseWith: <R>(services: ServiceMap.ServiceMap<R>) => ...
export const runPromiseExitWith: <R>(services: ServiceMap.ServiceMap<R>) => ...
```

Implemented strategy in `Auth.make`:

```ts
const runEffect = Effect.runPromiseWith(ServiceMap.empty());
```

That runner is passed into Better Auth option construction and reused across callbacks.

Decision:

1. use shared `runEffect` runner (name aligned with app convention),
2. avoid scattered inline `Effect.runPromise(...)` calls.

### 4) Can worker `runEffect` be accessed from Better Auth DB hooks?

Short answer: not directly in current architecture.

Why:

1. worker `runEffect` is request-context state passed into TanStack Start request context,
2. Better Auth callbacks are configured at `betterAuth(...)` construction and receive Better Auth context,
3. Better Auth hook context is `GenericEndpointContext | null`.

From Better Auth runtime (`node_modules/better-auth/dist/db/with-hooks.mjs`):

```ts
const context = await getCurrentAuthContext().catch(() => null);
```

Decision:

1. use closure-scoped runner inside `Auth.make`,
2. do not attempt to tunnel worker request `runEffect` into Better Auth DB hooks.

### 5) Layer composition readability

Implemented `makeAppLayer` shape with explicit wiring:

1. `envLayer` (Cloudflare env + greeting + config provider),
2. `runtimeLayer = Layer.provideMerge(FetchHttpClient.layer, envLayer)`,
3. `d1Layer = Layer.provideMerge(D1.layer, runtimeLayer)`,
4. `repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer)`,
5. `stripeLayer = Layer.provideMerge(Stripe.layer, repositoryLayer)`,
6. final `appLayer = Layer.provideMerge(Auth.layer, stripeLayer)`.

This keeps behavior while replacing deep inline nesting with named intermediate steps.

## Remaining Deferred Work

1. `organization-agent.ts` still has remaining `Effect.runPromise(...)` and broad sync decode usage,
2. Google OAuth client and agent decode/runtime cleanup remain deferred by original scope.
