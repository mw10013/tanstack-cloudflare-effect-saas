# Research: `D1.first` — Return `Option<T>` vs `T | null`

## Current Signature

```ts
// src/lib/D1.ts L28-32
const first = Effect.fn("D1.first")(function* <T>(
  statement: D1PreparedStatement,
) {
  return yield* tryD1(() => statement.first<T>());
});
```

Returns `Effect<T | null, D1Error>` because Cloudflare's `D1PreparedStatement.first<T>()` returns `Promise<T | null>`.

## Current Consumer Pattern (Repository.ts)

Every call site wraps the null with `Effect.fromNullishOr` + `Effect.catchNoSuchElement`:

```ts
// src/lib/Repository.ts L12-19
const result =
  yield *
  d1.first(d1.prepare(`select * from User where email = ?1`).bind(email));
return (
  yield *
  Effect.fromNullishOr(result).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Domain.User)),
    Effect.catchNoSuchElement,
  )
);
```

This 3-line `fromNullishOr → flatMap → catchNoSuchElement` pattern repeats in `getUser`, `getMemberByUserAndOrg`, `getOwnerOrganizationByUserId`.

Some callers (e.g. `getUsers`, `getAppDashboardData`) pass the nullable result straight into `Schema.decodeUnknownEffect` because those queries always return a JSON aggregate row (never null).

## Effect v4 `Option` — Key Concepts

### What is `Option`

Discriminated union: `None | Some<A>`. Type-safe replacement for `null`/`undefined`.

- `None` = absence (singleton, `{ _tag: 'None' }`)
- `Some<A>` = presence (value accessed via `.value`, `{ _tag: 'Some', value: A }`)

Source: `node_modules/effect/src/Option.ts` L1-13

### Constructors

| Function                  | Input                    | Output                   |
| ------------------------- | ------------------------ | ------------------------ |
| `Option.some(value)`      | `A`                      | `Some<A>`                |
| `Option.none()`           | —                        | `None`                   |
| `Option.fromNullishOr(a)` | `A \| null \| undefined` | `Option<NonNullable<A>>` |
| `Option.fromIterable(xs)` | `Iterable<A>`            | `Option<A>` (head)       |

Source: `Option.ts` L301, L334, L1184, L626

### Guards & Pattern Matching

```ts
Option.isSome(opt)  // type guard → opt is Some<A>
Option.isNone(opt)  // type guard → opt is None<A>
Option.match(opt, { onNone: () => ..., onSome: (a) => ... })
```

Source: `Option.ts` L400, L430, L465

### Getters (Unwrapping)

```ts
Option.getOrElse(opt, () => fallback); // lazy fallback
Option.getOrNull(opt); // → A | null
Option.getOrUndefined(opt); // → A | undefined
Option.getOrThrow(opt); // throws on None
Option.getOrThrowWith(opt, () => error); // throws custom error
```

Source: `Option.ts` L728, L1369, L1444

### Transformations

```ts
Option.map(opt, f); // Some(a) → Some(f(a)), None → None
Option.flatMap(opt, f); // Some(a) → f(a): Option<B>, None → None
Option.filter(opt, p); // Some(a) if p(a), else None
Option.orElse(opt, () => fallbackOpt);
Option.orElseSome(opt, () => fallbackValue);
```

### Option is Yieldable in `Effect.gen`

Yielding `Option` in `Effect.gen` unwraps `Some` or short-circuits with `NoSuchElementError`:

```ts
// From Option.ts L37: "When yielded in Effect.gen, a None becomes a NoSuchElementError defect"
```

This is the bridge between `Option` and `Effect` — you can yield an Option to get the value, then use `Effect.catchNoSuchElement` to recover into `Option` at the effect level.

### Effect ↔ Option Bridge

```ts
Effect.fromNullishOr(value); // null/undefined → Effect fails with NoSuchElementError
// otherwise → Effect succeeds with NonNullable<A>

Effect.fromOption(opt); // None → Effect fails with NoSuchElementError
// Some(a) → Effect succeeds with a

Effect.catchNoSuchElement; // Catches NoSuchElementError, converts:
// success A → Option.some(A)
// NoSuchElementError → Option.none()
```

Source: `Effect.ts` L2455, L2427, L5629

### Idiomatic v4 Pattern: `fromNullishOr` + `catchNoSuchElement`

```ts
// Effect.ts L5613-5614 — official example
const some = Effect.fromNullishOr(1).pipe(Effect.catchNoSuchElement);
const none = Effect.fromNullishOr(null).pipe(Effect.catchNoSuchElement);
```

### Idiomatic v4 Pattern: Service returning `Option`

From the official Effect v4 docs (`refs/effect4/ai-docs/src/01_effect/02_services/20_layer-composition.ts`):

```ts
export class UserRepository extends ServiceMap.Service<UserRepository, {
  findById(id: string): Effect.Effect<
    Option.Option<{ readonly id: string; readonly name: string }>,
    UserRespositoryError
  >
}>()("myapp/UserRepository") { ... }
```

The `findById` implementation uses `Array.head(results)` which returns `Option`.

### Codebase Usage

Existing `Option` usage in this codebase:

```ts
// Auth.ts L169-172 — map + getOrUndefined
activeOrganizationId: Option.map(activeOrganization, (org) => org.id)
  .pipe(Option.getOrUndefined)

// Auth.ts L341 — isSome guard
Option.isSome(member) && member.value.role === "owner"

// Stripe.ts L90-93 — Schema.decodeUnknownOption
const parseResult = Schema.decodeUnknownOption(Schema.Array(PlanSchema))(cachedPlans);
if (Option.isSome(parseResult)) { ... }

// e2e route — isNone guard + .value access
if (Option.isNone(userOption)) { return ... }
const user = userOption.value;
```

## Analysis: Should `D1.first` Return `Option<T>`?

### Option A: Change `D1.first` to return `Effect<Option<T>, D1Error>`

```ts
const first = Effect.fn("D1.first")(function* <T>(
  statement: D1PreparedStatement,
) {
  return yield* tryD1(() => statement.first<T>()).pipe(
    Effect.map(Option.fromNullishOr),
  );
});
```

**Pros:**

- Aligns with Effect v4 idiom — the official `UserRepository.findById` example returns `Option`
- Eliminates repeated `Effect.fromNullishOr(result)` at every "find" call site
- Absence is encoded in the type system — callers must handle `None` explicitly
- Composes naturally with `Option.map`, `Option.flatMap`, `Option.match`
- Consistent with `Array.head`, `Stream.runHead`, `Stream.runLast` — all return `Option`

**Cons:**

- Callers that know the result is never null (aggregate JSON queries) must now unwrap an `Option` that is always `Some` — adds friction. E.g. `getUsers`, `getAppDashboardData`, `getAdminDashboardData` etc.
- Introduces a wrapper object allocation on every call (minor perf, negligible in practice)

### Option B: Keep `T | null` at D1, handle at Repository

**Pros:**

- D1 stays a thin wrapper around the Cloudflare API — mirrors the platform exactly
- Callers that know the result is non-null can use it directly without unwrapping
- Current pattern (`fromNullishOr → flatMap → catchNoSuchElement`) already works

**Cons:**

- Null handling is not in the type-safe Effect/Option world at the D1 layer
- Every "find" consumer repeats the same 3-line conversion boilerplate

### Option C (Hybrid): Keep D1 as-is, add a `firstOption` helper

```ts
const firstOption = Effect.fn("D1.firstOption")(function* <T>(
  statement: D1PreparedStatement,
) {
  return yield* tryD1(() => statement.first<T>()).pipe(
    Effect.map(Option.fromNullishOr),
  );
});
```

Callers that need `Option` use `firstOption`; callers that know the row exists use `first`.

**Pros:** No breaking change, opt-in ergonomics
**Cons:** Two ways to do the same thing; surface area grows

## Recommendation

**Option A: Change `D1.first` to return `Effect<Option<T>, D1Error>`.**

We go with this option.

Rationale:

1. **Idiomatic** — Effect v4 models "maybe absent" as `Option`, not `T | null`. The canonical `UserRepository.findById` example in Effect v4 docs returns `Option.Option<...>`.
2. **Eliminates boilerplate** — The 3-line `fromNullishOr → flatMap → catchNoSuchElement` pattern in Repository is duplicated 3 times and will grow.
3. **Type safety** — `Option` forces callers to handle absence. `T | null` is easy to forget.
4. **Aggregate query callers** — These callers can simply `Option.getOrThrow` or yield the `Option` in `Effect.gen` (which short-circuits with `NoSuchElementError` on `None`). The aggregate queries are known to never return null, so this is safe and the overhead is one function call.

Impact on existing callers in Repository.ts:

**"Find" callers** (3 sites: `getUser`, `getMemberByUserAndOrg`, `getOwnerOrganizationByUserId`) simplify:

```ts
// Before
const result = yield* d1.first(...);
return yield* Effect.fromNullishOr(result).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Domain.User)),
  Effect.catchNoSuchElement,
);

// After
const result = yield* d1.first(...);
return yield* Effect.fromOption(result).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Domain.User)),
  Effect.catchNoSuchElement,
);
```

The change is minimal: `Effect.fromNullishOr(result)` → `Effect.fromOption(result)`. Both produce `Effect<A, NoSuchElementError>`, so the rest of the pipeline (`flatMap` decode, `catchNoSuchElement`) stays the same.

**Aggregate callers** (6 sites: `getUsers`, `getAppDashboardData`, etc.) add a simple unwrap:

```ts
// Before
const result = yield* d1.first(...);
return yield* Schema.decodeUnknownEffect(DataFromResult(...))(result);

// After
const result = yield* d1.first(...);
return yield* Effect.fromOption(result).pipe(
  Effect.flatMap((row) => Schema.decodeUnknownEffect(DataFromResult(...))(row)),
);
```

**Why no `catchNoSuchElement` here?** The two caller types have different semantics:

- **Find callers** return `Option<User>` — the row legitimately may not exist. `catchNoSuchElement` converts `NoSuchElementError` → `Option.none()`, making absence a normal success value.
- **Aggregate callers** return a decoded struct (e.g. `{ users: User[], count: number }`). The row is always present because `json_object(...)` always produces a result. `None` should never happen — if it does, it's a bug, so we *want* the `NoSuchElementError` to propagate as a failure rather than silently swallowing it into an `Option.none()`.

In short: find callers use `catchNoSuchElement` because absence is expected. Aggregate callers omit it because absence is a defect.
