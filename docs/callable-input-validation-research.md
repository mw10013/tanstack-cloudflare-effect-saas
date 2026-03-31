# Callable Input Validation Research

## Problem

`@callable()` methods on the organization agent receive JSON-deserialized arguments over WebSocket RPC. There is **no built-in runtime validation** — Cloudflare Agents just deserialize JSON and pass it through. Any external caller can send malformed data that TypeScript types won't catch at runtime.

Currently the agent has ad-hoc manual checks (e.g., `input.base64.length > MAX_BASE64_SIZE`, MIME type allowlist) but no systematic schema-based validation.

## Current State

### Callable methods in `organization-agent.ts`

| Method | Parameters | Has validation? |
|--------|-----------|----------------|
| `createInvoice()` | none | n/a |
| `updateInvoice(input)` | `{ invoiceId: string } & InvoiceFormSchema.Type` | none |
| `uploadInvoice(input)` | `{ fileName, contentType, base64 }` | manual size + MIME checks |
| `getInvoices()` | none | n/a |
| `getInvoice(invoiceId)` | `string` | none |

### Existing schemas in `OrganizationDomain.ts`

- `Invoice` — full domain schema with all fields, maxLength constraints
- `InvoiceItem` — full domain schema
- `InvoiceFormSchema` — derived via `Struct.pick` + `trimFields`, used for form editing (excludes id, status, metadata fields)
- `InvoiceItemFormSchema` — same pattern for items
- `InvoiceFormSchema` already converted to Standard Schema in the route: `Schema.toStandardSchemaV1(InvoiceFormSchema)` for TanStack Form validation

## TanStack Patterns

### TanStack Start: `inputValidator` on server functions

```ts
const myFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ name: z.string() }))
  .handler(({ data }) => { /* data is validated */ })
```

- Validator runs **server-side only** before the handler
- Supports Zod, Valibot, ArkType, plain functions, and **Standard Schema** (`~standard.validate()`)
- `execValidator` checks for `~standard`, then `.parse()`, then function — in that order
- Validation errors throw and propagate to client
- Validated data replaces raw input (`ctx.data = await execValidator(...)`)
- Parameter is called **`data`** in the handler

### TanStack Form: `value` in callbacks

```ts
onSubmit: async ({ value }) => { /* value is the validated form data */ }
validators: { onChange: ({ value }) => ... }
```

- Form state uses `values` (plural); `onSubmit` receives `value` (singular)
- Supports Standard Schema directly as validators

## Effect v4 Schema Capabilities

### Runtime validation

```ts
Schema.decodeUnknownSync(schema)(input)     // throws
Schema.decodeUnknownEffect(schema)(input)   // returns Effect
Schema.decodeUnknownExit(schema)(input)     // returns Exit
```

### Deriving input schemas from domain schemas

```ts
// pick fields
Invoice.mapFields(Struct.pick(["name", "vendorName"]))

// omit fields
Invoice.mapFields(Struct.omit(["id", "createdAt"]))

// make fields optional
Invoice.mapFields(Struct.map(Schema.optionalKey))

// pick + transform subset
Invoice.mapFields(Struct.mapPick(["name"], Schema.optional))
```

### Standard Schema interop

```ts
const standardSchema = Schema.toStandardSchemaV1(MySchema)
// result has ~standard.validate() — compatible with TanStack Form/Router
```

Already used in the invoice detail route for form validation.

## Decisions

### 1. Single `input` object for all callable methods

Standardize on `(input: { ... })` as the single argument for all callable methods that take parameters. `getInvoice(invoiceId: string)` becomes `getInvoice(input: { invoiceId: string })`.

Reasons:
- Consistent validation surface — always decode one object
- Extensible — can add fields without breaking signature

**Naming: `input`** (not `data` or `value`). TanStack Start uses `data` in server function handlers; TanStack Form uses `value` in onSubmit. Since callable methods are neither — they're Cloudflare Agent RPC endpoints — `input` is self-describing for a boundary parameter and already the convention in the existing agent methods.

### 2. Dedicated `OrganizationAgentSchemas.ts` module

New module at `src/lib/OrganizationAgentSchemas.ts` for callable input schemas.

- **Agent imports** for runtime validation at the `@callable()` boundary
- **UI imports** for form validation via `Schema.toStandardSchemaV1()`
- **Derives fields from domain** (`Invoice.fields`, `InvoiceItem.fields`) but is not the domain itself
- Keeps `OrganizationDomain.ts` focused on data shape definitions

Named `OrganizationAgentSchemas` because these are the agent's callable input contracts, consumed by both the agent and the UI. The extraction schema (`InvoiceExtractionSchema` in `InvoiceExtraction.ts`) is not a callable input — it stays where it is.

### 3. Explicit per-method validation

Each callable method calls `Schema.decodeUnknown` directly — no helper, no decorator wrapper. Simple and visible.

```ts
@callable()
updateInvoice(input: unknown) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const data = yield* Schema.decodeUnknown(UpdateInvoiceInput)(input)
      // ...
    }),
  )
}
```

### 4. Move form schemas, create agent input schemas

- **Move** `InvoiceFormSchema` and `InvoiceItemFormSchema` from `OrganizationDomain.ts` to `OrganizationAgentSchemas.ts`
- **Create** `UpdateInvoiceInput` = `Schema.Struct({ invoiceId: Schema.String, ...InvoiceFormSchema.fields })` — adds the `invoiceId` the agent method needs
- **Create** `UploadInvoiceInput` schema for file uploads (fileName, contentType, base64)
- **Create** `GetInvoiceInput` = `Schema.Struct({ invoiceId: Schema.String })` for reads

### 5. Constraints live in domain; input schemas compose

Domain schemas own the real data rules — non-empty strings, maxLength, valid formats. Input schemas **compose and re-export** domain field schemas into the shapes needed at the callable boundary. The input schema's job is structural (which fields are required for this operation), not adding new constraints that the domain should enforce.

### 6. UI form validation reuse

Current flow:
```
InvoiceFormSchema → Schema.toStandardSchemaV1() → TanStack Form validator
```

After refactor:
```
OrganizationAgentSchemas.InvoiceFormSchema → Schema.toStandardSchemaV1() → TanStack Form
OrganizationAgentSchemas.UpdateInvoiceInput → agent validates at @callable() boundary
```

Same schema source, two consumers. UI imports the form-facing schema; agent imports the method-facing schema (which extends the form schema with fields like `invoiceId`).

## Proposed File Structure

```
src/lib/
  OrganizationDomain.ts          — domain types (Invoice, InvoiceItem, etc.) with data constraints
  OrganizationAgentSchemas.ts    — callable input schemas, derived from domain
  OrganizationRepository.ts      — data access
src/
  organization-agent.ts           — imports agent schemas, validates at boundary
src/routes/
  ...                             — imports agent schemas for form validation via toStandardSchemaV1()
```

## Summary

| Decision | Choice |
|----------|--------|
| Input argument pattern | Single `input` object for all callable methods |
| Parameter name | `input` (not `data` or `value`) |
| Schema location | `OrganizationAgentSchemas.ts` — agent's callable input contracts |
| Validation approach | Explicit per-method `Schema.decodeUnknown` in Effect.gen |
| Domain relationship | Domain owns constraints; input schemas compose domain fields into operation-specific shapes |
| UI reuse | Same schemas → `toStandardSchemaV1()` for TanStack Form |
