# Research: Invoice Extraction via Gemini Flash & Cloudflare AI Gateway (2026)

## 1. Core Architecture Overview
For an indie developer, the most efficient stack for document processing combines the visual reasoning of Gemini Flash with the observability of Cloudflare.

*   **Model Provider:** Google AI Studio (Gemini 2.5/3.0 Flash).
*   **Proxy Layer:** Cloudflare AI Gateway.
*   **Execution Layer:** Cloudflare Workers (handling file uploads and schema validation).

## 2. Model Selection: Gemini 2.5 Flash
As of 2026, **Gemini 2.5 Flash** is the primary recommendation for document extraction:
*   **Multimodal Intelligence:** It "sees" the layout of the PDF/Image, identifying totals and line items even in complex or non-standard layouts.
*   **Cost Efficiency:** Priced at approximately **$0.10 per 1M tokens**, making it highly sustainable for indie budgets.
*   **Structured Output:** Supports native JSON schema enforcement, ensuring the model's response matches your application's data types exactly.

## 3. Cloudflare AI Gateway Configuration
The AI Gateway acts as a specialized proxy that provides logs, caching, and analytics for your AI requests.

### URL Structure
To route requests through the gateway, use the following endpoint format:
`https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_NAME}/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent`

### Authentication
Unlike enterprise-grade Google Cloud services, **Google AI Studio** uses a simple API Key. This key is passed to the Cloudflare Gateway as a query parameter:
`?key=YOUR_GOOGLE_AI_STUDIO_KEY`

### Gateway Benefits
1.  **Request Logging:** Inspect every invoice extraction attempt to debug edge cases.
2.  **Caching:** Automatically serve identical requests from the edge, reducing API costs and latency.
3.  **Cost Tracking:** Monitor token usage and spend in real-time within the Cloudflare dashboard.

## 4. Implementation with Effect Schema
Using **Effect (v4)** schemas ensures that the extraction is type-safe and consistent.

### The Extraction Schema
```typescript
import { Schema, JSONSchema } from "@effect/schema";

const LineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
});

export const InvoiceExtractionSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  invoiceNumber: Schema.String,
  invoiceDate: Schema.String,
  dueDate: Schema.String,
  currency: Schema.String,
  vendorName: Schema.String,
  lineItems: Schema.Array(LineItemSchema),
  total: Schema.String,
});

// Convert to OpenAPI for Gemini
const responseSchema = JSONSchema.make(InvoiceExtractionSchema);
```

### Request Logic (Cloudflare Worker)
In your Worker, you send the file (Base64) and the schema to the Gateway:
```typescript
const response = await fetch(`${gatewayUrl}?key=${env.API_KEY}`, {
  method: "POST",
  body: JSON.stringify({
    contents: [{
      parts: [
        { text: "Extract invoice data according to the provided schema." },
        { inlineData: { mimeType: "application/pdf", data: base64File } }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: responseSchema // The Effect-generated schema
    }
  })
});
```

## 5. Production Readiness & Privacy
To move from development to production:
1.  **Enable Billing in AI Studio:** Link a credit card to move to the **Paid Tier**.
2.  **Data Privacy:** Once billing is enabled, Google **does not** use your submitted documents or model outputs for training.
3.  **Rate Limits:** The Paid Tier increases limits to **2,000 Requests Per Minute**, providing ample headroom for scaling.
4.  **Secrets Management:** Store your Google API Key securely in **Cloudflare Secrets** rather than hardcoding it in your Worker.

***

### Quick Start Instructions:
1.  **Get Key:** Visit [aistudio.google.com](https://aistudio.google.com/) and generate an API key.
2.  **Create Gateway:** In the Cloudflare Dashboard, go to **AI > AI Gateway** and create a new gateway named `invoice-processor`.
3.  **Deploy Worker:** Use the logic above in a Cloudflare Worker to begin extracting structured data from invoices.