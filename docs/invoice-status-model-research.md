# Invoice Status Model Research

## Status Model Redesign

### Current Statuses

| Status       | Set Where                                             | Meaning                       |
| ------------ | ----------------------------------------------------- | ----------------------------- |
| `uploaded`   | `repo.upsertInvoice` (OrganizationRepository.ts:61)   | File in R2, DB record created |
| `extracting` | `repo.setExtracting` (OrganizationRepository.ts:97)   | Extraction workflow running   |
| `extracted`  | `repo.saveExtraction` (OrganizationRepository.ts:125) | AI extraction complete        |
| `error`      | `repo.setError` (OrganizationRepository.ts:165)       | Extraction failed             |

### Problem: "uploaded" Is Misleading

The invoice record is only inserted into the database **after** R2 confirms the upload is complete (via R2 notification → worker → org-agent). So by the time the DB record exists, the file is already uploaded. The status immediately transitions: `uploaded` → `extracting` in the same `onInvoiceUpload` handler (organization-agent.ts). The `uploaded` status is effectively a transient intermediate state that users rarely see.

### Problem: "extracted" Doesn't Fit Manual Invoices

When a user creates an invoice manually (no file, no extraction), the invoice is immediately usable. Calling it "extracted" is wrong — nothing was extracted.

### Proposed Status Model

| Status       | Meaning                           | When Set                                                   |
| ------------ | --------------------------------- | ---------------------------------------------------------- |
| `extracting` | Extraction workflow running       | Upload flow: on invoice insert (R2 notification received)  |
| `ready`      | Invoice data is available for use | Upload flow: extraction completes. Manual flow: on create. |
| `error`      | Extraction or processing failed   | Upload flow: extraction fails                              |
| `deleted`    | Soft-deleted                      | Delete action (replaces current hard delete)               |

**Removed:**

- `uploaded` — not needed. Record is inserted with `extracting` since extraction kicks off immediately upon insert.
- `extracted` — renamed to `ready` (or alternative, see below).

**Added:**

- `deleted` — for soft-delete.

### Status Lifecycle: Upload Flow (Revised)

```
R2 notification received → worker → org-agent.onInvoiceUpload
  → repo.upsertInvoice()          status: "extracting"
  → runWorkflow(EXTRACTION)
  → extraction completes
    → repo.saveExtraction()        status: "ready"
  OR extraction fails
    → repo.setError()              status: "error"
```

No more `uploaded` → `extracting` two-step. The record starts at `extracting`.

### Status Lifecycle: Manual Create Flow

```
createInvoice server fn → org-agent.createInvoice
  → repo.upsertInvoice()          status: "ready"
```

Immediately `ready` — no extraction needed.

### Status Lifecycle: Soft Delete

```
deleteInvoice server fn
  → auth check
  → get org agent stub
  → stub.softDeleteInvoice(invoiceId)
    → repo.softDeleteInvoice(invoiceId)    status: "deleted"
    → broadcastActivity("Invoice deleted")
```

No R2 deletion. No queue message. No R2 notification. The file stays in R2; the invoice row stays in the DB with status `deleted` and is filtered from default queries.

---

## Question 3: Is "ready" the Right Name?

### Options Considered

| Name        | Pros                                          | Cons                                                                                             |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ready`     | Clear intent: invoice is ready for use/review | Slightly vague — ready for what?                                                                 |
| `active`    | Common SaaS status term, clear meaning        | Could imply ongoing activity vs. static data                                                     |
| `complete`  | Indicates all data is present                 | Manual invoices start "complete" with no data — contradictory?                                   |
| `available` | Neutral, indicates accessibility              | Uncommon in status enums                                                                         |
| `draft`     | Familiar term for editable documents          | Implies not finalized; but extracted invoices are also "ready" — calling them draft is confusing |

### Assessment

`ready` works well for both flows:

- Upload: extraction done, invoice data ready for review
- Manual: invoice created, ready for user to populate

The alternative `active` is also reasonable but has a different connotation (ongoing vs. available). `complete` is misleading for manual invoices that start empty.

<!-- REVIEW: Preference between "ready" and "active"? Or another option? -->

---

## Question 4: Other Statuses to Consider

### Statuses We Considered and Rejected (For Now)

| Status             | Why Considered                               | Why Not Now                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`            | Manual invoice creation research proposed it | Adds complexity. If manual invoices are immediately `ready`, a separate `draft` state just means "ready but empty" which the UI can determine from data presence. If we later want explicit draft→finalized workflow, we can add it then. |
| `uploading`        | Track in-progress uploads                    | Not needed — DB record is only created after R2 confirms upload complete. Upload progress is client-side only.                                                                                                                            |
| `uploaded`         | Current status                               | Redundant — extraction starts immediately on insert.                                                                                                                                                                                      |
| `sent`             | Invoice sent to recipient                    | Out of scope — no send/share functionality yet.                                                                                                                                                                                           |
| `paid` / `overdue` | Payment tracking                             | Out of scope — no payment tracking yet.                                                                                                                                                                                                   |
| `archived`         | Hide without deleting                        | `deleted` (soft delete) serves the same purpose for now.                                                                                                                                                                                  |
| `processing`       | Generic "something happening"                | `extracting` is more specific and descriptive.                                                                                                                                                                                            |

### Recommended Final Status Set

```typescript
export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
```

Four statuses. Minimal, each with clear meaning and a specific lifecycle trigger.

---

## Soft Delete Implementation

### Deletable Statuses

Only invoices in `ready` or `error` can be soft-deleted. Invoices in `extracting` cannot — the running workflow would set status to `ready` or `error` and overwrite the `deleted` status.

<!-- REVIEW: For `extracting` invoices, should the trash icon be hidden entirely, or shown but disabled? Hidden for now since it's simpler and the extraction is typically fast. -->

Should only be shown if status is ready or error.

### Current Delete Flow (Hard Delete)

```
invoices.tsx deleteInvoice server fn
  → auth check
  → r2.delete(data.r2ObjectKey)                    ← deletes file from R2
  → (local) queue.send({ action: "DeleteObject" }) ← triggers queue processing
  → (prod) R2 notification fires automatically
    → worker.ts processInvoiceDelete
      → parseInvoiceObjectKey(key)
      → stub.onInvoiceDelete({ invoiceId, r2ActionTime, r2ObjectKey })
        → repo.deleteInvoice(invoiceId, r2ActionTime)   ← SQL: delete from Invoice
        → broadcastActivity("Invoice deleted")
```

### Proposed Delete Flow (Soft Delete)

```
invoices.tsx deleteInvoice server fn
  → auth check
  → get org agent stub
  → stub.softDeleteInvoice(invoiceId)
    → repo.softDeleteInvoice(invoiceId)    ← SQL: update set status = 'deleted'
    → broadcastActivity("Invoice deleted")
```

Need logic to ensure deleting invoice that is in ready.

**What's removed from the flow:**

- No `r2.delete()` — file stays in R2
- No queue message (local env)
- No R2 notification processing (prod env)
- No `r2ActionTime` concurrency guard needed — soft delete is a simple status update

### Changes by File

| File                                          | Change                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/app.$organizationId.invoices.tsx` | `deleteInvoice` server fn: remove R2 delete, remove queue message, call `stub.softDeleteInvoice(invoiceId)` directly. `deleteInvoiceSchema`: remove `r2ObjectKey` field (only `invoiceId` needed). Trash icon: only render when `status === "ready" \|\| status === "error"`. |
| `src/organization-agent.ts`                   | Add `@callable() softDeleteInvoice(invoiceId)` method. `onInvoiceDelete`: keep for now (R2 delete notifications from outside the app could still arrive) or remove — see open question.                                                                                       |
| `src/lib/OrganizationRepository.ts`           | Add `softDeleteInvoice`: `update Invoice set status = 'deleted' where id = ? and status in ('ready', 'error')`. Replace or keep `deleteInvoice` — see open question.                                                                                                          |
| `src/lib/OrganizationRepository.ts`           | `getInvoices`: add `where status != 'deleted'` filter.                                                                                                                                                                                                                        |
| `src/worker.ts`                               | `processInvoiceDelete`: becomes dead code since the app no longer triggers R2 deletions. Keep for safety (external R2 deletes) or remove.                                                                                                                                     |

### Open Questions

<!-- REVIEW: Should we remove `onInvoiceDelete` and `processInvoiceDelete` (the hard-delete R2 notification path) now, or keep them as dead code for safety? They'd only fire if something outside the app deletes an R2 object. Leaning toward keeping them — they're harmless and provide a safety net. But the hard `delete from Invoice` SQL in `repo.deleteInvoice` would need to stay too if we keep it. -->

Remove dead code

<!-- REVIEW: R2 cleanup strategy — files stay in R2 indefinitely after soft delete. Future options: (1) scheduled cleanup job that deletes R2 objects for invoices in `deleted` status older than N days, (2) manual purge action, (3) never clean up (storage cost). Not blocking for this implementation. -->

## Defer. No need to mention.

## Summary of Proposed Changes

1. ~~**Move** `InvoiceStatus` + `InvoiceStatusValues` from Domain.ts → OrganizationDomain.ts~~ **DONE**
2. ~~**Replace** status values: `["uploaded", "extracting", "extracted", "error"]` → `["extracting", "ready", "error", "deleted"]`~~ **DONE**
3. ~~**Upload flow**: insert with `extracting` (remove `uploaded` intermediate step)~~ **DONE**
4. **Manual create flow**: insert with `ready` — see below
5. ~~**Soft delete**: status update to `deleted`, no R2 deletion, trash icon gated on `ready`/`error`~~ **DONE**

---

## Manual Create Flow

### Overview

A "New Invoice" button next to the Upload button. Creates a blank invoice record with status `ready` — no file, no extraction. User can populate fields later (editing is a future feature).

### DB Schema Constraint

The `Invoice` table has these `not null` columns without defaults that are upload-specific:

| Column           | Type                   | Issue for Manual Create                 |
| ---------------- | ---------------------- | --------------------------------------- |
| `fileName`       | `text not null`        | No file. Use `''` empty string.         |
| `contentType`    | `text not null`        | No file. Use `''` empty string.         |
| `r2ActionTime`   | `integer not null`     | No R2 event. Use `createdAt` timestamp. |
| `idempotencyKey` | `text not null unique` | No R2 idempotency. Generate a UUID.     |
| `r2ObjectKey`    | `text not null`        | No R2 object. Use `''` empty string.    |

<!-- REVIEW: Alternative: make these columns nullable or add defaults in the DDL. But that touches the upload flow too and risks breaking existing data. Using empty strings / generated values is simpler and non-breaking. Preference? -->

For string types default to empty string. r2ActionTime should be nullable. since idempotencyKey must be unique, let's make that nullable. understand this would require refactoring code.

### Status Lifecycle

```
createInvoice server fn
  → auth check
  → get org agent stub
  → stub.createInvoice()
    → repo.createInvoice()              status: "ready"
    → broadcastActivity("Invoice created")
```

### Changes by File

| File                                          | Change                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/app.$organizationId.invoices.tsx` | Add `createInvoice` server fn (no input needed beyond auth — server generates ID). Add "New Invoice" `<Button>` with `Plus` icon next to Upload button in both empty and non-empty states. Wire to `createMutation`. |
| `src/organization-agent.ts`                   | Add `@callable() createInvoice()` method: generates `invoiceId`, calls `repo.createInvoice()`, broadcasts activity, returns `{ invoiceId }`.                                                                         |
| `src/lib/OrganizationRepository.ts`           | Add `createInvoice` method: inserts a new row with `status = 'ready'`, empty strings for file/R2 fields, generated UUID for `idempotencyKey`, `Date.now()` for timestamps.                                           |

### `createInvoice` Server Fn

```typescript
const createInvoice = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        const validSession = yield* auth
          .getSession(request.headers)
          .pipe(Effect.flatMap(Effect.fromOption));
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        return yield* Effect.tryPromise(() => stub.createInvoice());
      }),
    ),
);
```

### `OrganizationAgent.createInvoice`

```typescript
@callable()
createInvoice() {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const repo = yield* OrganizationRepository;
      const invoiceId = crypto.randomUUID();
      yield* repo.createInvoice(invoiceId);
      yield* broadcastActivity(this, {
        level: "info",
        text: "Invoice created",
      });
      return { invoiceId };
    }),
  );
}
```

### `OrganizationRepository.createInvoice`

```typescript
const createInvoice = Effect.fn("OrganizationRepository.createInvoice")(
  function* (invoiceId: string) {
    const now = Date.now();
    yield* sql`
      insert into Invoice (
        id, name, fileName, contentType, createdAt, r2ActionTime,
        idempotencyKey, r2ObjectKey, status,
        extractedJson, error
      ) values (
        ${invoiceId}, ${"Untitled Invoice"}, ${""}, ${""},
        ${now}, ${now}, ${crypto.randomUUID()},
        ${""}, ${"ready"},
        ${null}, ${null}
      )
    `;
  },
);
```

I don't think we need to specify r2ActionTime, idempotencyKey, and r2ObjectKey - they can default.

<!-- REVIEW: Default name "Untitled Invoice" vs empty string? "Untitled Invoice" gives the table row a readable label. Empty string falls back to `invoice.name || invoice.fileName` which would show nothing for manual invoices. -->

Untitled vs Unnamed? trade-offs, recommendation. in the database, we use name, but should that be renamed to title? I don't know.

### UI: "New Invoice" Button

Placed next to the Upload button in both empty-state and non-empty-state card headers. Uses `Plus` icon from `lucide-react`.

```tsx
<Button
  type="button"
  size="sm"
  variant="outline"
  disabled={!isHydrated || createMutation.isPending}
  onClick={() => createMutation.mutate()}
>
  {createMutation.isPending ? (
    <Loader2 className="size-4 animate-spin" />
  ) : (
    <Plus className="size-4" />
  )}
  New Invoice
</Button>
```

The mutation:

```typescript
const createServerFnRef = useServerFn(createInvoice);
const createMutation = useMutation({
  mutationFn: () => createServerFnRef({ data: undefined }),
  onSuccess: (result) => {
    setSelectedInvoiceId(result.invoiceId);
    void router.invalidate();
  },
});
```

### Invoice Detail Pane: Manual Invoice Display

When a manual invoice is selected (status `ready`, no `extractedJson`, empty `fileName`), the detail pane currently shows the extraction fields which are all empty strings displaying as "—". This is acceptable for now — it shows the invoice structure with placeholder dashes.

<!-- REVIEW: Future: add inline editing so users can populate these fields. Out of scope for this task. -->

### `getInvoices` Filter

**Bug found during research:** `repo.getInvoices()` (OrganizationRepository.ts:31) currently fetches all invoices without filtering deleted ones:

```sql
select * from Invoice order by createdAt desc
```

Should be:

```sql
select * from Invoice where status != 'deleted' order by createdAt desc
```

This was listed in the soft-delete changes table but not yet implemented. Should be fixed as part of this work.

We want to display deleted invoices. Update research accordingly

### `viewUrl` for Manual Invoices

The `getInvoices` server fn generates `viewUrl` for each invoice using R2 signed URLs or local API path. Manual invoices have empty `r2ObjectKey` — the signed URL generation will fail or produce a broken URL.

Fix: skip `viewUrl` generation when `r2ObjectKey` is empty. The `FileText` icon link in the table already conditionally renders on `invoice.viewUrl`, so manual invoices will just not show the file link. This is correct — there's no file to view.

<!-- REVIEW: The viewUrl generation iterates all invoices with Promise.all and signs URLs. For manual invoices with empty r2ObjectKey, we should set viewUrl to undefined/null. Two approaches: (1) filter in the map — `if (!invoice.r2ObjectKey) return { ...invoice, viewUrl: undefined }`, (2) always set viewUrl and let the broken URL fail silently. Approach 1 is cleaner. -->

hmmm, we should probably be using effect v4 instead of Promise.all?
