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

All broadcasts originate from `OrganizationAgent` (`src/organization-agent.ts`) via the `broadcastActivity` helper (L58-70), which wraps `agent.broadcast()` from the Cloudflare Agents SDK.

| Trigger | Text prefix | Level | Source line |
|---|---|---|---|
| `onInvoiceUpload` | `"Invoice uploaded: {fileName}"` | info | L187 |
| `createInvoice` | `"Invoice created"` | info | L223 |
| `updateInvoice` | `"Invoice updated: {name}"` | success | L259 |
| `softDeleteInvoice` | `"Invoice deleted"` | info | L318 |
| `saveExtraction` | `"Invoice extraction completed: {fileName}"` | success | L338 |
| `onWorkflowProgress` | Forwarded from workflow | varies | L357 |
| `onWorkflowError` | `"Invoice extraction failed: {fileName}"` | error | L374 |

The workflow (`InvoiceExtractionWorkflow`, `src/invoice-extraction-workflow.ts`) reports progress via `this.reportProgress()` which the Agent SDK routes to `onWorkflowProgress`, which then re-broadcasts as activity.

## Activity type system

### Single type: `ActivityMessage`

After simplification, `src/lib/Activity.ts` defines one schema and one type:

```ts
ActivityMessage = { createdAt: string, level: "info"|"success"|"error", text: string }
```

This is the wire format, the display type, and the cache type — no wrapping, no unwrapping.

### What was removed and why

**`ActivityEnvelope`** (`{ type: "activity", message: ActivityMessage }`) — the `type: "activity"` discriminator existed for future message types that never materialized. The Agents SDK handles state sync and RPC on separate internal channels, so user-land `onMessage` only receives `agent.broadcast()` messages. The envelope added wrap/unwrap ceremony with no benefit.

**`WorkflowProgress`** (`{ level, text }`) — existed as `ActivityMessage` minus `createdAt` because workflows don't set timestamps. But `broadcastActivity` always added `createdAt` anyway, so its input was always `{ level, text }`. Now expressed as `Pick<ActivityMessage, "level" | "text">` — no separate type needed.

**`ActivityLevel`** — was a shared schema (`Schema.Literals(["info", "success", "error"])`) used by both `ActivityMessageSchema` and `WorkflowProgressSchema`. With only one schema remaining, it's inlined.

### How the types flow now

**Path A: Direct agent method → broadcast**
```
broadcastActivity(agent, { level, text })     // Pick<ActivityMessage, "level" | "text">
  → adds createdAt → JSON.stringify            // ActivityMessage
  → agent.broadcast(string) → WebSocket
  → decodeActivityMessage(event)               // parse JSON, validate ActivityMessageSchema
  → ActivityMessage
```

**Path B: Workflow → agent → broadcast**
```
workflow.reportProgress({ level, text })       // Pick<ActivityMessage, "level" | "text">
  → Agent SDK RPC → onWorkflowProgress(unknown)
  → inline Schema.Struct validation            // unknown → { level, text }
  → broadcastActivity(this, result.value)      // same as Path A
```

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

`shouldInvalidateForInvoice` (Activity.ts L25-30) checks for these prefixes:
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
- **Single message type**: `ActivityMessage` serves as wire format, display type, and cache type — no envelope ceremony.

### Where it falls short

#### 1. String-based message discrimination is fragile — **decided: add `action` field**
`shouldInvalidateForInvoice` pattern-matches on `text.startsWith("Invoice uploaded:")` etc. Adding a new broadcast requires coordinating a string literal in the agent AND a prefix check on the client. A typo or missing colon (see "Invoice created" above) silently breaks invalidation.

**Plan**: Add a structured `action` literal field to `ActivityMessage`:
```ts
ActivityMessage = {
  createdAt: string,
  level: "info" | "success" | "error",
  text: string,
  action: "invoice.uploaded" | "invoice.created" | "invoice.updated"
        | "invoice.deleted" | "invoice.extraction.completed"
        | "invoice.extraction.failed" | "invoice.extraction.progress"
}
```
`shouldInvalidateForInvoice` becomes a `Set.has()` lookup on `action` — no string coordination, no silent misses. The "Invoice created" bug goes away automatically.

**Deferred: `entityId` field.** Adding `entityId?: string` would enable targeted single-invoice invalidation (`["organization", orgId, "invoice", entityId]`) instead of the current broad prefix match on `["organization", orgId, "invoice"]`. Not needed now — broad invalidation is fine at current scale. Revisit if invoice count grows or if single-invoice cache precision becomes valuable.

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

## Changes made

### Type simplification (this iteration)
- **Removed `ActivityEnvelope`**: `type: "activity"` discriminator was unused — no other message types exist. `broadcastActivity` now sends `ActivityMessage` directly as JSON.
- **Removed `WorkflowProgress`**: replaced with `Pick<ActivityMessage, "level" | "text">` in `InvoiceExtractionWorkflow` generic param and `broadcastActivity` input.
- **Removed `ActivityLevel`**: inlined into `ActivityMessageSchema`.
- **Simplified `decodeActivityMessage`**: decodes JSON directly to `ActivityMessage` — no envelope unwrap.
- **Inline validation in `onWorkflowProgress`**: `WorkflowProgressSchema` removed; uses inline `Schema.Struct` to validate `unknown` from SDK.

### Dead code removal (previous iteration)
- **`onStateUpdate` + `agentState` query key**: never consumed by any component.
- **`setState` from context**: never called by any consumer.
- **`invoiceItems` query key invalidation**: query key never used by any `useQuery`.

## Questions for iteration

1. ~~Should we adopt a structured `action` discriminator on the message, or keep string-matching and just fix the gaps?~~ **Decided: add `action` field. Defer `entityId` for future.**
2. Do we want server-side activity persistence (DO SQLite) so clients can hydrate history on reconnect?
3. Should mutations stop doing their own invalidation and defer entirely to broadcast? Or keep the dual path as a "fast path" optimization?
4. Do we need to handle WebSocket reconnect more explicitly (invalidate stale queries on `onOpen`)?
