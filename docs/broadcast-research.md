# Broadcast Messages: Research & Analysis

## Architecture Overview

```
R2 Upload → Queue → Worker.queue() → OrganizationAgent.onInvoiceUpload()
                                            ↓
Client RPC (stub.createInvoice, etc.) → OrganizationAgent @callable methods
                                            ↓
                                      broadcastActivity()
                                            ↓
                                      agent.broadcast(JSON)
                                            ↓
                                    WebSocket to all clients
                                            ↓
                              useAgent onMessage → decodeActivityMessage()
                                    ↓                        ↓
                        setQueryData(activity)    invalidateQueries(invoices)
```

## Where broadcasts originate

All broadcasts originate from `OrganizationAgent` (`src/organization-agent.ts`) via the `broadcastActivity` helper (L59-74), which wraps `agent.broadcast()` from the Cloudflare Agents SDK.

| Trigger | Text prefix | Level | Source line |
|---|---|---|---|
| `onInvoiceUpload` | `"Invoice uploaded: {fileName}"` | info | L190 |
| `createInvoice` | `"Invoice created"` | info | L226 |
| `updateInvoice` | `"Invoice updated: {name}"` | success | L262 |
| `softDeleteInvoice` | `"Invoice deleted"` | info | L321 |
| `saveExtraction` | `"Invoice extraction completed: {fileName}"` | success | L341 |
| `onWorkflowProgress` | Forwarded from workflow | varies | L360 |
| `onWorkflowError` | `"Invoice extraction failed: {fileName}"` | error | L377 |

The workflow itself (`InvoiceExtractionWorkflow`, `src/invoice-extraction-workflow.ts`) reports progress via `this.reportProgress()` which the Agent SDK routes to `onWorkflowProgress`, which then re-broadcasts as activity.

## Activity type system: current implementation

### The three types and why they exist

`src/lib/Activity.ts` defines three schemas and three types:

```ts
// 1. What the client displays in the activity feed
ActivityMessage  = { createdAt: string, level: "info"|"success"|"error", text: string }

// 2. What the workflow sends via this.reportProgress()
WorkflowProgress = { level: "info"|"success"|"error", text: string }

// 3. What goes over the WebSocket wire
ActivityEnvelope = { type: "activity", message: ActivityMessage }
```

**Why `WorkflowProgress` exists separately from `ActivityMessage`:**
The Agents SDK's `AgentWorkflow<Agent, Params, ProgressType>` has a typed `reportProgress(progress: ProgressType)` method. The third generic param constrains what the workflow can send. `onWorkflowProgress` on the Agent side receives `progress: unknown` — we validate it with `Schema.decodeUnknownExit(WorkflowProgressSchema)`. `WorkflowProgress` is `ActivityMessage` minus `createdAt` because the workflow doesn't know when the message will be broadcast — the agent adds `createdAt` at broadcast time inside `broadcastActivity`.

**Why `ActivityEnvelope` wraps `ActivityMessage`:**
The `type: "activity"` field was added to discriminate from other potential WebSocket message types. In practice `type` is always `"activity"` — there are no other message types. The Agents SDK uses its own internal message types for state sync (handled by `onStateUpdate`) and RPC responses (handled by the `stub` proxy), so user-land `onMessage` only receives messages sent via `agent.broadcast()`.

### How the types flow through the system

**Path A: Direct agent method → broadcast**
```
broadcastActivity(agent, { level, text })  // input is WorkflowProgress shape
  → adds createdAt, wraps in { type: "activity", message: {...} }  // becomes ActivityEnvelope
  → JSON.stringify → agent.broadcast(string)
  → WebSocket → client onMessage
  → decodeActivityMessage(event)  // parses JSON, validates ActivityEnvelopeSchema
  → returns ActivityMessage (the .message field)
```

**Path B: Workflow → agent → broadcast**
```
workflow.reportProgress({ level, text })  // typed as WorkflowProgress
  → Agent SDK RPC → onWorkflowProgress(name, id, progress: unknown)
  → Schema.decodeUnknownExit(WorkflowProgressSchema)(progress)  // validate unknown → WorkflowProgress
  → broadcastActivity(this, message.value)  // same as Path A from here
```

### What's redundant

1. **`ActivityEnvelope` exists only to add `type: "activity"`** — a discriminator for message types that don't exist. Every `agent.broadcast()` call goes through `broadcastActivity`, which always sets `type: "activity"`. On the client, `decodeActivityMessage` validates the envelope then immediately unwraps it, discarding `type`.

2. **`WorkflowProgress` is structurally `ActivityMessage` minus `createdAt`** — it exists because (a) workflows shouldn't set timestamps and (b) the Agent SDK needs a type param for `reportProgress`. But `broadcastActivity` already accepts `{ level, text }` — the same shape — so `WorkflowProgress` just duplicates that input type.

3. **`ActivityLevel` is defined but only used inline** — `Schema.Literals(["info", "success", "error"])` is used twice (in `ActivityMessageSchema` and `WorkflowProgressSchema`) but could be a single shared field.

### The complexity cost

- 3 schemas (`ActivityMessageSchema`, `WorkflowProgressSchema`, `ActivityEnvelopeSchema`)
- 3 types (`ActivityMessage`, `WorkflowProgress`, `ActivityEnvelope`)
- 1 decoder (`decodeActivityMessage`) that wraps/unwraps the envelope
- `broadcastActivity` manually constructs the envelope with `satisfies ActivityEnvelope`
- `onWorkflowProgress` validates `unknown` against `WorkflowProgressSchema` then passes to `broadcastActivity` which re-wraps it in `ActivityEnvelope`

## Proposed simplification: single `BroadcastMessage` type

Collapse to one schema that serves as both the wire format and the client display type:

```ts
export const BroadcastMessageSchema = Schema.Struct({
  createdAt: Schema.String,
  level: Schema.Literals(["info", "success", "error"]),
  text: Schema.String,
});
export type BroadcastMessage = typeof BroadcastMessageSchema.Type;
```

### Why we can drop `ActivityEnvelope`

The `type: "activity"` discriminator serves no purpose because:
- `agent.broadcast()` is the only source of user-land WebSocket messages
- The Agents SDK handles state sync and RPC on separate internal channels
- If we ever need a second message type, we can add a discriminated union then — YAGNI

Without the envelope, `broadcastActivity` sends `BroadcastMessage` directly as JSON. On the client, `decodeActivityMessage` validates against `BroadcastMessageSchema` directly — no unwrapping.

### Why we can drop `WorkflowProgress` as a separate type

`WorkflowProgress = { level, text }` exists because the workflow doesn't set `createdAt`. But `broadcastActivity` already adds `createdAt` — the input to `broadcastActivity` has always been `{ level, text }`, never `ActivityMessage`. We can express this with `Omit<BroadcastMessage, "createdAt">` or `Pick<BroadcastMessage, "level" | "text">` — no need for a separate schema/type.

For the `AgentWorkflow` generic param, use `Pick<BroadcastMessage, "level" | "text">` directly:

```ts
export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  Pick<BroadcastMessage, "level" | "text">
> { ... }
```

### Simplified `broadcastActivity`

```ts
const broadcastActivity = (
  agent: OrganizationAgent,
  input: Pick<BroadcastMessage, "level" | "text">,
) =>
  Effect.sync(() => {
    agent.broadcast(
      JSON.stringify({
        createdAt: new Date().toISOString(),
        level: input.level,
        text: input.text,
      } satisfies BroadcastMessage),
    );
  });
```

### Simplified `decodeBroadcastMessage`

```ts
export const decodeBroadcastMessage = (
  event: MessageEvent,
): BroadcastMessage | null => {
  const result = Schema.decodeUnknownExit(
    Schema.fromJsonString(BroadcastMessageSchema),
  )(String(event.data));
  return Exit.isSuccess(result) ? result.value : null;
};
```

### Simplified `onWorkflowProgress`

`WorkflowProgressSchema` can stay as a validation schema for the `unknown` input from the SDK, but it doesn't need its own type export. Or we can inline the validation using `BroadcastMessageSchema.pick("level", "text")` — but Effect Schema `pick` isn't a thing. Simplest: keep a small validation schema for the `unknown` → `{ level, text }` decode in `onWorkflowProgress`, but don't export a separate type.

### What changes and what stays

| Before | After | Notes |
|---|---|---|
| `ActivityEnvelopeSchema` | removed | No envelope needed |
| `ActivityEnvelope` type | removed | |
| `ActivityMessageSchema` | `BroadcastMessageSchema` | Same shape, better name |
| `ActivityMessage` type | `BroadcastMessage` type | |
| `WorkflowProgressSchema` | kept (internal) | Still needed to validate `unknown` from SDK |
| `WorkflowProgress` type | removed as export | Use `Pick<BroadcastMessage, "level" \| "text">` |
| `decodeActivityMessage` | `decodeBroadcastMessage` | No envelope unwrap |
| `activityQueryKey` | `broadcastQueryKey` or keep | Naming choice |
| `shouldInvalidateForInvoice` | unchanged | Separate concern |

## Do broadcasts trigger query invalidation?

**Yes.** In `src/routes/app.$organizationId.tsx` L120-136:

```ts
onMessage: (event) => {
  const message = decodeActivityMessage(event);
  if (!message) return;
  queryClient.setQueryData(activityQueryKey(organizationId), ...);
  if (shouldInvalidateForInvoice(message.text)) {
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoices"] });
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoice"] });
  }
}
```

`shouldInvalidateForInvoice` (Activity.ts L38-42) checks for these prefixes:
- `"Invoice uploaded:"`
- `"Invoice extraction completed:"`
- `"Invoice extraction failed:"`
- `"Invoice updated:"`
- `"Invoice deleted"`

**Notable:** `"Invoice created"` does NOT trigger invalidation via broadcast. The `createInvoiceMutation.onSuccess` handles it locally instead.

## Dual invalidation: broadcast + mutation onSuccess

| Action | Mutation onSuccess invalidation | Broadcast invalidation |
|---|---|---|
| Upload invoice | `invoicesQueryKey` (invoices.index L107) | `shouldInvalidateForInvoice("Invoice uploaded:")` → yes |
| Create invoice | `invoicesQueryKey` (invoices.index L117) | `shouldInvalidateForInvoice("Invoice created")` → **no** (no match) |
| Update invoice | `invoicesQueryKey` (invoices.$invoiceId L166) | `shouldInvalidateForInvoice("Invoice updated:")` → yes |
| Delete invoice | **none** | `shouldInvalidateForInvoice("Invoice deleted")` → yes |
| Extraction complete | n/a (server-initiated) | yes |

**Issues:**
1. Upload and update invoke double-invalidation for the initiating client — once from mutation `onSuccess` and again from broadcast `onMessage`. Harmless but wasteful.
2. `softDeleteInvoiceMutation` has no `onSuccess` invalidation — relies entirely on broadcast. If WebSocket disconnects briefly, UI won't reflect the delete until manual refresh.
3. `"Invoice created"` misses broadcast invalidation entirely — not in the `shouldInvalidateForInvoice` list. Other connected clients won't see the new invoice until their next query refetch.

## Activity feed implementation

`ActivityFeed` (`app.$organizationId.tsx` L299-341) uses a TanStack Query with `staleTime: Infinity` and a no-op `queryFn: () => []`. Data is injected purely via `setQueryData` in the `onMessage` handler. Client-only, ephemeral — resets on page refresh.

## Agent connection & auth

1. `useAgent` connects via PartySocket (WebSocket) to `/agents/organization-agent/{organizationId}`
2. `routeAgentRequest` in `worker.ts` L240 intercepts this before TanStack Start's server entry
3. Auth checked in `onBeforeConnect` / `onBeforeRequest` via `authorizeAgentRequest` (worker.ts L207-222): validates session, checks `activeOrganizationId === agentName`, injects `x-organization-agent-user-id` header
4. `OrganizationAgent.onConnect` (L138-148) reads that header and sets connection state

## Agent context surface

`OrganizationAgentContext` (`src/lib/OrganizationAgentContext.tsx`) exposes `{ call, stub, ready, identified }` from `useAgent`. Consumer components use `stub` for typed RPC. `OrganizationAgentState` and `initialState` remain in `organization-agent.ts` because the `Agent<Env, State>` base class requires a state type parameter, even though agent state is not consumed on the client.

## Analysis: functional / idiomatic patterns

### What's good

- **`broadcastActivity` as an Effect**: wrapping `agent.broadcast()` in `Effect.sync` composes cleanly inside `Effect.gen` pipelines.
- **Schema-driven message decoding**: `decodeActivityMessage` uses `Schema.fromJsonString` composed with `Schema.decodeUnknownExit` — total function, no try/catch, no type assertion.
- **Centralized broadcast helper**: single `broadcastActivity` function, consistent shape, every broadcast goes through it.
- **Query key factories**: `activityQueryKey`, `invoicesQueryKey`, `invoiceQueryKey` in dedicated modules — consistent, refactor-friendly.
- **Agent SDK integration**: `useAgent` + `@callable()` gives typed RPC with automatic WebSocket lifecycle. Clean separation of transport from domain logic.

### Where it falls short

#### 1. String-based message discrimination is fragile
`shouldInvalidateForInvoice` pattern-matches on `text.startsWith("Invoice uploaded:")` etc. Adding a new broadcast requires coordinating a string literal in the agent AND a prefix check on the client. A typo or missing colon (see "Invoice created" above) silently breaks invalidation.

**Alternative**: Add a structured `action` field to `BroadcastMessage`:
```ts
BroadcastMessage = {
  createdAt: string,
  level: "info" | "success" | "error",
  text: string,
  action: "invoice.uploaded" | "invoice.created" | ...
  entityId?: string
}
```
Then `shouldInvalidateForInvoice` becomes a set lookup on `action`, and targeted single-invoice invalidation becomes possible.

#### 2. Broadcast is fire-and-forget with no delivery guarantee
`agent.broadcast()` sends to all currently-connected WebSockets. If a client is disconnected during extraction, it misses the completion broadcast and the invoice stays in "extracting" state until manual refresh.

**Mitigations to consider**:
- Use `useAgent`'s `onOpen` to trigger `queryClient.invalidateQueries()` for stale-prone keys on reconnect
- Persist recent activity server-side (in DO SQLite) and hydrate on connect

#### 3. Dual invalidation is uncoordinated
The initiating client gets two invalidations for upload/update: one from mutation `onSuccess`, one from broadcast.

**Principled approach**: mutations should NOT invalidate — let broadcast be the single source of truth for cache freshness. The mutation `onSuccess` handles optimistic UI updates (navigate, select) only.

Exception: `createInvoice` doesn't broadcast an invalidation-triggering message. Fix: make "Invoice created" trigger invalidation too.

#### 4. `broadcastActivity` takes `this` (agent instance) as an argument
Every call site does `yield* broadcastActivity(this, { ... })`. Could be a method on `OrganizationAgent` for cleaner `this` binding.

#### 5. `OrganizationAgentContext` exposes transport primitives
`useOrganizationAgent()` returns raw WebSocket/RPC primitives. A domain-oriented hook like `useInvoiceActions()` would encapsulate RPC calls and handle error normalization, loading states, and invalidation.

#### 6. No backpressure or deduplication on rapid broadcasts
During batch upload, each file triggers its own broadcast and invalidation. TanStack Query deduplicates concurrent fetches, but the activity feed could flood.

## Reference material consulted

- **Agents SDK**: `refs/agents/packages/agents/src/workflows.ts` L62-67 — `AgentWorkflow<Agent, Params, ProgressType>` generic, `reportProgress(progress: ProgressType)` L368
- **Agents SDK**: `refs/agents/packages/agents/src/index.ts` L4190-4198 — `onWorkflowProgress(name, id, progress: unknown)` receives untyped progress
- **Agents SDK**: `refs/agents/docs/client-sdk.md` — `useAgent` hook, `onMessage`, RPC via `stub`
- **Agents SDK**: `refs/agents/docs/state.md` — state sync, `broadcast()` — state sync uses separate internal channel, not `onMessage`
- **Cloudflare Docs**: `refs/cloudflare-docs/.../durable-objects/best-practices/websockets.mdx` — WebSocket hibernation, broadcast patterns
- **Effect v4**: `refs/effect4/ai-docs/src/01_effect/06_pubsub/` — PubSub for fan-out (not used; could be relevant)

## Dead code removed

- **`onStateUpdate` + `agentState` query key**: never consumed by any component. Removed.
- **`setState` from context**: never called by any consumer. Removed.
- **`invoiceItems` query key invalidation**: query key never used by any `useQuery`. Removed.

## Questions for iteration

1. Should we adopt a structured `action` discriminator on the message, or keep string-matching and just fix the gaps?
2. Do we want server-side activity persistence (DO SQLite) so clients can hydrate history on reconnect?
3. Should mutations stop doing their own invalidation and defer entirely to broadcast? Or keep the dual path as a "fast path" optimization?
4. Do we need to handle WebSocket reconnect more explicitly (invalidate stale queries on `onOpen`)?
5. Naming: `BroadcastMessage` or something else? `broadcastQueryKey` or keep `activityQueryKey`?
