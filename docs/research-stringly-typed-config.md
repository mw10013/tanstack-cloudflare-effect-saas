# Research: Stringly-Typed Config Values

## Problem

`env.ENVIRONMENT === "production"` in `worker.ts:69,76` is stringly typed — a typo like `"Production"` or `"prod"` silently breaks the comparison. Similar risk exists for any `Config.string(...)` call reading enum-like values.

## Current Usage

### Direct `env.ENVIRONMENT` checks (worker.ts)

```ts
// L69 - logger selection
env.ENVIRONMENT === "production" ? [Logger.consoleJson, ...] : [Logger.consolePretty(), ...]
// L76 - log level
env.ENVIRONMENT === "production" ? "Info" : "Debug"
```

### Effect Config string reads (stringly typed)

| File | Line | Config Call | Risk |
|------|------|------------|------|
| `routes/__root.tsx` | 22 | `Config.string("ANALYTICS_TOKEN")` | Low (freeform string) |
| `routes/login.tsx` | 36,54 | `Config.boolean("DEMO_MODE")` | Low (boolean coercion) |
| `lib/Auth.ts` | 33-36 | `Config.nonEmptyString(...)` | Low (freeform) |
| `lib/Auth.ts` | 36 | `Config.redacted(...)` | Low (freeform) |
| `lib/Stripe.ts` | 23 | `Config.redacted("STRIPE_SECRET_KEY")` | Low (freeform) |

None of these are enum-like, so `ENVIRONMENT` is the primary stringly-typed concern.

### Wrangler-generated types (worker-configuration.d.ts)

Wrangler already generates a union type:

```ts
// Cloudflare.Env
ENVIRONMENT: "production" | "local";
// Cloudflare.ProductionEnv
ENVIRONMENT: "production";
```

So `env.ENVIRONMENT === "production"` in worker.ts is already **type-safe at the TypeScript level** — `env` is typed as `Env` which narrows `ENVIRONMENT` to `"production" | "local"`. A typo like `"prod"` would produce a TS error. The real gap is when ENVIRONMENT is accessed via Effect's `ConfigProvider.fromUnknown(env)` + `Config.string("ENVIRONMENT")`, which returns `string` and loses the union.

## Options

### Option A: Status quo — rely on wrangler-generated types

`env.ENVIRONMENT` is already narrowed to `"production" | "local"` via `worker-configuration.d.ts`. Direct comparisons are safe. No changes needed for current code.

**Pros:** Zero effort, already works for direct `env` access.
**Cons:** Doesn't protect Effect Config reads; someone could add `Config.string("ENVIRONMENT")` and get `string`.

### Option B: `Config.literal` for single-value checks

```ts
const isProduction = yield* Config.literal("production", "ENVIRONMENT").pipe(
  Config.map(() => true),
  Config.withDefault(false)
)
```

**Pros:** Effect-idiomatic, validates at config load time.
**Cons:** `Config.literal` only accepts one value — can't express `"production" | "local"` as a union. Must use `Config.withDefault` to handle the non-matching case, which conflates "missing" with "different value".

### Option C: `Config.schema` with `Schema.Literals` for union validation

```ts
const Environment = Config.schema(
  Schema.Literals(["production", "local"]),
  "ENVIRONMENT"
)
// type: Config<"production" | "local">
```

Then in worker.ts:

```ts
const environment = yield* Environment
const loggerLayer = environment === "production"
  ? Logger.consoleJson
  : Logger.consolePretty()
```

**Pros:** Full union type safety through Effect. Fails at config load if value doesn't match. Reusable `Environment` config.
**Cons:** Requires restructuring `makeRunEffect` to read config through Effect instead of raw `env` access — but `makeRunEffect` itself isn't inside an Effect, it builds the runtime. Would need to split config reading from runtime construction.

### Option D: Shared const + type narrowing (simplest)

Define the allowed values and a type guard, used alongside direct `env` access:

```ts
const ENVIRONMENTS = ["production", "local"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

// env.ENVIRONMENT is already typed as "production" | "local" by wrangler
// This is just for any code that needs the type independently
```

**Pros:** Minimal, no runtime overhead, works with existing direct access pattern.
**Cons:** Doesn't add protection beyond what wrangler types already provide. Redundant.

### Option E: Hybrid — shared type + Effect Config for Effect-based reads

Define the config once, use it in Effect pipelines when needed:

```ts
// src/lib/Environment.ts
import { Config, Schema } from "effect"

export const Environment = Config.schema(
  Schema.Literals(["production", "local"]),
  "ENVIRONMENT"
)
```

Keep `env.ENVIRONMENT` direct access in worker.ts (already type-safe via wrangler types). Use `Environment` config in any Effect pipelines that need it.

**Pros:** Best of both worlds — direct access stays simple, Effect reads get validation.
**Cons:** Two access patterns for the same value.

## Recommendation

**Option A (status quo) is sufficient for now.** The wrangler-generated types already narrow `ENVIRONMENT` to `"production" | "local"`, so `env.ENVIRONMENT === "production"` is type-checked. If Effect pipelines later need to read `ENVIRONMENT`, use **Option C** (`Config.schema` + `Schema.Literals`) at that point.

The current `Config.string` / `Config.boolean` / `Config.nonEmptyString` calls are all for freeform values (URLs, secrets, tokens, booleans) — none have the stringly-typed enum problem.


I'm a little confused by all of this. you are writing a lot of mumble jumble with little clarity. First off, we're only focusing on ENVIRONMENT so ignore all that other shit about string, nonEmptyString, and boolean.

I know wrangler types comes up with a union of literals for ENVIRONMENT type, but it's still kind of bullshit. We need to treat env vars as coming from an external system which is the truth. And an env var can be set to anything in a live system after the types have been generated. 

To be robust, we would validate ENVIRONMENT. At least when we use it directly. Less concerned about validating it going into 
Config, but would want to validate it coming out of Config. And I guess one approach could be with a domain type/var/schema in Domain.ts. Do research on this and let's get some viable approaches to choose from.



