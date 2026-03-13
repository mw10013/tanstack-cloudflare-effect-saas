# R2 Effect Service — Research

## Existing Pattern (D1.ts / KV.ts)

Both use the `make` variant of `ServiceMap.Service`, which infers the service interface from the return type of the `make` effect:

```ts
export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    // define methods with Effect.fn(...)
    return { prepare, batch, run, first };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### Common patterns across D1 & KV

| Concern | Pattern |
|---|---|
| Error class | `Schema.TaggedErrorClass` with `message: Schema.String` + `cause: Schema.Defect` |
| Promise wrapping | `tryXxx` helper: `Effect.tryPromise({ try, catch })` piped to `Effect.tapError(logError)` |
| Retry | Configurable or always-on; `Schedule.exponential("1 second").pipe(Schedule.jittered)`, `times: 2`, `while:` checks message against signal list |
| CloudflareEnv | `yield* CloudflareEnv` destructured to get binding |

---

## R2 Workers API (from `worker-configuration.d.ts`)

### R2Bucket methods

| Method | Signature | Returns |
|---|---|---|
| `head` | `(key: string)` | `Promise<R2Object \| null>` |
| `get` | `(key: string, options?: R2GetOptions)` | `Promise<R2ObjectBody \| null>` |
| `get` (conditional) | `(key: string, options: R2GetOptions & { onlyIf: ... })` | `Promise<R2ObjectBody \| R2Object \| null>` |
| `put` | `(key: string, value: ReadableStream \| ArrayBuffer \| ArrayBufferView \| string \| null \| Blob, options?: R2PutOptions)` | `Promise<R2Object>` |
| `put` (conditional) | same + `{ onlyIf: ... }` | `Promise<R2Object \| null>` |
| `delete` | `(keys: string \| string[])` | `Promise<void>` |
| `list` | `(options?: R2ListOptions)` | `Promise<R2Objects>` |
| `createMultipartUpload` | `(key: string, options?: R2MultipartOptions)` | `Promise<R2MultipartUpload>` |
| `resumeMultipartUpload` | `(key: string, uploadId: string)` | `R2MultipartUpload` (sync) |

### Key return types

- **`R2Object`** — metadata only: `key`, `version`, `size`, `etag`, `httpEtag`, `checksums`, `uploaded`, `httpMetadata?`, `customMetadata?`, `range?`, `storageClass`, `writeHttpMetadata(headers)`
- **`R2ObjectBody extends R2Object`** — adds `body: ReadableStream`, `bodyUsed`, `arrayBuffer()`, `bytes()`, `text()`, `json<T>()`, `blob()`
- **`R2Objects`** — `{ objects: R2Object[], delimitedPrefixes: string[], truncated: boolean, cursor?: string }`

### Options types

- **`R2GetOptions`** — `onlyIf?`, `range?`, `ssecKey?`
- **`R2PutOptions`** — `onlyIf?`, `httpMetadata?`, `customMetadata?`, `md5?`, `sha1/256/384/512?`, `storageClass?`, `ssecKey?`
- **`R2ListOptions`** — `limit?` (max 1000), `prefix?`, `cursor?`, `delimiter?`, `startAfter?`, `include?`

---

## R2 Error Codes & Retry Strategy

### Retryable (transient) error codes

From `refs/cloudflare-docs/src/content/docs/r2/api/error-codes.mdx`:

| Code | S3 Code | HTTP | Signal |
|---|---|---|---|
| 10001 | InternalError | 500 | Internal error |
| 10043 | ServiceUnavailable | 503 | Temporarily unavailable |
| 10054 | ClientDisconnect | 400 | Client disconnected before completion |
| 10058 | TooManyRequests | 429 | Rate limit exceeded (1 write/sec/key) |

Workers API throws exceptions with message ending in `"(CODE)"`, e.g.:
`"put: Your metadata headers exceed the maximum allowed metadata size. (10012)"`

### Proposed `RETRYABLE_R2_SIGNALS`

```ts
const RETRYABLE_R2_SIGNALS = [
  "network connection lost",
  "internalerror",    // code 10001
  "serviceunavailable", // code 10043
  "clientdisconnect",  // code 10054
] as const;
```

**Decision point**: Should 429 (`TooManyRequests` / code 10058) be retryable? The 1 write/sec/key limit means retrying with 1s+ backoff makes sense (same rationale as KV's `"kv put failed: 429 too many requests"`). But the R2 error message format differs — it uses thrown exceptions with `(10058)` suffix rather than the textual signals D1/KV use.

Yes

**R2 error matching**: R2 errors are thrown as `Error` instances. The `message` property contains the error text. We can match on:
- Lowercase message substring (like D1/KV do)
- Or match on the numeric error code suffix `(10001)`, `(10043)`, etc.

**Recommendation**: Use code-based matching for R2 since error messages are more structured. This is more robust than substring matching.

```ts
const RETRYABLE_R2_CODES = [10001, 10043, 10054, 10058] as const;

const isRetryable = (message: string) =>
  RETRYABLE_R2_CODES.some((code) => message.includes(`(${code})`)) ||
  message.toLowerCase().includes("network connection lost");
```

Yes

---

## Infrastructure Prerequisites

### Not yet configured

1. **`wrangler.jsonc`** — needs `r2_buckets` binding:
   ```jsonc
   "r2_buckets": [
     { "binding": "R2", "bucket_name": "tcei-r2-local" }
   ]
   ```
2. **`Env` interface** — will auto-generate `R2: R2Bucket` after running `pnpm typecheck`
3. **`CloudflareEnv`** — no changes needed; it exposes `Env` and R2 will be available via `{ R2: r2 } = yield* CloudflareEnv`

---

## Proposed R2 Service API

### Core methods (v1 — skip multipart initially)

| Method | Wraps | Return in Effect | Notes |
|---|---|---|---|
| `head` | `r2.head(key)` | `Option<R2Object>` | null → Option |
| `get` | `r2.get(key, options?)` | `Option<R2ObjectBody>` | null → Option |
| `put` | `r2.put(key, value, options?)` | `R2Object` | Use non-conditional overload |
| `delete` | `r2.delete(keys)` | `void` | Accepts `string \| string[]` |
| `list` | `r2.list(options?)` | `R2Objects` | Returns as-is |

### Deferred (v2)

- `createMultipartUpload` / `resumeMultipartUpload` — more complex, involves `R2MultipartUpload` lifecycle
- Conditional `get`/`put` with `onlyIf` — returns `R2Object | null` (precondition failures)

### Retry strategy

All operations retry by default (like KV, unlike D1's opt-in `idempotentWrite`).

**Rationale**: R2 `get`, `head`, `list` are safe to retry (reads). `delete` is idempotent. `put` overwrites, so retrying a failed put is safe (same key+value). This matches KV's approach where all ops retry.

```ts
const tryR2 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new R2Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.retry({
      while: (error) => isRetryable(error.message),
      times: 2,
      schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
    }),
  );
```

---

## Sketch

```ts
import { Effect, Layer, Option, Schedule, Schema, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class R2 extends ServiceMap.Service<R2>()("R2", {
  make: Effect.gen(function* () {
    const { R2: r2 } = yield* CloudflareEnv;
    const head = Effect.fn("R2.head")(function* (key: string) {
      return yield* tryR2(() => r2.head(key)).pipe(Effect.map(Option.fromNullishOr));
    });
    const get = Effect.fn("R2.get")(function* (key: string, options?: R2GetOptions) {
      return yield* tryR2(() => r2.get(key, options)).pipe(Effect.map(Option.fromNullishOr));
    });
    const put = Effect.fn("R2.put")(function* (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) {
      return yield* tryR2(() => r2.put(key, value, options));
    });
    const del = Effect.fn("R2.delete")(function* (keys: string | string[]) {
      return yield* tryR2(() => r2.delete(keys));
    });
    const list = Effect.fn("R2.list")(function* (options?: R2ListOptions) {
      return yield* tryR2(() => r2.list(options));
    });
    return { head, get, put, delete: del, list };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
```

---

## Open Questions

1. **Error matching strategy**: Substring-based (like D1/KV) vs code-based `(10058)` suffix? Code-based is more precise but couples to Cloudflare's error format.

code based. 

2. **429 retry**: Include `TooManyRequests` in retry set? KV includes its 429; seems consistent to include R2's.

include

3. **Multipart**: Defer to v2? If yes, service surface is compact (5 methods).

defer

4. **Conditional operations**: Expose `onlyIf` overloads now or later? They change return type to `R2Object | null` for `put`, `R2ObjectBody | R2Object | null` for `get`.

explain onlyIf. what problem does it solve?

5. **Binding name**: Use `R2` as the binding name in wrangler? Consistent with `D1` and `KV`.

Yes
