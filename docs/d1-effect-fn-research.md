# D1 `Effect.fn` Research

## Question

In [`src/lib/D1.ts`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/D1.ts), should any properties returned from `make` use `Effect.fn`?

Short answer: yes for `batch`, `run`, and `first`; no for `prepare`.

## Current Shape

[`src/lib/D1.ts:5`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/D1.ts:5) returns:

- `prepare`: sync wrapper over `d1.prepare(...)`
- `batch`: function returning `tryD1(...).pipe(retryIfIdempotentWrite(...))`
- `run`: function returning `tryD1(...).pipe(retryIfIdempotentWrite(...))`
- `first`: function returning `tryD1(...)`

Excerpt:

```ts
return {
  prepare: (query: string) => d1.prepare(query),
  batch: <T = Record<string, unknown>>(statements: D1PreparedStatement[], options?: { readonly idempotentWrite?: boolean }) =>
    tryD1(() => d1.batch<T>(statements)).pipe(
      retryIfIdempotentWrite(options?.idempotentWrite),
    ),
  run: <T = Record<string, unknown>>(statement: D1PreparedStatement, options?: { readonly idempotentWrite?: boolean }) =>
    tryD1(() => statement.run<T>()).pipe(
      retryIfIdempotentWrite(options?.idempotentWrite),
    ),
  first: <T>(statement: D1PreparedStatement) =>
    tryD1(() => statement.first<T>()),
};
```

Source: [`src/lib/D1.ts:7`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/D1.ts:7)

## Effect v4 Guidance

Effect's local docs are explicit:

> "Prefer writing Effect code with `Effect.gen` & `Effect.fn(\"name\")`."

Source: [`refs/effect4/LLMS.md:16`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/LLMS.md:16)

> "When writing functions that return an Effect, use `Effect.fn`"

> "Avoid creating functions that return an `Effect.gen`, use `Effect.fn` instead."

Source: [`refs/effect4/LLMS.md:53`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/LLMS.md:53)

For services, the example is also explicit:

> "Define the service methods using `Effect.fn`"

Source: [`refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts:25`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts:25)

The managed runtime example shows the split clearly:

- `getAll`: zero-arg `Effect` value built with `Effect.gen(...).pipe(Effect.withSpan(...))`
- `getById`, `create`: parameterized service methods built with `Effect.fn("...")`

Source: [`refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:34`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:34)

## Why `Effect.fn` Fits Here

`batch`, `run`, and `first` are all reusable service methods with parameters and `Effect` return values. That is the exact boundary Effect docs target with `Effect.fn`.

Effect source also says `Effect.fn` adds:

> "spans and stack frames"

Source: [`refs/effect4/packages/effect/src/Effect.ts:12839`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/packages/effect/src/Effect.ts:12839)

Implementation detail confirms that named `Effect.fn`:

- wraps each call in a span
- attaches a call stack frame
- attaches a definition stack frame

Source: [`refs/effect4/packages/effect/src/internal/effect.ts:1175`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/packages/effect/src/internal/effect.ts:1175)

That is useful for infra methods like `D1.run` and `D1.batch`, where failures and latency are operationally important.

## Why `prepare` Should Stay Plain

`prepare` does not return an `Effect`. It is a synchronous handle-builder:

```ts
prepare: (query: string) => d1.prepare(query)
```

Source: [`src/lib/D1.ts:8`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/D1.ts:8)

Using `Effect.fn` here would force an unnecessary effect boundary around a pure sync API and would make call sites worse:

- current: `d1.prepare(sql).bind(...)`
- wrapped: `yield* d1.prepare(sql)` then `.bind(...)`

That would be less ergonomic for no real gain.

## Repo Pattern

This repo already follows the same split:

- reusable service methods use `Effect.fn`, for example [`src/lib/Repository.ts:10`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/Repository.ts:10) and [`src/lib/Stripe.ts:29`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/Stripe.ts:29)
- one-off orchestration inside a method still uses `Effect.gen`, for example [`src/lib/Stripe.ts:102`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/lib/Stripe.ts:102)

So changing `D1.run` / `batch` / `first` to `Effect.fn` would make `D1` more consistent with the rest of the codebase.

## Recommended Shape

Recommended direction:

```ts
const batch = Effect.fn("D1.batch")(function* <T = Record<string, unknown>>(
  statements: D1PreparedStatement[],
  options?: {
    readonly idempotentWrite?: boolean;
  },
) {
  return yield* tryD1(() => d1.batch<T>(statements)).pipe(
    retryIfIdempotentWrite(options?.idempotentWrite),
  );
});

const run = Effect.fn("D1.run")(function* <T = Record<string, unknown>>(
  statement: D1PreparedStatement,
  options?: {
    readonly idempotentWrite?: boolean;
  },
) {
  return yield* tryD1(() => statement.run<T>()).pipe(
    retryIfIdempotentWrite(options?.idempotentWrite),
  );
});

const first = Effect.fn("D1.first")(function* <T>(
  statement: D1PreparedStatement,
) {
  return yield* tryD1(() => statement.first<T>());
});

return {
  prepare: (query: string) => d1.prepare(query),
  batch,
  run,
  first,
};
```

## Trade-offs

Benefits:

- aligns with explicit Effect v4 guidance for functions that return `Effect`
- matches service examples in local Effect docs
- improves spans and stack traces for D1 method calls
- makes `D1` consistent with `Repository`, `Stripe`, and `Auth`

Costs:

- slightly more verbose than the current arrow form
- generic `Effect.fn` signatures can be a little denser to read
- trace/span wrapping adds some runtime overhead, though likely negligible at this boundary

## Pipeables vs Body

`Effect.fn` supports post-processing pipeables that receive the produced `Effect` and original args. Effect docs mention this at [`refs/effect4/packages/effect/src/Effect.ts:12839`](/Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/effect4/packages/effect/src/Effect.ts:12839).

I would not use that feature for `retryIfIdempotentWrite` here. Keeping retry inside the generator body is clearer because retry behavior is core method semantics and depends on `options`.

So the recommendation is:

- use `Effect.fn` for the method boundary
- keep `retryIfIdempotentWrite(options?.idempotentWrite)` inside the body

## Recommendation

Recommended:

- keep `prepare` as a plain synchronous function
- convert `batch`, `run`, and `first` to named `Effect.fn` methods
- do not wrap `prepare` in `Effect.fn`
- do not force `Effect.fn` pipeables for retry logic here

This is the most idiomatic Effect v4 shape based on the local docs and the current repo's own service patterns.
