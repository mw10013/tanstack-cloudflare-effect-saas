# Invoice JSON Extraction Research

Question: after `InvoiceExtractionWorkflow` converts PDF to markdown, how do we add workflow steps that feed the markdown into a Workers AI model to extract structured invoice JSON, store it in the agent database, and display it in the invoices route?

## Short Answer

Add two new workflow steps after `convert-pdf-to-markdown`:

1. `extract-invoice-json` — call `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", ...)` with JSON mode and a JSON schema derived from an Effect Schema via `Schema.toJsonSchemaDocument`.
2. `save-invoice-json` — persist the extracted JSON to a new `invoiceJson` column on the `Invoice` table via agent RPC.

Route the `env.AI.run` call through Cloudflare AI Gateway by passing `{ gateway: { id: gatewayId } }` as the third argument. The gateway ID comes from a wrangler var.

Display the JSON in the invoices route in a `<pre>` block, matching the existing markdown display pattern.

## Model Selection

### Recommendation: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:116`:

```
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

This model supports JSON mode with `json_schema` response format. It's the best Workers AI option for structured extraction because:

- **70B parameter model** — much stronger at following complex schemas and reasoning about invoice fields than the 8B alternatives
- **fp8 quantization + fast inference** — 2-4x speed boost vs standard 70B, practical for real-time extraction
- **24,000 token context window** — sufficient for invoice markdown (typical invoice markdown is 1-5K tokens)
- **JSON mode support** — constrained decoding ensures valid JSON output matching the schema

### Pricing context

From `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx:42`:

```
@cf/meta/llama-3.3-70b-instruct-fp8-fast: $0.293 per M input tokens / $2.253 per M output tokens
```

vs the cheaper alternative:

```
@cf/meta/llama-3.1-8b-instruct-fp8-fast: $0.045 per M input tokens / $0.384 per M output tokens
```

The 70B model is ~6x more expensive but significantly more reliable for structured extraction. Invoice volumes are low, so cost is not a concern.

### Why not the 8B model?

`@cf/meta/llama-3.1-8b-instruct-fast` also supports JSON mode (from json-mode.mdx:114), but smaller models struggle with:

- correctly mapping ambiguous fields (e.g., distinguishing bill-to vs ship-to addresses)
- handling varied invoice layouts
- reliably populating optional fields vs hallucinating values

Start with 70B. If extraction quality is good, consider testing 8B as a cheaper alternative later.

### Caveat from docs

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`:

```
Workers AI can't guarantee that the model responds according to the requested JSON Schema.
Depending on the complexity of the task and adequacy of the JSON Schema, the model may not
be able to satisfy the request in extreme situations. If that's the case, then an error
`JSON Mode couldn't be met` is returned and must be handled.
```

This means we need error handling for malformed responses — both the `JSON Mode couldn't be met` error and potential schema validation failures.

## AI Gateway Integration

### How it works

From `refs/cloudflare-docs/src/content/docs/ai-gateway/integrations/aig-workers-ai-binding.mdx:85`:

> You can integrate Workers AI with AI Gateway using an environment binding.

From `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:89`:

```ts
const response = await env.AI.run(
  "@cf/meta/llama-3.1-8b-instruct",
  { prompt: "..." },
  {
    gateway: {
      id: "{gateway_id}",
      skipCache: false,
      cacheTtl: 3360,
    },
  },
);
```

The third argument to `env.AI.run` accepts a `gateway` object. Parameters from `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:120`:

- `id` string — name of the AI Gateway (must be in same account)
- `skipCache` boolean (default: false)
- `cacheTtl` number

### Gateway creation

From `refs/cloudflare-docs/src/content/docs/ai-gateway/get-started.mdx:49`:

> AI Gateway automatically creates a gateway for you on the first request. The gateway is created with authentication turned on.

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx:65`:

> When an AI Gateway is accessed from a Cloudflare Worker using a binding, the `cf-aig-authorization` header does not need to be manually included.

So when using the binding path (`env.AI.run` with `gateway.id`), auth is automatic. No token management needed.

### Wrangler changes

`AI_GATEWAY_ID` is already configured in `wrangler.jsonc:19` (and `:109` for production):

```jsonc
"AI_GATEWAY_ID": "tcei-ai-gateway"
```

`AI_GATEWAY_TOKEN` and `WORKERS_AI_API_TOKEN` are already in `.env` and typed in `worker-configuration.d.ts`. Not needed for the binding path but available for future use (e.g., URL path with AI SDK).

No new binding needed — the existing `"ai": { "binding": "AI" }` already supports gateway routing.

### Gateway ID explained

The gateway ID **is the name you give the gateway in the Cloudflare dashboard**. There is no separate internal UUID — the slug you choose becomes the `{gateway_id}` in the URL `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...`.

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/manage-gateway.mdx:16`:

> AI Gateway can automatically create a gateway for you. When you use `default` as a gateway ID and no gateway with that ID exists in your account, AI Gateway creates it on the first authenticated request.

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/manage-gateway.mdx:32`:

> Auto-creation only applies to the gateway ID `default`. Using any other gateway ID requires creating the gateway first.

### Should we reuse tca's gateway or create a new one?

`refs/tca` uses `AI_GATEWAY_ID: "saas-ai-gateway"` (from `refs/tca/wrangler.jsonc:20`). Both projects share the same `account_id` (`1422451be59cc2401532ad67d92ae773`), so they share the same gateway namespace.

**Already done: `tcei-ai-gateway` exists in the Cloudflare dashboard** as a separate gateway from tca's `saas-ai-gateway`.

Why separate:

- Separate logging/analytics — invoice extraction logs won't mix with tca's classification logs
- Independent rate limiting and caching config

### No tokens needed for the binding path

`refs/tca` has two gateway usage patterns:

1. **Binding path** (`env.AI.run` with `gateway.id`) — from `refs/tca/src/organization-agent.ts:258`:
   ```ts
   const response = await this.env.AI.run(
     "@cf/microsoft/resnet-50",
     { image: bytes },
     { gateway: { id: this.env.AI_GATEWAY_ID, skipCache: false, cacheTtl: 7 * 24 * 60 * 60 } },
   );
   ```
   **No token needed.** Auth is automatic via the worker binding.

2. **URL path** (`env.AI.gateway().getUrl()` with OpenAI SDK) — from `refs/tca/src/organization-agent.ts:939`:
   ```ts
   const gatewayUrl = await this.env.AI.gateway(this.env.AI_GATEWAY_ID).getUrl("workers-ai");
   const openai = createOpenAI({
     baseURL: `${gatewayUrl}/v1`,
     apiKey: this.env.WORKERS_AI_API_TOKEN,
     headers: { "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}` },
   });
   ```
   **Requires both `WORKERS_AI_API_TOKEN` and `AI_GATEWAY_TOKEN`.**

We use path 1 (binding). So: **no `AI_GATEWAY_TOKEN` or `WORKERS_AI_API_TOKEN` needed**. Just `AI_GATEWAY_ID` as a var.

### Gateway setup (already complete)

- Gateway `tcei-ai-gateway` exists in Cloudflare dashboard
- `AI_GATEWAY_ID: "tcei-ai-gateway"` is in wrangler vars (both top-level and production)
- `AI_GATEWAY_TOKEN` and `WORKERS_AI_API_TOKEN` are in `.env`
- Types are up to date in `worker-configuration.d.ts`
- Enable caching in the dashboard if not already on (set TTL e.g. 3600s)

### What AI Gateway provides

- **Logging** — every request/response is logged in the dashboard, useful for debugging extraction quality
- **Caching** — cache identical requests to save on dev costs during iteration
- **Rate limiting** — protect against runaway costs
- **Analytics** — token usage, latency, error rates per model

### Caching strategy

From `refs/cloudflare-docs/src/content/docs/ai-gateway/features/caching.mdx:12`:

> AI Gateway can cache responses from your AI model providers, serving them directly from Cloudflare's cache for identical requests.

From `refs/cloudflare-docs/src/content/docs/ai-gateway/features/caching.mdx:22`:

> Currently caching is supported only for text and image responses, and it applies only to identical requests.

**For dev: enable caching.** During development, we'll re-upload the same test PDFs repeatedly. The markdown extraction is deterministic, so the same markdown → same prompt → cache hit on the JSON extraction call. This saves on dev costs.

**For production: also keep caching on.** If a workflow retries (e.g., the `save-invoice-json` step fails after `extract-invoice-json` succeeds), the retry will re-run `extract-invoice-json` with the same prompt and hit cache.

Use `skipCache: false` with a reasonable TTL:

```ts
{
  gateway: {
    id: this.env.AI_GATEWAY_ID,
    skipCache: false,
    cacheTtl: 7 * 24 * 60 * 60, // 1 week
  },
}
```

### Additional gateway binding methods

From `refs/cloudflare-docs/src/content/docs/ai-gateway/integrations/worker-binding-methods.mdx:56`:

```ts
const myLogId = env.AI.aiGatewayLogId;
```

Could log the gateway log ID alongside the invoice for debugging/audit trail. Optional for spike.

## JSON Schema Approach

### Use Effect v4 Schema → JSON Schema

Define the invoice shape as an Effect Schema, then use `Schema.toJsonSchemaDocument` to generate the JSON Schema for the Workers AI `response_format`.

From `refs/effect4/packages/effect/SCHEMA.md:4572`:

```ts
import { Schema } from "effect"

const document = Schema.toJsonSchemaDocument(schema)
// Returns { source: "draft-2020-12", schema: {...}, definitions: {...} }
```

### Why this approach

1. **Single source of truth** — the Effect Schema defines both the JSON Schema for the LLM and the runtime decoder/validator
2. **Runtime validation** — use `Schema.decodeUnknownSync` to validate the LLM response, catching hallucinated or malformed output
3. **Already in use** — the codebase already uses Effect Schema for `InvoiceRowSchema` in `src/organization-agent.ts:17`
4. **Type safety** — `typeof InvoiceDataSchema.Type` gives the TypeScript type for free

### Extracting the raw JSON Schema object

`Schema.toJsonSchemaDocument` returns a `{ source, schema, definitions }` document. Workers AI `response_format.json_schema` expects a raw JSON Schema object.

For a flat schema without `$ref`, just use `document.schema`:

```ts
const document = Schema.toJsonSchemaDocument(InvoiceDataSchema)
const jsonSchema = document.schema
// Pass as response_format: { type: "json_schema", json_schema: jsonSchema }
```

If the schema uses refs (e.g., branded types, recursive types), `$defs` must be inlined. For invoice data this should not be needed — keep the schema flat.

### Annotations for better extraction

From `refs/effect4/packages/effect/SCHEMA.md:4653`:

```ts
const schema = Schema.NonEmptyString.annotate({
  title: "Username",
  description: "A non-empty user name string",
})
```

Annotating fields with `description` helps the LLM understand what each field means, improving extraction accuracy:

```ts
Schema.String.annotate({ description: "The invoice number or ID printed on the document" })
```

## Invoice JSON Schema Design

### Recommended shape

```ts
const InvoiceLineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.NullOr(Schema.Number),
  unitPrice: Schema.NullOr(Schema.Number),
  amount: Schema.Number,
})

const InvoiceAddressSchema = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  street: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  postalCode: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
})

const InvoiceDataSchema = Schema.Struct({
  invoiceNumber: Schema.NullOr(Schema.String),
  invoiceDate: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  vendor: InvoiceAddressSchema,
  billTo: InvoiceAddressSchema,
  lineItems: Schema.Array(InvoiceLineItemSchema),
  subtotal: Schema.NullOr(Schema.Number),
  tax: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
})
```

### Design decisions

- **`NullOr` for optional fields** — invoices vary wildly. Some have no due date, no tax line, no vendor address. Using `NullOr` instead of `optional` because the LLM should always return the key (just set to `null` if not found). This produces cleaner JSON Schema with no `anyOf`/`oneOf` complexity that could confuse the model.
- **Flat address struct** — avoids nested complexity. Both vendor and billTo share the same shape.
- **Line items as array** — every invoice has line items. `quantity` and `unitPrice` are nullable because some invoices show only a flat amount per line.
- **Amounts as `Number`** — not `String`. The LLM can parse "$1,234.56" into `1234.56`. If precision matters later, switch to string and parse separately.
- **Dates as `String`** — LLMs can return dates in various formats. Store as-is and normalize later if needed.
- **No `additionalProperties`** — Effect Schema's `Struct` sets `additionalProperties: false` by default in the generated JSON Schema, which constrains the LLM output.

### Note on `NullOr` in JSON Schema output

From `refs/effect4/packages/effect/SCHEMA.md:4735`:

> Fields including `undefined` (such as those defined using `Schema.optional` or `Schema.UndefinedOr`) are converted to optional fields or elements in the JSON Schema with a union with the `null` type.

`Schema.NullOr(Schema.String)` produces:

```json
{ "anyOf": [{ "type": "string" }, { "type": "null" }] }
```

This is valid JSON Schema and well-understood by LLMs.

## Prompt Design

### System prompt

```
You are an invoice data extraction assistant. Extract structured data from the provided invoice markdown.
Rules:
- Extract only information explicitly present in the document.
- Set fields to null if the information is not found.
- For amounts, extract as numbers without currency symbols or commas.
- For dates, use the format as shown in the document.
- Include all line items found in the invoice.
```

### User prompt

```
Extract the invoice data from the following markdown:

{markdown}
```

### Why this prompt structure

- **Explicit null instruction** — prevents hallucination of missing fields
- **Number formatting instruction** — the LLM needs guidance to strip currency symbols
- **Minimal prompt** — the JSON Schema already constrains the output shape; the prompt just needs to guide extraction behavior
- **No few-shot examples** — adds token cost and the schema is self-describing enough. Add examples later if extraction quality is poor.

## Implementation Plan

### 1. Define `InvoiceDataSchema` in `src/organization-agent.ts`

Place it alongside `InvoiceRowSchema`. Create the JSON schema object once at module level:

```ts
const InvoiceDataSchema = Schema.Struct({ ... })
type InvoiceData = typeof InvoiceDataSchema.Type
const decodeInvoiceData = Schema.decodeUnknownSync(InvoiceDataSchema)
const invoiceDataJsonSchema = Schema.toJsonSchemaDocument(InvoiceDataSchema).schema
```

### 2. Add `invoiceJson` and `invoiceJsonError` columns to `Invoice` table

Add columns directly to the `create table` statement. Remove all `alter table` migrations (both existing `markdown`/`markdownError` alters and new ones) — database will be reset from scratch.

Store the extracted JSON as a serialized string. Decode with `JSON.parse` + `decodeInvoiceData` when reading.

Update `InvoiceRowSchema` to include the new columns.

### 3. Add two new workflow steps

After step `convert-pdf-to-markdown`, add:

```ts
const invoiceJson = await step.do("extract-invoice-json", async () => {
  const result = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Extract the invoice data from the following markdown:\n\n${markdown}` },
      ],
      response_format: {
        type: "json_schema",
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
  if (!result.response) {
    throw new Error("No response from AI model");
  }
  const parsed = JSON.parse(result.response);
  return decodeInvoiceData(parsed);
});
```

Then save:

```ts
await step.do("save-invoice-json", async () => {
  await this.agent.applyInvoiceJson({
    invoiceId: event.payload.invoiceId,
    idempotencyKey: event.payload.idempotencyKey,
    invoiceJson: JSON.stringify(invoiceJson),
  });
});
```

### 4. Add `applyInvoiceJson` method to `OrganizationAgent`

Same pattern as `applyInvoiceMarkdown`:

```ts
applyInvoiceJson(input: {
  invoiceId: string;
  idempotencyKey: string;
  invoiceJson: string;
}) {
  const processedAt = Date.now();
  const updated = this.sql<{ id: string; fileName: string }>`
    update Invoice
    set status = 'ready',
        processedAt = ${processedAt},
        invoiceJson = ${input.invoiceJson},
        invoiceJsonError = null
    where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
    returning id, fileName
  `;
  if (updated.length === 0) return;
  this.broadcast(JSON.stringify({
    type: "invoice_extraction_complete",
    invoiceId: updated[0].id,
    fileName: updated[0].fileName,
  }));
}
```

### 5. Update `applyInvoiceMarkdown` to set `status = 'extracted_markdown'`

Since extraction now continues after markdown, `applyInvoiceMarkdown` sets `status = 'extracted_markdown'` and broadcasts `invoice_markdown_complete`. Only `applyInvoiceJson` sets `'ready'`.

Update `onInvoiceUpload` to set `status = 'extracting_markdown'` (instead of `'extracting'`) when starting the workflow.

### 6. Update error handling

`onWorkflowError` already handles workflow-level errors. The new steps will throw on failure and the workflow error handler will catch them. Update the error handler to store in `invoiceJsonError` if the JSON extraction step fails.

Alternatively, keep it simple: any workflow error sets `status = 'extract_error'` and stores the error message. The workflow is atomic — if JSON extraction fails, the whole workflow errors.

### 7. `AI_GATEWAY_ID` var (already in `wrangler.jsonc`)

Already configured as `"tcei-ai-gateway"` in both top-level and production vars. No changes needed.

### 8. Display in route

In `src/routes/app.$organizationId.invoices.tsx`, add a second display block after the markdown `<pre>`:

```tsx
{selectedInvoice.invoiceJson && (
  <pre className="max-h-144 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
    {JSON.stringify(JSON.parse(selectedInvoice.invoiceJson), null, 2)}
  </pre>
)}
```

Add a "JSON" column to the table alongside the existing "Markdown" column, showing size or status.

## Workflow Step Ordering

Current workflow:

1. `load-pdf` — R2 fetch
2. `convert-pdf-to-markdown` — `env.AI.toMarkdown`
3. `save-markdown` — agent RPC

New workflow:

1. `load-pdf` — R2 fetch
2. `convert-pdf-to-markdown` — `env.AI.toMarkdown`
3. `save-markdown` — agent RPC (status → `'extracted_markdown'`, broadcasts `invoice_markdown_complete`)
4. `extract-invoice-json` — `env.AI.run` with JSON mode through gateway (agent sets status → `'extracting_json'`, broadcasts `invoice_json_started` before the call)
5. `save-invoice-json` — agent RPC (status → `'ready'`, broadcasts `invoice_extraction_complete`)

Why save markdown before extracting JSON:

- Markdown is useful on its own for debugging even if JSON extraction fails
- If the JSON extraction step fails and retries, the markdown step result is already persisted via the workflow step checkpointing
- The user can see markdown appear first, then JSON follows — better incremental UX

## Resolved Questions

### 1. Schema complexity — keep full schema, make more fields `NullOr`

Decision: try with more properties but make more of them `NullOr` so the model can return partial results.

Updated schema approach: every field except `lineItems` is `NullOr`. Even `lineItems` uses `NullOr` for individual item fields like `quantity`, `unitPrice`. The model can always return `null` for anything it can't find — we get partial extraction rather than failure.

### 2. Status granularity — separate statuses, broadcast each transition

Decision: use separate statuses and broadcast each one.

Statuses:

- `uploaded` — file uploaded, no processing yet
- `extracting_markdown` — markdown conversion in progress
- `extracted_markdown` — markdown done, JSON extraction pending
- `extracting_json` — JSON extraction in progress
- `ready` — JSON extraction complete
- `extract_error` — any step failed

Broadcast events:

- `invoice_extraction_started` — workflow kicked off
- `invoice_markdown_complete` — markdown saved
- `invoice_json_started` — JSON extraction step beginning
- `invoice_extraction_complete` — JSON saved, fully done
- `invoice_extraction_error` — any failure

#### Route broadcast message display

The route component needs a way to show these broadcast messages as a live activity feed. Approach:

- Use a TanStack Query `queryClient.setQueryData` call to accumulate broadcast messages into a client-side query key like `["invoice-activity", organizationId]`
- Messages are ephemeral — they live only in the query cache, not persisted
- A small UI component (e.g., a toast stack or a collapsible activity log panel) reads from this query key and displays recent messages
- On page load, the list starts empty — no persistence needed
- The existing websocket `onmessage` handler that calls `router.invalidate()` can also push messages into this query cache

This keeps the implementation simple: no new server state, no new API, just client-side accumulation of websocket events.

### 3. Retry on schema validation failure — let workflow-level retry handle it

Recommendation: **let the workflow retry handle it** (throw from the step).

Why:

- The `step.do` callback is the retry boundary. If `decodeInvoiceData` throws, the step fails and the workflow retries the step from scratch.
- The workflow step result is checkpointed only on success (from `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx:216`: "step.do executes code and persists the result"). A failed step is not persisted, so retry is clean.
- Adding in-step retry logic (e.g., retry 3 times within the step) adds complexity and masks problems. If the model consistently returns bad JSON for a given invoice, we want the workflow to error out and surface it, not silently retry 3 times and then error anyway.
- With caching enabled on the gateway, a retry of the same prompt would hit cache and return the same bad result anyway. A workflow-level retry with a fresh attempt is more likely to get a different response (cache may have expired or the step may re-run with slightly different timing).

If we see frequent schema validation failures in practice, we can add in-step retry with a modified prompt (e.g., append "Please ensure all fields match the schema exactly") as a second attempt before throwing.

### 4. Effect Schema `NullOr` vs `optionalKey` — use `NullOr`

Decision: `NullOr` for all nullable fields.

`NullOr` produces `{ "anyOf": [{ "type": "string" }, { "type": "null" }] }` which requires the key to always be present. This is better for LLMs because:

- Explicit key presence means the model must consider each field
- Optional keys (`optionalKey`) let the model silently skip fields, making it harder to distinguish "model couldn't find it" from "model forgot to include it"

### 5. Gateway name — `tcei-ai-gateway`, already exists

Gateway `tcei-ai-gateway` already exists in the Cloudflare dashboard. `AI_GATEWAY_ID` is already configured in wrangler. The dashboard name and the API slug are the same thing.

See "Gateway ID explained" and "Gateway setup" sections above for details.
