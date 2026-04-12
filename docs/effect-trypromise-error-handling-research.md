# `Effect.tryPromise` Error Handling Research

## Problem

`Effect.tryPromise(() => ...)` without a `catch` handler wraps rejections in `Cause.UnknownError` (renamed from `UnknownException` in v4) with the message `"An error occurred in Effect.tryPromise"`. After TanStack Start serializes errors (only `.message` survives via seroval's `ShallowErrorPlugin`), the client sees this useless string instead of the actual error.

This bit us on login: D1 was returning `no such table: Verification` but the UI showed `"An error occurred in Effect.tryPromise"`.

## How Errors Flow Through the Stack

`src/worker.ts:60-95` `makeRunEffect`:

```
Effect.tryPromise rejection
  → catch handler (if provided) maps to typed error
  → OR bare tryPromise wraps in UnknownException(message="An error occurred in Effect.tryPromise")
  → error channel flows through pipeline
  → runPromiseExit captures Exit
  → Cause.squash(exit.cause) extracts primary error
  → if Error with empty .message → Cause.pretty() fills it in
  → thrown to TanStack Start
  → ShallowErrorPlugin serializes ONLY .message
  → client receives Error(message)
```

The `Cause.squash` → `Cause.pretty` fallback in worker.ts handles the case where `.message` is falsy, but `UnknownException` has a non-empty `.message` (`"An error occurred in Effect.tryPromise"`), so the pretty-print path is skipped. The unhelpful default message survives all the way to the client.

## Current State: Bare vs Handled tryPromise

### Infrastructure services with catch handlers (4 services)

All follow the same pattern via a `tryXxx` helper:

`src/lib/D1.ts:71-79`:
```ts
const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new D1Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

- **D1.ts** — `D1Error` with retry logic for transient `D1_ERROR` signals
- **KV.ts** — `KVError` with auto-retry + exponential backoff
- **R2.ts** — `R2Error` with retry on specific error codes (10001, 10043, etc.)
- **Stripe.ts** — `StripeError` with `optional(Defect)` cause

### Bare tryPromise calls (~43 instances)

**Auth service (`src/lib/Auth.ts`):**
- Line 52: `auth.handler(request)`
- Line 58: `auth.api.getSession({ headers })`
- Line 367: `auth.api.signOut({ headers })`

**Login (`src/lib/Login.ts`):**
- Line 28: `auth.api.signInMagicLink({...})` ← the one that triggered this investigation

**Queue/provisioning (`src/lib/Q.ts`, `UserProvisioning.ts`):**
- Q.ts:50 — `env.Q.send(message)`
- Q.ts:62 — `stub.setName(organizationId)`
- Q.ts:84, Q.ts:96 — DO stub calls
- UserProvisioning.ts:48 — `env.USER_PROVISIONING_WORKFLOW.createBatch([...])`

**Invoices (`src/lib/Invoices.ts`):**
- Lines 31, 49, 59, 84, 104, 111 — stub calls, dynamic imports, R2 signed URLs

**Route handlers (`src/routes/`):**
- 30+ instances across app routes — mostly `auth.api.*` calls

**Workflows:**
- user-provisioning-workflow.ts — `auth.api.createOrganization`, `auth.api.addMember`
- invoice-extraction-workflow.ts — `reportProgress`, `saveInvoiceExtraction`

## Effect v4 Idiomatic Patterns

From `refs/effect4/.patterns/error-handling.md`:

### Data.TaggedError — for discrimination
```ts
class RequestError extends Data.TaggedError("RequestError")<{
  reason: "Transport" | "Encode" | "InvalidUrl"
  cause?: unknown
}> {}
```
Use when you need `Effect.catchTag("RequestError", ...)`.

### Schema.TaggedErrorClass — for serialization
```ts
class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
```
Use when errors cross service boundaries or need JSON round-trips. This is what the codebase uses for D1, KV, R2, Stripe.

### Recommended catch pattern
```ts
Effect.tryPromise({
  try: () => somePromise(),
  catch: (cause) => new MyError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  }),
})
```

## Options

### Option A: Add AuthError, fix Auth + Login only

Add `AuthError extends Schema.TaggedErrorClass` to `Auth.ts`. Update the 3 bare calls in Auth.ts + 1 in Login.ts. Leave the 40+ other bare calls alone.

**Pro:** Targeted fix for the auth boundary where errors surface to end users.
**Con:** Inconsistent — route-level bare calls (30+ `auth.api.*`) still produce `UnknownException`. Does not address Q, Invoices, Workflows.

### Option B: Add AuthError + wrap all auth.api calls

Same as A, but also fix the 30+ `auth.api.*` calls in route handlers.

**Pro:** All auth errors typed and surfaced with real messages.
**Con:** Large diff across many route files. Still doesn't address Q, Invoices, Workflows.

### Option C: Fix the catch-all in worker.ts (chosen)

Instead of per-call catch handlers, improve `makeRunEffect` to extract the original error from `Cause.UnknownError`.

Effect v4 provides `Cause.isUnknownError(u): u is UnknownError` as the public API for detecting these. The `UnknownError` stores the original rejection in `.cause`. No string matching or casting needed.

```ts
if (squashed instanceof Error) {
  if (Cause.isUnknownError(squashed) && squashed.cause instanceof Error) {
    squashed.message = squashed.cause.message;
  } else if (!squashed.message) {
    squashed.message = pretty;
  }
  throw squashed;
}
```

**Pro:** One change fixes all 43+ bare tryPromise calls. No diff across service/route files. Uses Effect's public API (`Cause.isUnknownError`), not internals.
**Con:** Doesn't give typed errors for retry/catchTag. But that's only needed for infrastructure services (D1, KV, R2, Stripe) which already have typed errors.

### Option D: Fix worker.ts catch-all + add AuthError for auth boundary

Combine C (so bare calls always produce useful messages) with A (so auth errors are typed for potential retry/discrimination).

**Pro:** Best of both worlds — safety net at the boundary + typed errors where it matters most.
**Con:** Two changes to maintain.

## Decision

**Option C.** Applied in `src/worker.ts:89-93`.

The infrastructure services (D1, KV, R2, Stripe) already define `TaggedErrorClass` errors with catch handlers for retry logic. The remaining bare `tryPromise` calls (auth, routes, queues, workflows) don't need typed errors — they just need the actual error message to reach the UI instead of the generic `UnknownError` wrapper.

## Effect v4 API Notes

- `Cause.UnknownException` was renamed to `Cause.UnknownError` in v4
- `Cause.isUnknownError(u)` — public type guard
- `Cause.UnknownErrorTypeId` — symbol ID: `"~effect/Cause/UnknownError"`
- `UnknownError` extends `TaggedError("UnknownError")<{ cause: unknown; message?: string }>`
- `.cause` holds the original thrown value, `.message` holds the wrapper message

## Relevant Files

- `src/worker.ts:60-96` — `makeRunEffect` error handling (fix applied here)
- `src/lib/D1.ts:57-79` — `D1Error` + `tryD1` pattern (the gold standard in this codebase)
- `src/lib/Auth.ts:52-64` — bare tryPromise calls in Auth service
- `src/lib/Login.ts:28-33` — bare tryPromise that triggered this investigation
- `refs/effect4/.patterns/error-handling.md` — Effect v4 error patterns
- `refs/effect4/packages/effect/src/Cause.ts:1532` — `isUnknownError` definition
- `refs/effect4/packages/effect/test/Cause.test.ts:800-833` — `UnknownError` tests
