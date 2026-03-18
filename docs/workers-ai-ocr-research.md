# Workers AI OCR Research

## Summary

Workers AI has no dedicated OCR model. OCR-like capability comes from two approaches:

1. **`env.AI.toMarkdown()` (Markdown Conversion)** — high-level utility, easiest path
2. **Direct vision model invocation** — lower-level, more control over prompts

## Approach 1: `toMarkdown` for Image → Markdown → LLM Extraction

### How It Works for Images

The `toMarkdown` pipeline for images:

1. Resizes image if > 1280×720
2. Runs **`@cf/facebook/detr-resnet-50`** for object detection
3. Feeds detected objects + image to **`@cf/google/gemma-3-12b-it`** (12B multimodal) for image-to-text

The output is a **markdown description** of the image contents. For an invoice image, it would describe what text/tables it sees. This is **not a text-preserving PDF extraction** like it does for PDFs (where it uses `StructTree` for semantic parsing and returns verbatim text).

### Image → toMarkdown → LLM Pipeline (Matches Existing Pattern)

This project already does: **PDF → `toMarkdown` → `@cf/openai/gpt-oss-120b`** for structured invoice extraction (see `src/lib/invoice-extraction.ts`). The same two-step pipeline works for images:

```typescript
// Step 1: Image → markdown via toMarkdown
const markdownResult = await env.AI.toMarkdown({
  name: "invoice.jpeg",
  blob: new Blob([imageBuffer], { type: "image/jpeg" }),
});
// markdownResult.data => markdown description of the image

// Step 2: Feed markdown to LLM for structured extraction (existing pattern)
const extracted = await runInvoiceExtractionViaGateway({
  accountId, gatewayId, workersAiApiToken, aiGatewayToken,
  markdown: markdownResult.data,
});
```

**Caveat:** For PDFs, `toMarkdown` extracts verbatim text from the PDF structure. For images, it uses a vision model to **describe** the image — the markdown won't be as precise or faithful as PDF text extraction. Invoice images with dense tables/numbers may lose accuracy in this step.

What the fuck does describe mean. stop being so fucking vague. If the invoice image contains line items with descriptions and prices, what gets output?

### Binding Usage

```typescript
const result = await env.AI.toMarkdown({
  name: "invoice.jpeg",
  blob: new Blob([imageBuffer], { type: "image/jpeg" }),
});
// result.data => markdown string
// result.tokens => estimated token count
```

### REST API Usage

```bash
curl https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown \
  -X POST \
  -H 'Authorization: Bearer {API_TOKEN}' \
  -F "files=@invoice.jpeg"
```

### Conversion Options

```typescript
await env.AI.toMarkdown(files, {
  conversionOptions: {
    image: { descriptionLanguage: "en" }, // en | it | de | es | fr | pt
  },
});
```

`descriptionLanguage` adds a directive to the prompt sent to `@cf/google/gemma-3-12b-it` telling it to output the image description in the specified language. It only affects the language of the AI-generated description — it does not do translation of text found in the image. Best-effort: the model may still output in a different language.

So in our case we should just use english, right?

### Costs

`toMarkdown` is free for most formats. For images specifically, it runs **two Workers AI models** under the hood:
- `@cf/facebook/detr-resnet-50` (object detection)
- `@cf/google/gemma-3-12b-it` ($0.345/M input tokens, $0.556/M output tokens)

These count against your Workers AI neuron allocation and will incur costs beyond the free 10,000 neurons/day.

## Approach 2: Direct Vision Models

### Available Vision/Image-to-Text Models

| Model | Params | JSON Mode | Notes |
|---|---|---|---|
| **`@cf/google/gemma-3-12b-it`** | 12B | No | Used by `toMarkdown` internally. Multimodal. |
| **`@cf/meta/llama-3.2-11b-vision-instruct`** | 11B | ✅ Yes | Vision model with JSON mode + structured output. |
| `@cf/llava-hf/llava-1.5-7b-hf` | 7B | No | Older, smaller. |

### Why `toMarkdown` Uses Gemma 3 Instead of Llama 3.2 Vision

`toMarkdown` uses `@cf/google/gemma-3-12b-it` because it's a general-purpose pipeline that needs to work without user prerequisites. Llama 3.2 Vision requires explicit Meta license acceptance per account, which would break the zero-config nature of `toMarkdown`. Gemma 3 has no such license gate.

### Best for Direct Image OCR: `@cf/meta/llama-3.2-11b-vision-instruct`

Supports JSON mode → can request structured output with a schema directly from the image, skipping the intermediate markdown step entirely.

I don't think we want to use JSON mode, right? I doubt it's powerful enough to extract invoice data. Would be asking too much of it and need more powerful model to figure that out. Is there a way just to spit out all the text in the image with coordinates or some such? In other words, OCR - not a structured json which we specify the schema for.

```typescript
const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
  messages: [
    { role: "system", content: "You are an OCR assistant. Extract all text from the image." },
    { role: "user", content: "Extract all text from this image exactly as written." },
  ],
  image: base64ImageData, // "data:image/png;base64,..." or raw base64
  response_format: {
    type: "json_schema",
    json_schema: { /* schema */ },
  },
});
```

This is a **single-model, single-step** approach vs the two-step `toMarkdown` → LLM pipeline. However, it's an 11B model — may not be as accurate for complex structured extraction as routing through a more powerful LLM like `@cf/openai/gpt-oss-120b` (120B) which the project currently uses.

### Pricing Comparison

| Model | Input | Output |
|---|---|---|
| `@cf/google/gemma-3-12b-it` | $0.345/M tokens | $0.556/M tokens |
| `@cf/meta/llama-3.2-11b-vision-instruct` | $0.049/M tokens | $0.676/M tokens |
| `@cf/openai/gpt-oss-120b` (current extraction model) | $0.350/M tokens | $0.750/M tokens |

Llama 3.2 Vision is **7× cheaper on input** than Gemma 3.

### Rate Limits

- Image-to-Text: 720 requests/minute

## Recommendation

### Option A: Image → `toMarkdown` → `gpt-oss-120b` (Two-Step, Highest Accuracy)

Matches existing PDF pipeline. Feed invoice image through `toMarkdown` to get markdown, then pass to the existing `runInvoiceExtractionViaGateway` with `@cf/openai/gpt-oss-120b`. Most powerful extraction model (120B) but costs two model invocations for the image step + the LLM call.

### Option B: Image → `llama-3.2-11b-vision-instruct` with JSON Mode (Single-Step, Cheapest)

Skip `toMarkdown`, feed image directly to Llama 3.2 Vision with structured output schema. Single model call, cheapest input cost. But only 11B — may struggle with dense invoice tables compared to the 120B model.

### Option C: Image → `toMarkdown` → `llama-3.2-11b-vision-instruct` (Redundant)

Don't do this — `toMarkdown` already uses a vision model, so you'd be running two vision models in sequence. Either use `toMarkdown` + a text LLM, or skip `toMarkdown` and go directly to a vision model.

## Prerequisites

### AI Binding

```toml
[ai]
binding = "AI"
```

### Meta License for Llama 3.2 Vision

Required **once per Cloudflare account** before first use. Send a single API request:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_AUTH_TOKEN" \
  -d '{ "prompt": "agree" }'
```

This is a one-time acknowledgment. After this, the model is immediately available for all subsequent requests on that account. No approval wait time.

Confirm that I only need run this on the command line once before deploy.

## Sources

- `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/llama-vision-tutorial.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`
- `src/lib/invoice-extraction.ts` (existing project pattern)
