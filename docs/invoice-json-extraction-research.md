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

Add a var for the gateway ID in `wrangler.jsonc`:

```jsonc
"vars": {
  "AI_GATEWAY_ID": "tcei-gateway"
}
```

Need more research here for the gateway id. scan refs/tca to see how that project does it. I'm not sure if we can reuse its gateway or we should create a new one in cloudflare. probably a new one but then we need the tokens and all that shit. Do research.

We want to use the gateway cache to save on dev costs.

No new binding needed — the existing `"ai": { "binding": "AI" }` already supports gateway routing.

### What AI Gateway provides

- **Logging** — every request/response is logged in the dashboard, useful for debugging extraction quality
- **Caching** — can cache identical requests (useful if retrying the same invoice)
- **Rate limiting** — protect against runaway costs
- **Analytics** — token usage, latency, error rates per model

For invoice extraction, **skip cache** since each invoice is unique:

```ts
{ gateway: { id: env.AI_GATEWAY_ID, skipCache: true } }
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

Similar pattern to `markdown` / `markdownError`:

```sql
alter table Invoice add column invoiceJson text
alter table Invoice add column invoiceJsonError text
```

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
        skipCache: true,
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

### 5. Update `applyInvoiceMarkdown` to not set `status = 'ready'`

Since extraction now continues after markdown, `applyInvoiceMarkdown` should set an intermediate status like `'extracted_markdown'` or just leave status as `'extracting'`. Only `applyInvoiceJson` sets `'ready'`.

### 6. Update error handling

`onWorkflowError` already handles workflow-level errors. The new steps will throw on failure and the workflow error handler will catch them. Update the error handler to store in `invoiceJsonError` if the JSON extraction step fails.

Alternatively, keep it simple: any workflow error sets `status = 'extract_error'` and stores the error message. The workflow is atomic — if JSON extraction fails, the whole workflow errors.

### 7. Add `AI_GATEWAY_ID` var to `wrangler.jsonc`

```jsonc
"vars": {
  "AI_GATEWAY_ID": "tcei-gateway"
}
```

Add to both top-level and `env.production` vars.

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
3. `save-markdown` — agent RPC (status stays `'extracting'`)
4. `extract-invoice-json` — `env.AI.run` with JSON mode through gateway
5. `save-invoice-json` — agent RPC (sets status `'ready'`)

Why save markdown before extracting JSON:

- Markdown is useful on its own for debugging even if JSON extraction fails
- If the JSON extraction step fails and retries, the markdown step result is already persisted via the workflow step checkpointing
- The user can see markdown appear first, then JSON follows — better incremental UX

## Open Questions

1. **Schema complexity vs model capability** — should we start with a simpler schema (just invoiceNumber, date, total, lineItems) and expand later?

Let's try with more properties, but maybe make more of them optional so we can get something back if the model cannot fully populate.

2. **Status granularity** — should there be separate statuses for markdown-done-json-pending (e.g., `'extracting_json'`), or is `'extracting'` sufficient throughout?

Separate statuses and would be helpful if they were broadcast. The route component for invoices probably needs a way to display the broadcast messages. Maybe there could be a local cache in tanstack query that accumulates the messages and a ui component displays them. we don't need to persist these messages across page loads.

3. **Retry on schema validation failure** — if `decodeInvoiceData` fails (model returned valid JSON but wrong shape), should we retry the AI call within the step, or let the workflow-level retry handle it?

What do you recommend and why?

4. **Effect Schema `NullOr` vs `optionalKey`** — `NullOr` forces the LLM to always include the key with null. `optionalKey` makes the key optional. Which produces better LLM compliance? (Recommendation: `NullOr` for explicitness with LLMs.)

NullOr

5. **Gateway name** — what should the gateway be named? Suggestion: `tcei-gateway` or just use `default`.

Is this the name of the gateway in cloudflare admin dashboard? or is this internal name for gateway?
