# Effect v4 Tagged Errors and `tryPromise` Research

Questions:

- does `Schema.TaggedErrorClass` already include `cause`?
- should we switch error definitions to something else to get `cause` more automatically?
- do we really need `catch` on `Effect.tryPromise`, or is `UnknownError` acceptable?

## Short Answer

- `Schema.TaggedErrorClass` does not auto-add `cause`. It auto-adds `_tag`.
- `Data.TaggedError` also does not auto-add `cause`.
- So our current pattern is already the Effect v4 idiom: `Schema.TaggedErrorClass(..., { ..., cause: Schema.Defect })`.
- If `cause` is useful only sometimes, make it optional with `Schema.optional(Schema.Defect)`.
- `Effect.tryPromise` does not require custom `catch` if `UnknownError` is acceptable.
- Use custom `catch` when you want a stable domain/integration error type, `catchTag` handling, better messages, retry rules, or better logs.

## What `TaggedErrorClass` Actually Adds

From `refs/effect4/packages/effect/src/Schema.ts:8328-8358`, `TaggedErrorClass` is just a thin wrapper over `ErrorClass` that injects `_tag`:

```ts
export const TaggedErrorClass: {
  <Self, Brand = {}>(identifier?: string): {
    <Tag extends string, const Fields extends Struct.Fields>(
      tag: Tag,
      fields: Fields,
      annotations?: ...
    ): ErrorClass<Self, TaggedStruct<Tag, Fields>, Cause_.YieldableError & Brand>
```

And the implementation:

```ts
return ErrorClass(identifier ?? tagValue)(
  ...
  TaggedStruct(tagValue, schema),
  annotations
)
```

So `TaggedErrorClass` gives you:

- yieldable error behavior
- schema-backed fields
- a `_tag`

It does not give you:

- an automatic `cause`
- an automatic `message`

You still define those explicitly in the schema.

## `Data.TaggedError` Also Does Not Auto-Add `cause`

From `refs/effect4/packages/effect/src/Data.ts:764-768`:

```ts
export const TaggedError: <Tag extends string>(
  tag: Tag
) => new<A extends Record<string, any> = {}>(
  args: ...
) => Cause.YieldableError & { readonly _tag: Tag } & Readonly<A>
```

That means `Data.TaggedError("Foo")<{ cause: unknown }>` can carry `cause`, but only because you put `cause` in the generic fields yourself.

So switching from `Schema.TaggedErrorClass` to `Data.TaggedError` would not remove the need to spell out `cause`.

## What Effect v4 Docs Prefer

The v4 docs and ai-docs overwhelmingly use `Schema.TaggedErrorClass` / `Schema.ErrorClass`, not `Data.TaggedError`, for app-facing errors.

From `refs/effect4/LLMS.md:166-173`:

```ts
// Define custom errors using Schema.TaggedErrorClass
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  input: Schema.String,
  message: Schema.String
}) {}
```

From `refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts:40-42`:

```ts
export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect
}) {}
```

And `refs/effect4` itself often models infrastructure/library-facing errors with explicit cause fields too:

From `refs/effect4/packages/effect/src/unstable/sql/SqlError.ts:11-14`:

```ts
export class SqlError extends Schema.TaggedErrorClass<SqlError>("effect/sql/SqlError")("SqlError", {
  cause: Schema.Defect,
  message: Schema.optional(Schema.String)
}) {}
```

So our repo pattern is aligned with v4:

- `src/lib/D1.ts:57-60`
- `src/lib/R2.ts:46-48`
- `src/lib/KV.ts:71-73`
- `src/lib/InvoiceExtraction.ts:72-76`
- `src/invoice-extraction-workflow.ts:24-29`

## Should We Change Error Base Class?

Probably no.

For this repo, `Schema.TaggedErrorClass` remains the best default because:

- it matches v4 docs
- it gives schema-backed fields
- it works well with `Schema.Defect`
- it keeps `_tag`-based handling easy
- it stays consistent with the rest of the codebase

If anything, the more interesting refinement is not changing base class, but deciding whether `cause` should be required or optional.

## Required vs Optional `cause`

Right now repo errors mostly require `cause`, for example `src/lib/D1.ts:57-60`:

```ts
export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

That is good when the error is specifically a wrapper around foreign failure.

But `refs/effect4` also uses optional cause in some aggregate/user-facing errors.

From `refs/effect4/packages/effect/src/unstable/workers/WorkerError.ts:25-30`:

```ts
export class WorkerSpawnError extends Schema.ErrorClass<WorkerSpawnError>(...)({
  _tag: Schema.tag("WorkerSpawnError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}
```

And from `refs/effect4/packages/effect/src/unstable/http/HttpClientError.ts:239-252`:

```ts
export class HttpClientErrorSchema extends Schema.ErrorClass<HttpClientErrorSchema>(TypeId)({
  _tag: Schema.tag("HttpError"),
  kind: Schema.Literals(...),
  cause: Schema.optional(Schema.Defect)
}) {
```

Reasonable rule:

- use `cause: Schema.Defect` when the error is basically a wrapper around an underlying thrown/rejected value
- use `cause: Schema.optional(Schema.Defect)` when some instances have an underlying defect and some are constructed directly from domain state

Another way to say it:

- required `cause` encodes an invariant: "this error only exists as a wrapper around some other failure"
- optional `cause` encodes a union of construction styles: "sometimes this wraps another failure, sometimes the message itself is the whole error"

That distinction matters more than convenience.

If we make `cause` optional everywhere, we lose the useful signal carried by wrapper-only errors like D1 / R2 / KV. Those errors are better when the type forces us to attach the underlying failure.

If we keep `cause` required everywhere, we end up fabricating causes just to satisfy the schema, which is a smell.

Examples of fabricated causes in this repo before refactor:

- `src/lib/Stripe.ts:246` used `cause: new Error(message)` in `failStripe(...)`
- `src/invoice-extraction-workflow.ts:85-90` created a new `Error(...)` for file-not-found
- `src/lib/InvoiceExtraction.ts:174-177` created a new `Error(...)` for non-2xx AI Gateway status

Those are not really wrapper errors. They are direct application/integration errors with a useful message, so optional `cause` is a better fit there.

## Repo-Level Rule

For this codebase, the clearest rule is:

- keep `cause` required for infra wrapper errors that always come from caught exceptions / rejected Promises
- make `cause` optional for mixed-origin errors that are sometimes wrapped failures and sometimes directly constructed failures

Applied here:

- keep required `cause`: `D1Error`, `R2Error`, `KVError`
- use optional `cause`: `StripeError`, `InvoiceExtractionError`, `InvoiceExtractionWorkflowError`

Why those three are mixed-origin:

- `StripeError` is used both from `tryStripe(...)` and `failStripe(...)`
- `InvoiceExtractionError` is used both from `mapError(...)` wrappers and from explicit non-2xx response handling
- `InvoiceExtractionWorkflowError` is used both from `tryPromise(... catch ...)` wrappers and from direct workflow state checks like missing file / decode failure

## `tryPromise`: Do We Need `catch`?

No, not always.

From `refs/effect4/packages/effect/src/Effect.ts:1104-1109`:

```ts
There are two ways to handle errors with `tryPromise`:

1. If you don't provide a `catch` function, the error is caught and the
   effect fails with an `UnknownError`.
2. If you provide a `catch` function, the error is caught and the `catch`
   function maps it to an error of type `E`.
```

And the actual overload from `refs/effect4/packages/effect/src/Effect.ts:1152-1156`:

```ts
export const tryPromise: <A, E = Cause.UnknownError>(
  options:
    | { readonly try: (signal: AbortSignal) => PromiseLike<A>; readonly catch: (error: unknown) => E }
    | ((signal: AbortSignal) => PromiseLike<A>)
) => Effect<A, E>
```

So:

- function form: `Effect.tryPromise(() => promise)` -> `UnknownError`
- object form: `Effect.tryPromise({ try: ..., catch: ... })` -> your custom error
- object form without `catch` is not the API

## Is `UnknownError` Okay To Let Through More Often?

Sometimes yes.

From `refs/effect4/packages/effect/src/internal/effect.ts:973-975`:

```ts
const catcher = typeof options === "function"
  ? ((cause: unknown) => new UnknownError(cause, "An error occurred in Effect.tryPromise"))
  : options.catch
```

So default `UnknownError` gives you:

- original `cause`
- a generic message
- a typed failure rather than a defect

That is fine when you only need:

- to safely bridge Promise code into Effect
- to log failure generically
- to bubble the failure upward without tag-specific handling

It is weaker when you need:

- meaningful `_tag`s in your own domain
- clearer user/log messages at the boundary
- retry logic keyed off your own error type
- `Effect.catchTag(...)` on a stable app error

## Practical Recommendation For This Repo

Use both styles, intentionally.

### Keep custom `catch` when the boundary matters

Examples:

- `src/lib/D1.ts:71-79`
- `src/lib/R2.ts:58-66`
- `src/lib/KV.ts:83-91`
- `src/lib/Stripe.ts:236-244`
- `src/invoice-extraction-workflow.ts:74-107`
- `src/invoice-extraction-workflow.ts:122-159`

These are integration boundaries where custom tags/messages help.

### Skip custom `catch` when you are only lifting a Promise

Examples already in repo:

- `src/invoice-extraction-workflow.ts:44`
- `src/lib/Auth.ts:48`
- `src/lib/Auth.ts:54`

Those are fine as `UnknownError` if the caller does not need a domain-specific error.

Practical heuristic:

- leaf infra/service helper -> prefer custom `catch`
- thin local bridge where caller already wraps or remaps -> `UnknownError` is often fine

## Applying This To `invoice-extraction-workflow.ts`

At `src/invoice-extraction-workflow.ts:141-159`, the outer `catch` is still worth keeping.

Why:

- it adds step-specific context: `save-extracted-json`
- it keeps workflow failures under `InvoiceExtractionWorkflowError`
- it avoids leaking generic `UnknownError` out of a top-level workflow boundary

But the inner `Effect.promise` was wrong.

That is now fixed in `src/invoice-extraction-workflow.ts:145`:

```ts
Effect.tryPromise(() =>
  agent.saveExtractedJson({
    invoiceId: event.payload.invoiceId,
    idempotencyKey: event.payload.idempotencyKey,
    extractedJson: JSON.stringify(extractedJson),
  }),
)
```

That keeps rejection from `saveExtractedJson(...)` in the normal Effect error channel instead of treating it as a defect first.

## Recommendation

- stay on `Schema.TaggedErrorClass` for repo error classes
- keep spelling out `cause`; there is no more automatic option from the tagged error helpers
- consider `Schema.optional(Schema.Defect)` for higher-level errors that may not always wrap an underlying cause
- use `Effect.tryPromise(() => ...)` without `catch` when `UnknownError` is acceptable
- use object-form `tryPromise({ try, catch })` at important boundaries where tag/message/context matter

## Scan Of Current Custom-`catch` Sites In `src/`

I reviewed the current `Effect.tryPromise({ try, catch })` sites in app code:

- `src/lib/D1.ts:71-79`
- `src/lib/R2.ts:57-72`
- `src/lib/KV.ts:82-100`
- `src/lib/Stripe.ts:235-243`
- `src/invoice-extraction-workflow.ts:74-107`
- `src/invoice-extraction-workflow.ts:122-159`

Question: which of these could reasonably drop custom `catch` and just use `UnknownError`?

### Conclusion

None of the current custom-`catch` sites look like strong candidates.

The places already using bare `Effect.tryPromise(() => ...)` are thin bridges and seem fine as-is, but among the places that currently have custom `catch`, each one is buying something concrete.

### Why The Current Custom Sites Still Earn Their Keep

`src/lib/D1.ts:71-79`

- maps failures into stable `D1Error`
- preserves `message` as a first-class field used by retry logic in `src/lib/D1.ts:81-97`
- keeps the service boundary typed as D1-specific infra failure, not generic `UnknownError`

`src/lib/R2.ts:57-72`

- same pattern as D1
- retry policy depends on `error.message` in `src/lib/R2.ts:67-71`
- `R2Error` makes the service contract explicit

`src/lib/KV.ts:82-100`

- same reasoning as R2/D1
- retry logic is driven off the normalized error message in `src/lib/KV.ts:92-99`
- this is an integration boundary, not a thin Promise lift

`src/lib/Stripe.ts:235-243`

- no retry here, so this is the closest case to being simplifiable
- but the module also defines `StripeError` as the service error type in `src/lib/Stripe.ts:227-246`
- `failStripe(...)` already returns `StripeError`, so using `UnknownError` for Promise rejection would make Stripe failures less uniform inside the same module

`src/invoice-extraction-workflow.ts:74-107`

- `catch` adds step-specific context: `load-file`
- replacing it with `UnknownError` would lose the workflow-level message that identifies which durable step failed

`src/invoice-extraction-workflow.ts:122-159`

- same reasoning for `extract-invoice` and `save-extracted-json`
- these are top-level workflow step boundaries, so adding contextual workflow errors is useful and likely worth the small verbosity cost

### If We Wanted A More Aggressive Simplification

The only site that is even mildly arguable is `src/lib/Stripe.ts:235-243`.

But even there, I would still lean no, because the module already has a deliberate `StripeError` abstraction:

```ts
export class StripeError extends Schema.TaggedErrorClass<StripeError>()(
  "StripeError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

const tryStripe = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new StripeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

Once a service has chosen a named error type, staying consistent is usually more valuable than saving a few lines.

### Bottom Line

If the goal is: "where can we simplify by allowing more `UnknownError`?"

- good candidates are the thin bridge call sites already using bare `Effect.tryPromise(() => ...)`
- among the current custom-`catch` sites, there are no obvious wins
- keep the existing custom `catch` at those boundaries

## Refactor Decision

I would not switch the whole repo to optional `cause`.

I would refactor only the mixed-origin error classes:

- `src/lib/Stripe.ts`
- `src/lib/InvoiceExtraction.ts`
- `src/invoice-extraction-workflow.ts`

And I would leave wrapper-only infra errors alone:

- `src/lib/D1.ts`
- `src/lib/R2.ts`
- `src/lib/KV.ts`

That preserves a strong invariant where it is real, while removing fake `new Error(message)` causes where they were only there to satisfy the schema.
