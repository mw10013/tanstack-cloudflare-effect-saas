# Effect v4 Config Research: `CloudflareEnv` vs `env` vs `Config`

## Bottom Line

- `Config` is already wired for the Worker runtime. `src/worker.ts` installs `ConfigProvider.fromUnknown(env)`, so any Effect running through `runEffect` can read Cloudflare env vars via `Config`.
- In current app runtime code, `CloudflareEnv` is only used for real Cloudflare bindings: `D1`, `KV`, and raw `D1Database` for Better Auth. That is correct.
- Only 2 remaining scalar env reads in `src/` should move to `Config`:
  - `src/worker.ts` logger selection via `env.ENVIRONMENT`
  - `src/routes/__root.tsx` analytics token via `env.ANALYTICS_TOKEN`

## Grounding

### Current `Config` wiring

`src/worker.ts:53-58`:

```ts
const envLayer = Layer.succeedServices(
  ServiceMap.make(CloudflareEnv, env).pipe(
    ServiceMap.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(env),
    ),
  ),
);
```

This is the key point. The Worker runtime already exposes both:

- `CloudflareEnv` for the full raw `Env`
- `ConfigProvider` backed by the same `env` object

### Generated `Env` shape

`worker-configuration.d.ts:8-30`:

```ts
interface Env {
  PORT: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ANALYTICS_TOKEN: string;
  KV: KVNamespace;
  D1: D1Database;
  MAGIC_LINK_RATE_LIMITER: RateLimit;
  ENVIRONMENT: "production" | "local";
  DEMO_MODE: "true";
  TRANSACTIONAL_EMAIL: "noreply@example.com";
}
```

This splits cleanly into:

- scalar config: `PORT`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANALYTICS_TOKEN`, `ENVIRONMENT`, `DEMO_MODE`, `TRANSACTIONAL_EMAIL`
- bindings: `KV`, `D1`, `MAGIC_LINK_RATE_LIMITER`

### Cloudflare docs

Cloudflare’s env var docs say env vars are available on the Worker `env` parameter, and the bindings docs describe bindings as capability APIs rather than plain strings:

- `refs/cloudflare-docs/src/content/docs/workers/configuration/environment-variables.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/runtime-apis/bindings/index.mdx`

Relevant direction from those docs:

- env vars are text / JSON config values on `env`
- bindings like KV / D1 / Rate Limit are runtime APIs
- bindings can be reached through `env`, but they are not the same category of data as scalar config

### Effect docs

Effect’s docs match the pattern already in this repo:

`refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts`:

```ts
static readonly layer = Layer.unwrap(
  Effect.gen(function*() {
    const useInMemory = yield* Config.boolean("MESSAGE_STORE_IN_MEMORY").pipe(
      Config.withDefault(false)
    )
```

`refs/effect4/ai-docs/src/01_effect/04_resources/10_acquire-release.ts`:

```ts
const user = yield* Config.string("SMTP_USER")
const pass = yield* Config.redacted("SMTP_PASS")
```

So the Effect-native split is:

- use `Config` for scalar strings / booleans / numbers / secrets
- use services for runtime resources and bindings

## Current Inventory

### `CloudflareEnv` usage in `src/`

| Location | Current code | Kind | Should use `Config` instead? |
|---|---|---|---|
| `src/lib/CloudflareEnv.ts:3` | `ServiceMap.Service<Env>("CloudflareEnv")` | service tag | No |
| `src/worker.ts:53-58` | `ServiceMap.make(CloudflareEnv, env)` | wiring | No |
| `src/lib/D1.ts:6` | `const { D1: d1 } = yield* CloudflareEnv;` | binding | No |
| `src/lib/KV.ts:19` | `const { KV: kv } = yield* CloudflareEnv;` | binding | No |
| `src/lib/Auth.ts:38` | `const { D1: database } = yield* CloudflareEnv;` | binding | No |

Finding:

- there are currently no scalar env reads through `CloudflareEnv` in `src/`
- `CloudflareEnv` is already narrowed to binding access

### Direct `env` usage in `src/`

| Location | Current code | Kind | Recommendation |
|---|---|---|---|
| `src/worker.ts:69-76` | `env.ENVIRONMENT === "production"` | scalar env var | Migrate to `Config` |
| `src/worker.ts:142` | `env.MAGIC_LINK_RATE_LIMITER.limit(...)` | binding | Keep on `env` / binding service |
| `src/worker.ts:148` | `d1: env.D1` | binding | Keep on `env` |
| `src/worker.ts:164` | `context: { env, ... }` | context plumbing | Optional to keep; avoid new scalar reads from it |
| `src/routes/__root.tsx:19-24` | `analyticsToken: env.ANALYTICS_TOKEN ?? ""` | scalar env var | Migrate to `Config` |

### Existing `Config` usage in `src/`

These are already aligned with Effect v4:

`src/lib/Auth.ts:32-36`:

```ts
const authConfig = yield* Config.all({
  betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
  betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
  transactionalEmail: Config.nonEmptyString("TRANSACTIONAL_EMAIL"),
  stripeWebhookSecret: Config.redacted("STRIPE_WEBHOOK_SECRET"),
});
```

`src/lib/Stripe.ts:23-25`:

```ts
const stripeSecretKey = yield* Config.redacted("STRIPE_SECRET_KEY");
const stripe = new StripeClient.Stripe(Redacted.value(stripeSecretKey), {
```

`src/routes/login.tsx:35-37` and `src/routes/login.tsx:53-55`:

```ts
const demoMode = yield* Config.boolean("DEMO_MODE");
```

## Where `Config` Should Replace `env`

### 1. `src/worker.ts` logger environment branch

Current code, `src/worker.ts:67-77`:

```ts
const loggerLayer = Layer.merge(
  Logger.layer(
    env.ENVIRONMENT === "production"
      ? [Logger.consoleJson, Logger.tracerLogger]
      : [Logger.consolePretty(), Logger.tracerLogger],
    { mergeWithExisting: false },
  ),
  Layer.succeed(
    References.MinimumLogLevel,
    env.ENVIRONMENT === "production" ? "Info" : "Debug",
  ),
);
```

Why this is a `Config` fit:

- `ENVIRONMENT` is scalar config, not a binding
- Effect docs already show config-driven layer selection with `Layer.unwrap(...)`
- this is the last direct scalar read inside Worker bootstrap

Recommended shape:

```ts
const loggerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* Config.string("ENVIRONMENT");
    return Layer.merge(
      Logger.layer(
        environment === "production"
          ? [Logger.consoleJson, Logger.tracerLogger]
          : [Logger.consolePretty(), Logger.tracerLogger],
        { mergeWithExisting: false },
      ),
      Layer.succeed(
        References.MinimumLogLevel,
        environment === "production" ? "Info" : "Debug",
      ),
    );
  }),
);
```

If you want runtime validation tighter than `string`, use `Config.schema(Schema.Literal("local", "production"), "ENVIRONMENT")`.

### 2. `src/routes/__root.tsx` analytics token

Current code, `src/routes/__root.tsx:18-25`:

```ts
const getAnalyticsToken = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect, env } }) =>
    runEffect(
      Effect.succeed({
        analyticsToken: env.ANALYTICS_TOKEN ?? "",
      }),
    ),
);
```

Why this is a `Config` fit:

- `ANALYTICS_TOKEN` is scalar config
- the handler already runs inside `runEffect`
- local `wrangler.jsonc` sets `ANALYTICS_TOKEN` to `""`, so empty-string default behavior matters

Recommended shape:

```ts
const getAnalyticsToken = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const analyticsToken = yield* Config.string("ANALYTICS_TOKEN").pipe(
          Config.withDefault(""),
        );
        return { analyticsToken };
      }),
    ),
);
```

Use `Config.string(...).pipe(Config.withDefault(""))`, not `Config.nonEmptyString(...)`, because current behavior explicitly allows empty.

## Where `Config` Should Not Replace `CloudflareEnv` / `env`

### `src/lib/D1.ts`

`src/lib/D1.ts:6`:

```ts
const { D1: d1 } = yield* CloudflareEnv;
```

Keep this as-is. `D1` is a Cloudflare runtime binding, not scalar config.

### `src/lib/KV.ts`

`src/lib/KV.ts:19`:

```ts
const { KV: kv } = yield* CloudflareEnv;
```

Keep this as-is. `KV` is a binding API.

### `src/lib/Auth.ts`

`src/lib/Auth.ts:38`:

```ts
const { D1: database } = yield* CloudflareEnv;
```

Keep this as-is. Better Auth needs the raw `D1Database` object, not a scalar config value.

### `src/worker.ts` rate limiter and D1 session setup

`src/worker.ts:142` and `src/worker.ts:148`:

```ts
const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });

const d1SessionService = createD1SessionService({
  d1: env.D1,
```

Keep both on raw `env` or on dedicated binding services. They are request-time binding calls.

## Non-App / Out Of Scope Usage

These are env usages in the repo, but not good `Effect.Config` migration targets in the current architecture:

| Location | Current code | Why out of scope |
|---|---|---|
| `playwright.config.ts` | `process.env.PORT`, `process.env.CI` | Node config, not Worker Effect runtime |
| `e2e/utils.ts` | `process.env.PORT` | Node e2e utility |
| `package.json` scripts | `source .env`, `$PORT`, `--env production` | shell / Wrangler CLI |
| `test/test-utils.ts` | `env.D1` from `cloudflare:test` | test harness binding |
| `test/apply-migrations.ts` | `env.D1`, `env.TEST_MIGRATIONS` | test harness binding |
| `test/integration/auth.test.ts` | `env.KV`, `process.env.BETTER_AUTH_URL` | test code, not app runtime layer |
| `scripts/d1-reset.ts` | CLI `--env` arg | script argument, not runtime config service |

## Recommended Next Steps

1. Migrate `src/worker.ts` `ENVIRONMENT` reads to a config-driven `loggerLayer` using `Layer.unwrap(...)`.
2. Migrate `src/routes/__root.tsx` `ANALYTICS_TOKEN` read to `Config.string("ANALYTICS_TOKEN").pipe(Config.withDefault(""))`.
3. Keep `CloudflareEnv` only for bindings. The codebase is already close to that target.
4. After step 2, avoid introducing new `context.env.X` scalar reads in route modules. Prefer `Config` inside `runEffect`.

## Final Assessment

Current state is already mostly correct:

- `Config` is the right tool for scalar env vars and secrets, and the repo already uses it in `Auth`, `Stripe`, and `login`
- `CloudflareEnv` is the right tool for `D1` and `KV`
- remaining migration surface in runtime app code is small: 2 scalar callsites
