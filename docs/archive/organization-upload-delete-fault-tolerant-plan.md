# Organization Upload Delete Plan (Fault-Tolerant)

## Goal

Allow users to delete uploaded images with the same reliability posture as current upload processing:

- async processing
- safe retries
- duplicate/out-of-order tolerance
- stale event protection

## Current baseline (from code)

1. Queue consumer only handles upload create events (`PutObject`) today.

```ts
if (notification.action !== "PutObject") {
  message.ack();
  continue;
}
```

Source: `src/worker.ts:154`

2. Upload rows are keyed by `name`; recency marker is `eventTime`; stale upload events are already skipped.

```ts
if (existing && eventTime < existing.eventTime) {
  return;
}
```

Source: `src/organization-agent.ts:290`

3. UI has upload flow/listing but no delete action.

Source: `src/routes/app.$organizationId.upload.tsx:64`, `src/routes/app.$organizationId.upload.tsx:319`

4. Queue retry config already exists (`max_retries: 3`, DLQ configured).

Source: `wrangler.jsonc:80`

## Research constraints (Cloudflare + Agents refs)

1. R2 emits delete events:
- `object-delete` is supported.
- trigger actions include `DeleteObject` and `LifecycleDeletion`.
- delete notifications omit `object.size`/`object.eTag`.

Source: `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:68`
Source: `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:101`

2. Queue delivery is at-least-once; duplicates must be expected.

Source: `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`

3. Explicit `ack()`/`retry()` is the intended per-message fault control.

Source: `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:63`
Source: `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:93`

4. Workflow side-effects outside `step.do` may repeat after engine restart.

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`

5. Agents `runWorkflow()` creates workflow, then writes tracking row (non-atomic sequence).

```ts
const instance = await workflow.create({ id: workflowId, params: augmentedParams });
this.sql`INSERT INTO cf_agents_workflows (...) VALUES (...)`;
```

Source: `refs/agents/packages/agents/src/index.ts:2233`
Source: `refs/agents/packages/agents/src/index.ts:2245`

6. Agents workflow terminate APIs are not supported in local dev.

Source: `refs/agents/packages/agents/src/index.ts:2458`

## Proposed design

## 1) Deletion model

Use R2 as source of truth, queue as durable processor, agent table as materialized projection.

Flow:

1. User requests delete.
2. Server deletes object from R2 (`env.R2.delete(key)`).
3. R2 emits `DeleteObject` notification to queue.
4. Queue calls `agent.onDelete(...)`.
5. Agent removes row only if delete event is not stale versus current `eventTime`.

Why:

- matches existing upload architecture (event-driven, retryable)
- avoids split-brain between direct UI mutation and queue-driven state
- naturally handles duplicate message delivery

## 2) Queue consumer changes (`src/worker.ts`)

Extend action handling from only `PutObject` to:

- `PutObject` (existing path, unchanged)
- `DeleteObject` and `LifecycleDeletion` (new path)

For delete actions:

1. Do not call `R2.head()` (object may already be gone).
2. Parse `{ organizationId, name }` from `object.key` (`${organizationId}/${name}`).
   - For R2 delete notifications, no custom metadata is available in the message payload. Key parsing is the practical source for routing to the correct organization agent.
   - Key format contract must remain `${organizationId}/${name}`.

3. Pass `{ name, eventTime, r2ObjectKey, action }` to new agent RPC `onDelete`.
4. `ack()` terminal validation failures.
5. `retry()` on transient failures.

## 3) Agent delete logic (`src/organization-agent.ts`)

Add callable/remote method:

`onDelete({ name, eventTime, r2ObjectKey, action })`

Behavior:

1. Parse `eventTime` to epoch; throw on invalid timestamp (queue retries).
2. Read `Upload` row by `name`.
3. If no row: no-op success.
4. If `eventTime < row.eventTime`: stale delete, no-op success.
5. Else delete row (single row by `name`).
6. Broadcast delete event message for UI invalidation.

Stale safety invariant:

- Newer upload wins over older delayed delete.
- Existing upload recency marker (`Upload.eventTime`) already supports this.
Workflow handling for delete:

- Single path for all environments:
  - attempt workflow termination if a related active workflow is found
  - wrap termination in `try/catch`
  - never throw from termination failures
  - continue delete flow in all cases
- Reason 1: correctness is preserved even when termination fails, because classification result write is guarded by `idempotencyKey` and becomes a no-op once row is deleted (`update ... where idempotencyKey = ?`).
- Reason 2: this avoids environment-specific branching while still allowing local dev (where terminate may be unsupported) to complete deletes.

Why `onUpload()` pattern is different:

- `onUpload()` must ensure a new classification workflow can start with a deterministic ID (`idempotencyKey`), so it performs active-workflow cleanup before `runWorkflow()`.
- That cleanup is part of "start-new-workflow correctness", not "data-delete correctness".
- Delete already reaches correct state by removing the row; classification callbacks after that are no-op by design (`update ... where idempotencyKey = ?`).
- So we can do similar termination mechanics as best-effort in the same unified path, not as a required success condition.

I agree that we can't let this block local dev. Take a look at onUpload(). It seems to have a way to terminate an existing workflow, if any. Can we do something similar? Analyze it carefully and tell me what you think.

## 4) API/UI delete entrypoint (`src/routes/app.$organizationId.upload.tsx`)

Add `deleteUpload` server fn:

1. validate org authorization (same pattern as upload fn)
2. `await env.R2.delete(\`${organizationId}/${name}\`)`
3. in local env, send synthetic queue message with:
   - `action: "DeleteObject"`
   - `object.key`
   - `eventTime: new Date().toISOString()`
4. return success payload

UI:

1. Add delete button per card.
2. Call mutation -> `deleteUpload`.
3. invalidate on success.
4. update websocket handler to invalidate on delete events from agent.

## 5) Message contract updates (`src/organization-messages.ts`)

Add new messages:

- `upload_deleted` (`name`, `eventTime`)
- `upload_delete_error` (`name`, `error`) optional if surfacing async failures

Current union has only upload/classification/approval events.

Source: `src/organization-messages.ts:3`

## 6) R2 notification rule update (ops)

Ensure bucket notification includes `object-delete` in addition to existing create rule.

Doc basis:

- object-delete event type exists and includes DeleteObject/LifecycleDeletion actions.

Source: `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:68`
Also update deployment docs to include this requirement (README deploy section).

## 7) Fault tolerance properties after change

1. Duplicate delete messages:
- safe (idempotent row delete by `name`).

2. Out-of-order events:
- older delete cannot remove newer upload (`eventTime` guard).

3. Worker/agent transient failure:
- queue `retry()` replays message.

4. Object already gone before processing:
- delete path does not require `head()`, so still converges.

5. Late classification completion after delete:
- already safe because classification write uses `where idempotencyKey = ?`; no row => no write.

Source: `src/organization-agent.ts:365`

## 8) Implementation phases

1. Queue + agent delete event handling.
2. Server delete endpoint + local synthetic delete message.
3. Message schema + UI button + UI invalidation wiring.
4. E2E + retry/staleness validation.
5. Optional follow-up: cleanup stale workflow tracking rows related to deleted uploads.

## 9) Validation matrix

1. Delete existing upload -> row removed.
2. Delete same name twice -> second is no-op.
3. Re-upload same name after delete, then delayed old delete event arrives -> upload remains.
4. Queue duplicate delete deliveries -> no duplicate side effects.
5. Queue consumer throws once then retries -> converges.
6. Local env synthetic delete message path mirrors production behavior.

## Decisions locked

1. Deletion mode: hard delete.
2. UX while classifying: immediate delete.
3. UI events: silent invalidate only (no message card event required).
4. Queue delete actions: handle both `DeleteObject` and `LifecycleDeletion` in the same delete path.
5. Local-dev behavior: delete path must succeed locally; therefore workflow termination cannot be a required step in MVP.
