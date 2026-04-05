**Scope**
- Target: `src/organization-agent.ts` L104-141 schema, `src/lib/OrganizationRepository.ts` queries
- Goal: index needs, why, and query/index alignment suggestions

**Documentation Excerpt**
From `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/access-durable-objects-storage.mdx`:
```
Creating indexes for your most queried tables and filtered columns reduces how much data is scanned and improves query performance at the same time. If you have a read-heavy workload (most common), this can be particularly advantageous. Writing to columns referenced in an index will add at least one (1) additional row written to account for updating the index...
```

**Schema Excerpts**
From `src/organization-agent.ts`:
```
create table if not exists Invoice (
  id text primary key,
  createdAt integer not null default (unixepoch() * 1000),
  idempotencyKey text unique,
  status text not null,
  ...
)
```
```
create table if not exists InvoiceItem (
  id text primary key,
  invoiceId text not null references Invoice(id) on delete cascade,
  "order" real not null,
  ...
)
```

**Query Excerpts**
From `src/lib/OrganizationRepository.ts`:
```
select * from Invoice order by createdAt desc
```
```
select * from Invoice where id = ${invoiceId}
```
```
select json_group_array(...)
from (
  select *
  from InvoiceItem
  where invoiceId = i.id
  order by "order" asc
) as ii
```
```
delete from InvoiceItem where invoiceId = ${input.invoiceId}
```
```
update Invoice ... where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
```
```
update Invoice ... where idempotencyKey = ${workflowId}
```

**Existing Index Coverage**
- `Invoice.id` primary key implies an index used by `findInvoice`, `getInvoice`, updates/deletes by `id`.
- `InvoiceItem.id` primary key implies an index, but not used by the current queries.
- `Invoice.idempotencyKey` is `unique`, which in SQLite creates a unique index; used by updates filtered by `idempotencyKey`.

**Recommended Indexes**
- `Invoice(createdAt)` for `getInvoices` ordering. Reason: avoids full table sort on `order by createdAt desc`.
- `InvoiceItem(invoiceId, "order")` for `getInvoice` item fetch. Reason: supports `where invoiceId = ? order by "order" asc` without scan+sort.
- `InvoiceItem(invoiceId)` is subsumed by the composite index above; no separate single-column index needed if composite exists.

**Query Alignment Notes**
- `getInvoices` already matches an index on `createdAt`; no query change needed to benefit.
- `getInvoice` item subquery already matches `InvoiceItem(invoiceId, "order")`; no query change needed.
- Updates filtering by `idempotencyKey` already align with the existing unique index; no change needed.
- If future pagination is added to `getInvoices`, keep the `order by createdAt desc` so the `createdAt` index remains usable.
