# Research: Replace getInvoices + getInvoiceItems with getInvoiceWithItems

## Current Pattern

The invoices route (`src/routes/app.$organizationId.invoices.tsx`) uses two separate server functions that each call separate agent methods:

1. **`getInvoices`** (server fn L60) → `stub.getInvoices()` → `repo.getInvoices()` — returns `Invoice[]`
2. **`getInvoiceItems`** (server fn L120) → `stub.getInvoiceItems(invoiceId)` → `repo.getInvoiceItems(invoiceId)` — returns `InvoiceItem[]`

The component combines them client-side: selects an invoice from the list, then fetches its items via a second react-query (`invoiceItemsQuery` at L222).

### Problems

- **N+1 from client perspective**: Each invoice detail view triggers a separate HTTP round-trip (server fn → agent stub → SQLite) just to get line items.
- **Pieces assembled client-side**: The component has to coordinate `invoicesQuery` and `invoiceItemsQuery` with `selectedInvoiceId` state and `useEffect` sync (L178-190). This is fragile if we ever need the combined data in more than one place.
- **No domain object for InvoiceWithItems**: The combined shape is implicit — the component manually merges `selectedInvoice` fields with `invoiceItemsQuery.data`.

## Proposed: `getInvoiceWithItems`

### Repository Layer

Add a single query that uses SQLite's `json_group_array` to return an invoice with its items nested as a JSON array:

```sql
select i.*,
  (select json_group_array(json_object(
    'id', ii.id,
    'invoiceId', ii.invoiceId,
    'order', ii."order",
    'description', ii.description,
    'quantity', ii.quantity,
    'unitPrice', ii.unitPrice,
    'amount', ii.amount,
    'period', ii.period
  )) from InvoiceItem ii where ii.invoiceId = i.id) as itemsJson
from Invoice i
where i.id = ${invoiceId}
```

This returns a single row. Parse `itemsJson` with `JSON.parse` and decode with the existing `InvoiceItem` schema array. One DB call instead of two.

### Domain Layer

Add `InvoiceWithItems` schema in `OrganizationDomain.ts`:

```ts
export const InvoiceWithItems = Schema.Struct({
  ...Invoice.fields,
  items: Schema.mutable(Schema.Array(InvoiceItem)),
});
export type InvoiceWithItems = typeof InvoiceWithItems.Type;
```

### Agent Layer

Replace `getInvoiceItems` callable with `getInvoiceWithItems(invoiceId)`:

```ts
@callable()
getInvoiceWithItems(invoiceId: string) {
  return this.runEffect(
    Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      return yield* repo.getInvoiceWithItems(invoiceId);
    }),
  );
}
```

The existing `getInvoices` callable stays for the list view (items not needed there). `getInvoiceItems` callable is removed.

### Server Function Layer

Replace `getInvoiceItems` server fn with `getInvoiceWithItems`. The route component no longer needs to coordinate two queries — one query gives the full invoice detail.

### Route Component

Simplify from:

```ts
const selectedInvoice = invoices.find(...) ?? invoices[0] ?? null;
const invoiceItemsQuery = useQuery({ ... getInvoiceItemsFn ... });
```

To:

```ts
const invoiceDetailQuery = useQuery({
  queryKey: invoiceDetailQueryKey(organizationId, selectedInvoiceId),
  queryFn: () => getInvoiceWithItemsFn({ data: { organizationId, invoiceId: selectedInvoiceId } }),
  enabled: selectedInvoiceId !== null,
});
```

The detail card reads from `invoiceDetailQuery.data` for both invoice fields and `items`.

## Files to Change

| File | Change |
|------|--------|
| `src/lib/OrganizationDomain.ts` | Add `InvoiceWithItems` schema |
| `src/lib/OrganizationRepository.ts` | Add `getInvoiceWithItems` using JSON subquery |
| `src/organization-agent.ts` | Replace `getInvoiceItems` callable with `getInvoiceWithItems` |
| `src/routes/app.$organizationId.invoices.tsx` | Replace `getInvoiceItems` server fn + query with `getInvoiceWithItems` |

## Loader

The current loader only preloads the invoices list. With `getInvoiceWithItems`, the loader can also preload the first invoice's detail (when the list is non-empty), so the detail card renders immediately on navigation without a loading flash.

```ts
loader: async ({ params: { organizationId }, context }) => {
  const invoices = await context.queryClient.ensureQueryData({
    queryKey: invoicesQueryKey(organizationId),
    queryFn: () => getInvoices({ data: { organizationId } }),
  });
  const firstId = invoices[0]?.id;
  if (firstId) {
    await context.queryClient.ensureQueryData({
      queryKey: invoiceDetailQueryKey(organizationId, firstId),
      queryFn: () => getInvoiceWithItemsFn({ data: { organizationId, invoiceId: firstId } }),
    });
  }
},
```
