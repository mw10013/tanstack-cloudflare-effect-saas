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

### Retry Deep Dive

#### KV 429 behavior — what exactly happens?

- **Rate limit is per key, per second**: 1 write/sec to the **same key**. Writes to different keys are unlimited (paid plan). Source: `refs/cloudflare-docs/src/content/docs/kv/platform/limits.mdx` line 14, FAQ line 48.
- **Error message**: `"KV PUT failed: 429 Too Many Requests"` — thrown as an exception from the `put()` promise.
- **Only affects writes**: reads (`get`, `getWithMetadata`, `list`) are not rate limited per-key. Reads have daily limits on free plan (100k/day) but unlimited on paid.
- **Scope**: The 429 is specific to writing the same key too fast. Writing different keys concurrently is fine.

#### Is "idempotent KV put" a valid concept?

Yes. KV `put` is inherently idempotent — calling `put(key, value)` multiple times with the same arguments produces the same final state. There's no auto-increment, no append, no read-modify-write. A retry after 429 is safe because:
- The value hasn't changed between attempts
- No partial writes — `put` either succeeds or fails entirely
- Last-write-wins semantics mean repeated identical writes are harmless

This is actually simpler than D1's `idempotentWrite` concept, where you must reason about whether a SQL mutation is safe to replay.

#### Recommended retry policy

Cloudflare docs explicitly recommend exponential backoff for 429 errors (source: `refs/cloudflare-docs/src/content/docs/kv/api/write-key-value-pairs.mdx` lines 200-267). Their example uses:
- `maxAttempts = 5`
- `initialDelay = 1000` (1 second — matches the 1 write/sec/key limit)
- `delay *= 2` (exponential)

**Proposed Effect retry for KV put**:
```ts
const RETRYABLE_KV_SIGNALS = [
  "kv put failed: 429 too many requests",
] as const;

const retryIfIdempotentWrite =
  (idempotentWrite?: boolean) =>
  <A>(effect: Effect.Effect<A, KVError>) =>
    idempotentWrite
      ? effect.pipe(
          Effect.retry({
            while: (error) => {
              const message = error.message.toLowerCase();
              return RETRYABLE_KV_SIGNALS.some((signal) =>
                message.includes(signal),
              );
            },
            times: 2,
            schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          }),
        )
      : effect;
```

Using `times: 2` (3 total attempts) with exponential backoff starting at 1s is conservative and appropriate. The 1s base delay aligns with the 1 write/sec/key limit. With jitter: ~1s, ~2s, done — total worst-case ~3s which is acceptable for a write operation that was already rate-limited.

#### When NOT to retry
- `delete` — while technically idempotent, 429 doesn't apply (no per-key write rate limit documented for delete)
- `get`/`list` — reads aren't rate limited per-key
- Non-429 errors — network errors, auth errors, etc. should fail immediately

I'm confused why we need an idempotentWrite flag? I thought you said puts are implicitly idempotent.

Where is the research on errors unrelated to 429. Surely we would want a retry policy around them.

### getWithMetadata Deep Dive

#### What is metadata?

Metadata is a JSON-serializable object (max 1024 bytes) attached to a KV entry via `put()`:
```ts
await kv.put("user:123", largeProfileJSON, {
  metadata: { role: "admin", updatedAt: 1700000000 }
});
```

#### Why use getWithMetadata vs get?

- `get(key)` → returns just the value
- `getWithMetadata(key)` → returns `{ value, metadata, cacheStatus }`

Key use cases:
1. **Content-type/MIME info**: store file type in metadata when value is binary
2. **Timestamps/versioning**: track when value was last updated without parsing the value
3. **Access control**: store `userId`/`role` to check permissions before processing large value
4. **List optimization**: metadata is returned by `list()` too — store display fields in metadata to avoid N+1 `get()` calls

#### Recommendation: keep minimal

Expose just two variants matching the most common patterns:
- `getWithMetadata(key)` — text value + metadata (default)
- `getWithMetadataJson(key)` — JSON-parsed value + metadata

The `arrayBuffer`/`stream` variants are rare and can be added later if needed. This matches the `get`/`getJson` split.

Ok. You can remove this section and just incorporate getWithMetadataJson.

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
      getBulk: (keys: string[]) => tryKV(() => kv.get(keys)),
      getWithMetadata: <Metadata = unknown>(key: string) =>
        tryKV(() => kv.getWithMetadata<Metadata>(key)),
      getWithMetadataJson: <T, Metadata = unknown>(key: string) =>
        tryKV(() => kv.getWithMetadata<T, Metadata>(key, "json")),
      put: (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: KVNamespacePutOptions & { readonly idempotentWrite?: boolean },
      ) => {
        const { idempotentWrite, ...putOptions } = options ?? {};
        return tryKV(() => kv.put(key, value, putOptions)).pipe(
          retryIfIdempotentWrite(idempotentWrite),
        );
      },
      delete: (key: string) => tryKV(() => kv.delete(key)),
      list: <Metadata = unknown>(options?: KVNamespaceListOptions) =>
        tryKV(() => kv.list<Metadata>(options)),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const RETRYABLE_KV_SIGNALS = [
  "kv put failed: 429 too many requests",
] as const;

const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new KVError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));

const retryIfIdempotentWrite =
  (idempotentWrite?: boolean) =>
  <A>(effect: Effect.Effect<A, KVError>) =>
    idempotentWrite
      ? effect.pipe(
          Effect.retry({
            while: (error) => {
              const message = error.message.toLowerCase();
              return RETRYABLE_KV_SIGNALS.some((signal) =>
                message.includes(signal),
              );
            },
            times: 2,
            schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          }),
        )
      : effect;
```

### Resolved questions

1. **Retry for put 429** — Yes. KV puts are inherently idempotent. Use same `idempotentWrite` opt-in pattern as D1. Retry only on `"KV PUT failed: 429 Too Many Requests"`, 2 retries with exponential backoff starting at 1s (aligns with 1 write/sec/key limit).

Since puts are inherently idempotent, we don't need complexity of opt-in. Seems we need a separate retry policy for puts vs reads.

2. **Bulk get** — Yes. Exposed as `getBulk(keys[])`. Returns `Map<string, string | null>`. Counts as single operation against 1,000 ops/invocation limit. Max 100 keys.

3. **getWithMetadata variants** — Keep minimal: `getWithMetadata` (text) and `getWithMetadataJson`. Skip arrayBuffer/stream variants.

4. **List pagination** — Leave to caller. Thin wrapper returning `KVNamespaceListResult`. Caller checks `list_complete` and passes `cursor` for next page.
