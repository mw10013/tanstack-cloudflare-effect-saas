# Invoice Schema Expansion Research

## Decisions

- **Reconciliation**: Option A — single source of truth in domain schemas, extraction derives from them
- **Naming**: `InvoiceItem` (not LineItem). Extraction schema field renamed `lineItems` → `invoiceItems`
- **`extractedJson`**: Keep as audit record
- **Text field defaults**: `''` (not null). `invoiceConfidence` defaults to `0` (real, not null)
- **InvoiceItem ordering**: `sortOrder` column (real) — 1.0, 2.0, 3.0 on insert; fractional reorder without touching other rows
- **InvoiceItem.id**: UUID
- **Cascade**: SQLite FK `on delete cascade`
- **InvoiceRow → Invoice** rename

---

## Schema Design (Option A)

### Shared field definitions in `OrganizationDomain.ts`

Using `.fields` spread pattern from effect v4 Schema:

```ts
const InvoiceExtractionFields = Schema.Struct({
  invoiceConfidence: Schema.Number,
  invoiceNumber: Schema.String,
  invoiceDate: Schema.String,
  dueDate: Schema.String,
  currency: Schema.String,
  vendorName: Schema.String,
  vendorEmail: Schema.String,
  vendorAddress: Schema.String,
  billToName: Schema.String,
  billToEmail: Schema.String,
  billToAddress: Schema.String,
  subtotal: Schema.String,
  tax: Schema.String,
  total: Schema.String,
  amountDue: Schema.String,
})

const InvoiceItemFields = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
})
```

### Domain schemas (OrganizationDomain.ts)

```ts
export const Invoice = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  r2ActionTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  ...InvoiceExtractionFields.fields,   // ← spread shared fields
  extractedJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})

export const InvoiceItem = Schema.Struct({
  id: Schema.String,
  invoiceId: Schema.String,
  sortOrder: Schema.Number,
  ...InvoiceItemFields.fields,         // ← spread shared fields
})
```

### Extraction schema (InvoiceExtraction.ts)

Imports and reuses the shared field structs:

```ts
import { InvoiceExtractionFields, InvoiceItemFields } from "./OrganizationDomain"

const InvoiceExtractionSchema = Schema.Struct({
  ...InvoiceExtractionFields.fields,
  invoiceItems: Schema.Array(Schema.Struct({
    ...InvoiceItemFields.fields,
  })),
})
```

Same fields, zero duplication. Gemini JSON schema generated from the same source. Field rename → one place.

---

## SQLite DDL

### Invoice table (updated)

```sql
create table if not exists Invoice (
  id text primary key,
  fileName text not null,
  contentType text not null,
  createdAt integer not null,
  r2ActionTime integer not null,
  idempotencyKey text not null unique,
  r2ObjectKey text not null,
  status text not null,
  invoiceConfidence real not null default 0,
  invoiceNumber text not null default '',
  invoiceDate text not null default '',
  dueDate text not null default '',
  currency text not null default '',
  vendorName text not null default '',
  vendorEmail text not null default '',
  vendorAddress text not null default '',
  billToName text not null default '',
  billToEmail text not null default '',
  billToAddress text not null default '',
  subtotal text not null default '',
  tax text not null default '',
  total text not null default '',
  amountDue text not null default '',
  extractedJson text,
  error text
)
```

### InvoiceItem table (new)

```sql
create table if not exists InvoiceItem (
  id text primary key,
  invoiceId text not null references Invoice(id) on delete cascade,
  sortOrder real not null,
  description text not null default '',
  quantity text not null default '',
  unitPrice text not null default '',
  amount text not null default '',
  period text not null default ''
)
```

Note: SQLite requires `pragma foreign_keys = on` per connection for cascade to work. Need to verify this is enabled in the DO sqlite context.

it's enabled. change sortOrder to order

---

## Data Flow Changes

### Current
1. Upload → `upsertInvoice` (status=uploaded)
2. Workflow extracts → `saveExtractedJson(invoiceId, idempotencyKey, jsonString)`
3. UI reads `extractedJson`, `JSON.parse`s for display

### New
1. Upload → `upsertInvoice` (status=uploaded) — same, new fields default to `''`/`0`
2. Workflow extracts → `saveExtraction(invoiceId, idempotencyKey, extractedFields, invoiceItems[])`:
   - Update Invoice row with extracted field values + `extractedJson` blob
   - Delete existing InvoiceItems for this invoiceId (re-extraction case)
   - Insert InvoiceItem rows with generated UUIDs and sortOrder 1.0, 2.0, ...
   - Set status = 'extracted'
3. UI reads fields directly from Invoice + joined InvoiceItems

---

## Files to Change

| File | Change |
|---|---|
| `src/lib/OrganizationDomain.ts` | Add `InvoiceExtractionFields`, `InvoiceItemFields` shared structs. Rename `InvoiceRow` → `Invoice` with spread fields. Add `InvoiceItem` schema. |
| `src/lib/InvoiceExtraction.ts` | Import shared field structs, rebuild `InvoiceExtractionSchema` from them. Rename `lineItems` → `invoiceItems` in prompt + schema. |
| `src/organization-agent.ts` | Update DDL (new columns + InvoiceItem table + FK pragma). Update `saveExtractedJson` → `saveExtraction`. |
| `src/lib/OrganizationRepository.ts` | Rename decoders. Add `InvoiceItem` queries. Replace `saveExtractedJson` with `saveExtraction` (transaction: update Invoice fields + delete/insert InvoiceItems). |
| `src/invoice-extraction-workflow.ts` | Pass structured extraction result instead of `JSON.stringify`. |
| `src/routes/app.$organizationId.invoices.tsx` | Read fields directly. Update `InvoiceRow` references → `Invoice`. |
