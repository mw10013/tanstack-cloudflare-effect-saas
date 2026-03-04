# Effect 4 Config: Object Bindings Not Supported

## Problem

Cloudflare Workers expose resources (D1, R2, KV, Durable Objects) as **object bindings** on the `env` parameter. Effect's Config system is **string-based** — leaf values are always strings. You can't pass a `D1Database` instance through Config.

## Prior Art

[cloudflare-effect-config-object-poc](https://github.com/mw10013/cloudflare-effect-config-object-poc) proposed `Config.object` and `ConfigProvider.fromObject` for Effect 3. The POC worked by type-punning object references as strings through `ConfigProvider.fromMap`, then casting them back via `Config.mapOrFail`. Clever but fundamentally a hack — smuggling objects through a string-typed channel.

## Effect 4 Config Capabilities

Effect 4 Config supports nested structured data via:
- `Config.all({ ... })` — combine configs into an object
- `Config.schema(Schema.Struct({ ... }))` — nested objects from env vars
- `ConfigProvider.fromUnknown(obj)` — traverse a JS object

All of these still resolve to **string leaf values**. `ConfigProvider.Node` is `Value (string) | Record (keys) | Array (length)`. No variant for opaque objects.

## Conclusion: Abandon This Approach

Don't fight the library. Config is designed for string-based configuration (env vars, .env files, JSON). Forcing object bindings through it requires side-channel hacks (module-scoped Maps, type punning) that are fragile and non-idiomatic.

## Recommended Pattern

Two mechanisms, each used for what it's good at:

| What | Mechanism | Why |
|---|---|---|
| String env vars (secrets, feature flags) | `ConfigProvider.fromUnknown(env)` | Declarative `yield* Config.string("BETTER_AUTH_SECRET")` |
| Object bindings (D1, R2, KV, DO, etc.) | `ServiceMap` + `runPromiseWith` | Typed dependency injection, no Layers needed |

### ServiceMap for the entire env

Use `CloudflareEnv` as the service name to hold the full `Env` object. Access both object bindings and string vars through it.

```ts
const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv")

export default {
  async fetch(req: Request, env: Env) {
    const services = ServiceMap.make(CloudflareEnv, env)
    const run = Effect.runPromiseWith(services)
    return run(handleRequest(req))
  }
}
```

### ConfigProvider for declarative string config

`ConfigProvider.fromUnknown(env)` makes string env vars available via `Config.*` declaratively. Object bindings are ignored (they appear as records, not values).

```ts
const services = ServiceMap.make(CloudflareEnv, env)
  .pipe(ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)))
const run = Effect.runPromiseWith(services)
```

Then anywhere in the program:
```ts
const secret = yield* Config.string("BETTER_AUTH_SECRET")
const port = yield* Config.number("PORT")
```

No need to thread `env` through — Config resolves declaratively from the provider.

See [effect4-runtime-servicemap-cloudflare.md](./effect4-runtime-servicemap-cloudflare.md) for the full ServiceMap pattern.
