# Invoice Schema Refactor Plan

Current schema (organization-agent.ts):

```sql
create table if not exists Invoice (
  id text primary key,
  fileName text not null,
  contentType text not null,
  createdAt integer not null,
  eventTime integer not null,
  idempotencyKey text not null unique,
  r2ObjectKey text not null,
  status text not null default 'uploaded',
  processedAt integer,
  invoiceJson text,
  invoiceJsonError text
)
```

---

## `status` → keep column name, new values + type safety

### Current values

| Value | Where set | Meaning |
|---|---|---|
| `uploaded` | `onInvoiceUpload` — insert/upsert (L109, L118) | File landed in R2 |
| `extracting` | `onInvoiceUpload` — after `runWorkflow` (L146) | Workflow started |
| `extracting_json` | Only checked in guard (L95), **never written** | Dead code |
| `ready` | `applyInvoiceJson` (L190) | Extraction succeeded |
| `extract_error` | `onWorkflowError` (L221) | Workflow failed |

### Changes

1. **Remove `extracting_json`** from guard at L95. Dead code from prior iteration.
2. **Remove `default 'uploaded'`** from DDL. Upsert must be explicit about status.
3. **Rename `extract_error` → `error`**. Status column already scopes to invoice context.
4. **Remove `ready`**. After extraction succeeds, status should be `extracted`. No `ready` state until we build a human-review step.
5. **Final values**: `uploaded`, `extracting`, `extracted`, `error`.
6. **Add type safety** following existing Domain.ts pattern:

```ts
// Domain.ts pattern:
export const InvitationStatusValues = ["pending", "accepted", "rejected", "canceled"] as const;
export const InvitationStatus = Schema.Literals(InvitationStatusValues);
export type InvitationStatus = typeof InvitationStatus.Type;

// New:
export const InvoiceStatusValues = ["uploaded", "extracting", "extracted", "error"] as const;
export const InvoiceStatus = Schema.Literals(InvoiceStatusValues);
export type InvoiceStatus = typeof InvoiceStatus.Type;
```

Then use `InvoiceStatus` in `InvoiceRowSchema` instead of `Schema.String`.

### UI impact

- `getStatusVariant`: update `ready` → `extracted`, `extract_error` → `error`
- Badge renders status raw — new values display cleaner

---

## `processedAt` → remove

Set on extraction success/error but **never read in UI**. Remove from schema, row type, all SQL statements. Easy to re-add if needed.

---

## `eventTime` → rename to `r2ActionTime`

### What it actually is

From [R2 event notifications docs](refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx):

> `eventTime` — String — The time when the **action** that triggered the event occurred.

It's present on **both** `object-create` (`PutObject`) and `object-delete` (`DeleteObject`) notifications. It's the timestamp of the R2 action itself (put/delete), not the notification delivery time, not the queue processing time.

### Usage in our code

- `onInvoiceUpload`: out-of-order guard — `if (existing && eventTime < existing.eventTime)` (L85)
- `onInvoiceDelete`: delete guard — `where eventTime <= ${eventTime}` (L170)
- On first insert: `createdAt = eventTime` (L108). On upsert, only `eventTime` updates.

### Recommended name: `r2ActionTime`

- `r2EventTime` — still generic ("event" could mean anything)
- `r2ActionTime` — directly maps to the docs description: "the time when the **action** that triggered the event occurred"
- Makes clear it's the R2 put/delete action timestamp, used for ordering

---

## `invoiceJsonError` → rename to `error`

- Column stores errors from any workflow step (file load, extraction, save), not just JSON extraction.
- `status = 'error'` already conveys context.
- **Remove `extractInvoiceJsonErrorPrefix`** and prefix-stripping logic. Store raw error string from `onWorkflowError`.
- Remove export from organization-agent.ts, remove import from invoice-extraction-workflow.ts.

---

## `invoiceJson` → rename to `extractedJson`

Clearer purpose. Aligns with `extracted` status.

---

## Final schema

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
  extractedJson text,
  error text
)
```

### Changes summary

| Before | After | Action |
|---|---|---|
| `eventTime` | `r2ActionTime` | Rename |
| `status default 'uploaded'` | `status` (no default) | Remove default |
| `processedAt` | — | Remove |
| `invoiceJson` | `extractedJson` | Rename |
| `invoiceJsonError` | `error` | Rename |
| `extracting_json` in guard | — | Remove dead code |
| `ready` status value | `extracted` | Rename |
| `extract_error` status value | `error` | Rename |
| `extractInvoiceJsonErrorPrefix` | — | Remove (both export and import) |
| `Schema.String` for status | `InvoiceStatus` (Schema.Literals) | Type safety |

### Files to modify

1. **`src/lib/Domain.ts`** — Add `InvoiceStatusValues`, `InvoiceStatus` type
2. **`src/organization-agent.ts`** — DDL, row schema, all SQL, remove prefix export, remove `extracting_json` guard
3. **`src/invoice-extraction-workflow.ts`** — Remove prefix import/usage, update `applyInvoiceJson` → `applyExtractedJson` (or keep method name?)
4. **`src/routes/app.$organizationId.invoices.tsx`** — Update status checks, field references
5. **`src/worker.ts`** — Update `eventTime` references in queue handler

### Status vs State naming

**Recommendation: keep `status`.**

- `status` is the conventional column name in databases and APIs (HTTP status, Stripe subscription status, our own `InvitationStatus`, `SubscriptionStatus` in Domain.ts).
- `state` implies a state machine with defined transitions — more formal, more common in backend/systems contexts.
- For UI display labels, `status` reads more naturally ("Status: extracted" vs "State: extracted").
- Consistency: we already use `status` for invitations and subscriptions in this codebase.
