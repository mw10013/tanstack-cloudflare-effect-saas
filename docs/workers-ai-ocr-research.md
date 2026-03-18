# Workers AI OCR Research

## Summary

**Workers AI has no true OCR.** No model returns verbatim text with coordinates/bounding boxes (like Tesseract or AWS Textract). What it has are vision LLMs (11-12B) that can look at an image and write about what they see. These are not OCR engines — they summarize, paraphrase, and miss details.

For invoice image → structured data extraction, the only viable Workers AI approach is:
**Image → vision model (text extraction prompt) → powerful text LLM (structured extraction)**

## Available Vision Models

| Model | Params | JSON Mode | Notes |
|---|---|---|---|
| **`@cf/meta/llama-3.2-11b-vision-instruct`** | 11B | ✅ Yes | Best option. Controllable prompt. Requires one-time Meta license acceptance. |
| **`@cf/google/gemma-3-12b-it`** | 12B | No | Used by `toMarkdown` internally. No license gate. |
| `@cf/llava-hf/llava-1.5-7b-hf` | 7B | No | Older, smaller. Not worth considering. |

**`@cf/openai/gpt-oss-120b`** (the project's current extraction model) is **text-only** — it cannot accept image input. So you always need a vision model as an intermediary step.

## Why `toMarkdown` Is Not Suitable for Invoice Images

`toMarkdown` for images uses object detection (`detr-resnet-50`) + Gemma 3 to produce a **prose description**, not text extraction. For a cat photo, it outputs _"The image features a cat sitting on a windowsill."_ For an invoice, it outputs something like _"The image shows an invoice from Cloudflare, Inc. It lists several line items including Workers Paid at $5.00. The total is $5.39."_ — a lossy summary that omits line items, exact amounts, addresses, etc. You cannot feed this to another LLM and expect accurate structured extraction because the data is already lost.

`toMarkdown` works well for PDFs because it parses the actual text layer (`StructTree`). For images, it's a different pipeline entirely and not designed for OCR.

## Recommended Approach: Llama 3.2 Vision → gpt-oss-120b

Use `@cf/meta/llama-3.2-11b-vision-instruct` as a text extractor (prompted to dump all visible text verbatim), then feed that text to `@cf/openai/gpt-oss-120b` via the existing `runInvoiceExtractionViaGateway` pipeline.

```typescript
// Step 1: Extract text from image via vision model
const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
  messages: [
    {
      role: "user",
      content: "Extract all text from this image exactly as it appears. Preserve the layout, line breaks, and formatting. Do not summarize or paraphrase.",
    },
  ],
  image: base64ImageData, // "data:image/png;base64,..." or raw base64
  max_tokens: 4096,
});
// response.response => raw-ish text from the image

// Step 2: Feed to gpt-oss-120b for structured extraction (existing pipeline)
const extracted = await runInvoiceExtractionViaGateway({
  accountId, gatewayId, workersAiApiToken, aiGatewayToken,
  markdown: response.response,
});
```

### Honest Assessment

This is a best-effort approach. An 11B vision model prompted to extract text is better than `toMarkdown`'s summary, but it's still not real OCR. Expect:
- **Good:** Invoice number, dates, vendor name, total amount — large, prominent text
- **Mediocre:** Individual line items with quantities and unit prices — dense tabular data
- **Poor:** Fine print, multi-page invoices (single image only), heavily formatted layouts

For production-quality invoice OCR, you'd want a dedicated OCR service (Google Cloud Vision, AWS Textract, Azure Document Intelligence) called from your Worker via fetch, then feed that OCR text to `gpt-oss-120b`. Workers AI alone isn't built for this.

### Pricing

| Model | Input | Output |
|---|---|---|
| `@cf/meta/llama-3.2-11b-vision-instruct` | $0.049/M tokens | $0.676/M tokens |
| `@cf/openai/gpt-oss-120b` | $0.350/M tokens | $0.750/M tokens |

Total per invoice: vision model call + LLM extraction call.

### Rate Limits

- Image-to-Text: 720 requests/minute

## Prerequisites

### AI Binding

```toml
[ai]
binding = "AI"
```

### Meta License for Llama 3.2 Vision

One-time per Cloudflare account. Run from terminal before deploying:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_AUTH_TOKEN" \
  -d '{ "prompt": "agree" }'
```

Immediately available after — no approval wait. Doesn't need to be in Worker code. All Workers on the account can use the model after this.

## Sources

- `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/llama-vision-tutorial.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`
- `src/lib/invoice-extraction.ts` (existing project pattern)
