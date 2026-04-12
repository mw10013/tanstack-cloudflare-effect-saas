# Cloudflare Workers + Effect v4 Observability Research

## Short Answer

- Cloudflare Workers has first-party logs and traces, plus OTLP export for both.
- Yes, `head_sampling_rate: 1` means every invocation is traced or logged. Cloudflare's docs also say the default sampling rate is `1` when unspecified, but setting it explicitly in `wrangler.jsonc` removes ambiguity.
- Cloudflare Workers does not currently support custom application spans inside Worker code. The docs explicitly say custom spans and attributes are still being worked on.
- Effect v4 has built-in structured logging and tracing. `Effect.withLogSpan` enriches logs. `Effect.withSpan` creates real spans. OTLP export exists in `effect/unstable/observability`.
- For this repo, we are going with Cloudflare-native traces and Cloudflare-native logs only. No third-party logging destination and no app-level OTEL export.
- For this repo, the best fit is Cloudflare-native traces for platform activity plus Effect `withLogSpan` for app-level timing inside logs.

## Goal

Answer three questions:

1. What observability and logging support does Cloudflare Workers expose from the local refs?
2. What observability, logging, and span support does Effect v4 expose from the local refs?
3. How should we combine them if we specifically want to use `Effect.withLogSpan`?

## Current Repo State

The repo already has two useful pieces in place:

- [`wrangler.jsonc`](../wrangler.jsonc) now enables Workers observability and explicit full trace sampling with:

```json
{
  "observability": {
    "enabled": true,
    "logs": {
      "invocation_logs": true,
      "head_sampling_rate": 1
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  }
}
```

- [`src/lib/LayerEx.ts`](../src/lib/LayerEx.ts) already uses structured console logging in production and keeps `Logger.tracerLogger` enabled:

```ts
Logger.layer(
  environment === "production"
    ? [Logger.consoleJson, Logger.tracerLogger]
    : [Logger.consolePretty(), Logger.tracerLogger],
  { mergeWithExisting: false },
)
```

That means the repo is already close to a good `withLogSpan` setup.

## Cloudflare Workers Findings

### Native tracing exists

Cloudflare's Workers tracing docs say tracing is automatic and requires no SDK or code changes. Once enabled, Workers automatically traces:

- fetch calls
- binding calls such as KV, R2, Durable Objects
- handler calls such as fetch, scheduled, queue

Source: `refs/cloudflare-docs/src/content/docs/workers/observability/traces/index.mdx`

Example config from the docs:

```json
{
  "observability": {
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.05
    }
  }
}
```

For this repo, we are choosing the same shape but setting `head_sampling_rate` to `1`, which means 100% head sampling. Cloudflare's docs state that the default sampling rate is also `1`, but keeping it explicit in config is clearer.

For logs specifically, Cloudflare's configuration docs say `observability.head_sampling_rate` defaults to `1` when unspecified, and the Query Builder docs show `observability.logs.invocation_logs = true` with `observability.logs.head_sampling_rate = 1` as the explicit way to turn on full invocation logging.

### OTLP export exists for traces and logs, but we are not using it

Cloudflare's OTLP export docs say Workers can export OpenTelemetry-compliant telemetry to any destination with an OTLP endpoint.

Supported export types:

- traces
- logs

Not supported yet:

- worker metrics export
- custom metrics export

The docs also say log export includes:

- `console.log()` output
- system-generated logs

Source: `refs/cloudflare-docs/src/content/docs/workers/observability/exporting-opentelemetry-data/index.mdx`

Example config from the docs:

```json
{
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["tracing-destination-name"],
      "head_sampling_rate": 0.05,
      "persist": false
    },
    "logs": {
      "enabled": true,
      "destinations": ["logs-destination-name"],
      "head_sampling_rate": 0.6,
      "persist": false
    }
  }
}
```

### Workers Trace Events include logs

The Workers Trace Events dataset includes a `Logs` field described as:

> List of console messages emitted during the invocation.

Source: `refs/cloudflare-docs/src/content/docs/logs/logpush/logpush-job/datasets/account/workers_trace_events.md`

This matters because Effect logs that end up on `console` can flow through Cloudflare's logging pipeline even if Cloudflare does not understand Effect-specific span semantics. For this repo, that means `Logger.consoleJson` plus `Effect.withLogSpan` is enough for the initial observability setup.

### Native useful correlation fields exist

The spans-and-attributes docs list several attributes that are useful for correlating log entries with platform traces:

- `faas.invocation_id`
- `cloudflare.ray_id`
- `cloudflare.invocation.sequence.number`

Source: `refs/cloudflare-docs/src/content/docs/workers/observability/traces/spans-and-attributes.mdx`

These are strong candidates to include in app log annotations when available.

### Important Cloudflare limitations

Cloudflare's tracing limitations are the key design constraint here.

The docs explicitly say:

- trace IDs are not propagated to external platforms yet
- service bindings and Durable Objects appear as separate traces, not one nested trace tree
- support for custom spans and custom attributes is still in progress

Source: `refs/cloudflare-docs/src/content/docs/workers/observability/traces/known-limitations.md`

This is the main reason `Effect.withSpan` cannot currently become a first-class Cloudflare Worker span inside Cloudflare's native tracing product.

## Effect v4 Findings

### Effect has first-class observability support

Effect's AI docs say:

> Effect has built-in support for structured logging, distributed tracing, and metrics.

They recommend:

- `effect/unstable/observability` for new OTLP export setups
- `@effect/opentelemetry` Node SDK only when integrating into an existing OpenTelemetry setup

Source: `refs/effect4/ai-docs/src/08_observability/index.md`

### `Effect.withLogSpan` is log enrichment, not a tracing span

The implementation in `Effect.ts` shows that `withLogSpan` records a label and start timestamp in `CurrentLogSpans`.

Source: `refs/effect4/packages/effect/src/Effect.ts`

That means `withLogSpan` does not create an OTEL span by itself. Instead, it enriches logs produced inside the wrapped effect.

The logging docs show the intended use clearly:

```ts
Effect.annotateLogs({
  service: "checkout-api",
  route: "POST /checkout"
}),
Effect.withLogSpan("checkout")
```

Source: `refs/effect4/ai-docs/src/08_observability/10_logging.ts`

### Effect structured loggers surface log spans directly

`Logger.formatStructured` and `Logger.formatJson` include a `spans` object in each log record.

The source shows:

```ts
for (const [label, timestamp] of spans) {
  spansObj[label] = now - timestamp
}
```

and the final structured output includes:

```ts
spans: spansObj
```

Source: `refs/effect4/packages/effect/src/Logger.ts`

So with `Logger.consoleJson`, a log line emitted inside `Effect.withLogSpan("checkout")` will include something like:

```json
{
  "message": "...",
  "spans": {
    "checkout": 37
  }
}
```

This is exactly why `withLogSpan` is a good fit for Cloudflare logs.

### `Logger.tracerLogger` turns logs into span events

Effect's logger docs say `Logger.tracerLogger` records log messages as events on the current trace span, and that it is part of Effect's default logger set unless you override it.

Source: `refs/effect4/packages/effect/src/Logger.ts`

This repo does override logger configuration, but it already explicitly re-adds `Logger.tracerLogger` in [`src/lib/LayerEx.ts`](../src/lib/LayerEx.ts).

### Effect has real tracing spans too

Effect also exposes true tracing primitives:

- `Effect.withSpan`
- `Effect.makeSpanScoped`
- `Effect.currentSpan`
- `Effect.withParentSpan`
- `Effect.annotateCurrentSpan`

Source: `refs/effect4/packages/effect/src/Effect.ts` and `refs/effect4/packages/effect/src/Tracer.ts`

So the mental model is:

- `withLogSpan` enriches logs
- `withSpan` creates a real tracing span

### Effect has first-party OTLP tracer and logger exporters

The Effect observability example shows a reusable layer composed from:

- `OtlpTracer.layer`
- `OtlpLogger.layer`
- `OtlpSerialization.layerJson`
- `FetchHttpClient.layer`

Source: `refs/effect4/ai-docs/src/08_observability/20_otlp-tracing.ts`

This is important context, but we are not using this path for the current plan.

### Effect OTLP logger preserves `withLogSpan`

`OtlpLogger.ts` shows a detail that is directly relevant to this question.

When Effect exports logs via OTLP, it adds log-span attributes like:

```ts
key: `logSpan.${label}`
value: { stringValue: `${nowMillis - startTime}ms` }
```

It also attaches `traceId` and `spanId` when a current Effect span exists.

Source: `node_modules/effect/src/unstable/observability/OtlpLogger.ts`

So if we ever add Effect's own OTLP pipeline, `withLogSpan` remains valuable there too. That said, this repo is not adopting that path now.

### Effect can parse and emit trace headers

Effect's HTTP trace context module supports:

- W3C `traceparent`
- B3 single header
- B3 multi-header

Source: `refs/effect4/packages/effect/src/unstable/http/HttpTraceContext.ts`

That gives us a manual span propagation story for external services, even though Cloudflare's native tracing does not yet propagate its own trace IDs externally.

## What This Means For Integration

## `withLogSpan` works very well with Cloudflare logs

This is the cleanest immediate integration.

Flow:

1. App code wraps logical operations with `Effect.withLogSpan("...")`.
2. Effect loggers render that as structured log metadata.
3. The repo's production logger already uses `Logger.consoleJson`.
4. Cloudflare captures console output as Worker logs.
5. Cloudflare can keep those logs natively or export them to an OTLP destination.

Result:

- app-level durations appear in log lines
- Cloudflare-native traces still show platform spans for fetch, D1, KV, R2, DO, handlers
- no custom tracing SDK is required inside the Worker for the initial setup

## `withSpan` does not currently become a Cloudflare-native custom span

This is the critical constraint.

Because Cloudflare Workers does not yet support custom spans in the Worker runtime, an Effect span created with `Effect.withSpan("...")` will not show up as a native Cloudflare Worker trace span.

So:

- use `withLogSpan` when the goal is app timing inside Cloudflare logs
- do not expect `withSpan` to appear inside Cloudflare's trace waterfall today

## Why we are not using Effect OTLP or a third-party backend

We are deliberately not choosing:

- Effect OTLP tracing
- Effect OTLP log export
- Cloudflare OTLP export to Honeycomb, Grafana, Axiom, Sentry, or any other third party

Reason:

- the requirement is Cloudflare-native observability only
- `Effect.withLogSpan` already gives app-level timing inside structured logs
- Cloudflare native traces already cover fetch, bindings, and handlers
- avoiding a second telemetry pipeline keeps the system simpler

## If we later need real custom app spans, use Effect OTLP directly

If the requirement becomes:

- custom spans for business operations
- logs correlated to those spans by trace ID and span ID
- full app-level trace trees in Honeycomb, Grafana, Axiom, or Sentry

then we should add Effect's own OTLP tracer/logger layer and send that data directly to an external backend.

That would make `Effect.withSpan` and `Effect.annotateCurrentSpan` visible externally.

But it comes with an important caveat:

- those Effect spans will be a separate tracing pipeline from Cloudflare's native Worker traces

Cloudflare's own docs say native trace IDs are not propagated yet, so there is no clean automatic parent-child link between Cloudflare's root Worker trace and a separate Effect OTLP trace tree.

## Recommended Architecture

### Option A: Cloudflare-native traces + Effect log spans

This is the best default for this repo.

Use:

- Cloudflare native traces for platform and infra visibility
- Cloudflare native logs for application logs
- Effect `withLogSpan` and `annotateLogs` for app-level timing and dimensions

Pros:

- smallest change
- uses the repo's existing logger setup
- good fit for current Cloudflare capabilities
- no duplicate tracing systems
- no third-party vendor wiring

Cons:

- no first-class custom application spans in Cloudflare traces

### Option B: Cloudflare-native traces + external Effect OTLP traces

Use this only if app-level custom spans become a hard requirement.

This is not the chosen plan.

Use:

- Cloudflare traces for runtime and bindings
- Effect OTLP tracer for custom business spans
- optionally Effect OTLP logger if we want direct trace/log correlation in the external backend

Pros:

- real application spans
- logs can include `traceId`, `spanId`, and `logSpan.*`
- good for Honeycomb or Grafana style trace analysis

Cons:

- two separate observability pipelines
- no automatic Cloudflare-to-Effect trace stitching today
- likely duplicate logging unless configured carefully

## Recommendation For This Repo

## Primary recommendation

Start with Option A.

Specifically:

1. Keep the current Effect logger approach in [`src/lib/LayerEx.ts`](../src/lib/LayerEx.ts).
2. Standardize on `Effect.withLogSpan` around meaningful business operations.
3. Use `Effect.annotateLogs` for stable dimensions such as `organizationId`, `userId`, `invoiceId`, `workflow`, `operation`.
4. Keep `wrangler.jsonc` explicit with `observability.logs.invocation_logs = true`, `observability.logs.head_sampling_rate = 1`, `observability.traces.enabled = true`, and `observability.traces.head_sampling_rate = 1` so every invocation is logged and traced.
5. Do not add OTLP destinations or third-party logging/export config.

This gives us:

- Cloudflare platform traces
- structured application logs
- `withLogSpan` timings on every log line inside the wrapped scope
- low implementation risk
- one observability system to reason about

## Secondary recommendation if we later need custom spans

If we decide that log-based timing is not enough, add an Effect observability layer similar to the example in `refs/effect4/ai-docs/src/08_observability/20_otlp-tracing.ts`.

At that point:

- use `Effect.withSpan` for real business spans
- keep `Effect.withLogSpan` for log context
- prefer a single external backend for Effect traces and logs
- treat Cloudflare native traces as complementary infra telemetry, not the same trace tree

This is not part of the current plan.

## Where To Use `Effect.withLogSpan`

Use `withLogSpan` at business-operation boundaries that already emit multiple logs or represent a real unit of work.

### Highest-value targets

- [`src/invoice-extraction-workflow.ts`](../src/invoice-extraction-workflow.ts): wrap the overall `run()` body with `Effect.withLogSpan("invoice.extraction.workflow")`.
- [`src/invoice-extraction-workflow.ts`](../src/invoice-extraction-workflow.ts): wrap the nested `load-file`, `extract-invoice`, and `save-extraction` step effects with `invoice.extraction.loadFile`, `invoice.extraction.extract`, and `invoice.extraction.save` labels.
- [`src/organization-agent.ts`](../src/organization-agent.ts): wrap `onInvoiceUpload()` with `Effect.withLogSpan("organizationAgent.onInvoiceUpload")` because it performs validation, dedupe checks, repo access, and workflow dispatch.
- [`src/organization-agent.ts`](../src/organization-agent.ts): wrap `syncMembershipImpl` with `Effect.withLogSpan("organizationAgent.syncMembership")` because it does D1 lookup, DO-local persistence, and conditional socket cleanup while already emitting multiple logs.
- [`src/routes/_mkt.pricing.tsx`](../src/routes/_mkt.pricing.tsx): wrap the `upgradeSubscriptionServerFn` effect with `Effect.withLogSpan("pricing.upgradeSubscription")` because it logs start, failure, and response around a Stripe checkout transition.
- [`src/lib/Auth.ts`](../src/lib/Auth.ts): wrap the `sendMagicLink` effect with `Effect.withLogSpan("auth.sendMagicLink")` because it logs send intent, persists demo data, and logs simulated email delivery.
- [`src/lib/Auth.ts`](../src/lib/Auth.ts): wrap the `hooks.before.ensureBillingPortalConfiguration` effect with `Effect.withLogSpan("auth.ensureBillingPortalConfiguration")` because it is a request-time billing setup boundary.
- [`src/lib/Stripe.ts`](../src/lib/Stripe.ts): wrap `getPlans` with `Effect.withLogSpan("stripe.getPlans")` because it includes cache-hit/cache-miss behavior, Stripe reads, and KV writes.
- [`src/lib/Stripe.ts`](../src/lib/Stripe.ts): wrap `ensureBillingPortalConfiguration` with `Effect.withLogSpan("stripe.ensureBillingPortalConfiguration")` because it performs multiple Stripe and KV operations and already logs creation/warning paths.
- [`src/lib/Login.ts`](../src/lib/Login.ts): wrap the login handler effect with `Effect.withLogSpan("auth.loginMagicLink")` because it performs Better Auth API work, optional KV read, and final log emission.
- [`src/worker.ts`](../src/worker.ts): wrap the cron cleanup effect in `scheduled()` with `Effect.withLogSpan("session.cleanup")` because it already logs the cleanup outcome and is a natural scheduled-operation boundary.

### Good follow-up targets

- [`src/lib/Auth.ts`](../src/lib/Auth.ts): the Stripe subscription callbacks such as `onSubscriptionComplete`, `onSubscriptionUpdate`, and `onSubscriptionDeleted` are good candidates if they later grow beyond single log lines.
- [`src/organization-agent.ts`](../src/organization-agent.ts): `assertCallerMember` should only get `withLogSpan` if it grows beyond the current quick membership check plus warning path.
- [`src/lib/KV.ts`](../src/lib/KV.ts), [`src/lib/R2.ts`](../src/lib/R2.ts), and [`src/lib/D1.ts`](../src/lib/D1.ts): these should generally rely on Cloudflare native traces plus existing error logs, not `withLogSpan` on every low-level primitive.

## Concrete guidance for `Effect.withLogSpan`

Good uses:

- request-level operations like `pricing.upgradeSubscription`
- workflows like `invoiceExtractionWorkflow`
- repo/service operations that are multi-step and emit more than one log
- external integrations like Stripe, R2 load, AI extraction, queue processing

Avoid using it on every tiny helper. Use it at boundaries that represent a real business step.

For this codebase specifically, prefer `withLogSpan` on:

- server function handlers
- workflow step groups
- agent mutation or reconciliation flows
- Stripe or auth operations that already emit two or more logs

Prefer not to add it to:

- tiny repository helpers
- single log-and-return branches
- low-level D1, KV, and R2 wrappers where Cloudflare already provides platform tracing

Example shape:

```ts
Effect.gen(function* () {
  yield* Effect.logInfo("invoice.extract.started", { invoiceId })
  yield* loadFile()
  yield* callModel()
  yield* saveResult()
  yield* Effect.logInfo("invoice.extract.complete", { invoiceId })
}).pipe(
  Effect.annotateLogs({ operation: "invoice.extract", invoiceId }),
  Effect.withLogSpan("invoice.extract")
)
```

In production, the repo's `Logger.consoleJson` logger should emit a JSON log line with a `spans` object, which Cloudflare can capture and export.

## Minimal config direction

When we are ready to move from generic observability to explicit logs + traces, the Wrangler shape should move toward:

```json
{
  "observability": {
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.05
    },
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  }
}
```

We are not adding any destination names because we are not exporting to third parties.

## Final Answer

- Cloudflare Workers: yes, `head_sampling_rate: 1` captures everything for both logs and traces; no, custom Worker-code spans are not supported yet.
- Effect v4: yes, observability is first-class; for this plan we care primarily about `withLogSpan` for log enrichment.
- Integration: use Cloudflare-native traces plus Effect `withLogSpan`, keep logs/traces inside Cloudflare, and do not add OTLP destinations or third-party logging.

## Sources

- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/index.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/known-limitations.md`
- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/spans-and-attributes.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/observability/exporting-opentelemetry-data/index.mdx`
- `refs/cloudflare-docs/src/content/docs/logs/logpush/logpush-job/datasets/account/workers_trace_events.md`
- `refs/effect4/ai-docs/src/08_observability/index.md`
- `refs/effect4/ai-docs/src/08_observability/10_logging.ts`
- `refs/effect4/ai-docs/src/08_observability/20_otlp-tracing.ts`
- `refs/effect4/packages/effect/src/Effect.ts`
- `refs/effect4/packages/effect/src/Logger.ts`
- `refs/effect4/packages/effect/src/Tracer.ts`
- `refs/effect4/packages/effect/src/unstable/http/HttpTraceContext.ts`
- `node_modules/effect/src/unstable/observability/OtlpLogger.ts`
- `node_modules/effect/src/unstable/observability/OtlpTracer.ts`
- [`wrangler.jsonc`](../wrangler.jsonc)
- [`src/lib/LayerEx.ts`](../src/lib/LayerEx.ts)
