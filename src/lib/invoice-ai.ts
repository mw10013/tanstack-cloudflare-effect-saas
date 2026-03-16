import * as Schema from "effect/Schema";

export const SimpleInvoiceProbeSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  total: Schema.NullOr(Schema.String),
});

export const decodeSimpleInvoiceProbe = Schema.decodeUnknownSync(SimpleInvoiceProbeSchema);
export const simpleInvoiceProbeJsonSchema =
  Schema.toJsonSchemaDocument(SimpleInvoiceProbeSchema).schema;

export const SAMPLE_INVOICE_MARKDOWN = `# Invoice

Invoice Number: INV-1001
Invoice Date: 2026-03-15
Due Date: 2026-04-14
Currency: USD

Vendor:
- Name: Acme Supplies
- Street: 123 Market St
- City: San Francisco
- State: CA
- Postal Code: 94105
- Country: USA

Bill To:
- Name: Example Corp
- Street: 456 Billing Ave
- City: Oakland
- State: CA
- Postal Code: 94607
- Country: USA

Line Items:
- Description: Widget A
  Quantity: 2
  Unit Price: 25.00
  Amount: 50.00
- Description: Service Fee
  Quantity: 1
  Unit Price: 10.00
  Amount: 10.00

Subtotal: 60.00
Tax: 5.40
Total: 65.40`;
