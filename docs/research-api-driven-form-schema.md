# Research: API-Driven Form Schema (Eliminating InvoiceFormSchema)

## Problem

`InvoiceFormSchema` is defined for the UI and then reused inside `UpdateInvoiceInput` (API). This lets the UI dictate the API contract. We want the API schema (`UpdateInvoiceInput`) to be the single source of truth, and the form to derive what it needs from it.

The key tension: `UpdateInvoiceInput` contains `invoiceId` — a route param, not a user-editable field. The form needs a schema that excludes it for validation but must still send it with the mutation.

## Current Structure

```
OrganizationAgentSchemas.ts
├── InvoiceItemFormSchema  ← picks from InvoiceItem domain
├── InvoiceFormSchema      ← picks from Invoice domain + invoiceItems array
└── UpdateInvoiceInput     ← { invoiceId, ...InvoiceFormSchema.fields }

Route component
├── form validates with InvoiceFormSchema (via toStandardSchemaV1)
├── defaultValues: Struct.pick(invoice, [...fields]) satisfies InvoiceFormSchema.Type
└── mutation adds invoiceId: stub.updateInvoice({ invoiceId, ...formData })
```

## Proposed: Inline InvoiceFormSchema into UpdateInvoiceInput

```ts
// OrganizationAgentSchemas.ts — API is the source of truth
export const UpdateInvoiceInput = Schema.Struct({
  invoiceId: Invoice.fields.id,
  ...trimFields(Struct.pick(Invoice.fields, [
    "name", "invoiceNumber", "invoiceDate", "dueDate", "currency",
    "vendorName", "vendorEmail", "vendorAddress",
    "billToName", "billToEmail", "billToAddress",
    "subtotal", "tax", "total", "amountDue",
  ])),
  invoiceItems: Schema.mutable(Schema.Array(InvoiceItemFormSchema)),
});
```

Then the form needs a schema derived from `UpdateInvoiceInput` that omits `invoiceId`.

---

## Approaches

### A. Derive form schema via `mapFields(Struct.omit(...))`

Effect v4 supports deriving structs from existing ones:

```ts
// SCHEMA.md:1007-1024
const schema = Schema.Struct({ a: Schema.String, b: Schema.Number })
  .mapFields(Struct.omit(["b"]))
```

Applied here:

```ts
// Route file — derive form-only schema from API schema
const InvoiceFormSchema = UpdateInvoiceInput.mapFields(Struct.omit(["invoiceId"]));
const invoiceFormStandardSchema = Schema.toStandardSchemaV1(InvoiceFormSchema);
```

**defaultValues**: Same as today — `Struct.pick(invoice, [...fields])` satisfying `typeof InvoiceFormSchema.Type`.

**Mutation**: Same as today — `stub.updateInvoice({ invoiceId, ...formData })`.

**Pros**:
- API schema is single source of truth.
- Form schema is mechanically derived — stays in sync automatically.
- Zero UI code changes except the derivation line and removing the import.
- `mapFields` + `Struct.omit` is idiomatic Effect v4.

**Cons**:
- Form schema derivation lives in the route file (or a shared lib). Minor, since it's a one-liner.

### B. Hidden input for `invoiceId`

Include `invoiceId` in the form's `defaultValues` and validate the whole form against `UpdateInvoiceInput`. Render `invoiceId` as a hidden field or simply don't render it.

```tsx
const form = useForm({
  defaultValues: { invoiceId, ...invoiceFields },
  validators: { onSubmit: Schema.toStandardSchemaV1(UpdateInvoiceInput) },
  onSubmit: ({ value }) => { void saveMutation.mutateAsync(value); },
});
// No need to merge invoiceId in mutation — it's already in the form value.
```

TanStack Form doesn't require every field in `defaultValues` to have a rendered `<form.Field>`. Unrendered fields stay in state and get submitted.

**Pros**:
- Form validates with the exact API schema — no derived schema needed.
- `onSubmit` value already has `invoiceId`; mutation is just `stub.updateInvoice(value)`.

**Cons**:
- `invoiceId` is now mutable form state. If anything accidentally changes it, you'd send a wrong id. (Low risk since there's no rendered field, but conceptually impure.)
- Couples the form's shape to the API shape including non-editable fields. If more non-editable fields are added to the API later (e.g., `organizationId`), they all leak into form state.
- Contradicts the principle that form state = user-editable state.

### C. Derive via `mapFields(Struct.pick(...))`

Instead of omitting `invoiceId`, explicitly pick the fields you want in the form:

```ts
const InvoiceFormSchema = UpdateInvoiceInput.mapFields(
  Struct.pick(["name", "invoiceNumber", /* ...all 14+ fields + invoiceItems */])
);
```

**Pros**:
- Explicit about what's in the form.

**Cons**:
- Verbose — must list every field. Defeats the purpose of deriving from the API schema.
- Fragile — adding a new editable field to the API requires updating the pick list too.

### D. Compose at the API level (current approach, inverted naming)

Keep a shared editable-fields schema but name it API-first:

```ts
export const InvoiceEditableFields = Schema.Struct({ ...trimFields(...), invoiceItems: ... });
export const UpdateInvoiceInput = Schema.Struct({ invoiceId: ..., ...InvoiceEditableFields.fields });
```

**Pros**:
- Named to emphasize it's a domain concept ("editable fields"), not a UI concept.

**Cons**:
- Cosmetic change — same structure, different name. Doesn't address the core concern.

---

## Assessment

| Criterion | A (omit) | B (hidden input) | C (pick) | D (rename) |
|---|---|---|---|---|
| API is source of truth | ✅ | ✅ | ✅ | ⚠️ shared schema | 
| Form state = editable only | ✅ | ❌ invoiceId in state | ✅ | ✅ |
| Stays in sync automatically | ✅ | ✅ | ❌ manual pick list | ✅ |
| Minimal code change | ✅ | ✅ | ❌ | ✅ |
| Idiomatic Effect v4 | ✅ | n/a | ✅ | ✅ |

## Recommendation

**Approach A** — derive form schema by omitting `invoiceId` from `UpdateInvoiceInput`.

- `UpdateInvoiceInput` becomes the canonical definition.
- `InvoiceFormSchema` is deleted from `OrganizationAgentSchemas.ts`.
- The route file derives a local form schema: `UpdateInvoiceInput.mapFields(Struct.omit(["invoiceId"]))`.
- `InvoiceItemFormSchema` is also inlined into `UpdateInvoiceInput` — no orphan schemas.
- No changes to `defaultValues` construction or mutation call.

### Note on `trimFields`

`trimFields` currently wraps every field in `InvoiceFormSchema` and `InvoiceItemFormSchema`. When inlining into `UpdateInvoiceInput`, the trim transformation applies at the API level — which is arguably better (API trims inputs, not just the form). The derived form schema inherits those trims for validation.

### `unsafePreserveChecks`

If `UpdateInvoiceInput` later adds struct-level `.check()` refinements, the `mapFields` derivation will drop them by default. Pass `{ unsafePreserveChecks: true }` only if the checks remain valid without `invoiceId`. Not needed currently since there are no struct-level checks.
