# Organization Image Classification Workflow Plan (Design Review + Revision)

## Goal

When an image upload lands in R2 and emits an R2 event notification, run a dedicated image-classification workflow to classify the image with Workers AI `@cf/microsoft/resnet-50` through AI Gateway, and persist the latest classification in organization-agent SQLite.

This plan is design-only. No implementation steps executed yet.

## Review Verdict

### Correct in prior plan

- Queue delivery is at-least-once, duplicates possible (`refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`).
- `ack()` marks per-message delivery success (`refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:58`).
- Workflow side effects outside `step.do` can repeat (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:218`).
- `runWorkflow()` creates workflow then inserts tracking row (non-atomic sequence): `refs/agents/packages/agents/src/index.ts:1906`, `refs/agents/packages/agents/src/index.ts:1917`.

### Incorrect / stale in prior plan

- Typo: `AI Gatewayy`.
- Baseline omitted current approval UI and RPC coupling:
  - `requestApproval`/`approveRequest`/`rejectRequest`/`listApprovalRequests` in `src/organization-agent.ts:333`.
  - Approval route depends on them: `src/routes/app.$organizationId.workflow.tsx:33`.
- Current queue->agent handoff drops event metadata (`eventTime`) and only sends `{ name }`: `src/worker.ts:130`, `src/worker.ts:158`, `src/organization-agent.ts:199`.
- Requirements numbering inconsistent and duplicated.

### Feasibility

Feasible with current stack (TanStack Start + Agents + Workflows + R2 + Queue). Core constraints are ordering and idempotency under:

- at-least-once queue delivery,
- non-atomic `runWorkflow` tracking,
- overwrite semantics for same object key.

## Evidence Excerpts

- Queue duplicates: “at least once delivery” and “may be delivered more than once” (`refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`).
- Explicit ack semantics: “call the `ack()` method on the message” (`refs/cloudflare-docs/src/content/docs/queues/configuration/bxatching-retries.mdx:63`).
- Workflow side effects guidance: “side effects outside of steps… may be duplicated” (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`).
- Workflow `create` with custom ID can throw if ID exists (`refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:277`).
- R2 notification includes `eventTime` (`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:103`).
- ResNet output schema is array of `{ score, label }` (`refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json:56`).

## Revised Plan

## 1) Scope and non-goals

- Keep existing approval workflow behavior as-is.
- Add a separate classification workflow in the same agent module.
- Add Wrangler workflow binding/config for the new workflow.
- Preserve existing upload UX route; workflow route may be repurposed or deprecated in follow-up.
- No multi-label storage initially; store top-1 only.

## 2) Data contracts

- Upload write must include immutable per-upload id:
  - `idempotencyKey` (UUID) in R2 `customMetadata`.
- Queue notification payload already carries:
  - `object.key`, `eventTime` (`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:74`).
- Worker queue handler passes to agent:
  - `organizationId`, `name`, `eventTime`, `idempotencyKey`.

## 3) Agent state model (single source of truth per `name`)

Keep `name` as PK and add upload/classification columns so stale writes are rejected deterministically.

Required logical fields (camelCase):

- `name` (pk)
- `eventTime`
- `idempotencyKey`
- `classificationLabel`
- `classificationScore`
- `classifiedAt`

## 4) Ordering and staleness rules

For every queue event:

- Queue handler forwards event metadata to agent; it does not do ordering logic.
- Agent `onUpload` compares incoming `eventTime` against stored `eventTime`.
- If older than current marker: no-op + `ack()`.
- If newer: upsert marker (`eventTime`, `idempotencyKey`) first.
- After marker upsert, reconcile workflow state to known state (agent tracking + workflow binding status) before any start.
- Start only after reconciliation confirms no active workflow for that marker.

For workflow completion:

- Completion must include expected marker (`idempotencyKey`).
- Before writing classification, re-check row marker still matches expected `idempotencyKey`.
- If marker mismatch, drop completion as stale (do not overwrite newer upload state).

`idempotencyKey` is the only authoritative stale-write guard.

## 5) Workflow launch/idempotency strategy

- Workflow ID = upload `idempotencyKey` (stable retry key).
- Call `runWorkflow(..., { id: idempotencyKey, metadata: ... })`.
- No manual writes to `cf_agents_workflows` (avoid coupling to SDK internals).
- Pre-start flow is reset-first:
  - always attempt cleanup via agent-tracked workflow APIs for the same `idempotencyKey`,
  - always query workflow binding ground truth for the same `idempotencyKey`,
  - always attempt to stop/terminate any active instance found at either layer,
  - only then start fresh workflow with same `idempotencyKey`.
- Use workflow binding status as ground truth when tracking and binding disagree.
- Keep `idempotencyKey` as authoritative row marker.
- Duplicate-ID create is treated as an invariant violation, not acceptable steady-state behavior:
  - do not silently continue,
  - fail the current queue attempt (no `ack()`) so retry path re-enters reconciliation-first flow.
- Rationale: `runWorkflow` create+tracking is non-atomic (`refs/agents/packages/agents/src/index.ts:1906`, `refs/agents/packages/agents/src/index.ts:1917`), so guards must not rely on tracking row alone.
- Local-dev policy is fail-fast:
  - if reset/control APIs throw local-dev `Not implemented`, rethrow,
  - allow queue retries to continue and eventually DLQ in local if unresolved,
  - no environment-specific fallback path in MVP.

## 6) Workflow definition changes

- Keep current approval workflow unchanged.
- Add a new workflow definition with classification payload (object identity + marker fields).
- Ensure external side effects (AI inference, result persistence callback) are wrapped in `step.do` (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:218`).
- Return durable classification result payload from workflow and propagate via `onWorkflowComplete`.

## 7) AI invocation path

- Use Workers AI with AI Gateway pattern already present in agent (`src/organization-agent.ts:265`).
- Model: `@cf/microsoft/resnet-50`.
- Store top-1 label + score only.

## 8) Queue consumer behavior

- Keep explicit per-message `ack()`.
- On validation failures (missing metadata, missing object): log + `ack()` (terminal for that message).
- On transient internal failures: do not `ack()` message so queue retries by default policy.

## 9) App/UI impact (planned)

- Upload page message schema currently expects approval-era workflow states (`src/routes/app.$organizationId.upload.tsx:44`).
- Workflow page is approval-specific (`src/routes/app.$organizationId.workflow.tsx:33`).
- Plan update:
  - introduce classification-centric workflow message types/status for upload/inspection surfaces.
  - keep `/app/$organizationId/workflow` for approval workflow.

## 10) Validation plan (no code yet)

- Duplicate queue delivery for same event => one durable classification write.
- Two uploads same `name` out of order notifications => newest marker wins.
- Old workflow completion arriving late => rejected as stale.
- `runWorkflow` partial-failure simulation (create succeeded, tracking insert failed) => next queue retry performs reconciliation first and restores known state before any start attempt.
- Local and production parity for queue flow (`src/routes/app.$organizationId.upload.tsx:90` local synthetic queue message path).
- AI/model failure => queue-level retry path (no `ack()`), not silent terminal success.

## MVP decisions locked

- Stale-write guard: `idempotencyKey` only.
- Ordering check location: agent `onUpload`, not queue handler.
- No direct writes to `cf_agents_workflows`.
- AI/model failure handling: retry at queue level (no `ack()`).
- Keep approval workflow and route as-is; add separate classification workflow + Wrangler binding.
- Persist classification by extending `Upload` table (no separate `UploadClassification` table in MVP).
- Local-dev workflow-control limitation handling: Option 1 fail-fast; no env-specific specialization.

## 11) Detailed implementation steps (for review)

### Phase 1: schema + message contracts

1. Update `Upload` table schema in `src/organization-agent.ts` constructor:
   - add columns: `eventTime`, `idempotencyKey`, `classificationLabel`, `classificationScore`, `classifiedAt`.
   - keep `name` as primary key.
   - no additive `alter table` migration logic in this pass (local schema reset baseline).

2. Add/adjust zod row schema in `src/organization-agent.ts` for typed upload rows returned to UI.
3. Expand websocket message union in `src/organization-agent.ts` and `src/routes/app.$organizationId.upload.tsx`:
   - keep approval messages unchanged.
   - add classification-specific events (`classification_workflow_started`, `classification_workflow_skipped`, `classification_updated`, `classification_error`).
4. Keep existing approval route and message handling untouched except type additions needed for shared union compile correctness.

### Phase 2: upload write path metadata

1. In `src/routes/app.$organizationId.upload.tsx` upload server fn:
   - generate `idempotencyKey` per upload (`crypto.randomUUID()`).
   - write to R2 `customMetadata` with `organizationId`, `name`, `idempotencyKey`.
2. Keep local synthetic queue send path, but include `idempotencyKey` and `eventTime` in message body so local behavior matches production queue contract.
3. Ensure returned mutation payload includes enough fields for optimistic UI message if needed.

### Phase 3: queue consumer -> agent handoff

1. Update queue handler in `src/worker.ts`:
   - continue `R2.head(object.key)`.
   - read `organizationId`, `name`, `idempotencyKey` from object custom metadata.
   - pass `{ name, eventTime, idempotencyKey }` to agent `onUpload`.
2. Validation handling:
   - missing `head` or metadata -> log and `ack()`.
   - unexpected runtime failure -> do not `ack()`.
3. Keep explicit per-message `ack()` only on successful terminal processing paths.

### Phase 4: new classification workflow class + binding

1. In `src/organization-agent.ts`:
   - keep current `OrganizationWorkflow` approval class unchanged.
   - add new class, e.g. `OrganizationImageClassificationWorkflow extends AgentWorkflow<...>`.
2. Classification workflow payload fields:
   - `idempotencyKey`, `r2ObjectKey`.

3. Workflow steps (all side effects in `step.do`):
   - fetch image bytes from R2 using `r2ObjectKey` from payload.

   - call Workers AI `@cf/microsoft/resnet-50` via gateway-enabled path.
   - select top-1 prediction.
   - callback to agent method to apply guarded classification write.
4. Export new workflow class from `src/worker.ts`.
5. Add workflow binding in `wrangler.jsonc` (local + production env blocks) and regenerate `worker-configuration.d.ts` via `pnpm typecheck`.

### Phase 5: onUpload orchestration + known-state reconciliation

1. Refactor `onUpload` in `src/organization-agent.ts` to accept `{ name, eventTime, idempotencyKey }`.
2. Implement ordering gate:
   - load row by `name`.
   - if incoming `eventTime` older than stored `eventTime`, broadcast skipped + return.
   - else upsert marker fields (`eventTime`, `idempotencyKey`).
3. Inline reset-first workflow cleanup directly in `onUpload` (no separate reconciliation helper function in MVP):
   - check agent tracking for `idempotencyKey` via agent workflow APIs.
   - attempt to stop/terminate tracked instance for that ID when present.
   - handle “not found / already terminal” as no-op.
   - handle local-dev workflow-control limitation explicitly:
     - Agents workflow control wrappers (`terminateWorkflow`/`pauseWorkflow`/`restartWorkflow`) are documented by the SDK as not implemented in local dev and throw `Not implemented` errors (`refs/agents/packages/agents/src/index.ts:2102`, `refs/agents/packages/agents/src/index.ts:2129`, `refs/agents/packages/agents/src/index.ts:2287`).
     - in local dev, when this occurs, treat as reset failure and throw so queue retry semantics apply (no `ack()`), with no fallback branch.

4. Query workflow binding ground truth for the same `idempotencyKey` (`env.<classification_binding>.get(id).status()`):
   - if instance exists and is active/waiting, attempt stop/terminate unconditionally.
   - if stop/terminate fails, treat as reset failure and throw (no `ack()`).
   - if already terminal/non-existent, continue.
5. After cleanup/reset pass, start classification workflow with explicit ID (`idempotencyKey`).
6. If start still fails with duplicate-ID or invariant breach:
   - treat as failure (throw), no `ack()` in queue path so message retries.
7. Add jsdoc on `onUpload` reset sequence in code:
   - explain why cleanup must always run in both layers (tracking + binding),
   - explain non-atomic `runWorkflow` create/tracking behavior,
   - explain why reset failures throw to trigger queue retry.

### Phase 6: guarded result apply path

1. Add callable/internal agent method for workflow completion apply, e.g. `applyClassificationResult`.
2. Input: `{ name, idempotencyKey, label, score, classifiedAt }`.
3. Guard:
   - read current row by `name`.
   - if row `idempotencyKey !== input.idempotencyKey`, drop as stale.
4. If guard passes, update:
   - `classificationLabel`, `classificationScore`, `classifiedAt`.
5. On workflow error callback (`onWorkflowError`):
   - emit classification error only if row `idempotencyKey` still matches workflow ID.

### Phase 7: workflow callbacks and status mapping

1. In `onWorkflowProgress`/`onWorkflowComplete`/`onWorkflowError`:
   - branch by workflow name so approval and classification signals remain separate.
2. Preserve approval callbacks for existing route behavior.
3. Add classification callback broadcasts used by upload/inspector views.
4. Update `getUploads()` query to return classification fields for UI.

### Phase 8: UI updates (minimal MVP)

1. `src/routes/app.$organizationId.upload.tsx`:
   - extend loader data typing to include classification fields.
   - render classification label/score per upload card.
   - wire new websocket message types to invalidate/refetch and message list formatting.
2. Leave `src/routes/app.$organizationId.workflow.tsx` approval UX unchanged.
3. Optional: small updates in `app.$organizationId.inspector.tsx` for status visibility if already workflow-centric.

### Phase 9: failure behavior + retries

1. Ensure queue consumer throws on transient classification/orchestration failures.
2. Do not emit terminal success messages when start/apply failed.
3. Rely on queue retry policy (`max_retries` + DLQ) already configured in `wrangler.jsonc`.
4. Ensure idempotent reprocessing:
   - repeated message for same marker does not produce duplicate final writes.

### Phase 10: verification checklist

1. Static checks:
   - `pnpm typecheck`
   - `pnpm lint`
2. Manual local flow:
   - upload image A as `name=x` -> classification appears.
   - upload new image B as same `name=x` -> classification replaced.
   - replay old message for A -> no overwrite.
3. Fault simulation:
   - force AI call error -> message not acked, retries observed.
   - simulate create/tracking inconsistency -> reconciliation prevents duplicate starts.
4. Regression:
   - approval workflow page still works (`requestApproval`, approve/reject/list unchanged).
