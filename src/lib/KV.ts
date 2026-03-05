import { Effect, Layer, Schedule, Schema, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class KVError extends Schema.TaggedErrorClass<KVError>()("KVError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

/**
 * Effect service wrapping Cloudflare Workers KV.
 *
 * All operations automatically retry on transient errors with exponential
 * backoff (1s base, jittered, up to 2 retries). Retryable signals:
 * - `"network connection lost"` — transient Workers runtime connection failure
 * - `"daemondown"` — temporary problem invoking the Worker
 * - `"kv put failed: 429 too many requests"` — per-key write rate limit
 *   (1 write/sec/key); harmless no-op for reads since they never produce this
 *
 * The 1s base delay is intentional: KV enforces 1 write/sec/key, so retrying
 * sooner would just hit the rate limit again.
 */
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
        options?: KVNamespacePutOptions,
      ) => tryKV(() => kv.put(key, value, options)),
      delete: (key: string) => tryKV(() => kv.delete(key)),
      list: <Metadata = unknown>(options?: KVNamespaceListOptions) =>
        tryKV(() => kv.list<Metadata>(options)),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const RETRYABLE_KV_SIGNALS = [
  "network connection lost",
  "daemondown",
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
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
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
  );
