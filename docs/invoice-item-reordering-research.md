# Invoice Item Reordering Research

## Context

The backend already persists line item order by array position. No new backend API needed — reorder the array in the form, save, done.

From `src/lib/OrganizationRepository.ts:82`:

```sql
select *
from InvoiceItem
where invoiceId = i.id
order by "order" asc
```

From `src/lib/OrganizationRepository.ts:276`:

```ts
for (let i = 0; i < input.invoiceItems.length; i++) {
  const item = input.invoiceItems[i];
  const order = i + 1;
  yield* sql`
    insert into InvoiceItem (id, invoiceId, "order", description, quantity, unitPrice, amount, period)
    values (${id}, ${input.invoiceId}, ${order}, ${item.description}, ${item.quantity}, ${item.unitPrice}, ${item.amount}, ${item.period})
  `;
}
```

## Stable Row Key

The form currently uses `key={index}` (`src/routes/app.$organizationId.invoices.$invoiceId.tsx:454`). Reordering requires a stable key so React can track each row through position changes.

### Can we use the server `InvoiceItem.id`?

No. `InvoiceItem` has an `id` column and it's fetched in the query (`OrganizationRepository.ts:72`), but save does delete-all + reinsert with fresh `crypto.randomUUID()` (`OrganizationRepository.ts:278`). Item ids are **not stable across saves**. Using them as keys would give correct behavior between saves but mislead about their stability.

### Recommended: client-side `clientId`

- Add `clientId: string` to form item shape
- Existing items: `clientId = crypto.randomUUID()` (not server id, since it changes on save anyway)
- New items: `clientId = crypto.randomUUID()`
- Render `key={item.clientId}`
- Before save, strip `clientId` — send only `{ description, quantity, unitPrice, amount, period }`

This is the simplest approach: every row gets a UUID on form init and on add. No server changes.

## Implementation: Up / Down Buttons

No new dependency. Simple immutable state update. Naturally keyboard accessible. Works with the current card-per-item UI.

Steps:

1. Add `clientId` to each form item (see above)
2. Use `clientId` for React `key`
3. Add `Move up` / `Move down` buttons beside delete
4. Reorder with array splice
5. Strip `clientId` before save

### UX Details

- Place reorder controls in the item header beside delete
- Disable `Move up` on first item
- Disable `Move down` on last item
- Keep row numbering derived from current array index
- Displayed order = saved order
