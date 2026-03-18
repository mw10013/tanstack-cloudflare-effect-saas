# Research: Invoice Extraction via Gemini Flash & Cloudflare AI Gateway

## Architecture

Gemini 2.5 Flash as the vision+extraction model, routed through the existing Cloudflare AI Gateway.

- **Model:** Google AI Studio — Gemini 2.5 Flash
- **Proxy:** Cloudflare AI Gateway (existing)
- **Execution:** Cloudflare Workers

## Gemini 2.5 Flash

- **Multimodal:** Accepts images and PDFs directly — no separate OCR step. Reads the document visually and extracts structured data in one call.
- **Structured Output:** Native JSON schema enforcement via `responseMimeType: "application/json"` + `responseSchema`.
- **Cost:** ~$0.10/M input tokens, ~$0.40/M output tokens.
- **Rate Limits (Paid Tier):** 2,000 RPM.
- **Privacy:** Paid tier data is not used for training.

## AI Gateway

### URL

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent
```

Gateway recognizes `google-ai-studio` as a provider from the URL path. No additional dashboard configuration needed.

### Authentication

Google API key via `x-goog-api-key` header + `cf-aig-authorization` for the authenticated gateway. Same pattern as the existing Workers AI gateway calls in `src/lib/invoice-extraction.ts`.

## Implementation

```typescript
const response = await fetch(
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": googleApiKey,
      "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: buildPrompt() },
          { inlineData: { mimeType: "image/jpeg", data: base64ImageData } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: InvoiceExtractionJsonSchema,
      },
    }),
  }
);
```

- **Images:** `inlineData` with `mimeType: "image/jpeg"` or `"image/png"`
- **PDFs:** `inlineData` with `mimeType: "application/pdf"`
- **Schema:** Reuse existing `InvoiceExtractionJsonSchema` from `src/lib/invoice-extraction.ts`

## Production Checklist

1. **Get API key** from [aistudio.google.com](https://aistudio.google.com/)
2. **Enable billing** for paid tier (privacy guarantee, 2,000 RPM)
3. **Store key** as Cloudflare secret: `wrangler secret put GOOGLE_AI_STUDIO_KEY`

## Sources

- `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/google-ai-studio.mdx`
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx`
- `src/lib/invoice-extraction.ts`
