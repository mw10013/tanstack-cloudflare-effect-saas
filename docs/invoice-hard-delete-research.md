# Invoice Hard Delete Research

## Goal

Refactor invoice deletion from soft delete to hard delete.

- Rename `softDeleteInvoice` to `deleteInvoice`
- Remove the `deleted` invoice status entirely
- Delete the `Invoice` row from SQLite
- Delete the R2 object when `r2ObjectKey` exists
- Do not broadcast activity for delete
- Make the two side effects fault tolerant

## Current State

`src/organization-agent.ts:300-315` currently soft-deletes and broadcasts:

```ts
@callable()
softDeleteInvoice(input: typeof SoftDeleteInvoiceInput.Type) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const { invoiceId } = yield* Schema.decodeUnknownEffect(SoftDeleteInvoiceInput)(input);
      const repo = yield* OrganizationRepository;
      const deleted = yield* repo.softDeleteInvoice(invoiceId);
      if (deleted.length === 0) return;
      yield* broadcastActivity(this, {
        action: "invoice.deleted",
        level: "info",
        text: "Invoice deleted",
      });
    }),
  );
}
```

`src/lib/OrganizationRepository.ts:147-156` only flips status:

```ts
const softDeleteInvoice = Effect.fn("OrganizationRepository.softDeleteInvoice")(
  function* (invoiceId: string) {
    return yield* sql`
      update Invoice
      set status = 'deleted'
      where id = ${invoiceId} and status in ('ready', 'error')
      returning id
    `;
  },
);
```

`src/lib/OrganizationDomain.ts:3-10` still models `deleted` as a first-class status:

```ts
export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
```

`src/lib/Activity.ts:4-18` and `:34-40` still include `invoice.deleted`.

UI callers also assume soft delete:

- `src/routes/app.$organizationId.invoices.index.tsx:188-197` uses `stub.softDeleteInvoice({ invoiceId })`
- `src/routes/app.$organizationId.invoices.index.tsx:435-436` renders `This invoice has been deleted.`

Two useful schema details from `src/organization-agent.ts`:

- `Invoice.r2ObjectKey text not null default ''` means uploaded invoices may have an R2 object, manual invoices may not.
- `InvoiceItem.invoiceId ... references Invoice(id) on delete cascade` means hard-deleting `Invoice` will also delete invoice items automatically.

## Why A Plain In-Request Delete Is Fragile

The delete operation has two side effects:

1. Delete R2 object, if present
2. Delete SQLite row

If both happen inside one normal RPC request and the process resets between them, one side effect may commit and the other may not.

Examples:

- R2 delete succeeds, process dies before DB delete: invoice row remains, file gone
- DB delete succeeds, process dies before R2 delete: invoice disappears, file leaks in R2

This is the part that needs Cloudflare durability, not just local `Effect.retry`.

## Cloudflare Options

### Option A: Cloudflare Queues

Queues fit the UX better than Workflows for this delete.

Relevant docs:

- `refs/cloudflare-docs/src/content/docs/queues/configuration/javascript-apis.mdx:102-106`

```md
* `send(...)` <Type text="Promise<void>" />
* When the promise resolves, the message is confirmed to be written to disk.
```

- `refs/cloudflare-docs/src/content/docs/queues/reference/how-queues-works.mdx:24-26`

```md
messages written to a queue should never be lost once the write succeeds
messages are not deleted from a queue until the consumer has successfully consumed the message
Queues does not guarantee that messages will be delivered to a consumer in the same order
```

- `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13-17`

```md
Queues provides at least once delivery by default
... may be delivered more than once
... use a unique ID / idempotency key to de-duplicate
```

- `refs/cloudflare-docs/src/content/docs/queues/configuration/dead-letter-queues.mdx:10-12`

```md
Messages are delivered to the DLQ when they reach the configured retry limit for the consumer.
Without a DLQ configured, messages that reach the retry limit are deleted permanently.
```

- `refs/cloudflare-docs/src/content/docs/queues/examples/use-queues-with-durable-objects.mdx:16-17`

```md
publish to Cloudflare Queues from within a Durable Object
```

This repo already uses Queues and a DLQ for invoice ingest:

- `wrangler.jsonc:70-85`
- `src/worker.ts:281-308`

That matters because delete is fire-and-return work. The user does not want polling, and the UI only cares whether the initial `deleteInvoice` callable succeeded.

#### Queue shape that matches the desired UX

Recommended message body:

```ts
{
  invoiceId: string,
  r2ObjectKey: string,
}
```

Important implication: the consumer should not need to re-read the invoice row. The row may already be gone by the time the consumer runs.

Recommended flow:

1. `deleteInvoice` validates invoice exists and is deletable
2. `deleteInvoice` enqueues `{ invoiceId, r2ObjectKey }`
3. once `send()` resolves, the delete job is durable
4. `deleteInvoice` may then eagerly delete the DB row
5. queue consumer performs idempotent cleanup: delete DB row if still present, delete R2 object if key is non-empty, ack on success, retry on failure, DLQ after retry exhaustion

This gives a good failure story:

- if queue send fails, return error and do nothing else
- if queue send succeeds but eager DB delete fails, the consumer can still delete the row later
- if eager DB delete succeeds but R2 delete fails, retries and DLQ still exist

### Option B: Cloudflare Workflows

Workflows are still viable, just less aligned with the desired UX.

Relevant docs:

- `refs/cloudflare-docs/src/content/docs/workflows/index.mdx:23-24`

```md
chain together multiple steps, automatically retry failed tasks,
and persist state for minutes, hours, or even weeks
```

- `refs/cloudflare-docs/src/content/docs/workflows/get-started/guide.mdx:121-129`

```md
`step.do(name, callback)` ... resumes from the last successful step rather than re-running completed work.
Separate steps are ideal for operations like calling external APIs, querying databases, or reading files from storage
```

- `refs/cloudflare-docs/src/content/docs/workflows/build/trigger-workflows.mdx:103-128`

```md
instance.status() ... inspect whether an instance is ... errored
error?: { name: string, message: string }
```

This repo already uses Workflows for extraction:

- `src/invoice-extraction-workflow.ts:33-167`
- `wrangler.jsonc:44-50`
- `src/organization-agent.ts:201-214`

Why Workflows are weaker here:

- `runWorkflow()` returns a workflow ID, not completion: `refs/agents/packages/agents/src/index.ts:3158-3163`
- your desired UX does not want polling or tracking background completion
- queues have an explicit DLQ model in the docs we have; for workflows, the docs we reviewed surface failures through status, logs, metrics, and dashboard inspection instead

## Recommendation

Use Cloudflare Queues for invoice deletion.

Reason:

- matches fire-and-return UX better
- queue send gives a durable acceptance point
- native retries and DLQ fit "backend may continue after UI returns"
- already used in this repo
- at-least-once delivery is acceptable because delete can be made idempotent

## Recommended Delete Flow

### API surface

- Rename `SoftDeleteInvoiceInput` -> `DeleteInvoiceInput`
- Rename `softDeleteInvoice` -> `deleteInvoice`
- Rename all callers accordingly
- Remove `invoice.deleted` activity action and delete broadcast usage
- Remove `deleted` from `InvoiceStatusValues`

### Queue shape

Recommended queued payload:

```ts
{
  invoiceId: string,
  r2ObjectKey: string,
}
```

### Order of operations

Recommended order:

1. read invoice metadata in `deleteInvoice`
2. queue `{ invoiceId, r2ObjectKey }`
3. eagerly delete the DB row in `deleteInvoice`
4. in queue consumer, delete DB row if still present
5. in queue consumer, delete R2 object if `r2ObjectKey` is non-empty

Why this order:

- queue first gives a durable handoff point before local mutation
- eager DB delete lets the UI treat success as deleted immediately and keeps router invalidation from seeing the row
- consumer-side DB delete repairs the case where queue send succeeded but eager DB delete did not
- deleting DB before R2 in the consumer avoids leaving a dangling DB pointer if background cleanup is delayed

The queue design does mean the consumer must be idempotent. That is okay here because Queues are at-least-once.

### DB delete behavior

DB delete can stay small. `InvoiceItem` rows cascade.

Schema excerpt from `src/organization-agent.ts:129-138`:

```sql
create table if not exists InvoiceItem (
  id text primary key,
  invoiceId text not null references Invoice(id) on delete cascade,
  ...
)
```

So the hard-delete SQL can be one `delete from Invoice where id = ? ... returning ...` query.

### R2 delete behavior

R2 deletes are strongly consistent once they resolve.

`refs/cloudflare-docs/src/content/docs/r2/api/workers/workers-api-reference.mdx:117-120`:

```md
- `delete` <Type text="(key: string | string[]): Promise<void>" />
- R2 deletes are strongly consistent. Once the Promise resolves, all subsequent read operations will no longer see the provided key value pairs globally.
```

This repo's `R2` service already wraps R2 calls with Effect retries for transient codes:

- `src/lib/R2.ts:57-71`

```ts
Effect.retry({
  while: (error) => isRetryable(error.message),
  times: 2,
  schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
})
```

So the recommended stack is:

- inner retry: existing `R2` / D1 service retry for transient request-level failures
- outer durability: queue delivery retries + DLQ

## Deleting `extracting`

For now, restricting delete to `ready` / `error` is still the right call.

Current code suggests deleting an `extracting` invoice is probably functionally survivable, but messy:

- extraction saves back with `where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}`
  - `src/lib/OrganizationRepository.ts:168-190`
- if the row is gone, `saveInvoiceExtraction` returns `[]` and `OrganizationAgent.saveInvoiceExtraction()` returns without broadcasting
  - `src/organization-agent.ts:323-333`
- workflow error handling also becomes a no-op if the row is gone
  - `src/lib/OrganizationRepository.ts:206-215`
  - `src/organization-agent.ts:355-372`

So deleting `extracting` would likely not corrupt invoice data, but it can still:

- waste R2 / AI work already in flight
- produce errored extraction workflows after the invoice has been removed
- leave extra operational noise in workflow tracking/logs

There is a termination API in Agents / Workflows:

- `refs/cloudflare-docs/src/content/docs/workflows/build/trigger-workflows.mdx:154-163`
- `refs/agents/packages/agents/src/index.ts:3359-3400`

But `terminate()` is not supported in local development:

- `refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:452-478`
- `refs/agents/packages/agents/src/index.ts:3351-3352`

Bottom line: deleting `extracting` looks technically survivable, but not clean enough to expand scope now.

## Effect v4 Fit

The current codebase is already using the right shape for this kind of work:

- `Effect.fn("...")` for reusable service operations
- `Effect.gen(function* () { ... })` for orchestration
- service layers for `OrganizationRepository`, `R2`, config, logging

Effect docs in `refs/effect4/ai-docs/src/06_schedule/10_schedules.ts:4-5` and `:50-56` reinforce the retry model already used locally:

```ts
Build schedules, compose them, and use them with `Effect.retry`
...
Schedule.exponential("250 millis").pipe(..., Schedule.jittered)
```

For implementation, the idiomatic split is:

- repository helpers stay as `Effect.fn`
- agent callable / queue consumer orchestration stays as `Effect.gen`
- keep queue payloads JSON-serializable
- keep consumer cleanup idempotent

## Likely Code Changes

Primary files:

- `src/organization-agent.ts`
- `src/lib/OrganizationRepository.ts`
- `src/lib/OrganizationAgentSchemas.ts`
- `src/lib/OrganizationDomain.ts`
- `src/lib/Activity.ts`
- `src/routes/app.$organizationId.invoices.index.tsx`
- `wrangler.jsonc`
- `src/worker.ts`

Expected cleanup:

- remove deleted-status references
- remove deleted-state UI branch
- remove delete activity action / invalidation path tied to broadcast
- rename mutation/callers to `deleteInvoice`

## Failure Surfacing

The desired UX is:

- if `deleteInvoice` returns an error, show it
- otherwise treat delete as accepted/successful
- do not track background completion in the UI

Queues fit that better because the background failure path can go to a DLQ.

Workflow failure surfacing in the docs we reviewed is different:

- `instance.status()` exposes `status: "errored"` and `error`
  - `refs/cloudflare-docs/src/content/docs/workflows/build/trigger-workflows.mdx:103-128`
  - `refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:520-541`
- workflow logs/state are retained for a limited period
  - `refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx:40`

I did not find a DLQ-like workflow primitive in `refs/cloudflare-docs`.

## Open Questions

1. Should delete remain restricted to `ready` / `error` only, matching current behavior and UI, or should it also cancel `extracting` invoices?

Restrict to `ready` / `error` for now. Research result above: deleting `extracting` looks survivable but noisy.

2. Should `deleteInvoice()` resolve only after the row is actually gone, or is enqueueing a durable delete acceptable?

Do not wait for full background completion. Await the callable, but let that mean "delete accepted" rather than "all cleanup finished".


3. If a delete workflow exhausts retries and ends `errored`, where should that surface if delete no longer broadcasts activity?

With queues, surface it in a DLQ, not the UI.

## Bottom Line

Recommended approach: hard delete via queue-backed async cleanup.

- Step 1: validate invoice and read `r2ObjectKey`
- Step 2: enqueue durable delete job
- Step 3: eagerly delete DB row in the callable
- Step 4: queue consumer idempotently deletes DB row and R2 object
- Step 5: let retries/DLQ handle background failure cases
- no delete broadcast
- remove `deleted` status from the domain/UI
- keep Effect code small, layered, and idempotent
