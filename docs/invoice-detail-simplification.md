# Invoice Detail Route Simplification

## Goal

Simplify `app.$organizationId.invoices.$invoiceId.tsx` to use a straightforward loader pattern like `login.tsx`, remove broadcast-triggered query invalidation for the edit form, and keep `useMutation` for saves.

## Current Architecture (What's Wrong)

### 1. Loader uses `ensureQueryData` + redundant invoice list fetch

```ts
// app.$organizationId.invoices.$invoiceId.tsx loader
loader: async ({ params, context }) => {
  await Promise.all([
    context.queryClient.ensureQueryData({ queryKey: invoicesQueryKey(...) }),  // ← why?
    context.queryClient.ensureQueryData({ queryKey: invoiceQueryKey(...) }),
  ]);
}
```

**Problems:**

- Fetches the full invoices list (`getInvoices`) on a single-invoice edit page — only used for `invoiceSummary?.viewUrl` (one field).
- Returns nothing from loader — data consumed via `useQuery` in component, duplicating the query config.
- `ensureQueryData` coordinates with TanStack Query cache but adds complexity vs. just returning data.

### 2. Component re-fetches what the loader already ensured

```ts
// Component creates its own useQuery with a DIFFERENT queryKey (appends getInvoiceWithItemsFn)
const invoiceQuery = useQuery({
  queryKey: [...invoiceQueryKey(orgId, invoiceId), getInvoiceWithItemsFn],
  queryFn: () => getInvoiceWithItemsFn({ data: { organizationId, invoiceId } }),
});
```

The `queryKey` includes `getInvoiceWithItemsFn` (the `useServerFn` wrapper), making it a _different_ cache entry from what the loader seeded. The loader's `ensureQueryData` call seeds `invoiceQueryKey(orgId, invoiceId)` but the component queries a different key — so the loader's cache hit may not apply.

### 3. Broadcast activity triggers global query invalidation

In `app.$organizationId.tsx`, the `useAgent` `onMessage` handler invalidates _all_ invoice queries on `invoice.updated`:

```ts
if (shouldInvalidateForInvoice(message.action)) {
  void queryClient.invalidateQueries({
    queryKey: ["organization", organizationId, "invoices"],
  });
  void queryClient.invalidateQueries({
    queryKey: ["organization", organizationId, "invoice"],
  });
}
```

`"invoice.updated"` is in `INVALIDATING_ACTIONS` (Activity.ts L38). When the user saves _their own_ edit, the mutation's `onSuccess` already calls `setQueryData` + `invalidateQueries` — then the broadcast echo arrives and invalidates _again_. For a form that the user is actively editing, this creates an unnecessary re-fetch cycle that overwrites the form's local state via the `useEffect` sync.

### 4. Form state synced via `useEffect`

```ts
const [form, setForm] = React.useState<InvoiceFormValues | null>(null);
React.useEffect(() => {
  if (invoiceQuery.data) setForm(toFormValues(invoiceQuery.data));
}, [invoiceQuery.data]);
```

Any query invalidation (including the broadcast echo) replaces the user's in-progress edits. This is the concrete bug created by the broadcast pattern on an edit form.

## Proposed Architecture

### Pattern: `login.tsx`-style

```
loader → return server fn data directly → useLoaderData in component
mutation → useMutation calling stub.updateInvoice → invalidate on settle
```

No TanStack Query for reading the invoice on this route. No broadcast invalidation touching this form.

### Loader: return data directly

```ts
// Proposed loader
const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(paramsSchema))
  .handler(({ data: { organizationId, invoiceId }, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        // auth check + get stub (same as existing getInvoiceWithItems)
        const stub = yield* getOrganizationAgentStub(organizationId);
        const invoice = yield* Effect.tryPromise(() =>
          stub.getInvoiceWithItems(invoiceId),
        );
        // also get viewUrl for this single invoice if needed
        // ...
        return { invoice: invoice ? structuredClone(invoice) : null };
      }),
    ),
  );

export const Route = createFileRoute(
  "/app/$organizationId/invoices/$invoiceId",
)({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});
```

Component consumes via:

```ts
const { invoice } = Route.useLoaderData();
```

**Key difference from login.tsx**: login returns a simple object. Here we return `{ invoice }`. No `ensureQueryData`, no `useQuery` for read.

### Mutation: keep `useMutation`, use `router.invalidate()` for refresh

```ts
const router = useRouter();
const saveMutation = useMutation({
  mutationFn: (data: InvoiceFormValues) => stub.updateInvoice({ ... }),
  onSuccess: (invoice) => {
    setForm(toFormValues(invoice));
    // Optionally invalidate the router to refetch loader data
    // But since we already set form from the response, we may not need to
  },
  onSettled: () => {
    // Invalidate the invoices list query for the parent route
    void queryClient.invalidateQueries({ queryKey: invoicesQueryKey(organizationId) });
  },
});
```

After save, the mutation response contains the updated `InvoiceWithItems`. We set form state directly — no need to refetch.

### Remove `invoice.updated` broadcast entirely

Remove everything related to broadcasting on invoice update:

1. **`organization-agent.ts`** — Remove the `broadcastActivity` call from `updateInvoice` (L263-267).
2. **`Activity.ts`** — Remove `"invoice.updated"` from `ActivityAction` literals (L7) and from `INVALIDATING_ACTIONS` (L38).

The form should behave like a regular web form — saving doesn't trigger background activity messages or query invalidation cascades. Broadcasts continue for uploads, extractions, creates, and deletes.

### Form state initialization

```ts
const { invoice } = Route.useLoaderData();
const [form, setForm] = React.useState<InvoiceFormValues | null>(
  invoice ? toFormValues(invoice) : null,
);
```

No `useEffect` sync — `useLoaderData` is available synchronously on initial render. When navigating between invoices, `params` change → loader re-runs → component remounts with new data (TanStack Router behavior for param changes).

### viewUrl for "Open source file"

Currently fetched via `invoicesQuery.data?.find(...)`. Options:

1. **Include in `getLoaderData`** — compute the viewUrl for this single invoice in the server fn.
2. **Separate server fn** — `getInvoiceViewUrl` if the R2 signing logic should stay isolated.
3. **Drop it** — if the source file link isn't essential on the edit form.

Recommendation: Option 1 — one server call, no extra round trip.

## What Changes

| File                                          | Change                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.$organizationId.invoices.$invoiceId.tsx` | Replace `ensureQueryData` loader with `createServerFn` returning data. Replace `useQuery` with `useLoaderData`. Remove `useEffect` form sync. Remove `invoicesQuery`. Keep `useMutation`.                     |
| `app.$organizationId.invoices.tsx` (layout)   | Remove the `getInvoiceWithItems` prefetch for first invoice (optional cleanup — it pre-warms a TanStack Query cache entry that the detail route won't use anymore). Keep `getInvoices` prefetch for the list. |
| `lib/Invoices.ts`                             | Possibly add a new server fn for the detail page, or keep `getInvoiceWithItems` and call it from the new loader's server fn.                                                                                  |
| `Activity.ts`                                 | Remove `"invoice.updated"` from `ActivityAction` literals and `INVALIDATING_ACTIONS`.                                                                                                                         |
| `organization-agent.ts`                       | Remove `broadcastActivity` call from `updateInvoice`.                                                                                                                                                         |
| `app.$organizationId.tsx`                     | No change needed. Broadcast invalidation continues for remaining actions (upload/extraction/create/delete).                                                                                                   |

## What Stays the Same

- `useMutation` for save via `stub.updateInvoice` (Cloudflare RPC)
- `useOrganizationAgent` for the stub
- Form state management via `useState` + `setForm`
- All the form UI (TextField, TextAreaField, line items CRUD)
- Broadcast activity for uploads/extractions/deletes (list page)
- Activity feed in sidebar

## Decisions

1. **Use `useForm` (TanStack Form)** for client-side validation — adopt the same pattern as login.tsx (`useForm` + `useMutation`). No SSR form patterns.

2. **`staleTime` stays at 0 (default)** — navigating away and back refetches. This is standard form behavior. No route in this app has a compelling case for `staleTime > 0`; the data is always fresh from the server on navigation.

3. **No concurrent edit support** — this is a regular form, not a real-time collaborative editor. Broadcast invalidation for `invoice.updated` is removed entirely.

4. **No `useServerFn` on this route** — loader calls server fn directly; mutation uses `stub.updateInvoice` via Cloudflare RPC. No wrapping needed.
