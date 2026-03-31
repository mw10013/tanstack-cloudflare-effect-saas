# Invoice Detail Route Simplification

## Summary

Research and decisions from simplifying `app.$organizationId.invoices.$invoiceId.tsx`. Covers the form save pattern, loader design, domain type alignment, `defaultValues` handling, and Effect/TanStack Router control flow.

## 1. Form Save Pattern: The Revert Bug

### Problem

After saving, the form reverted to the original (pre-edit) values. Multiple approaches were tried.

### What didn't work

**`form.reset(newValues)` in mutation `onSuccess`:**
After `reset(newValues)`, the form's internal `defaultValues` updated to the server response and `isTouched` became `false`. On the next React render, `useForm`'s internal `update()` compared options `defaultValues` (still the old loader data from `useLoaderData()`) against the form's internal `defaultValues` (new server data). Since `isTouched` was false and they differed, `update()` reverted the form to the old loader data.

**`await router.invalidate()` then `formApi.reset()`:**
`reset()` runs synchronously before the re-render from `invalidate()`. So it resets to the old `defaultValues`, causing a visible flash of old values before the fresh loader data arrives.

**`useState` to track current invoice:**
Works but is a hack -- doesn't follow any TanStack pattern and adds state management that shouldn't be needed.

### What works: fire-and-forget `router.invalidate()` in `onSuccess`

This is the pattern used by members, invitations, and every other mutation in the codebase:

```ts
const saveMutation = useMutation({
  mutationFn: (data) => stub.updateInvoice({ invoiceId, ...data }),
  onSuccess: () => {
    void router.invalidate();
  },
});

const form = useForm({
  defaultValues: { ...invoice fields... },
  onSubmit: ({ value }) => {
    void saveMutation.mutateAsync(value);
  },
});
```

The form values stay as-is after save (showing what the user typed). `router.invalidate()` re-runs the loader in the background. When the fresh loader data arrives, `useForm`'s `update()` sees new `defaultValues` that match the current form values, so nothing visually changes and dirty state clears naturally.

### Key insight

Members and invitations routes don't use `formApi.reset()` at all. They fire the mutation, invalidate, done. The invoice route was overcomplicating things with reset/refetch choreography.

## 2. Loader Design: Nullable Invoice

### Problem

The loader returned `{ invoice: null, viewUrl: undefined }` when invoice wasn't found. This forced:
- `invoice?.status` optional chaining throughout the component
- `toDefaultValues({} as InvoiceWithItems)` fallback hack
- A null-check early return in the component

### Decision

The loader should either have concrete data or 404. Server fn returns `null` for not found, route loader throws `notFound()`:

```ts
// Invoices.ts -- server fn returns null cleanly
if (!invoice) return null;

// Route loader -- translates to 404
loader: async ({ params }) => {
  const data = await getInvoiceDetail({ data: params });
  if (!data) throw notFound();
  return data;
},
```

This separates concerns: the server fn is a data fetcher (null is valid), the route owns UX decisions (null means 404 for this page).

### notFound() inside Effect

The codebase already uses `Effect.die(notFound())` and `Effect.die(redirect(...))` throughout (app.tsx, admin.tsx, pricing.tsx, etc.). `runEffect` in worker.ts already catches these:

```ts
const squashed = Cause.squash(exit.cause);
if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
```

Using `die` for control flow is semantically impure (defects are for bugs), but it works reliably and is the established pattern across 7+ call sites. Not worth changing.

## 3. Domain Type Alignment: `items` vs `invoiceItems`

### Problem

`InvoiceWithItems` had `items` but `InvoiceFormSchema` had `invoiceItems`. This mismatch required `toDefaultValues` to manually remap every field from the domain type to the form shape.

### Decision

Renamed `items` -> `invoiceItems` on `InvoiceWithItems` (domain type) and the SQL query in `OrganizationRepository.ts`. This aligns with:
- `InvoiceFormSchema.invoiceItems`
- `InvoiceExtractionSchema.invoiceItems`
- `OrganizationRepository` destructuring (`const { invoiceItems, ...extracted }`)

The rename was the smaller change -- `items` was only used in 3 places (domain schema, SQL query, invoices index template). `invoiceItems` was used everywhere else.

## 4. Killing `toDefaultValues`

### Problem

`toDefaultValues` manually copied 15 invoice fields and 5 item fields from the domain type to the form shape. Verbose, fragile, and looked like a made-up pattern.

### What other routes do

Members and invitations routes inline `defaultValues` as plain object literals with hardcoded defaults (empty strings). They don't edit existing server data, so there's no domain-to-form mapping needed.

### Decision

The mapping IS needed because the form only uses a subset of invoice fields (not `id`, `status`, `createdAt`, etc.) and a subset of item fields (not `id`, `invoiceId`, `order`). But it's done inline using `Struct.pick`:

```ts
defaultValues: {
  ...Struct.pick(invoice, ["name", "invoiceNumber", ...]),
  invoiceItems: invoice.invoiceItems.map((item) =>
    Struct.pick(item, ["description", "quantity", "unitPrice", "amount", "period"])
  ),
},
```

No intermediate function, no separate key constants -- all inline where it's used.

## 5. NonEmptyArray -> Array for invoiceItems

`InvoiceFormSchema` used `Schema.NonEmptyArray` for `invoiceItems`. This was wrong -- an invoice can legitimately have zero line items (newly created, extraction found none). Changed to `Schema.Array`. Removed the empty-item fallback in `defaultValues`.

## 6. Removing TanStack Query from the detail route

The detail route used `useQueryClient` and `queryClient.invalidateQueries({ queryKey: invoicesQueryKey(...) })` in `onSettled` to refresh the invoices list cache. But this route doesn't use any TanStack Query queries -- it uses loader data. The list route's own loader will re-run when the user navigates back.

Removed `useQueryClient`, `invoicesQueryKey` import, and the `onSettled` handler. The route no longer knows about TanStack Query.

## 7. Next Steps: getLoaderData pattern

### Current state

`getInvoiceDetail` in `Invoices.ts` is a server fn that composes `getInvoice` + `getInvoiceViewUrl`. It's called by one route's loader.

### Proposed

Follow the `login.tsx` pattern: local `getLoaderData` server fn in the route file that composes domain Effects.

- `Invoices.ts` exports clean domain Effects: `getInvoice` (returns `Option`), `getInvoiceViewUrl`
- Route file has local `getLoaderData` server fn that composes them via `runEffect`
- `getInvoice` returns `Option` (idiomatic Effect for "may not exist")
- `getLoaderData` translates `Option.None` -> `Effect.die(notFound())`

```ts
// Route file
const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(...)
  .handler(({ context: { runEffect }, data: { organizationId, invoiceId } }) =>
    runEffect(
      Effect.gen(function* () {
        const invoice = yield* getInvoice(organizationId, invoiceId).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.catchTag("NoSuchElementError", () => Effect.die(notFound())),
        );
        const viewUrl = yield* getInvoiceViewUrl(organizationId, invoice);
        return { invoice: structuredClone(invoice), viewUrl };
      }),
    ),
  );

export const Route = createFileRoute(...)({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});
```

This eliminates:
- `getInvoiceDetail` from `Invoices.ts`
- The async loader wrapper with `throw notFound()`
- The route becomes a one-liner loader again

### Naming: `getInvoiceWithItems` -> `getInvoice`

The "WithItems" suffix implies there's a version without items. There isn't. Items are just part of an invoice. Rename to `getInvoice` (including the DO stub method).

### General pattern: server fn per route

Routes that need multiple pieces of data compose them in a local `getLoaderData` server fn. Domain functions (`getInvoice`, `getInvoiceViewUrl`) stay clean and reusable. The server fn is the route's data contract -- named for the route, not the domain.
