# Invoice Extraction Research

## Problem

Extracting structured invoice data (header fields + ~40 line items) via Workers AI JSON mode. The ~60s gateway timeout is the primary constraint.

## Error 1031

**Undocumented.** Appears across Workers AI, D1, ai.toMarkdown() — a generic Cloudflare infrastructure error. Our initial 1031 errors were caused by a **stale dev environment** (`pnpm clean` resolved them), not schema complexity.

Relevant: cloudflare/workers-sdk#12398 — complex schemas with arrays of objects cause InferenceUpstreamErrors due to internal token accounting bugs.

## Gateway Timeout (~60s)

The `ai.run()` binding gateway config only supports `id`, `skipCache`, `cacheTtl` — **no timeout parameter**. AI Gateway supports `requestTimeout` via Universal Endpoint or `cf-aig-request-timeout` header, but not through the binding.

## Experiment Results

| Model | Params | lineItems | Result (from AI Gateway dashboard) | Time |
|---|---|---|---|---|
| llama-3.3-70b (flat schema) | 70B dense | no | **Success** | 31,309ms |
| llama-3.3-70b | 70B dense | yes (40 items) | **3046 Request timeout** (408) | ~60s |
| deepseek-r1-qwen-32b | 32B reasoning | yes (40 items) | **5024 JSON Model couldn't be met** (403) | 60,212ms |
| qwen3-30b-a3b-fp8 | MoE 3B active | yes (40 items) | **3046 Request timeout** (408) | 60,141ms |
| llama-4-scout (MoE 17B active) | 109B MoE | yes (40 items) | Response returned, **malformed JSON** | fast |

**Critical discovery:** The `ai.run()` binding wraps all AI Gateway errors into a generic `InferenceUpstreamError` with an HTML `504 Gateway Time-out` body. The actual structured error (JSON with `internalCode`, `description`, `requestId`) is lost. We were treating DeepSeek R1's "JSON Model couldn't be met" (5024) as a timeout when it's a completely different failure — the model genuinely cannot satisfy the JSON schema constraint.

### Error Types Observed

- **3046 Request timeout (408):** Model ran out of time. Given more time, it would likely succeed. (llama-3.3-70b, qwen3)
- **5024 JSON Model couldn't be met (403):** Model fundamentally cannot satisfy the JSON schema with constrained decoding. Not a speed issue. (deepseek-r1)
- **1031 (undocumented):** Stale dev environment issue. Resolved by `pnpm clean`.

### Observability Gap

The `ai.run()` binding provides terrible error observability. All errors arrive as `InferenceUpstreamError` with HTML body — no error code, no description, no request ID. The AI Gateway dashboard shows the real errors but that requires manual inspection. The REST API approach would return the actual JSON error response, improving both observability and debugging.

## JSON Mode: Official vs Unofficial

**Official JSON Mode list** (`json-mode.mdx:114-123`) — these do constrained decoding (guaranteed valid JSON):

| Model | Params | Context | Pricing (in/out per M) |
|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B dense | 24K | $0.293/$2.253 |
| `@cf/meta/llama-3.1-70b-instruct` | 70B dense | 24K | $0.293/$2.253 |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 32B reasoning | 80K | $0.497/$4.881 |
| Others (7-11B) | — | — | — |

**NOT on official list** but have `response_format` in API schema:

| Model | Params | Context | Notes |
|---|---|---|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | MoE 109B/17B active | 131K | **Tested.** Returns JSON string (not object), produces malformed JSON. No constrained decoding. |
| `@cf/openai/gpt-oss-120b` | 120B | 128K | Untested. |
| `@cf/openai/gpt-oss-20b` | 20B | 128K | Untested. |
| `@cf/nvidia/nemotron-3-120b-a12b` | MoE 120B/12B active | 32K | Untested. Function calling support. |
| `@cf/qwen/qwen3-30b-a3b-fp8` | MoE 30B/3B active | 32K | Untested. Function calling support. |

Scout proved that `response_format` in the API schema does NOT guarantee constrained decoding. But Scout is one data point — other models may behave differently.

## Scout Findings

Scout returns `response` as a JSON **string** (not parsed object) and produces **malformed JSON** for arrays of objects (misplaced commas). Consistent and reproducible. Abandoned.

The `AiResponseSchema` uses `Schema.Union([InvoiceExtractionSchema, Schema.fromJsonString(InvoiceExtractionSchema)])` to handle both response formats (object or string) idiomatically via Effect v4 Schema.

## max_tokens

Default is 256 — far too small for structured JSON with line items. Set to 8192 to cover large invoices (100+ items). `max_tokens` is a ceiling; model stops when JSON is complete.

## Code State

- Model: `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` (last tested)
- lineItems: enabled in schema
- `max_tokens: 8192`
- `AiResponseSchema` handles both object and string response formats
- Server-side timing on `ai.run()` calls

## Additional Experiments

See main experiment results table above. Qwen3 timed out (3046), DeepSeek R1 couldn't meet JSON schema (5024).

## Next: AI Gateway REST API with Custom Timeout

Instead of `ai.run()` binding (which has no timeout config), call Workers AI via the AI Gateway REST API with `cf-aig-request-timeout` header.

**URL format:** `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/{model_id}`

**Headers:**
- `Authorization: Bearer {WORKERS_AI_API_TOKEN}`
- `cf-aig-authorization: Bearer {AI_GATEWAY_TOKEN}` (gateway auth)
- `cf-aig-request-timeout: 120000` (ms — 2 minutes, doubling the ~60s default)
- `Content-Type: application/json`

**Available env vars:** `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `WORKERS_AI_API_TOKEN`, `AI_GATEWAY_TOKEN` — all present in wrangler.jsonc vars and .env.

**Note:** Timeout is based on first response byte. JSON mode doesn't support streaming, so this is effectively total request duration.

**Refs:**
- `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx` — URL format
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx` — timeout config
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx` — auth headers
