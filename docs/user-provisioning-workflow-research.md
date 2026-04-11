# User Provisioning via Cloudflare Workflows - Research

> Sibling doc: `user-create-after-hook-fault-tolerance-research.md` (queue-only approach). This revision keeps the workflow direction and applies the inline review annotations.

## TL;DR

Yes, the workflow direction is sound.

Final shape:

- Keep a durable queue backstop in `databaseHooks.user.create.before`, but use typed `enqueue(...)` from `src/lib/Q.ts:38` (not raw queue binding).
- Kick off provisioning in `databaseHooks.user.create.after` with `createBatch` via a shared helper, then return immediately (no waiting inside the auth hook).
- Use `user.id` as workflow instance id. Never email.
- Reuse the same `ensureUserProvisioningWorkflow` helper from the queue consumer (`EnsureUserProvisioning`) after resolving `email -> user`.
- Gate `/app` using D1 first (`owner org exists => done`), and only check workflow status for pending/error/restart behavior.

This preserves fast sign-in, gives durable recovery for the crash window between user-row write and after-hook kickoff, and avoids re-implementing Better Auth internals.

---

## 1) What is already true in this repo

- Current provisioning chain lives in `src/lib/Auth.ts:127-174` inside `databaseHooks.user.create.after`.
- Queue helper already exists and is typed: `enqueue` in `src/lib/Q.ts:38-41`.
- Workflows are already wired in this project via `InvoiceExtractionWorkflow` (`src/invoice-extraction-workflow.ts:35`, `src/worker.ts:25`, `wrangler.jsonc:45-51`).

So this is not a net-new platform bet. It is moving provisioning to the same runtime model already used for invoice extraction.

---

## 2) Cloudflare API facts that matter

From `refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx`:

- `create` throws if id already exists within retention (`:340`).
- `createBatch` is idempotent and skips existing ids (`:402`).
- `get` throws if instance does not exist (`:411`).
- `status()` is the external status API (`:471-575`).

From `refs/cloudflare-docs/src/content/docs/workflows/build/trigger-workflows.mdx:165-173`:

- `restart()` cancels in-flight work, clears intermediate state, and reruns from scratch.

From `refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx:35`:

- Completed instance retention is 3 days (Free) / 30 days (Paid).

These guarantees make `createBatch + get + status + restart` the correct primitive set for `ensureUserProvisioningWorkflow`.

---

## 3) Architecture (revised)

### 3.1 Lifecycle

1. `databaseHooks.user.create.before`
   - If role is `user`, call `enqueue({ action: "EnsureUserProvisioning", email })`.
   - This is the durable backstop before the user-row write.

2. Better Auth writes the user row.

3. `databaseHooks.user.create.after`
   - If role is `user`, call `ensureUserProvisioningWorkflow({ userId, email })`.
   - Return immediately. Do not wait for completion here.

4. Queue consumer receives `EnsureUserProvisioning`
   - Resolve `email -> user` from repository.
   - If no user row exists, ack and return.
   - Else call the same `ensureUserProvisioningWorkflow` helper.

5. `/app` gate
   - Server fn checks D1 for owner org first.
   - If present: complete.
   - If absent: inspect workflow status for pending/error and restart-on-error behavior.

### 3.2 Why this split is correct

- The auth hook stays narrow and fast.
- The queue gives durable recovery if the worker crashes after user-row commit but before workflow kickoff.
- The route gate is naturally retryable on each navigation/load.

---

## 4) Shared ensure helper

Use one helper from both after-hook and queue consumer:

```ts
const ensureUserProvisioningWorkflow = Effect.fn(
  "ensureUserProvisioningWorkflow",
)(function* ({ userId, email }: { userId: string; email: string }) {
  const env = yield* CloudflareEnv;
  const created = yield* Effect.tryPromise(() =>
    env.USER_PROVISIONING_WORKFLOW.createBatch([{ id: userId, params: { userId, email } }]),
  );
  if (created[0]) return created[0];

  const instance = yield* Effect.tryPromise(() =>
    env.USER_PROVISIONING_WORKFLOW.get(userId),
  );
  const snapshot = yield* Effect.tryPromise(() => instance.status());

  if (snapshot.status === "errored" || snapshot.status === "terminated") {
    yield* Effect.logWarning("userProvisioning.restart", {
      userId,
      previousStatus: snapshot.status,
      previousError: snapshot.error,
    });
    yield* Effect.tryPromise(() => instance.restart());
  }

  return instance;
});
```

Notes:

- `createBatch` gives idempotent kickoff.
- `restart` covers retained errored/terminated instances that would otherwise stay stuck.
- This helper is the only place that touches workflow start semantics.

---

## 5) Hook and queue changes

### 5.1 `databaseHooks.user.create.before`

Use the typed queue helper, not raw binding:

```ts
before: (user) =>
  runEffect(
    Effect.gen(function* () {
      if (user.role !== "user") return;
      yield* enqueue({ action: "EnsureUserProvisioning", email: user.email });
    }),
  ),
```

This directly addresses the annotation about type safety.

### 5.2 `databaseHooks.user.create.after`

Fire-and-forget ensure call only:

```ts
after: (user) =>
  runEffect(
    Effect.gen(function* () {
      if (user.role !== "user") return;
      yield* ensureUserProvisioningWorkflow({ userId: user.id, email: user.email });
    }),
  ),
```

No polling/waiting inside this hook.

### 5.3 Queue consumer

Add message schema + handler in `src/lib/Q.ts`:

```ts
const EnsureUserProvisioningQueueMessage = Schema.Struct({
  action: Schema.Literals(["EnsureUserProvisioning"]),
  email: Domain.User.fields.email,
});
```

Handler shape:

- `repository.getUser(email)`
- `Option.none` => ack and return
- else call `ensureUserProvisioningWorkflow`

Queue runtime layer must include `Repository.layer` (in addition to env/logger).

---

## 6) Do we need to poll workflow status?

Short answer: not for normal completion; mainly for error handling.

Recommended status function behavior:

1. Check D1 first via `getOwnerOrganizationByUserId`.
   - If present, return `complete` immediately.
2. Only if D1 is not ready, check workflow instance:
   - `get` not found => `queued`/`pending`.
   - `status === errored | terminated` => restart, return `running` (or `recovering`).
   - other statuses => return pending.

So workflow status is the control plane signal for restart and diagnostics; D1 is still the source of truth for "user is provisioned".

---

## 7) Workflow implementation approach

Use plain `WorkflowEntrypoint` (not `AgentWorkflow`) and keep effect-v4 idioms consistent with `src/invoice-extraction-workflow.ts:40-55`:

- Build runtime layer once inside `run`.
- For each step, execute effectful logic via `Effect.runPromiseWith(services)`.
- Keep step names deterministic.
- Keep step outputs JSON-serializable and small.

Core steps remain:

1. `ensure-organization` (includes half-write recovery path)
2. `initialize-active-organization-for-sessions`
3. `init-organization-agent`
4. `sync-membership`

---

## 8) Auth inside workflow (final decision)

Keep only Option A: build Auth in the workflow runtime and call `auth.api.createOrganization`.

Why this is the right choice:

- Avoids re-implementing Better Auth organization/member writes.
- Preserves Better Auth plugin behavior.
- Matches project architecture already using layered services.

Cost note from current code:

- `Stripe.layer` constructs a Stripe client object (`src/lib/Stripe.ts:28-31`), but no Stripe network request is made for `createOrganization` itself.
- Most cost is object/layer construction plus regular D1/DO calls during provisioning.
- Provisioning path is short; optimize only if observed latency says so.

---

## 9) Idempotency contract

| Surface | Idempotency mechanism |
|---|---|
| Workflow kickoff | `createBatch` skips existing ids within retention. |
| Existing failed instance | `status` + `restart` for `errored`/`terminated`. |
| Queue message | At-least-once safe; each delivery re-runs `ensureUserProvisioningWorkflow`. |
| `ensure-organization` | Read owner org first; if absent, call `createOrganization`; recover from half-write branch. |
| Session backfill | Existing repository method only fills missing `activeOrganizationId`. |
| DO init/sync | `setName` + membership sync are safe to re-run. |

---

## 10) Route gating plan

Current routes:

- `/app` auth gate in `src/routes/app.tsx:9-28`.
- `/app/` redirect based on `session.activeOrganizationId` in `src/routes/app.index.tsx:14-24`.

Recommended update:

- Add provisioning status server fn (D1-first logic above).
- If no active org, route to `/app/provisioning` and poll the server fn.
- On complete, navigate to `/app/$organizationId`.
- On repeated error, render a focused retry/support state.

Because provisioning is expected to be fast, this route should be a rare fallback path, not the common path.

---

## 11) Testing

Use `@cloudflare/vitest-pool-workers` workflow introspection APIs from `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx:238-414`:

- Happy path: sign-in trigger -> workflow reaches `complete`.
- Recovery path: force `ensure-organization` failure once -> verify eventual completion/retry behavior.
- Queue path: simulate before-hook enqueue with delayed user-row availability.

---

## 12) Implementation checklist

1. Add `src/user-provisioning-workflow.ts` (`WorkflowEntrypoint`).
2. Export it from `src/worker.ts`.
3. Add `USER_PROVISIONING_WORKFLOW` to local + production `wrangler.jsonc` workflow bindings.
4. Run `pnpm typecheck` to refresh generated env typing.
5. Add `ensureUserProvisioningWorkflow` (`createBatch + get/status + restart`).
6. Update `databaseHooks.user.create.before` to call `enqueue(EnsureUserProvisioning)`.
7. Update `databaseHooks.user.create.after` to call `ensureUserProvisioningWorkflow` only.
8. Extend `src/lib/Q.ts` schema/handler/runtime layer for `EnsureUserProvisioning`.
9. Add provisioning-status server fn (D1-first, workflow-status fallback).
10. Add `/app/provisioning` route and wire `/app` gating behavior.
11. Add workflow tests.
12. Run `pnpm typecheck` and `pnpm lint`.

---

## Final verdict

The research remains strong after these corrections:

- queue before-hook as durable start guarantee,
- workflow for step replay/idempotency/observability,
- after-hook kickoff without blocking,
- D1-first route gate with workflow-status fallback for restart.

That combination gives the best reliability-to-complexity ratio for this codebase.
