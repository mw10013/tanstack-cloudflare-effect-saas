# Invoice Item Reordering Research

## Context

The invoice editor already persists line item order by array position.

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

That means reorder is already a frontend concern. No new backend reorder API needed. Change the array order in the form, save, done.

## Important Current Constraint

The current editor renders rows with an index key.

From `src/routes/app.$organizationId.invoices.$invoiceId.tsx:454`:

```tsx
{form.invoiceItems.map((item, index) => (
  <div key={index} className="rounded-lg border p-4">
```

React docs explicitly warn against index keys when items can be inserted, deleted, or reordered:

> "The order in which you render items will change over time if an item is inserted, deleted, or if the array gets reordered. Index as a key often leads to subtle and confusing bugs."

Source: React docs, "Why does React need keys?"

So before adding reorder UX, the form rows should get stable client-side identity.

## Best Options

### 1. Up / Down buttons

Best v1.

Why it fits this codebase:

- no new dependency
- simple immutable state update
- naturally keyboard accessible
- works well with inputs and textareas
- matches current card-per-item UI

Implementation shape:

- add stable `clientId` to each form item
- use `clientId` for React `key`
- add `Move up` and `Move down` buttons beside delete
- reorder with array splice
- save after stripping `clientId`

This is the lowest-risk option and likely enough for most invoices.

### 2. Drag handle with `dnd-kit`

Best if drag-and-drop becomes important.

`dnd-kit` docs recommend sortable items with stable item ids and updating list state on drag end. That matches this editor well once each row has a stable id.

Why it is good:

- fastest interaction for long item lists
- supports pointer + keyboard interactions
- well-suited to sortable forms in React

Costs here:

- new dependency; not currently installed in `package.json`
- more UI/state complexity than buttons
- needs care so drag gestures do not fight with textarea/input interaction

Good phase 2, not first move.

### 3. Native HTML drag and drop

Possible, but not recommended here.

Why not:

- poor touch/mobile ergonomics
- weaker accessibility story
- awkward with nested form controls
- usually more brittle than it looks

For this editor, it gives worse UX than buttons and worse implementation ergonomics than `dnd-kit`.

## Recommendation

Start with explicit move controls, not drag-and-drop.

Recommended order:

1. add stable row identity
2. add `Move up` / `Move down` buttons
3. keep save semantics exactly as-is
4. only add `dnd-kit` later if real invoices make button-based reordering feel slow

This lines up with the current implementation because the server already derives persistence order from the submitted array.

## Required Frontend Refactor First

Today the form drops server item ids when it builds local state.

From `src/routes/app.$organizationId.invoices.$invoiceId.tsx:89`:

```ts
invoice.items.map((item) => ({
  description: item.description,
  quantity: item.quantity,
  unitPrice: item.unitPrice,
  amount: item.amount,
  period: item.period,
}))
```

Recommended change:

- add `clientId: string` to `InvoiceItemFormValues`
- initialize existing rows with `item.id`
- initialize new rows with `crypto.randomUUID()`
- render `key={item.clientId}` instead of `key={index}`
- before save, map `invoiceItems` back to `{ description, quantity, unitPrice, amount, period }`

Without this, reorder will work visually sometimes, but it will be easier to trigger focus jumps and wrong DOM reuse.

Research this: does invoice item in the database have an id? Why not just use that id and pass it down as id. it should be in the organization domain for item already? unclear how to handle new items which don't have an id from the server yet.

## Suggested UX Details

For the current card layout:

- place reorder controls in the item header beside delete
- disable `Move up` on first item
- disable `Move down` on last item
- keep row numbering derived from current array index
- continue treating displayed order as the saved order

If lists grow longer later, add a drag handle without removing the buttons. Buttons remain the best fallback for accessibility and precision.

## Bottom Line

Effective ways, ranked for this editor:

1. `Move up` / `Move down` buttons — best now
2. `dnd-kit` drag handle — best later if needed
3. native HTML drag and drop — avoid

The key technical prerequisite is stable row identity. The backend is already ready for reordering because it loads by `order asc` and saves `order = array index + 1`.
