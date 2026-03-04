# Research: Refactoring `runEffect` in Auth.ts — Effect 4 Idiomatic Approaches

## Problem

`createBetterAuthOptions` accepts `d1`, `stripe`, and `runEffect` as plain values via `CreateBetterAuthOptions`. Callbacks inside better-auth config (e.g. `plans()`, `authorizeReference()`, hooks) call `runEffect(Effect.gen(...))` where the generator closes over `d1` and `stripe` — captured as resolved service instances, not as Effect dependencies.

```ts
// Current: dependencies are closed-over values, invisible to the Effect type system
runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
//                                          ^ no R — services not tracked
```

This means:
- Effects have `R = never` even though they use D1/Stripe — losing dependency tracking
- `d1` and `stripe` are passed as plain values alongside `runEffect`, mixing Effect and non-Effect patterns
- `CreateBetterAuthOptions` interface is bloated with `d1`, `stripe`, `runEffect` props

## Effect 4 Primitives for This Situation

### 1. `Effect.services<R>()` — Capture the ServiceMap

Returns the current `ServiceMap<R>` from the fiber context. This is how Effect 4 captures "the current environment" for later use in non-Effect callbacks.

```ts
// refs/effect4/packages/effect/src/Effect.ts:5508
export const services: <R>() => Effect<ServiceMap.ServiceMap<R>, never, R>
```

Real usage in Effect 4 source (NodeSocketServer.ts:72):
```ts
const services = ServiceMap.omit(Scope.Scope)(
  yield* Effect.services<R>()
) as ServiceMap.ServiceMap<R>
```

### 2. `Effect.runPromiseWith(services)` — Run with a captured ServiceMap

Effect 4 provides `runPromiseWith` — a curried form that takes a `ServiceMap` and returns a runner.

```ts
// refs/effect4/packages/effect/src/Effect.ts:8455
export const runPromiseWith: <R>(
  services: ServiceMap.ServiceMap<R>
) => <A, E>(effect: Effect<A, E, R>, options?: RunOptions) => Promise<A>
```

### 3. `ManagedRuntime` — Bridge Effect to non-Effect frameworks

From `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts`:
```ts
const runtime = ManagedRuntime.make(TodoRepo.layer, { memoMap: appMemoMap })
// then: runtime.runPromise(effect)
```

`ManagedRuntime` manages layer lifecycle and provides `.runPromise` that automatically satisfies `R` requirements.

## Approaches

### Approach A: `Effect.services()` + `Effect.runPromiseWith()` (Recommended)

Capture the ServiceMap at Auth service construction time (inside `Auth.make`), then use `Effect.runPromiseWith(services)` as the runner. Callbacks write normal Effects with `yield* D1` / `yield* Stripe`.

```ts
// In Auth.make:
const services = yield* Effect.services<D1 | Stripe>()
const runEffect = Effect.runPromiseWith(services)

// Callbacks now write idiomatic Effect code:
plans: () =>
  runEffect(
    Effect.gen(function* () {
      const stripe = yield* Stripe
      return (yield* stripe.getPlans()).map(...)
    })
  ),
authorizeReference: ({ user, referenceId }) =>
  runEffect(
    Effect.gen(function* () {
      const d1 = yield* D1
      // ...
    })
  ),
```

**`CreateBetterAuthOptions` simplifies to:**
```ts
interface CreateBetterAuthOptions {
  db: D1Database;
  kv: KVNamespace;
  runEffect: <A, E>(effect: Effect.Effect<A, E, D1 | Stripe>) => Promise<A>;
  betterAuthUrl: string;
  betterAuthSecret: Redacted.Redacted;
  // ... config values only, no d1/stripe service instances
}
```

**Pros:**
- Effects properly track `D1 | Stripe` in `R` — full dependency visibility
- `d1` and `stripe` removed from `CreateBetterAuthOptions`
- `yield* D1` / `yield* Stripe` is idiomatic Effect 4
- The ServiceMap is captured once, reused across all callbacks
- Pattern matches Effect 4 source code (NodeSocketServer uses same approach)

**Cons:**
- `runEffect` type signature is less general (`Effect<A, E, D1 | Stripe>` vs `Effect<A, E>`)
- Still passes `runEffect` as a value, though now it carries services

### Approach B: `ManagedRuntime`

Build a `ManagedRuntime` from the composed layer of `D1 | Stripe | ...` and use `runtime.runPromise()`.

```ts
// In Auth.make:
const appLayer = Layer.mergeAll(D1.layer, Stripe.layer, /* ... */)
const runtime = ManagedRuntime.make(appLayer)

// CreateBetterAuthOptions gets:
interface CreateBetterAuthOptions {
  db: D1Database;
  kv: KVNamespace;
  runtime: ManagedRuntime<D1 | Stripe, never>;
  // ... config values
}

// Callbacks:
plans: () =>
  runtime.runPromise(
    Stripe.use((stripe) => stripe.getPlans()).pipe(
      Effect.map((plans) => plans.map(...))
    )
  ),
```

**Pros:**
- Lifecycle management (dispose) — useful for long-running processes
- Standard Effect 4 integration pattern for frameworks

**Cons:**
- ManagedRuntime creates its own layer instances — but Auth.make already has D1/Stripe from the parent layer, so this duplicates service construction
- Lifecycle (dispose) not needed here — Cloudflare Worker handles lifecycle
- More ceremony for no benefit over Approach A

### Approach C: `Effect.provideServices` inline (No `runEffect` at all)

Each callback constructs its Effect with full `R` and provides services inline.

```ts
// In Auth.make:
const services = yield* Effect.services<D1 | Stripe>()

// CreateBetterAuthOptions:
interface CreateBetterAuthOptions {
  db: D1Database;
  kv: KVNamespace;
  services: ServiceMap.ServiceMap<D1 | Stripe>;
  // ... config values
}

// Callbacks:
plans: () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stripe = yield* Stripe
      return (yield* stripe.getPlans()).map(...)
    }).pipe(Effect.provideServices(services))
  ),
```

**Pros:**
- No `runEffect` function at all — just raw `Effect.runPromise`
- Very explicit: each call site shows provide + run

**Cons:**
- Verbose — every callback repeats `Effect.runPromise(... .pipe(Effect.provideServices(services)))`
- Approach A achieves the same with `Effect.runPromiseWith(services)` which is the curried form of exactly this

### Approach D: Hybrid — keep `d1`/`stripe` closed over, type `runEffect` with `never`

Keep the current closure pattern but just use `Effect.runPromise` directly (since these effects have no `R`).

```ts
const runEffect: CreateBetterAuthOptions["runEffect"] = Effect.runPromise;
```

This is actually what the code does today (line 282). The effects close over `d1` and `stripe` as plain values. No refactor needed.

**Pros:**
- No change
- Simple

**Cons:**
- Not idiomatic Effect 4 — services aren't tracked in the type system
- `CreateBetterAuthOptions` carries both service instances and config, mixing concerns

## Recommendation

**Approach A** — `Effect.services()` + `Effect.runPromiseWith()`.

The key insight from Effect 4 source is this pattern (NodeSocketServer.ts):
```ts
const services = yield* Effect.services<R>()
// later, in a callback outside the Effect world:
Effect.runForkWith(services)(handler(socket))
```

Applied to Auth.ts:
1. In `Auth.make`, after yielding `D1` and `Stripe`, capture `yield* Effect.services<D1 | Stripe>()`
2. Create `runEffect = Effect.runPromiseWith(services)`
3. Remove `d1` and `stripe` from `CreateBetterAuthOptions`
4. Callbacks use `yield* D1` / `yield* Stripe` to access services

The `databaseHookUserCreateAfter` and `databaseHookSessionCreateBefore` callbacks (lines 302-341) that reference `auth` directly would still need the closure over `auth` — that's fine since `auth` isn't an Effect service. But `d1` access inside those callbacks would be via `yield* D1` instead of the closed-over instance.

## Implementation Sketch

```ts
export class Auth extends ServiceMap.Service<Auth>()("Auth", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    const stripe = yield* Stripe;
    const services = yield* Effect.services<D1 | Stripe>();
    const runEffect = Effect.runPromiseWith(services);
    const authConfig = yield* Config.all({ ... });
    const { KV, D1: db } = yield* CloudflareEnv;

    const auth = betterAuth(
      createBetterAuthOptions({
        db,
        kv: KV,
        runEffect,
        ...authConfig,
        databaseHookUserCreateAfter: (user) =>
          runEffect(
            Effect.gen(function* () {
              const d1 = yield* D1;
              if (user.role !== "user") return;
              const org = yield* Effect.tryPromise(() =>
                auth.api.createOrganization({ ... }),
              );
              yield* d1.run(
                d1.prepare("update Session ...").bind(org.id, user.id),
              );
            }),
          ),
        // ...
      }),
    );
    // ...
  }),
}) { ... }
```

### Simplified `CreateBetterAuthOptions`

```ts
interface CreateBetterAuthOptions {
  db: D1Database;
  kv: KVNamespace;
  runEffect: <A, E>(effect: Effect.Effect<A, E, D1 | Stripe>) => Promise<A>;
  betterAuthUrl: string;
  betterAuthSecret: Redacted.Redacted;
  transactionalEmail: string;
  stripeWebhookSecret: Redacted.Redacted;
  databaseHookUserCreateAfter?: ...;
  databaseHookSessionCreateBefore?: ...;
}
```

`d1` and `stripe` properties removed — services accessed idiomatically via `yield*` inside Effects.
