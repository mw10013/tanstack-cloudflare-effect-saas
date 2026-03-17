# Invoice Extraction Model Capacity Research

## Question

Are our invoice extraction failures mainly a timeout/infrastructure problem, or are the models themselves not capable enough for this task?

## Current setup

Grounded in `src/lib/invoice-extraction.ts`:

- `INVOICE_EXTRACTION_MODEL` is now `@cf/openai/gpt-oss-120b` in `src/lib/invoice-extraction.ts:38` for the next experiment.
- The schema includes invoice header fields plus `lineItems: Schema.Array(LineItemSchema)` in `src/lib/invoice-extraction.ts:23`.
- The prompt explicitly says: `For line items, include every line item found.` in `src/lib/invoice-extraction.ts:71`.
- The code now has two request shapes: classic Workers AI text-generation JSON mode for the previous models, and Responses API structured output for the OSS OpenAI models in `src/lib/invoice-extraction.ts:86` and `src/lib/invoice-extraction.ts:97`.
- The OSS OpenAI path requests structured output via `text.format = { type: "json_schema", name, schema, strict }` and reads `output_text`, then validates against the same invoice schema in `src/lib/invoice-extraction.ts:98` and `src/lib/invoice-extraction.ts:113`.
- The output token cap remains `8192`, now via `max_output_tokens`, so the main failures are not explained by the old default token cap.
- We now have both code paths: binding via `runInvoiceExtraction()` and REST via `runInvoiceExtractionViaGateway()` in `src/lib/invoice-extraction.ts:91` and `src/lib/invoice-extraction.ts:151`.

## Relevant docs grounding

### Workers AI JSON mode

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:112`:

> This is the list of models that now support JSON Mode

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`:

> Workers AI can't guarantee that the model responds according to the requested JSON Schema. Depending on the complexity of the task and adequacy of the JSON Schema, the model may not be able to satisfy the request in extreme situations. If that's the case, then an error `JSON Mode couldn't be met` is returned and must be handled.

This matters because a failure in JSON mode is not automatically a timeout. It can mean the model + constrained decoder cannot satisfy the schema.

### AI Gateway binding limits

From `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:118`:

- `id`
- `skipCache`
- `cacheTtl`

The binding path does not expose a request-timeout knob. That makes it a poor path for long-running structured extraction experiments.

### AI Gateway request timeout

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx:39`:

> For a Universal Endpoint, configure the timeout value by setting a `requestTimeout` property within the provider-specific `config` object.

And the REST path also supports gateway timeout headers, which is why `runInvoiceExtractionViaGateway()` adds `cf-aig-request-timeout` in `src/lib/invoice-extraction.ts:178`.

### Workers AI OSS OpenAI models

From `refs/cloudflare-docs/src/content/changelog/workers-ai/2025-08-05-openai-open-models.mdx:12`:

> Get started with the new models at `@cf/openai/gpt-oss-120b` and `@cf/openai/gpt-oss-20b`.

From `refs/cloudflare-docs/src/content/changelog/workers-ai/2025-08-05-openai-open-models.mdx:17`:

> Workers Binding, it will accept/return Responses API – `env.AI.run("@cf/openai/gpt-oss-120b")`

This is the important nuance: these models are available on Workers AI, but they do not slot into the older `prompt` + `response_format` path exactly the same way. They use Responses API input/output shapes.

## Experiments run so far

## Binding-path results

| Model | JSON mode support | Full line items | Result | Time |
|---|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | official | no | success | ~31s |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | official | yes | timeout (`3046` seen in gateway) | ~60s on binding path |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | official | yes | `5024 JSON Mode couldn't be met` | binding path masked this badly |
| `@cf/qwen/qwen3-30b-a3b-fp8` | not official | yes | timeout | ~60s |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | not official | yes | malformed JSON string | fast |

## REST-path results

Using `runInvoiceExtractionViaGateway()` improved observability:

- With a 120s gateway timeout, the request actually ran for about 120s and returned `2014: Provider request timeout`.
- With a 300s gateway timeout, llama still failed at about 120s with `3046: Request timeout`.
- DeepSeek R1 ran for about `544,143ms` and then returned `5024: JSON Mode couldn't be met`.

Key implication: increasing the gateway timeout helps us observe the true provider behavior, but it does not remove Workers AI's internal limits.

## Current experiment in code

The code is now set up to test the stronger OSS OpenAI Workers AI model directly:

- model: `@cf/openai/gpt-oss-120b`
- transport: same `env.AI.run(...)` / Workers AI path
- request shape: Responses API, not classic text-generation JSON mode
- structured output request: `text.format.type = "json_schema"`
- decoder path: `output_text` -> invoice schema validation

Why this is a good next experiment:

- keeps the provider as Workers AI
- changes the model family and API surface together, as Cloudflare intends for these models
- avoids the mistaken assumption that `gpt-oss-120b` can be tested by only swapping the old model name under the old request shape

## Findings

### 1. This does not look like just an underpowered-model problem

- A 70B official JSON-mode model still times out on the full schema.
- A 32B reasoning model can run for 9+ minutes and still fail schema satisfaction.
- Faster non-official models are not a clean comparison because they appear not to do constrained decoding reliably.

If this were only about model size, the 70B official model would be more convincing than it currently is. Instead, the results point to a harder interaction between model capability, constrained decoding, large array-of-object output, and noisy markdown input.

### 2. The task shape is probably too expensive for one-shot constrained decoding on Workers AI

The current request asks for all of these at once:

- classify whether it is an invoice
- extract header metadata
- extract addresses
- extract totals
- emit every line item as an array of objects

For this invoice, the line-item section is the expensive part. Header-only extraction already succeeds. Full extraction with `lineItems` is where the system breaks down.

### 3. The real bottleneck is likely schema complexity plus constrained decoding, not `max_tokens`

`max_tokens` is already `8192` in `src/lib/invoice-extraction.ts:87`.

The stronger signal is Cloudflare's own JSON mode warning that the model may not be able to satisfy the requested schema in extreme situations in `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`.

### 4. REST is the right experimentation path

The binding path collapses too much useful error detail. The REST path gives us structured provider errors and request IDs, which makes the next experiments much more interpretable.

## Assessment

My read today:

- The evidence does not support a simple conclusion of `the models are underpowered`.
- The evidence does support `Workers AI JSON mode struggles with this specific one-shot extraction shape`.
- Model capability is still part of the story, but the bigger issue seems to be structured-output reliability under a large schema with many line items.

So yes, testing OpenAI is worth doing, but not just because it may be a bigger or smarter model. It is valuable because it tests a different structured-output stack under the same invoice/input conditions.

## Recommended next experiments

### A. Best next experiment: Workers AI `@cf/openai/gpt-oss-120b`

This is now the active experiment.

Why:

- strongest of the two OSS OpenAI models on Workers AI
- tests whether a different model family on the same provider performs better
- keeps the rest of the system mostly unchanged apart from the request/response shape Cloudflare requires for this model family

What we want to learn:

- does `gpt-oss-120b` return valid schema-conforming JSON for the full invoice?
- is it faster than the earlier official JSON-mode models on this task?
- does it fail as a timeout problem, a structured-output problem, or a plain extraction-quality problem?

Immediate follow-up if it fails:

- try `@cf/openai/gpt-oss-120b` on header-only extraction
- compare full schema vs line-items-only schema
- only then decide whether to test non-Workers-AI OpenAI via AI Gateway

### B. Isolate the expensive part on Workers AI

Before declaring Workers AI unworkable, split the current task into smaller experiments:

1. header/totals only schema
2. line-items only schema
3. line-items only, but limited to a single page or chunk
4. line-items only, but only non-zero amount items

If header extraction keeps succeeding and line-items-only keeps failing, we will have much cleaner evidence that arrays of objects are the real break point.

### C. Compare structured Responses API vs free-form JSON text

Try the same Workers AI model without constrained decoding:

- prompt for JSON text
- parse + validate after the fact

If this succeeds much faster, that strongly suggests structured decoding is the main bottleneck, not raw comprehension.

## Working hypothesis

Current best hypothesis:

The limiting factor is not simply model size. It is the combination of:

- noisy markdown converted from PDF
- a large output schema
- many `lineItems` as array-of-object output
- constrained JSON decoding on Workers AI

`@cf/openai/gpt-oss-120b` is worth testing next because it can answer the most important question quickly:

Is the task itself too large, or were the earlier failures mainly a limitation of the earlier Workers AI model paths we tested?
