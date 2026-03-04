# Plan vs. Implementation Assessment

## Overview

Assessment of how faithfully the [organization image classification workflow plan](./organization-image-classification-workflow-plan.md) is implemented across the codebase.

Files reviewed:

- `src/organization-agent.ts`
- `src/organization-messages.ts`
- `src/worker.ts`
- `src/routes/app.$organizationId.upload.tsx`
- `src/routes/app.$organizationId.workflow.tsx`
- `wrangler.jsonc`
- `worker-configuration.d.ts`

## Section-by-section

### 1) Scope and non-goals — Faithful

- Approval workflow (`OrganizationWorkflow`) preserved unchanged at `src/organization-agent.ts:123-183`.
- Separate `OrganizationImageClassificationWorkflow` class at `src/organization-agent.ts:185-233`.
- Wrangler workflow binding configured for both local and production in `wrangler.jsonc:36-47` and `:164-175`.
- Workflow route (`app.$organizationId.workflow.tsx`) left untouched for approval use.
- Top-1 only classification stored (single label + score).

### 2) Data contracts — Faithful

- `idempotencyKey` generated as `crypto.randomUUID()` and written to R2 `customMetadata` alongside `organizationId` and `name` (`upload.tsx:79-83`).
- Queue handler reads `organizationId`, `name`, `idempotencyKey` from `head.customMetadata` and passes `{ name, eventTime, idempotencyKey, r2ObjectKey }` to `onUpload` (`worker.ts:150-168`).
- Implementation also passes `r2ObjectKey` (needed by workflow). Reasonable addition not contradicted by plan.

### 3) Agent state model — Faithful

- `Upload` table schema at `src/organization-agent.ts:239-247` has all planned columns: `name` (PK), `eventTime`, `idempotencyKey`, `classificationLabel`, `classificationScore`, `classifiedAt`.
- `UploadRow` zod schema at `:85-94` matches, plus `createdAt`.

### 4) Ordering and staleness rules — Faithful

- `onUpload` at `:286-291` parses `eventTime`, loads existing row by `name`, skips if incoming `eventTime < existing.eventTime` (`:292-299`).
- On skip, broadcasts `classification_workflow_skipped` and returns.
- On newer event, upserts marker fields and clears classification columns (`:300-325`).
- `applyClassificationResult` at `:359-385` guards by checking `idempotencyKey` before writing classification. Stale completions are dropped.

**Minor observation**: The guard in `applyClassificationResult` is structurally tautological — see gap #2 below.

### 5) Workflow launch/idempotency — Mostly faithful (2 gaps)

- Workflow ID = `idempotencyKey` (`:345`).
- No manual writes to `cf_agents_workflows`.
- Reset-first flow implemented:
  - Agent tracking check via `getWorkflow` (`:326-329`).
  - Workflow binding ground truth check via `env.OrganizationImageClassificationWorkflow.get()` (`:330-338`).
  - Both layers attempt terminate if active.
- Local-dev policy: workflow control throws naturally and propagates to queue handler catch block resulting in `retry()`. Matches plan intent.

Gaps described in detail below.

### 6) Workflow definition — Faithful

- `OrganizationImageClassificationWorkflow` at `:185-233` with payload `{ idempotencyKey, r2ObjectKey }`.
- All side effects in `step.do`: image fetch (`:199-207`), AI classification (`:208-223`), result apply (`:224-230`).
- Returns classification result payload.
- Exported from `worker.ts:15`.

### 7) AI invocation path — Faithful

- Workers AI with `@cf/microsoft/resnet-50` (`:209`).
- AI Gateway with `AI_GATEWAY_ID` (`:213-216`).
- Top-1 only via `predictions[0]` (`:221`).

### 8) Queue consumer behavior — Faithful

- Explicit per-message `ack()` on terminal paths (missing head: `:147`, missing metadata: `:158`).
- On transient failure: `message.retry()` (`:181`). Plan says "do not `ack()`"; implementation explicitly retries, which is functionally equivalent and arguably better.
- Error logging includes relevant context (`:174-179`).

### 9) App/UI impact — Faithful

- Upload page renders classification label/score per card (`upload.tsx:342-346`) with "Classifying..." placeholder.
- Upload page wires classification websocket messages to `router.invalidate()` (`:166-172`).
- Workflow page unchanged, remains approval-specific.
- Message schema in `organization-messages.ts` includes all four classification event types: `classification_workflow_started`, `classification_workflow_skipped`, `classification_updated`, `classification_error`.
- Plan's optional inspector updates not implemented. Acceptable — plan marked as "Optional."

### 10) Validation plan — N/A

Plan described manual testing scenarios with "no code yet." No automated test code exists. Expected at this stage.

## Summary table

| Plan Section | Status |
|---|---|
| 1. Scope/non-goals | Faithful |
| 2. Data contracts | Faithful |
| 3. Agent state model | Faithful |
| 4. Ordering/staleness | Faithful (minor observation) |
| 5. Workflow launch/idempotency | Mostly faithful (2 gaps) |
| 6. Workflow definition | Faithful |
| 7. AI invocation | Faithful |
| 8. Queue consumer | Faithful |
| 9. UI impact | Faithful |
| 10. Validation | N/A |

## Gaps

### Gap 1: Binding `.get()` error swallowed

`src/organization-agent.ts:330-332`

```ts
const existingInstance = await this.env.OrganizationImageClassificationWorkflow
  .get(upload.idempotencyKey)
  .catch(() => null);
```

`.catch(() => null)` treats all errors — including transient network failures — as "no instance found." This undermines the plan's requirement that binding status is ground truth (plan section 5: "Use workflow binding status as ground truth when tracking and binding disagree").

A transient binding error would skip the terminate step and potentially allow a duplicate create attempt. The plan says if stop/terminate fails at the binding layer, treat as reset failure and throw (no `ack()`).

**Risk**: Under transient binding failures, the reset-first invariant is violated. A duplicate-ID create could follow, which the plan classifies as an invariant violation.

### Gap 2: Tautological staleness guard in `applyClassificationResult`

`src/organization-agent.ts:365-366`

```ts
const row = UploadRow.nullable().parse(this
  .sql<UploadRow>`select * from Upload where idempotencyKey = ${input.idempotencyKey}`[0] ?? null);
if (row?.idempotencyKey !== input.idempotencyKey) {
  return;
}
```

The query uses `WHERE idempotencyKey = ?`, so any returned row already has a matching `idempotencyKey`. The subsequent `row?.idempotencyKey !== input.idempotencyKey` check can only be true when `row` is null (no row found). It is never true when a row is found.

The guard still works correctly — stale writes are dropped because the query returns null when a newer upload has overwritten the idempotencyKey. However, the plan describes the logic as: "read current row by `name`, then check if `idempotencyKey` matches." The plan's pattern would be more defensive if multiple names could theoretically share an idempotencyKey. By design they cannot (UUID), so this is not a bug — but the code structure doesn't match the documented intent.

## Verdict

Implementation is **substantially faithful** to the plan. Both gaps involve edge-case resilience rather than core correctness under normal operation. The plan's design constraints around ground-truth verification and explicit invariant-violation handling are the areas where implementation takes shortcuts.

---

## Proposed fix for Gap 1: Create-first with recovery

### Problem recap

`organization-agent.ts:329-331` — `.get(id).catch(() => null)` swallows all errors, treating transient binding failures as "no instance found." This violates the plan's ground-truth invariant: if the binding layer can't confirm whether an instance exists, the reset-first sequence should abort (throw → queue retry).

### Why `.get()` can't distinguish "not found" from transient errors

The Cloudflare docs say only: *"Throws an exception if the instance ID does not exist"* (`workers-api.mdx:348`). No error class, no error code.

Miniflare's implementation (`binding.worker.js:2317-2324`):

```ts
async get(id) {
    let stubId = this.env.ENGINE.idFromName(id),
        stub = this.env.ENGINE.get(stubId),
        handle = new WorkflowHandle(id, stub);
    try {
      await handle.status();
    } catch {
      throw new Error("instance.not_found");
    }
    return handle;
}
```

Miniflare itself catches **all** errors from `handle.status()` (including transient DO communication failures) and remaps them to a single `new Error("instance.not_found")`. So even if we matched on the message string, we'd still conflate the two cases at the miniflare layer.

Production workerd has no documented error type either. The `WorkflowError` interface in `@cloudflare/workers-types` (`{ code?: number; message: string }`) describes `InstanceStatus.error` (a failed workflow's error payload), not what `.get()` throws.

**Conclusion**: `.get()` as a speculative probe is fundamentally unreliable for ground-truth verification.

### Approach: create-first, recover on duplicate

Instead of probing with `.get()` then creating, **attempt `create()` directly**. The `create()` call is itself the existence check:

- If it succeeds → no prior instance existed (or it was already expired). Done.
- If it throws → an instance with that ID exists. Enter recovery: get → terminate → retry create.

This eliminates the speculative `.get()` entirely. In the recovery path, `.get()` is called only when we **know** the instance exists (because create just told us so), so a failure there is genuinely transient and should propagate.

### Current code (`organization-agent.ts:325-345`)

```ts
const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
  await this.terminateWorkflow(upload.idempotencyKey);
}
const existingInstance = await this.env.OrganizationImageClassificationWorkflow
  .get(upload.idempotencyKey)
  .catch(() => null);
if (existingInstance) {
  const status = await existingInstance.status();
  if (activeWorkflowStatuses.has(status.status)) {
    await existingInstance.terminate();
  }
}
await this.runWorkflow(
  "OrganizationImageClassificationWorkflow",
  {
    idempotencyKey: upload.idempotencyKey,
    r2ObjectKey: upload.r2ObjectKey,
  },
  { id: upload.idempotencyKey },
);
```

### Proposed replacement

```ts
const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
  await this.terminateWorkflow(upload.idempotencyKey);
}
try {
  await this.runWorkflow(
    "OrganizationImageClassificationWorkflow",
    {
      idempotencyKey: upload.idempotencyKey,
      r2ObjectKey: upload.r2ObjectKey,
    },
    { id: upload.idempotencyKey },
  );
} catch {
  const instance = await this.env.OrganizationImageClassificationWorkflow
    .get(upload.idempotencyKey);
  const status = await instance.status();
  if (activeWorkflowStatuses.has(status.status)) {
    await instance.terminate();
  }
  await this.runWorkflow(
    "OrganizationImageClassificationWorkflow",
    {
      idempotencyKey: upload.idempotencyKey,
      r2ObjectKey: upload.r2ObjectKey,
    },
    { id: upload.idempotencyKey },
  );
}
```

### Failure mode analysis

| Scenario | First `create()` | Recovery path | Outcome |
|---|---|---|---|
| No prior instance | Succeeds | — | Workflow starts. Correct. |
| Prior instance exists, active | Throws (duplicate ID) | `.get()` succeeds → terminate → retry create succeeds | Old workflow terminated, new one starts. Correct. |
| Prior instance exists, completed/expired | Succeeds (ID slot freed) | — | Workflow starts. Correct. |
| Transient binding error on first `create()` | Throws | `.get()` throws (transient) → **propagates** → queue retry | Safe. No silent swallow. Correct. |
| First `create()` fails transiently, `.get()` succeeds | Throws | `.get()` returns instance → terminate → retry create | Terminate may be unnecessary (instance may not be the cause), but is harmless. Correct. |
| Recovery create fails | — | Throws → **propagates** → queue retry | Safe. Correct. |
| Prior instance terminated between first create throw and recovery `.get()` | Throws | `.get()` throws "not found" → **propagates** → queue retry | Extra retry, but safe. The next queue attempt will succeed via the first-create path. |

### Open questions

1. **Does `runWorkflow` (from agents framework) throw the same error as `env.Workflow.create()`?** `runWorkflow` wraps `create()` and also writes to `cf_agents_workflows` tracking table. Need to verify that the duplicate-ID error from the binding propagates through `runWorkflow` unmodified. If `runWorkflow` catches and re-throws differently, the catch block may need adjustment.

2. **Retry amplification**: The last scenario in the table (instance terminated between create-throw and recovery `.get()`) causes one unnecessary queue retry. This is safe but worth acknowledging — under rapid re-uploads, the queue message may retry once more than strictly necessary.

3. **Agent tracking cleanup**: The current code calls `this.terminateWorkflow()` (agent tracking layer) before the binding layer. The proposed code preserves this. But if `terminateWorkflow` succeeds while the binding still has an active instance (tracking and binding disagree), the first `create()` will still fail on the binding. The recovery path then handles it via the binding. This is correct — the two layers are cleaned up independently.
