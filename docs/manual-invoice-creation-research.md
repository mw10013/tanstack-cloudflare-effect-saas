# Manual Invoice Creation Research

## Current Invoice Lifecycle

```
Upload Flow:
  uploadInvoice server fn → r2.put(key)
    → R2 notification → worker.ts
    → org-agent.onInvoiceUpload
      → repo.upsertInvoice()          status: "uploaded"
      → runWorkflow(EXTRACTION)
      → repo.setExtracting()           status: "extracting"
    → extraction workflow runs
      → load file from R2
      → AI extraction
      → agent.saveExtraction()          status: "extracted"
    OR
      → agent.onWorkflowError()         status: "error"

Delete Flow:
  deleteInvoice server fn → r2.delete(r2ObjectKey)
    → (local only) queue.send DeleteObject
    → R2 notification → worker.ts
    → org-agent.onInvoiceDelete
      → repo.deleteInvoice()            DB record removed
```

## Current Statuses

| Status | Meaning | Set By | Where |
|---|---|---|---|
| `uploaded` | File in R2, awaiting extraction | `upsertInvoice` | OrganizationRepository.ts:61 |
| `extracting` | Workflow running | `setExtracting` | OrganizationRepository.ts:97 |
| `extracted` | AI extraction complete, data populated | `saveExtraction` | OrganizationRepository.ts:125 |
| `error` | Extraction failed | `setError` | OrganizationRepository.ts:165 |

**UI behavior by status** (app.$organizationId.invoices.tsx):
- `extracted` → green badge, shows invoice detail + line items, enables items query (line 325)
- `error` → red badge, shows error alert (line 515-523)
- anything else → grey badge, shows "Extraction in progress" (line 525-526)

## Problem: Manual Invoices Don't Fit Current Model

A manually created invoice has:
- No R2 file upload
- No extraction workflow
- User-entered data (or blank to start)

Current assumptions that break:
1. `r2ObjectKey` is non-nullable (`Schema.String`, OrganizationDomain.ts:39)
2. Delete server fn always calls `r2.delete(data.r2ObjectKey)` (invoices.tsx:207)
3. Signed URL generation uses `r2ObjectKey` (invoices.tsx:128)
4. Extraction workflow loads file via `r2ObjectKey` (invoice-extraction-workflow.ts:84)
5. Status `"uploaded"` implies file exists; `"extracted"` implies AI ran

## Proposed Status Model

<!-- REVIEW: Do these statuses make sense? Should "draft" be the only new one, or do we need more? -->

| Status | Meaning |
|---|---|
| `draft` | **NEW.** Manually created, user is editing. No file, no extraction. |
| `uploaded` | File in R2, awaiting extraction |
| `extracting` | Extraction workflow running |
| `extracted` | AI extraction complete |
| `error` | Extraction or other failure |

**`draft` behavior in UI:**
- Badge: grey/secondary (same bucket as `uploaded`/`extracting`)
- Detail view: show editable invoice form (future) or empty state like "No data yet — edit this invoice or upload a file"
- No items query needed
- No signed URL / file preview

<!-- REVIEW: Should draft invoices be editable inline immediately? Or is that a separate feature? -->

## Proposed: `r2ObjectKey` Nullable

**Schema change** in OrganizationDomain.ts:
- `r2ObjectKey: Schema.String` → `r2ObjectKey: Schema.NullOr(Schema.String)`

**SQL change** in organization-agent.ts table creation:
- `r2ObjectKey text not null` → `r2ObjectKey text`

**Impact — places that need null guards:**

| File | Line | Usage | Fix |
|---|---|---|---|
| invoices.tsx:128 | Signed URL generation | Skip if null (no file to preview) |
| invoices.tsx:207 | `r2.delete(data.r2ObjectKey)` | Skip R2 delete if null |
| invoices.tsx:215 | Queue DeleteObject message | Skip if null |
| invoices.tsx:484 | Delete mutation passes r2ObjectKey | Allow null in deleteInvoiceSchema |
| invoice-extraction-workflow.ts:84 | `r2.get(r2ObjectKey)` | Never runs for drafts (no workflow triggered) |
| worker.ts:187,213 | R2 notification handler | Never fires for drafts (no R2 event) |

<!-- REVIEW: Is making r2ObjectKey nullable the right call, or would empty string "" be simpler? Nullable is more honest but touches more code. -->

## Proposed: `fileName` Default

- Manual invoices: `fileName` defaults to `""` (empty string)
- UI already handles this: `invoice.name || invoice.fileName` (invoices.tsx:466) — if both empty, shows nothing. May want to show "Untitled" or similar.

<!-- REVIEW: What should display in the file column for manual invoices? "Untitled"? Empty? -->

## Organization Agent: New `createInvoice` Method

```
createInvoice() → { invoiceId: string }
```

Proposed implementation:
- Generate `invoiceId = crypto.randomUUID()`
- Generate `idempotencyKey = crypto.randomUUID()`
- Call `repo.upsertInvoice` (or a new repo method) with:
  - `name: ""`
  - `fileName: ""`
  - `r2ObjectKey: null`
  - `status: "draft"`
  - `contentType: ""`
  - `r2ActionTime: Date.now()`
- Broadcast "Invoice created" activity
- Return `{ invoiceId }`
- No workflow triggered

<!-- REVIEW: Should createInvoice accept any initial data (name, vendor, etc.) or always start blank? If blank, the user would need an edit flow to populate fields. -->

## Delete Flow Refactor

Current delete assumes R2 file exists. Proposed changes:

**deleteInvoice server fn** (invoices.tsx:190-223):
- Accept `r2ObjectKey` as nullable in schema
- If `r2ObjectKey` is null: skip `r2.delete()` and queue message, just call agent delete directly
- If `r2ObjectKey` is non-null: existing flow (R2 delete → notification → agent)

<!-- REVIEW: For draft invoices without R2 objects, we need a direct delete path to the org agent since there's no R2 event to trigger it. The current flow is: server fn → r2.delete → R2 notification → worker → agent.onInvoiceDelete. For drafts it would be: server fn → agent.deleteInvoice directly. Is that okay? Or should we unify both paths? -->

## Server Fn for Create

New server fn in invoices.tsx:

```
createInvoice server fn (POST)
  → auth check (same pattern as upload/delete)
  → get org agent stub
  → stub.createInvoice()
  → return { invoiceId }
```

Mutation in component:
- On success: invalidate router, select the new invoice

## UI: Create Button

Place next to Upload button in both empty and non-empty states.

```
[Create] [file input] [Upload]
```

Single click → creates blank draft → appears in table → auto-selected.

<!-- REVIEW: Is this the right placement/UX? Should Create be more prominent than Upload, or equal? -->

## Open Questions

1. **Edit flow for drafts** — creating a blank draft is only useful if users can edit it. Is inline editing in scope for this work, or is create-only fine for now with edit coming later?

2. **Can a draft invoice later have a file attached?** If so, uploading a file to a draft would transition it from `draft` → `uploaded` → `extracting` → `extracted`. This affects the upload flow.

3. **Should `getStatusVariant` show `draft` differently?** Currently anything not `extracted`/`error` gets `secondary`. Draft could stay secondary or get its own style.

4. **Activity messages** — "Invoice created" broadcast pattern already exists for uploads. Same pattern for manual create?

5. **Idempotency** — uploads use `idempotencyKey` to prevent duplicates from R2 re-notifications. Manual creates don't have this concern but the DB schema requires it. Using a random UUID per create is fine.
