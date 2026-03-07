# Research: Moving `session` from TanStack `ServerContext` into an Effect service

## Current State

`src/worker.ts` fetches the session before calling `serverEntry.fetch`:

```ts
const runEffect = makeRunEffect(env);

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
    request,
    session: session ?? undefined,
  },
});
```

So current behavior is:

- one worker-level session fetch per HTTP request
- session value passed through `ServerContext`
- route code reads `session` from context, not from an Effect service

## Usage Analysis

Current `ServerContext.session` usage is concentrated in auth guards and a few mutations/loaders.

Representative call sites:

- `src/routes/app.tsx:6` -> redirect if `!session?.user`
- `src/routes/admin.tsx:38` -> admin role guard
- `src/routes/magic-link.tsx:6` -> role-based post-login redirect
- `src/routes/app.index.tsx:6` -> redirect based on active org
- `src/routes/app.$organizationId.tsx:57` -> validate `activeOrganizationId`
- `src/routes/_mkt.pricing.tsx:47` -> auth + organization guard before checkout

These handlers all read `session` only inside `runEffect`-executed logic today, so an Effect service is structurally possible.

## Candidate Service

New file: `src/lib/Session.ts`

```ts
import type { AuthInstance } from "@/lib/Auth";
import { ServiceMap } from "effect";

export const Session = ServiceMap.Service<
  AuthInstance["$Infer"]["Session"] | undefined
>("app/Session");
```

## Two Viable Provisioning Models

### Model A: eager session fetch in worker, then provide service

Preserve current behavior.

Sketch:

```ts
const runEffect = makeRunEffect(env);
const session = await runEffect(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* auth.getSession(request.headers);
  }),
);

const runRequestEffect = <A, E>(effect: Effect.Effect<A, E, any>) =>
  runEffect(effect.pipe(Effect.provideService(Session, session ?? undefined)));
```

Pros:

- preserves one session fetch per HTTP request
- preserves current fetch timing
- low semantic risk

Cons:

- still needs special worker wiring
- still has a separate prefetch phase before route execution

### Model B: lazy session layer

Build `Session` from `Auth.getSession(request.headers)` when first accessed.

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

This is idiomatic Layer construction, but behavior changes.

## Effect v4 Grounding

The lazy-layer idea is valid Effect code. `Layer.effect` is standard service construction; see `refs/effect4/LLMS.md:123` and `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:28`.

But memoization details matter.

Effect v4 docs say layers are memoized across `Effect.provide` calls unless opted out:

```md
In v4, the underlying `MemoMap` data structure which facilitates memoization of
Layers is shared between `Effect.provide` calls...
```

Source: `refs/effect4/migration/layer-memoization.md:8`

The same docs also emphasize explicit shared memo maps when bridging runtimes:

```ts
export const appMemoMap = Layer.makeMemoMapUnsafe();

export const runtime = ManagedRuntime.make(TodoRepo.layer, {
  memoMap: appMemoMap,
});
```

Source: `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:62`

For this repo, `src/worker.ts:86` runs each server effect via a fresh `Effect.runPromiseExit(Effect.provide(effect, runtimeLayer))` call. That means the research cannot assume, without verification, that a lazy `Session` layer will fetch only once for the entire outer HTTP request.

Safe conclusion:

- `Layer.effect(Session, ...)` will be memoized within the runtime/provide mechanics Effect gives you
- but this repo has not yet proven that this yields exactly one `getSession` call across all `runEffect` invocations triggered by a single page request

That distinction matters because current behavior is explicitly one worker-level fetch before `serverEntry.fetch`.

## Scheduled Path

Unlike `Request`, `Session` has no scheduled-use requirement today.

`scheduled()` in `src/worker.ts:177` only does repository cleanup and logging; it does not read `session`.

Still, a session service design should keep the non-request path explicit:

- eager model: only provide `Session` in HTTP fetch path
- lazy model: only merge `Session` layer into the HTTP request runtime, not the scheduled runtime

That avoids implying sessions exist outside HTTP request handling.

## Route Changes

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

## Open Questions

This topic is not implementation-ready yet. These questions need answers first:

1. Must session remain exactly once-per-HTTP-request, or is once-per-`runEffect` acceptable?
2. If lazy, what proof will we use to verify actual `auth.getSession` call count?
3. Does any route sequence trigger multiple server functions/loaders during one page request such that repeated lazy fetches matter?
4. Should `Session` depend on a future `Request` service, or stay independently worker-provided?

## Recommendation

Do not implement the session service migration first.

The safer order is:

1. move `Request` first
2. keep current worker-level session prefetch behavior unchanged
3. revisit `Session` only after deciding whether preserving one-fetch-per-request is a hard requirement

If the team wants the lowest-risk session migration later, use eager worker fetch + `Effect.provideService(Session, session ?? undefined)` before considering a lazy `Layer.effect(Session, ...)` design.
