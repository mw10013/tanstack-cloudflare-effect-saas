# Research: Runtime Validation of ENVIRONMENT

## Problem

`env.ENVIRONMENT` comes from an external system (Cloudflare Workers runtime). Wrangler-generated types give us `"production" | "local"` at compile time, but at runtime an env var can be anything. A misconfigured deployment could set `ENVIRONMENT=prod` and the `=== "production"` checks in `worker.ts:69,76` would silently fall through to dev behavior in production.

## Usage Sites

| Location | Code | Risk |
|----------|------|------|
| `worker.ts:69` | `env.ENVIRONMENT === "production"` | Logger selection — wrong logger in prod |
| `worker.ts:76` | `env.ENVIRONMENT === "production"` | Log level — Debug logs in prod |

## Existing Pattern in Domain.ts

Domain.ts already validates external data with `Values` array + `Schema.Literals`:

```ts
export const UserRoleValues = ["user", "admin"] as const;
export const UserRole = Schema.Literals(UserRoleValues);
export type UserRole = typeof UserRole.Type;
```

## Approaches

### Approach 1: Domain schema + `Schema.decodeUnknownSync` at entry point

Add to `Domain.ts`:

```ts
export const EnvironmentValues = ["production", "local"] as const;
export const Environment = Schema.Literals(EnvironmentValues);
export type Environment = typeof Environment.Type;
```

Validate once in worker.ts `fetch`/`scheduled` before use:

```ts
const environment = Schema.decodeUnknownSync(Domain.Environment)(env.ENVIRONMENT);
// environment: "production" | "local" — runtime-validated
```

**Pros:** Follows existing Domain.ts pattern. Fail-fast on invalid value. Single validation at system boundary.
**Cons:** `decodeUnknownSync` throws — need to decide if that's acceptable in the worker entry (it is — invalid ENVIRONMENT should crash the worker).

### Approach 2: Domain schema + `Config.schema` for Effect pipelines

Same Domain.ts addition, plus a Config accessor:

```ts
// Domain.ts
export const EnvironmentValues = ["production", "local"] as const;
export const Environment = Schema.Literals(EnvironmentValues);
export type Environment = typeof Environment.Type;
```

```ts
// Usage via Config (if needed inside Effect pipelines)
const environment = yield* Config.schema(Domain.Environment, "ENVIRONMENT")
```

For `worker.ts`, since `makeRunEffect` reads `env` outside of Effect, use `Schema.decodeUnknownSync` as in Approach 1.

**Pros:** Covers both direct access and Effect Config access. Validated on both paths.
**Cons:** Slightly more surface area.

### Approach 3: Validation helper function

```ts
// Domain.ts
export const EnvironmentValues = ["production", "local"] as const;
export const Environment = Schema.Literals(EnvironmentValues);
export type Environment = typeof Environment.Type;

export const parseEnvironment = Schema.decodeUnknownSync(Environment);
```

```ts
// worker.ts
const environment = Domain.parseEnvironment(env.ENVIRONMENT);
```

**Pros:** One-liner at call site. Reusable.
**Cons:** Extra export — but it's just `Schema.decodeUnknownSync(Environment)`.

## Decision

**Approach 2** — Domain schema + `Schema.decodeUnknownSync` at entry point for direct access, `Config.schema` for Effect pipelines.