# Invoice JSON Extraction Debug Research

Question: why does PDF -> markdown complete, but JSON extraction stall and then fail with `InferenceUpstreamError: 504 Gateway Time-out`?

## Short Answer

The failure is currently more consistent with an upstream inference timeout than a schema-shape regression.

What looks most likely:

1. `convert-pdf-to-markdown` succeeds.
2. `extract-invoice-json` calls `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", ...)` with JSON mode.
3. That request times out upstream and returns `InferenceUpstreamError: ... 504 Gateway Time-out`.
4. The workflow step then retries automatically using Workflows defaults.
5. The UI stays in a pending-looking state until retries are exhausted, then shows `extract_error`.

The current code does not override Workflow retry defaults, and Cloudflare docs say the default step config is:

```ts
const defaultConfig: WorkflowStepConfig = {
  retries: {
    limit: 5,
    delay: 10000,
    backoff: "exponential",
  },
  timeout: "10 minutes",
};
```

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx:56`

So yes: if `extract-invoice-json` fails once, Workflows likely retries it up to 5 total attempts unless we set a custom config.

## What Is Implemented Now

From `src/organization-agent.ts:363`:

```ts
const invoiceJson = await step.do("extract-invoice-json", async () => {
  const result = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: INVOICE_EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: `Extract the invoice data from the following markdown:\n\n${markdown}` },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: invoiceDataJsonSchema,
      },
      temperature: 0,
    },
    {
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 7 * 24 * 60 * 60,
      },
    },
  );
  ...
});
```

Key observations:

- No explicit Workflow retry config on `extract-invoice-json`
- No explicit Workflow timeout on `extract-invoice-json`
- Gateway binding config only sets `id`, `skipCache`, `cacheTtl`
- The code uses JSON mode exactly via `response_format: { type: "json_schema", json_schema: ... }`

## Why This Does Not Look Like The Old Research Doc's Main Failure Mode

The prior research doc focused on schema design and JSON-mode validation failures.

Cloudflare JSON mode docs say the failure for schema non-compliance is:

> `JSON Mode couldn't be met`

Source: `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`

But the UI now shows:

```txt
InferenceUpstreamError: <html> ... 504 Gateway Time-out ...
```

That points at request latency / upstream failure, not a bad JSON schema contract.

I did not find evidence that the `response_format` shape in code is stale:

- Workers AI docs still show `response_format.type = "json_schema"`
- `worker-configuration.d.ts` still types `json_schema?: unknown` for this model

Sources:

- `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:92`
- `worker-configuration.d.ts:4990`

## Confirmed Retry Behavior

### Workflow step defaults

Cloudflare Workflows docs:

```ts
const defaultConfig: WorkflowStepConfig = {
  retries: {
    limit: 5,
    delay: 10000,
    backoff: "exponential",
  },
  timeout: "10 minutes",
};
```

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx:59`

Docs also say:

- `ctx.attempt` is available inside the step callback
- throw `NonRetryableError` to fail immediately without retry

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx:97`

### AI Gateway retry knobs are not exposed on the binding path used here

The binding-path docs only list:

- `id`
- `skipCache`
- `cacheTtl`

Source: `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:118`

The request timeout and retry knobs in AI Gateway docs are documented for:

- Universal endpoint config
- direct provider headers like `cf-aig-request-timeout`, `cf-aig-max-attempts`, `cf-aig-retry-delay`

Source: `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx:96`

So if we want to reduce retry churn in local right now, the cleanest lever is Workflow step config, not the current `env.AI.run(..., ..., { gateway: ... })` binding options.

## Likely Root Cause

Most likely root cause: the JSON extraction step is timing out upstream when using `@cf/meta/llama-3.3-70b-instruct-fp8-fast` + full invoice markdown + JSON mode.

Why this fits better than a schema-change explanation:

- Markdown extraction completes, so the PDF and R2 path are fine.
- The surfaced error is a 504 upstream timeout, not `JSON Mode couldn't be met`.
- The workflow step currently has no explicit retry / timeout tuning.
- A 70B model with constrained JSON output is the slowest piece in the pipeline.

Secondary possibility: the request is not always permanently bad, but is large/slow enough that the provider or gateway times out before first response.

## Why The Logs Feel Empty

`logs/server.log` did not show useful workflow-step-level traces for this failure.

The code explains why:

- `src/organization-agent.ts:282` handles workflow failure in `onWorkflowError`
- it stores the error in the DB and broadcasts it
- it does not log step name, attempt number, or raw step timing to console

So retries can happen without much visible signal in `logs/server.log`.

## Current Error Attribution Is Blurry

From `src/organization-agent.ts:291`:

```ts
update Invoice
set status = 'extract_error',
    processedAt = ${processedAt},
    markdownError = ${error},
    invoiceJsonError = ${error}
where idempotencyKey = ${workflowId}
```

That means a JSON-step failure populates both `markdownError` and `invoiceJsonError`.

Then the route renders:

```tsx
{selectedInvoice.markdownError ?? selectedInvoice.invoiceJsonError ?? "Unknown extraction error"}
```

Source: `src/routes/app.$organizationId.invoices.tsx:321`

So the UI cannot reliably tell which step actually failed.

## Recommended Local Changes To Confirm The Diagnosis

### 1. Stop the silent retry loop for this step in local/dev

Add explicit step config to `extract-invoice-json`:

```ts
const invoiceJson = await step.do(
  "extract-invoice-json",
  {
    retries: {
      limit: 1,
      delay: "1 second",
      backoff: "constant",
    },
    timeout: "60 seconds",
  },
  async (ctx) => {
    console.log("extract-invoice-json attempt", ctx.attempt);
    ...
  },
);
```

Important: docs define `limit` as total attempts, not extra retries. So `limit: 1` means no retry.

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx:71`

### 2. Treat known terminal failures as non-retryable

If the thrown error includes `504 Gateway Time-out` or `InferenceUpstreamError`, wrap it in `NonRetryableError` so the workflow fails immediately.

Cloudflare docs:

> You can also force a Workflow instance to fail and not retry by throwing a `NonRetryableError` from within the step.

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx:108`

This is a good local-dev default if repeated retries are only burning time and cost.

### 3. Add step-attempt logging

At minimum, log:

- step name
- `ctx.attempt`
- markdown length
- model name
- final error string

That gives us enough to confirm whether the timeout happens on attempt 1 every time.

### 4. Make error storage step-specific

For a JSON extraction failure:

- keep `markdownError = null`
- set only `invoiceJsonError`

That will make the UI reflect reality.

## Follow-up Experiments After Retry Tuning

If `limit: 1` still fails fast with the same 504:

1. Try a smaller / faster JSON-mode model for local iteration.
2. Reduce prompt size before inference.
3. Reduce schema strictness if the prompt+schema pair is causing slow constrained decoding.
4. If AI Gateway-specific timeout/retry control is required, move this call to a path that supports `cf-aig-request-timeout` / `cf-aig-max-attempts` instead of relying only on the binding object.

## Working Conclusion

Current best read:

- The implementation is broadly correct.
- The old research doc is outdated mainly in diagnosis and operational assumptions, not because `response_format` or JSON mode wiring became invalid.
- The immediate issue is likely upstream timeout on the JSON extraction call.
- The hidden pain is amplified by Workflow default retries (`limit: 5`) and weak step-level logging.

So the next best iteration is not a schema rewrite first. It is:

1. cap or disable retries for `extract-invoice-json` in local
2. add attempt logging
3. mark 504-like failures non-retryable
4. then evaluate model/prompt/schema changes with faster feedback
