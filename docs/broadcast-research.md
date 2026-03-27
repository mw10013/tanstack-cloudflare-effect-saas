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

All broadcasts originate from `OrganizationAgent` (`src/organization-agent.ts`) via the `broadcastActivity` helper, which wraps `agent.broadcast()` from the Cloudflare Agents SDK.

| Trigger | Action | Text | Level |
|---|---|---|---|
| `onInvoiceUpload` | `invoice.uploaded` | `"Invoice uploaded: {fileName}"` | info |
| `createInvoice` | `invoice.created` | `"Invoice created"` | info |
| `updateInvoice` | `invoice.updated` | `"Invoice updated: {name}"` | success |
| `softDeleteInvoice` | `invoice.deleted` | `"Invoice deleted"` | info |
| `saveExtraction` | `invoice.extraction.completed` | `"Invoice extraction completed: {fileName}"` | success |
| `onWorkflowProgress` | Forwarded from workflow | Forwarded from workflow | varies |
| `onWorkflowError` | `invoice.extraction.failed` | `"Invoice extraction failed: {fileName}"` | error |

The workflow (`InvoiceExtractionWorkflow`, `src/invoice-extraction-workflow.ts`) reports progress via `this.reportProgress()` which the Agent SDK routes to `onWorkflowProgress`, which then re-broadcasts as activity.

## Activity type system

### `ActivityMessage`

`src/lib/Activity.ts` defines one schema and one type:

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

Wire format, display type, and cache type — no wrapping, no unwrapping. The `action` field is a structured discriminator used for query invalidation decisions. The `text` field is human-readable, used only for display in the activity feed.

### How the types flow

**Path A: Direct agent method → broadcast**
```
broadcastActivity(agent, { action, level, text })  // Pick<ActivityMessage, "action" | "level" | "text">
  → adds createdAt → JSON.stringify                 // ActivityMessage
  → agent.broadcast(string) → WebSocket
  → decodeActivityMessage(event)                    // parse JSON, validate ActivityMessageSchema
  → ActivityMessage
```

**Path B: Workflow → agent → broadcast**
```
workflow.reportProgress({ action, level, text })    // Pick<ActivityMessage, "action" | "level" | "text">
  → Agent SDK RPC → onWorkflowProgress(unknown)
  → inline Schema.Struct validation                 // unknown → { action, level, text }
  → broadcastActivity(this, result.value)           // same as Path A
```

## Query invalidation

In `src/routes/app.$organizationId.tsx`:

```ts
onMessage: (event) => {
  const message = decodeActivityMessage(event);
  if (!message) return;
  queryClient.setQueryData(activityQueryKey(organizationId), ...);
  if (shouldInvalidateForInvoice(message.action)) {
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoices"] });
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoice"] });
  }
}
```

`shouldInvalidateForInvoice` (`Activity.ts`) is a `Set.has()` lookup on `action`. All invoice-mutating actions trigger invalidation except `invoice.extraction.progress`.

### Dual invalidation: broadcast + mutation onSuccess

| Action | Mutation onSuccess invalidation | Broadcast invalidation |
|---|---|---|
| Upload invoice | `invoicesQueryKey` | yes |
| Create invoice | `invoicesQueryKey` | yes |
| Update invoice | `invoicesQueryKey` | yes |
| Delete invoice | **none** | yes |
| Extraction complete | n/a (server-initiated) | yes |

**Issues:**
1. Upload and update invoke double-invalidation for the initiating client — once from mutation `onSuccess` and again from broadcast `onMessage`. Harmless but wasteful.
2. `softDeleteInvoiceMutation` has no `onSuccess` invalidation — relies entirely on broadcast. If WebSocket disconnects briefly, UI won't reflect the delete until manual refresh.

## Activity feed implementation

`ActivityFeed` (`app.$organizationId.tsx`) uses a TanStack Query with `staleTime: Infinity` and a no-op `queryFn: () => []`. Data is injected purely via `setQueryData` in the `onMessage` handler. Client-only, ephemeral — resets on page refresh.

## Agent connection & auth

1. `useAgent` connects via PartySocket (WebSocket) to `/agents/organization-agent/{organizationId}`
2. `routeAgentRequest` in `worker.ts` intercepts this before TanStack Start's server entry
3. Auth checked in `onBeforeConnect` / `onBeforeRequest` via `authorizeAgentRequest`: validates session, checks `activeOrganizationId === agentName`, injects `x-organization-agent-user-id` header
4. `OrganizationAgent.onConnect` reads that header and sets connection state

## Agent context surface

`OrganizationAgentContext` (`src/lib/OrganizationAgentContext.tsx`) exposes `{ call, stub, ready, identified }` from `useAgent`. Consumer components use `stub` for typed RPC. `OrganizationAgentState` and `initialState` remain in `organization-agent.ts` because the `Agent<Env, State>` base class requires a state type parameter, even though agent state is not consumed on the client.

## Analysis

### What's good

- **`broadcastActivity` as an Effect**: wrapping `agent.broadcast()` in `Effect.sync` composes cleanly inside `Effect.gen` pipelines.
- **Schema-driven message decoding**: `decodeActivityMessage` uses `Schema.fromJsonString` composed with `Schema.decodeUnknownExit` — total function, no try/catch, no type assertion.
- **Centralized broadcast helper**: single `broadcastActivity` function, consistent shape, every broadcast goes through it.
- **Query key factories**: `activityQueryKey`, `invoicesQueryKey`, `invoiceQueryKey` in dedicated modules — consistent, refactor-friendly.
- **Agent SDK integration**: `useAgent` + `@callable()` gives typed RPC with automatic WebSocket lifecycle. Clean separation of transport from domain logic.
- **Single message type**: `ActivityMessage` serves as wire format, display type, and cache type — no envelope ceremony.
- **Structured `action` field**: invalidation decisions are a `Set.has()` lookup — no string-prefix matching, no silent misses from typos.

### Where it falls short

#### 1. Broadcast is fire-and-forget with no delivery guarantee
`agent.broadcast()` sends to all currently-connected WebSockets. If a client is disconnected during extraction, it misses the completion broadcast and the invoice stays in "extracting" state until manual refresh.

**Mitigations to consider**:
- Use `useAgent`'s `onOpen` to trigger `queryClient.invalidateQueries()` for stale-prone keys on reconnect
- Persist recent activity server-side (in DO SQLite) and hydrate on connect

#### 2. Dual invalidation is uncoordinated
The initiating client gets two invalidations for upload/update: one from mutation `onSuccess`, one from broadcast.

**Principled approach**: mutations should NOT invalidate — let broadcast be the single source of truth for cache freshness. The mutation `onSuccess` handles optimistic UI updates (navigate, select) only.

#### 3. `broadcastActivity` takes `this` (agent instance) as an argument
Every call site does `yield* broadcastActivity(this, { ... })`. Could be a method on `OrganizationAgent` for cleaner `this` binding.

#### 4. `OrganizationAgentContext` exposes transport primitives
`useOrganizationAgent()` returns raw WebSocket/RPC primitives. A domain-oriented hook like `useInvoiceActions()` would encapsulate RPC calls and handle error normalization, loading states, and invalidation.

#### 5. No backpressure or deduplication on rapid broadcasts
During batch upload, each file triggers its own broadcast and invalidation. TanStack Query deduplicates concurrent fetches, but the activity feed could flood.

#### 6. Deferred: `entityId` for targeted invalidation
Adding `entityId?: string` to `ActivityMessage` would enable targeted single-invoice invalidation (`["organization", orgId, "invoice", entityId]`) instead of the current broad prefix match on `["organization", orgId, "invoice"]`. Not needed at current scale — broad invalidation is fine. Revisit if invoice count grows or if single-invoice cache precision becomes valuable.

## Open questions

1. Do we want server-side activity persistence (DO SQLite) so clients can hydrate history on reconnect?
2. Should mutations stop doing their own invalidation and defer entirely to broadcast? Or keep the dual path as a "fast path" optimization?
3. Do we need to handle WebSocket reconnect more explicitly (invalidate stale queries on `onOpen`)?

## Reference material consulted

- **Agents SDK**: `refs/agents/packages/agents/src/workflows.ts` — `AgentWorkflow<Agent, Params, ProgressType>` generic, `reportProgress(progress: ProgressType)`
- **Agents SDK**: `refs/agents/packages/agents/src/index.ts` — `onWorkflowProgress(name, id, progress: unknown)` receives untyped progress
- **Agents SDK**: `refs/agents/docs/client-sdk.md` — `useAgent` hook, `onMessage`, RPC via `stub`
- **Agents SDK**: `refs/agents/docs/state.md` — state sync, `broadcast()` — state sync uses separate internal channel, not `onMessage`
- **Cloudflare Docs**: `refs/cloudflare-docs/.../durable-objects/best-practices/websockets.mdx` — WebSocket hibernation, broadcast patterns
