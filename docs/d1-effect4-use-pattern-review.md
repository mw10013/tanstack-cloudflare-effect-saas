# D1 Review Against Effect v4 `use` Research

Question: after grounding the `use` research in Effect v4, does `src/lib/D1.ts` need refactoring?

## Short Answer

Your understanding is correct:

- the Effect v3 `use` pattern is mostly not relevant in the literal API sense for Effect v4
- it is still relevant in the philosophical sense

For `src/lib/D1.ts`, the philosophy mostly already applies.

`src/lib/D1.ts` is already a solid v4-style service:

- `ServiceMap.Service` with `make`
- explicit `Layer.effect(...)`
- foreign Promise boundary wrapped with `Effect.tryPromise`
- public methods traced with `Effect.fn(...)`
- retries centralized in one place

So I would not do a large refactor.

The one meaningful design tension is that `prepare` exposes the raw `D1PreparedStatement`, which leaks the foreign API past the service boundary.

## What `D1.ts` Already Gets Right

From `src/lib/D1.ts:4`:

```ts
export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
```

This matches the v4 service shape from `refs/effect4/migration/services.md:173`:

```ts
In v4, `ServiceMap.Service` with `make` stores the constructor effect on the
class but does not auto-generate a layer. Define layers explicitly using
`Layer.effect`.
```

And `src/lib/D1.ts:53` does exactly that:

```ts
static readonly layer = Layer.effect(this, this.make);
```

The foreign async boundary is also wrapped correctly.

From `src/lib/D1.ts:70`:

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

That is aligned with `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:45`:

```ts
// `Effect.tryPromise` wraps Promise-based APIs that can reject or throw.
```

And the public methods are effect-native, traced methods, e.g. `src/lib/D1.ts:18`:

```ts
const run = Effect.fn("D1.run")(function* <T = Record<string, unknown>>(
  statement: D1PreparedStatement,
  options?: {
    readonly idempotentWrite?: boolean;
  },
) {
```

That lines up with the general v4 docs/examples where service methods are exposed as `Effect.fn(...)` methods.

## What Does Not Match The Strongest Boundary Style

The main mismatch with the strongest v4 interpretation of the research is `src/lib/D1.ts:7`:

```ts
const prepare = (query: string) => d1.prepare(query);
```

This means the service publicly exposes raw Cloudflare D1 prepared statements.

And repo usage depends on that.

From `src/lib/Repository.ts:12`:

```ts
const result =
  yield *
  d1.first(d1.prepare(`select * from User where email = ?1`).bind(email));
```

So today the effective public API is not just:

- `run`
- `first`
- `batch`

It is also:

- raw statement creation via `prepare(...).bind(...)`

That matters because it weakens the boundary.

More concretely: my concern is not that `prepare` exists. D1 requires prepared statements, so someone obviously has to create them.

The real design question is:

- who creates the `D1PreparedStatement`
- when it gets created
- where that logic lives

## Why `prepare` Is The Main Tension

From the v4 research, the strongest architectural direction is:

- keep the foreign library at the edge
- expose focused Effect-native methods
- avoid making app code depend directly on raw foreign types when possible

`prepare` cuts across that a bit.

What leaks through today:

- callers know about `D1PreparedStatement`
- callers call raw `.bind(...)`
- callers assemble batches from raw statements
- callers can potentially bypass wrappers if they ever gain access to other raw D1 methods

So the service is only partially hiding the foreign API.

Put concretely:

- current design: `Repository` creates raw D1 statements, `D1` executes them
- stricter boundary design: `D1` creates raw D1 statements and also executes them

That is the actual trade-off I am pointing at.

## Is That Bad Enough To Refactor Now?

Probably not.

Why I would not rush to refactor:

- the actual effectful execution boundary is still centralized in `tryD1`
- retries are still centralized in `retryIfIdempotentWrite`
- `prepare(...)` itself is synchronous and cheap
- the current API is ergonomic for SQL composition
- `src/lib/Repository.ts` uses this pattern heavily, so removing it would be a broad mechanical refactor with limited payoff

So while `prepare` is philosophically less pure, the important correctness boundary is still mostly in one place.

So to be explicit: I do not have strong animosity to `prepare` itself.

I only mean that exposing it publicly makes repository code participate in the raw D1 API instead of having `D1` fully encapsulate that API.

That can be a perfectly reasonable trade-off.

## What A More "Pure" v4 Shape Would Look Like

If you wanted to move closer to the research, the direction would be:

- stop exposing raw `prepare`
- expose narrower helpers that take SQL + params directly
- keep statement creation internal

Conceptually:

```ts
first(sql, ...params)
run(sql, ...params, options)
batch([...])
```

In that shape, the answer to who / when / where is concrete:

- who creates `D1PreparedStatement`: the `D1` service
- when: inside `first`, `run`, `all`, or `batch`, right before execution
- where: inside `src/lib/D1.ts`, not in `src/lib/Repository.ts`

Example:

```ts
const first = Effect.fn("D1.first")(function* <T>(
  sql: string,
  ...params: ReadonlyArray<unknown>
) {
  return yield* tryD1(() =>
    d1
      .prepare(sql)
      .bind(...params)
      .first<T>(),
  ).pipe(Effect.map(Option.fromNullishOr));
});
```

And the repository call site would become:

```ts
const result = yield * d1.first("select * from User where email = ?1", email);
```

first looks pretty good. Show me run. Note that options are optional.

That would better match the research principle:

- raw D1 client hidden
- statement details hidden
- one service boundary owns all D1 semantics

But it also makes some call sites less flexible, especially if you want to compose statements before execution.

For `batch`, there is then a second design choice:

- still accept raw `D1PreparedStatement[]`
- or accept your own data shape like `{ sql, params }[]` and build the prepared statements inside `D1`

Example:

```ts
batch([
  { sql: "insert into User (id, email) values (?1, ?2)", params: [id, email] },
  {
    sql: "insert into Member (userId, organizationId) values (?1, ?2)",
    params: [id, orgId],
  },
]);
```

Then again, `D1` owns statement creation.

first looked pretty good to me, but batch starts to look a little turgid. Do we really want to abstract over D1PreparedStatement. I'm still on the fence.

## Concrete Refactor Candidates

### 1. Keep as-is

This is my recommendation right now.

Reason:

- current design is already broadly aligned with v4 idioms
- the main gap is architectural purity, not an obvious bug or major complexity problem

### 2. Small cleanup only

Reasonable tiny refactors:

- possibly add a `query` / `all` helper if repeated patterns show up

This would improve style without changing the API shape much.

### 3. Bigger boundary-tightening refactor

Only worth doing if you want to deliberately hide raw D1 types from repository code.

That would mean:

- replacing public `prepare`
- changing `Repository` call sites from `d1.prepare(...).bind(...)` into direct `d1.first(sql, ...params)` / `d1.run(sql, ...params)` style helpers
- possibly adding typed helpers for multi-statement batches

This is architecturally cleaner, but I do not think the payoff is high enough yet.

## Does `D1.ts` Need A Literal `use` Method?

No.

That would not be an improvement.

Based on `refs/effect4/migration/services.md:126`, v4 already prefers explicit service access with `yield*` over leaning on `use` everywhere.

And for `D1`, public domain helpers like `run`, `first`, and `batch` are a better v4 fit than a generic callback API like:

```ts
d1.use((rawD1) => ...)
```

That would actually move the design away from the stronger v4 direction by leaking more raw D1 behavior to call sites.

## Bottom Line

Yes: the right reading is that the v3 `use` pattern is mostly philosophically relevant in v4, not literally something to reproduce.

Applied to `src/lib/D1.ts`:

- no, it should not gain a custom `use` method
- no, it does not need a major refactor
- yes, it already follows the important v4 ideas
- the only notable gap is that `prepare` leaks the raw D1 API, but that is currently a pragmatic trade-off more than a pressing design problem

If you want to tighten it later, the best direction is not `use`.

It is replacing public `prepare` with more focused SQL helpers that keep raw D1 statements fully inside the service.
