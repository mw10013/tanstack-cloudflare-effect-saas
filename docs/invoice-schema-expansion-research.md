# Invoice Schema Expansion Research

## Current State

### InvoiceExtractionSchema (`src/lib/InvoiceExtraction.ts:9-34`)
AI extraction output — flat invoice fields + `lineItems` array. All amounts/dates are strings (as-they-appear-in-document). Used as Gemini response schema and decoded in `decodeInvoiceExtractionResponse`.

```
invoiceConfidence, invoiceNumber, invoiceDate, dueDate, currency,
vendorName, vendorEmail, vendorAddress,
billToName, billToEmail, billToAddress,
lineItems[]: { description, quantity, unitPrice, amount, period },
subtotal, tax, total, amountDue
```

### InvoiceRow (`src/lib/OrganizationDomain.ts:5-16`)
Current SQLite row shape. Tracks upload lifecycle — no invoice-proper fields. Extraction result stored as opaque JSON blob in `extractedJson`.

```
id, fileName, contentType, createdAt, r2ActionTime,
idempotencyKey, r2ObjectKey, status, extractedJson, error
```

### Invoice table DDL (`src/organization-agent.ts:69-80`)
Matches InvoiceRow exactly.

### Data flow
1. Upload → `upsertInvoice` (status=uploaded)
2. Workflow extracts → `saveExtractedJson` stores `JSON.stringify(extractedJson)` as blob
3. UI reads `extractedJson` and `JSON.parse`s it for display

---

## Proposed Changes

### 1. Rename InvoiceRow → Invoice

`InvoiceRow` in `OrganizationDomain.ts` becomes `Invoice`. This is the canonical domain type.

### 2. Expand Invoice with extraction fields

The Invoice table/schema absorbs the flat invoice-proper fields from `InvoiceExtractionSchema`. These get populated when extraction completes (null until then).

**New nullable fields on Invoice:**

| Field | SQLite type | Notes |
|---|---|---|
| invoiceConfidence | real | 0-1 float |
| invoiceNumber | text | |
| invoiceDate | text | as-appears-in-document |
| dueDate | text | as-appears-in-document |
| currency | text | |
| vendorName | text | |
| vendorEmail | text | |
| vendorAddress | text | |
| billToName | text | |
| billToEmail | text | |
| billToAddress | text | |
| subtotal | text | |
| tax | text | |
| total | text | |
| amountDue | text | |

All nullable — null before extraction, populated after.

text fields can default to ''. and they can remain '' after extraction if not populated by llm.
i'm not sure if invoiceConfidence should be able to take null in the database. 0 as default might be ok.

**Drop:** `extractedJson` column — no longer needed once fields are first-class.

keep it as a record.

### 3. New InvoiceItem table + domain type

| Field | SQLite type | Notes |
|---|---|---|
| id | text | PK (generated) |
| invoiceId | text | FK → Invoice.id |
| description | text | |
| quantity | text | as-appears |
| unitPrice | text | as-appears |
| amount | text | as-appears |
| period | text | |

Domain type `InvoiceItem` in `OrganizationDomain.ts`.

---

## Reconciling with InvoiceExtractionSchema

**Option A: Single source of truth — extraction schema derives from domain schemas**

Define the canonical field names/types in `OrganizationDomain.ts` (Invoice + InvoiceItem). `InvoiceExtractionSchema` in `InvoiceExtraction.ts` reuses those field schemas (or a picked subset). The Gemini JSON schema is generated from the same source.

- Pro: Zero duplication. Rename a field → one place.
- Con: Extraction schema is coupled to domain schema. If Gemini needs different field shapes (e.g. `line_items` vs `lineItems`) we need a transform layer anyway.

**Option B: Separate extraction schema, explicit mapping**

Keep `InvoiceExtractionSchema` as its own thing (it's an external API contract with Gemini). Add a mapping function `extractionToInvoice` that converts extraction output → domain types (Invoice fields + InvoiceItem[]). `saveExtractedJson` is replaced by `saveExtraction(invoiceId, idempotencyKey, Invoice fields, InvoiceItem[])`.

- Pro: Extraction schema can evolve independently of storage schema. Clean boundary.
- Con: Two schemas with overlapping fields. Mapping code to maintain.

**Option C: Shared field schemas, composed differently**

Define a shared set of field schemas (e.g. `InvoiceFields`, `InvoiceItemFields`) that both the extraction schema and the domain schema compose from. Extraction schema adds `invoiceConfidence` and structures them for Gemini. Domain schema adds `id`, `fileName`, etc.

- Pro: Field definitions are shared — no type drift. Each schema composes what it needs.
- Con: Slightly more abstract. Need to think through how Effect Schema composition works for this pattern.

---

## Open Questions

1. **Naming: `InvoiceItem` vs `LineItem`?** Extraction calls them `lineItems`. DB table could be either. `InvoiceItem` is more domain-explicit; `LineItem` matches extraction.

InvoiceItem. Note, we can change the schema/field names for extraction. they are not set in stone and this is why we are doing research.

2. **Keep `extractedJson` as backup?** Once fields are first-class, is there value in also storing the raw JSON blob? Could be useful for debugging/auditing extraction results. Could also just be dropped.

Keep

3. **Which reconciliation option (A/B/C)?** Leaning toward C — shared field definitions, composed into extraction + domain schemas separately. But open to your take.

Let's try A first. Hopefully effect v4 schema makes that clean and straight-forward.

4. **InvoiceItem.id generation?** UUID generated at save time? Or should extraction assign ordinals?

uuid should be fine. now that i'm thinking about it, i think we also need an order column which is a real or float. and the items would go in with 1.0, 2.0, 3.0 ...

The reason they would be reals is so we can take advantage of properties of reals to reorder quickly without having to touch a lot of rows. Make sense?

5. **Cascade delete?** When Invoice is deleted, InvoiceItems should cascade. SQLite foreign key + `on delete cascade` or handle in repo code?

cascade

6. **Status implications?** Currently `saveExtractedJson` flips status to `extracted` and writes the blob. New version would insert Invoice fields + InvoiceItem rows in a transaction. Same status flow, just more columns/rows to write.

---

## Files to Change

| File | Change |
|---|---|
| `src/lib/OrganizationDomain.ts` | Rename `InvoiceRow` → `Invoice`, add extracted fields, add `InvoiceItem` schema |
| `src/lib/InvoiceExtraction.ts` | Reconcile schema (depends on option chosen) |
| `src/organization-agent.ts` | Update DDL, add InvoiceItem table, update `saveExtractedJson` |
| `src/lib/OrganizationRepository.ts` | Update queries, new InvoiceItem queries, rename decoder |
| `src/invoice-extraction-workflow.ts` | Pass structured data instead of JSON blob |
| `src/routes/app.$organizationId.invoices.tsx` | Read fields directly instead of JSON.parse |
