# KV Service Research

Research for creating `src/lib/KV.ts` — an Effect v4 service wrapping Cloudflare Workers KV.

## Existing Pattern: D1.ts

`src/lib/D1.ts` uses `ServiceMap.Service` with `make` pattern:

```ts
class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    return { /* methods returning Effects */ };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Key elements:
- `Schema.TaggedErrorClass` for typed errors
- `Effect.tryPromise` wrapper (`tryD1`) to catch and convert promise rejections
- `Effect.tapError` for error logging
- Retry logic with `Schedule.exponential` + `Schedule.jittered` for idempotent writes
- Accesses binding via `CloudflareEnv` service (`yield* CloudflareEnv`)

## CloudflareEnv Binding

```ts
// src/lib/CloudflareEnv.ts
export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");
```

`worker-configuration.d.ts` confirms `KV: KVNamespace` exists on `Env` (line 9).
`wrangler.jsonc` has `kv_namespaces` with `binding: "KV"`.

## KVNamespace API (from worker-configuration.d.ts)

### `get` — read values
```ts
get(key: Key, options?: Partial<KVNamespaceGetOptions<undefined>>): Promise<string | null>;
get(key: Key, type: "text"): Promise<string | null>;
get<ExpectedValue>(key: Key, type: "json"): Promise<ExpectedValue | null>;
get(key: Key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
get(key: Key, type: "stream"): Promise<ReadableStream | null>;
// + overloads with KVNamespaceGetOptions
// Bulk: get(key: Array<Key>, ...) → Promise<Map<string, ...>>
```

### `put` — write values
```ts
put(key: Key, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions): Promise<void>;
```

`KVNamespacePutOptions`:
```ts
interface KVNamespacePutOptions {
  expiration?: number;    // seconds since epoch
  expirationTtl?: number; // seconds from now (min 60)
  metadata?: any | null;  // max 1024 bytes serialized JSON
}
```

### `delete` — remove key-value pair
```ts
delete(key: Key): Promise<void>;
```

### `getWithMetadata` — read with metadata
```ts
getWithMetadata<Metadata>(key: Key, type: "json"): Promise<KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>;
// Returns { value, metadata, cacheStatus }
```

### `list` — enumerate keys
```ts
list<Metadata>(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<Metadata, Key>>;
```

`KVNamespaceListOptions`:
```ts
interface KVNamespaceListOptions {
  limit?: number;           // max 1000 (default)
  prefix?: string | null;
  cursor?: string | null;
}
```

`KVNamespaceListResult` is a discriminated union on `list_complete`:
```ts
type KVNamespaceListResult<Metadata, Key> =
  | { list_complete: false; keys: KVNamespaceListKey<Metadata, Key>[]; cursor: string; cacheStatus: string | null }
  | { list_complete: true;  keys: KVNamespaceListKey<Metadata, Key>[]; cacheStatus: string | null };
```

`KVNamespaceListKey`:
```ts
interface KVNamespaceListKey<Metadata, Key> {
  name: Key;
  expiration?: number;
  metadata?: Metadata;
}
```

## KV Characteristics (from Cloudflare docs)

- **Eventually consistent**: writes visible locally immediately, up to 60s elsewhere
- **Read-optimized**: high-read, low-write workloads (config, assets, caches, allow/deny lists)
- **Max value size**: 25 MiB
- **Max key length**: 512 bytes
- **Write rate limit**: 1 write/sec per key (429 Too Many Requests on violation)
- **cacheTtl**: min 30s, default 60s — controls edge cache duration for reads
- **Bulk read**: `get(keys[])` up to 100 keys, counts as single operation
- **Pagination**: `list()` returns max 1000 keys, use `cursor` for more
- **Metadata**: up to 1024 bytes JSON per key, set via `put()` options

## Effect v4 Patterns (from refs/effect4)

### ServiceMap.Service with `make`
```ts
class MyService extends ServiceMap.Service<MyService>()("MyService", {
  make: Effect.gen(function* () {
    // access dependencies
    return { /* service methods */ };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### Error class
```ts
class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

### tryPromise wrapper
```ts
const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new KVError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

## Proposed KV.ts Design

### Error
- `KVError` via `Schema.TaggedErrorClass` — mirrors `D1Error`

### Service methods to expose
Following the D1 pattern of thin wrappers that return Effects:

| Method | Wraps | Returns |
|--------|-------|---------|
| `get` | `kv.get(key, type?)` | `Effect<string \| null, KVError>` (text default) |
| `getJson` | `kv.get<T>(key, "json")` | `Effect<T \| null, KVError>` |
| `put` | `kv.put(key, value, options?)` | `Effect<void, KVError>` |
| `delete` | `kv.delete(key)` | `Effect<void, KVError>` |
| `list` | `kv.list(options?)` | `Effect<KVNamespaceListResult<Metadata>, KVError>` |
| `getWithMetadata` | `kv.getWithMetadata(key, type?)` | `Effect<{value, metadata, cacheStatus}, KVError>` |

### Retry considerations
- KV has a 429 rate limit on writes (1 write/sec per key)
- Could add optional retry for `put` with `"KV PUT failed: 429 Too Many Requests"` signal
- D1 uses `retryIfIdempotentWrite` pattern — similar pattern applicable for idempotent KV puts

Need more details and ressearch about retries. In context of Cloudflare KV, when should we retry? Does the concept of idempotent KV put make sense? For a 429, do we wait for > 1 sec and then retry? Or do we think things are too overloaded and just fail. Is the 429 for the same specific key? Need deeper research here to figure out what we need to retry, why, and what retry policy

### Skeleton

```ts
import { Effect, Layer, Schedule, Schema, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class KVError extends Schema.TaggedErrorClass<KVError>()("KVError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class KV extends ServiceMap.Service<KV>()("KV", {
  make: Effect.gen(function* () {
    const { KV: kv } = yield* CloudflareEnv;
    return {
      get: (key: string) => tryKV(() => kv.get(key)),
      getJson: <T>(key: string) => tryKV(() => kv.get<T>(key, "json")),
      put: (key: string, value: string, options?: KVNamespacePutOptions) =>
        tryKV(() => kv.put(key, value, options)),
      delete: (key: string) => tryKV(() => kv.delete(key)),
      list: <Metadata = unknown>(options?: KVNamespaceListOptions) =>
        tryKV(() => kv.list<Metadata>(options)),
      getWithMetadata: <Metadata = unknown>(key: string) =>
        tryKV(() => kv.getWithMetadata<Metadata>(key)),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new KVError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

### Open questions
1. Should `put` support retry for 429 rate limiting (like D1's `idempotentWrite`)? The 429 error message is `"KV PUT failed: 429 Too Many Requests"`.

I think so but we need more research regarding retry policies and such.

2. Should bulk `get(keys[])` be exposed as a separate method?

Yes.

3. Should `getWithMetadata` variants for json/stream/arrayBuffer be exposed or kept minimal?

What's your recommendation and why? I need more details on getWithMetadata in general.

4. Should `list` handle pagination automatically (cursor iteration) or leave that to callers?

I think leave that to caller for now. Keep thin wrapper.
