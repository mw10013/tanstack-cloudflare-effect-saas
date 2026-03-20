# Effect v4 `tryPromise` vs `promise` Research

Question: in `src/invoice-extraction-workflow.ts:141`, should this boundary use `Effect.tryPromise` or `Effect.promise`, what are the variants, and is `catch` required?

## Short Answer

- `Effect.tryPromise` is for Promise APIs that can reject or for async code that may throw before returning the Promise.
- `Effect.promise` is for Promise APIs you expect to never reject. If they do reject, Effect treats that as a defect, not a typed failure.
- `catch` is not required for `Effect.tryPromise` overall, but it is required in the object form. The function overload is the no-custom-catch variant.
- In `src/invoice-extraction-workflow.ts:141`, the outer `Effect.tryPromise` is the right constructor because `step.do(...)` returns a Promise and step failure is part of the expected failure model.
- The inner `Effect.promise(() => agent.saveExtractedJson(...))` works, but only if rejection from `saveExtractedJson` should be treated as a defect until the outer boundary catches the rejected `runEffect(...)` promise.

## Grounding From Effect v4

From `refs/effect4/packages/effect/src/Effect.ts:1044`:

```ts
Use `promise` when you are sure the operation will not reject.
```

From `refs/effect4/packages/effect/src/Effect.ts:1048-1054`:

```ts
The provided function (`thunk`) returns a `Promise` that should never reject; if it does, the error
will be treated as a "defect".
```

From `refs/effect4/packages/effect/src/Effect.ts:1096-1100`:

```ts
In situations where you need to perform asynchronous operations that might
fail ... you can use the `tryPromise` constructor.
```

From `refs/effect4/packages/effect/src/Effect.ts:1104-1109`:

```ts
There are two ways to handle errors with `tryPromise`:

1. If you don't provide a `catch` function, the error is caught and the
   effect fails with an `UnknownError`.
2. If you provide a `catch` function, the error is caught and the `catch`
   function maps it to an error of type `E`.
```

From `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:45-56`:

```ts
// `Effect.tryPromise` wraps Promise-based APIs that can reject or throw.
export const fetchUser = Effect.fn("fetchUser")((userId: number) =>
  Effect.tryPromise({
    async try() {
      const user = users.get(userId)
      if (!user) {
        throw new Error(`Missing user ${userId}`)
      }
      return user
    },
    catch: (cause) => new UserLookupError({ userId, cause })
  })
)
```

## Actual Signatures

From `refs/effect4/packages/effect/src/Effect.ts:1086-1088`:

```ts
export const promise: <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>
) => Effect<A>
```

From `refs/effect4/packages/effect/src/Effect.ts:1152-1156`:

```ts
export const tryPromise: <A, E = Cause.UnknownError>(
  options:
    | { readonly try: (signal: AbortSignal) => PromiseLike<A>; readonly catch: (error: unknown) => E }
    | ((signal: AbortSignal) => PromiseLike<A>)
) => Effect<A, E>
```

Key implication:

- `Effect.tryPromise(() => somePromise())` is valid and uses `UnknownError`.
- `Effect.tryPromise({ try: ..., catch: ... })` is valid and gives custom error mapping.
- `Effect.tryPromise({ try: ... })` is not one of the declared overloads.
- So `catch` is required in the object form, optional only because there is also a function form.

## Runtime Behavior

From `refs/effect4/packages/effect/src/internal/effect.ts:955-963`:

```ts
export const promise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>
): Effect.Effect<A> =>
  callbackOptions<A>(function(resume, signal) {
    internalCall(() => evaluate(signal!)).then(
      (a) => resume(succeed(a)),
      (e) => resume(die(e))
    )
  }, evaluate.length !== 0)
```

`Effect.promise` behavior:

- if the Promise resolves, the effect succeeds
- if the Promise rejects, the effect dies with a defect via `die(e)`
- thrown errors before the Promise is returned are also inside `internalCall(() => evaluate(signal!))`, so they are treated as defects too

From `refs/effect4/packages/effect/src/internal/effect.ts:966-985`:

```ts
export const tryPromise = <A, E = Cause.UnknownError>(
  options: {
    readonly try: (signal: AbortSignal) => PromiseLike<A>
    readonly catch: (error: unknown) => E
  } | ((signal: AbortSignal) => PromiseLike<A>)
): Effect.Effect<A, E> => {
  const f = typeof options === "function" ? options : options.try
  const catcher = typeof options === "function"
    ? ((cause: unknown) => new UnknownError(cause, "An error occurred in Effect.tryPromise"))
    : options.catch
  return callbackOptions<A, E>(function(resume, signal) {
    try {
      internalCall(() => f(signal!)).then(
        (a) => resume(succeed(a)),
        (e) => resume(fail(internalCall(() => catcher(e)) as E))
      )
    } catch (err) {
      resume(fail(internalCall(() => catcher(err)) as E))
    }
  }, eval.length !== 0)
}
```

`Effect.tryPromise` behavior:

- if the Promise resolves, the effect succeeds
- if the Promise rejects, the effect fails in the error channel
- if `try` throws synchronously before returning the Promise, the effect also fails in the error channel
- without custom `catch`, the failure type defaults to `Cause.UnknownError`
- with custom `catch`, the failure type is whatever `catch` returns

From `refs/effect4/packages/effect/src/internal/effect.ts:973-975`:

```ts
const catcher = typeof options === "function"
  ? ((cause: unknown) => new UnknownError(cause, "An error occurred in Effect.tryPromise"))
  : options.catch
```

And `UnknownError` itself from `refs/effect4/packages/effect/src/internal/effect.ts:5783-5787`:

```ts
export class UnknownError extends TaggedError("UnknownError") {
  constructor(cause: unknown, message?: string) {
    super({ message, cause } as any)
  }
}
```

## AbortSignal Support

Both constructors take a function of `(signal: AbortSignal) => PromiseLike<A>`.

From `refs/effect4/packages/effect/src/Effect.ts:1056-1060` and `refs/effect4/packages/effect/src/Effect.ts:1111-1114`:

```ts
An optional `AbortSignal` can be provided to allow for interruption of the
wrapped `Promise` API.
```

So if the foreign API accepts a signal, both `promise` and `tryPromise` can participate in interruption. The difference is error semantics, not cancellation support.

## When To Use Which

Use `Effect.tryPromise` when:

- the API can reject during ordinary operation
- the async thunk may throw before returning a Promise
- you want recoverable failures in the typed error channel
- you want to map foreign errors into domain/integration errors

Use `Effect.promise` when:

- rejection would indicate a bug or invariant break
- you intentionally want rejection to be treated as a defect
- the Promise is effectively cleanup / shutdown / guaranteed-success glue

Repo-grounded examples from `refs/effect4` lean this way too:

- body decoding uses `Effect.tryPromise` because response parsing can fail: `refs/effect4/packages/effect/src/unstable/http/HttpClientResponse.ts:303-355`
- cleanup/finalizer code often uses `Effect.promise`, e.g. `Effect.promise(() => reader.cancel())` or `Effect.promise(() => provider.forceFlush().then(() => provider.shutdown()))`

## Applying That To `invoice-extraction-workflow.ts`

The relevant code at `src/invoice-extraction-workflow.ts:141-159` is:

```ts
yield* Effect.tryPromise({
  try: () =>
    step.do("save-extracted-json", () =>
      runEffect(
        Effect.promise(() =>
          agent.saveExtractedJson({
            invoiceId: event.payload.invoiceId,
            idempotencyKey: event.payload.idempotencyKey,
            extractedJson: JSON.stringify(extractedJson),
          }),
        ),
      ),
    ),
  catch: (cause) =>
    new InvoiceExtractionWorkflowError({
      message: "Workflow step failed: save-extracted-json",
      cause,
    }),
})
```

What this means:

- outer `Effect.tryPromise(...)` wraps `step.do(...)`, which is a Promise boundary that can fail; that is correct
- inner `Effect.promise(...)` says `agent.saveExtractedJson(...)` is expected to never reject
- if `agent.saveExtractedJson(...)` does reject, the inner effect dies with a defect, then `runEffect(...)` rejects, then the outer `tryPromise` catches that rejected Promise and maps it to `InvoiceExtractionWorkflowError`

So the current code is not wrong, but it makes a semantic claim:

- rejection from `saveExtractedJson` is defect-level inside the inner effect
- only at the outer `step.do` Promise boundary is it normalized back into a workflow error

If `agent.saveExtractedJson(...)` can fail for operational reasons, the more direct constructor would usually be:

```ts
Effect.tryPromise(() =>
  agent.saveExtractedJson({
    invoiceId: event.payload.invoiceId,
    idempotencyKey: event.payload.idempotencyKey,
    extractedJson: JSON.stringify(extractedJson),
  }),
)
```

or, if you want typed inner mapping too:

```ts
Effect.tryPromise({
  try: () =>
    agent.saveExtractedJson({
      invoiceId: event.payload.invoiceId,
      idempotencyKey: event.payload.idempotencyKey,
      extractedJson: JSON.stringify(extractedJson),
    }),
  catch: (cause) =>
    new InvoiceExtractionWorkflowError({
      message: "Failed to save extracted json",
      cause,
    }),
})
```

That keeps the failure in the Effect error channel earlier, instead of classifying it as a defect first.

## Recommendation

- Keep the outer `Effect.tryPromise` around `step.do(...)`.
- Prefer inner `Effect.tryPromise` over inner `Effect.promise` if `agent.saveExtractedJson(...)` can reject in normal operation.
- Keep `Effect.promise` for async operations that are truly expected not to reject.

For this specific workflow, the simplest consistent reading is:

- `step.do(...)` -> `Effect.tryPromise`
- `object.value.arrayBuffer()` -> `Effect.promise` is acceptable if that rejection is considered impossible/unexpected
- `agent.saveExtractedJson(...)` -> likely better modeled with `Effect.tryPromise`, unless the agent API contract guarantees non-rejection
