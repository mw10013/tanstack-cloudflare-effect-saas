# Queue Handler → Effect v4 Migration Research

## Current State

`worker.ts` queue handler (lines 384–410) is raw async/await with manual `Schema.decodeUnknownExit`, `console.error`/`console.warn`, and direct `env.R2.head()` calls. The `fetch` and `scheduled` handlers already use Effect v4 via `makeHttpRunEffect` / `makeScheduledRunEffect`.

## Key Decisions

### 1. No Queue service

The queue handler is a top-level entry point (like `fetch`/`scheduled`), not a reusable service dependency. Follow the existing pattern: **`makeQueueRunEffect(env)`** builds a minimal layer stack and returns a `runEffect` helper.

### 2. Layer stack

Queue handler accesses:
- `env.R2.head()` → **R2 service**
- `env.ORGANIZATION_AGENT` → **CloudflareEnv** binding
- `console.error/warn` → **Effect.logError / Effect.logWarning**

```
CloudflareEnv (env)
├── R2 (for head() call in handleInvoiceUpload)
└── Logger (env-aware pretty/json)
```

No D1, KV, Auth, Stripe, Repository, or Request needed.

### 3. Ack/retry: outside Effect via `Exit` inspection

Keep ack/retry _outside_ Effect in the `queue` handler after inspecting `Exit`. Simpler to start with. Can move inside later if unified logging becomes important.

### 4. `getOrganizationAgentStub` via CloudflareEnv

Access `ORGANIZATION_AGENT` binding through `CloudflareEnv` service. No typed error — let failures be defects. The queue handler's exit-based retry machinery handles it: `Exit.isFailure` → `message.retry()`.

### 5. No string env var changes needed

Queue handler doesn't read string env vars. Only bindings.

### 6. No `ParseError` distinction

Don't distinguish bad-queue-body from bad-R2-metadata. Both ack (not retryable). Same as current behavior.

### 7. `formatQueueError` removed

`Cause.pretty` via Effect's structured logging replaces it.

## Implementation Plan

### `makeQueueRunEffect`

```ts
const makeQueueRunEffect = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const runtimeLayer = Layer.merge(r2Layer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ) => Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
};
```

### `getOrganizationAgentStub`

```ts
const getOrganizationAgentStub = Effect.fn("getOrganizationAgentStub")(
  function* (organizationId: string) {
    const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
    const id = ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = ORGANIZATION_AGENT.get(id);
    yield* Effect.tryPromise(() => stub.setName(organizationId));
    return stub;
  },
);
```

### Effectified message processors

```ts
const processQueueMessage = Effect.fn("processQueueMessage")(
  function* (messageBody: unknown) {
    const notification = yield* Schema.decodeUnknownEffect(r2QueueMessageSchema)(messageBody);
    if (notification.action !== "PutObject" && notification.action !== "DeleteObject") return;
    if (notification.action === "DeleteObject") {
      yield* processInvoiceDelete(notification);
    } else {
      yield* processInvoiceUpload(notification);
    }
  },
);

const processInvoiceDelete = Effect.fn("processInvoiceDelete")(
  function* (notification: typeof r2QueueMessageSchema.Type) {
    const parsed = parseInvoiceObjectKey(notification.object.key);
    if (!parsed) {
      yield* Effect.logError("Invalid invoice delete object key", { key: notification.object.key });
      return;
    }
    const stub = yield* getOrganizationAgentStub(parsed.organizationId);
    yield* Effect.tryPromise(() =>
      stub.onInvoiceDelete({
        invoiceId: parsed.invoiceId,
        r2ActionTime: notification.eventTime,
        r2ObjectKey: notification.object.key,
      }),
    );
  },
);

const processInvoiceUpload = Effect.fn("processInvoiceUpload")(
  function* (notification: typeof r2QueueMessageSchema.Type) {
    const r2 = yield* R2;
    const head = yield* r2.head(notification.object.key);
    if (Option.isNone(head)) {
      yield* Effect.logWarning("R2 object deleted before notification processed", {
        key: notification.object.key,
      });
      return;
    }
    const metadata = yield* Schema.decodeUnknownEffect(r2ObjectCustomMetadataSchema)(
      head.value.customMetadata ?? {},
    );
    const stub = yield* getOrganizationAgentStub(metadata.organizationId);
    yield* Effect.tryPromise(() =>
      stub.onInvoiceUpload({
        invoiceId: metadata.invoiceId,
        r2ActionTime: notification.eventTime,
        idempotencyKey: metadata.idempotencyKey,
        r2ObjectKey: notification.object.key,
        fileName: metadata.fileName ?? "unknown",
        contentType: metadata.contentType ?? "application/octet-stream",
      }),
    );
  },
);
```

### Queue handler entry point

```ts
async queue(batch, env) {
  const runEffect = makeQueueRunEffect(env);
  for (const message of batch.messages) {
    const exit = await runEffect(processQueueMessage(message.body));
    if (Exit.isSuccess(exit)) {
      message.ack();
    } else {
      const squashed = Cause.squash(exit.cause);
      if (squashed instanceof ParseError) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
},
```

## What gets removed

- `handleInvoiceDelete` function (replaced by `processInvoiceDelete`)
- `handleInvoiceUpload` function (replaced by `processInvoiceUpload`)
- `getOrganizationAgentStub` async function (replaced by Effect.fn version)
- `formatQueueError` helper
