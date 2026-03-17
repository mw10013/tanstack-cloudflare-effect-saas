# Invoice Extraction Model Capacity Research

## Question

Can Workers AI extract this invoice into the full schema, including many line items, within practical latency limits?

## Current setup

Grounded in `src/lib/invoice-extraction.ts`:

- Model: `@cf/openai/gpt-oss-120b`
- Path under active test: REST via AI Gateway in `runInvoiceExtractionViaGateway()`
- Cache bypass enabled with `cf-aig-skip-cache: true`
- Responses API structured output path for OSS OpenAI models
- Output ceiling for current experiment: `max_output_tokens = 16_384`
- Schema includes header fields, totals, and `lineItems: Schema.Array(LineItemSchema)`

## Relevant docs grounding

### Workers AI JSON mode caveat

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`:

> Workers AI can't guarantee that the model responds according to the requested JSON Schema.

This is still useful context for the earlier failures on the classic Workers AI JSON-mode models.

### Binding limits

From `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:118`:

- `id`
- `skipCache`
- `cacheTtl`

The binding path does not expose request-timeout control, which is why REST is the better experiment path right now.

### Gateway cache bypass

From `refs/cloudflare-docs/src/content/docs/ai-gateway/features/caching.mdx:80`:

> You can use the header **cf-aig-skip-cache** to bypass the cached version of the request.

This matters because cached runs made latency look unrealistically good.

### OSS OpenAI model shape on Workers AI

From `refs/cloudflare-docs/src/content/changelog/workers-ai/2025-08-05-openai-open-models.mdx:17`:

> Workers Binding, it will accept/return Responses API – `env.AI.run("@cf/openai/gpt-oss-120b")`

So `gpt-oss-120b` is not just a model-name swap on the old request shape; it uses Responses API semantics.

## What we tested

### Earlier baseline

Before `gpt-oss-120b`, the main Workers AI models we tried on the full invoice/schema failed in one of these ways:

- timeout
- `JSON Mode couldn't be met`
- malformed JSON on non-official JSON-mode models

That established the original problem: one-shot structured extraction with many line items was not working reliably on the earlier model paths.

### `@cf/openai/gpt-oss-120b` via REST + AI Gateway

Key runs seen in `logs/server.log`:

| Run | Cache | Result | Time | Notes |
|---|---|---|---|---|
| 1 | likely uncached | decode failure | ~67.9s | local decode bug + malformed output |
| 2 | likely cached | success | ~0.5s | not useful for latency judgment |
| 3 | uncached | decode failure | ~73.5s | truncated at `max_output_tokens = 8192` |
| 4 | uncached | success | ~57.6s | after raising `max_output_tokens` to `16_384` |
| 5 | uncached | success | ~57.9s | second successful uncached run |

Grounding from the latest log entries:

- uncached success at `elapsedMs: 57,632` in `logs/server.log:62`
- another uncached success at `elapsedMs: 57,916` in `logs/server.log:465`
- both logged decoded invoice objects at `logs/server.log:66` and `logs/server.log:469`

### `@cf/openai/gpt-oss-120b` via Workers AI binding

We now have two binding data points:

| Run | Result | Time | Notes |
|---|---|---|---|
| 1 | success | ~51.9s | completed and decoded through `ai.run()` |
| 2 | failure at caller | ~60.2s | binding returned `504 Gateway Time-out` |

Grounding from `logs/server.log`:

- binding success: `elapsedMs: 51,897` at `logs/server.log:893`
- binding failure: `ai.run threw` after `elapsedMs: 60,219` at `logs/server.log:1292`
- failure body was HTML `504 Gateway Time-out` at `logs/server.log:1295`

But the AI Gateway dashboard for that failed binding run shows something more important:

- provider duration about `90,522ms`
- full Responses payload returned
- `status: "completed"`
- `incomplete_details: null`
- `usage.output_tokens: 8381`

That means the provider finished successfully, but the binding caller timed out first.

## Findings

### 1. `gpt-oss-120b` is the first Workers AI path here that looks genuinely viable

- It can return the full schema for this invoice.
- It has now succeeded on multiple uncached runs.
- The uncached latency is roughly high-50s seconds, not sub-second.

That is a big improvement over the earlier models, which mostly failed outright on the same task shape.

### 2. Output length was a real bottleneck

One uncached failure included:

- `incomplete_details: { reason: "max_output_tokens" }`
- a truncated JSON string that failed to parse

After raising the ceiling from `8192` to `16_384`, the next uncached runs succeeded. That strongly suggests truncation, not only model unreliability, caused at least one failure mode.

### 3. REST is still the right place to experiment

REST gives us:

- structured provider responses
- explicit uncached requests
- timeout control via gateway headers

That makes the results much easier to interpret than the binding path.

### 4. Binding can fail even when the model run succeeds upstream

The newest binding result is the clearest evidence yet:

- the binding returned a generic `504 Gateway Time-out`
- the dashboard still shows a completed model response at about `90.5s`

So the failure boundary is not simply `did the model finish?`; it is `did the binding path wait long enough for the model to finish?`

This is exactly the kind of observability problem that makes the binding path risky for this workload.

### 5. We still do not have clean evidence that binding is safe

The best uncached runs are about `57.6s` and `57.9s`.

That is encouraging, but it is too close to the rough timeout boundary we were worried about earlier to assume the binding path will be reliable. The new 504 result strengthens that concern.

## Assessment

Current read:

- The problem was not just `underpowered models`.
- The earlier Workers AI model paths were a poor fit for this extraction shape.
- `@cf/openai/gpt-oss-120b` is materially better.
- For this invoice, REST + `gpt-oss-120b` now looks workable.
- The main remaining questions are consistency across more runs and how it behaves on larger invoices.

On binding specifically:

- Is it feasible to test? Yes.
- Would I switch immediately based on current evidence? No.
- Why not? Because we now have direct evidence that binding can return a 504 around ~60s even when the upstream model run completes successfully later.

## Recommendation

Short term:

1. keep REST as the experiment/default path
2. treat the binding result as an informative negative data point
3. keep using REST for any runs where you care about observability or completion beyond ~60s

If the goal is practical reliability today, REST is the better choice.

## Notable quality caveat

The latest decoded output still deserves spot-checking.

From the recent log, the model appears to duplicate `Workers Paid` in one successful run, once with `$0.00` and once with `$5.00`. So we now have basic viability, but not yet proof of extraction correctness at the line-item level.
