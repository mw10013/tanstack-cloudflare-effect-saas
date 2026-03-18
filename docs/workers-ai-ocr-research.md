# Workers AI OCR Research

## Summary

Workers AI has no dedicated OCR model. OCR-like capability comes from two approaches:

1. **`env.AI.toMarkdown()` (Markdown Conversion)** — high-level utility, easiest path
2. **Direct vision model invocation** — lower-level, more control over prompts

## Approach 1: `toMarkdown` (Recommended for OCR)

The `toMarkdown` pipeline handles images automatically:

1. Resizes image if > 1280×720
2. Runs **`@cf/facebook/detr-resnet-50`** for object detection
3. Feeds detected objects + image to **`@cf/google/gemma-3-12b-it`** (12B multimodal) for text description

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

### Limitations

- Image pipeline produces a **description**, not raw OCR text extraction. It describes what's in the image rather than extracting exact text verbatim.

This is too vague. Do more research. I have images of invoices. Can I use toMarkdown on the invoice image and then use another llm to extract the invoice data? See invoice-extraction.ts in this project.

- Language option is best-effort.

More research. what does language option actually do?

- Uses two models under the hood → additional neuron costs.

## Approach 2: Direct Vision Models

### Available Vision/Image-to-Text Models

| Model                                        | Params | JSON Mode | Notes                                                                  |
| -------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------- |
| **`@cf/google/gemma-3-12b-it`**              | 12B    | No        | Most powerful. Used by `toMarkdown` internally. Multimodal.            |
| **`@cf/meta/llama-3.2-11b-vision-instruct`** | 11B    | ✅ Yes    | Vision model with JSON mode support. Requires Meta license acceptance. |
| `@cf/llava-hf/llava-1.5-7b-hf`               | 7B     | No        | Older, smaller. Referenced in Jupyter notebook tutorial.               |

How does one accept the meta license? Practically what does that mean? Can I use this model immediately.

### Most Powerful for OCR: `@cf/meta/llama-3.2-11b-vision-instruct`

**Why:** 11B vision model + supports JSON mode = can request structured OCR output with a schema.

If this is the most powerful, why doesn't toMarkdown use it?

```typescript
const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
  messages: [
    {
      role: "system",
      content: "You are an OCR assistant. Extract all text from the image.",
    },
    {
      role: "user",
      content: "Extract all text from this image exactly as written.",
    },
  ],
  image: base64ImageData, // "data:image/png;base64,..." or raw base64
  response_format: {
    type: "json_schema",
    json_schema: {
      /* schema */
    },
  },
});
```

### Pricing Comparison

| Model                                    | Input           | Output          |
| ---------------------------------------- | --------------- | --------------- |
| `@cf/google/gemma-3-12b-it`              | $0.345/M tokens | $0.556/M tokens |
| `@cf/meta/llama-3.2-11b-vision-instruct` | $0.049/M tokens | $0.676/M tokens |

Llama 3.2 Vision is **7× cheaper on input** — significant for image-heavy workloads.

### Rate Limits

- Image-to-Text: 720 requests/minute

## Recommendation

**For structured OCR (extracting specific fields from invoices):**
→ Use **`@cf/meta/llama-3.2-11b-vision-instruct`** directly with JSON mode. Cheaper input, structured output, custom prompts.

**For general image-to-markdown conversion:**
→ Use **`env.AI.toMarkdown()`** — zero-config, handles PDFs too.

toMarkdown must have costs then?

## Prerequisites

- `[ai]` binding in wrangler config:
  ```toml
  [ai]
  binding = "AI"
  ```
- For Llama 3.2 Vision: must accept Meta's license first via API call.

More details about this.

## Sources

- `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/llama-vision-tutorial.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`
