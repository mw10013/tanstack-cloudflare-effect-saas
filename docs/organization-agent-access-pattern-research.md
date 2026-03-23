# Organization Agent Access Pattern Research

## Question

Can this app call the organization agent directly from the client via `useAgent().stub`, instead of going through TanStack Start `createServerFn` handlers like `deleteInvoice`?

Short answer: yes, technically. Not as a blanket replacement. The safer general pattern here is a hybrid:

- use one client agent connection per org route for realtime pushes, activity, progress, presence, and selected low-risk RPC
- keep server functions as the main authority boundary for session-sensitive reads/writes and anything involving secrets, signed URLs, or strict per-request auth

## Current Codebase Shape

The app already has the pieces for both paths.

`src/routes/app.$organizationId.tsx` opens one org-scoped agent connection and puts the stub in context:

```tsx
const agent = useAgent<OrganizationAgent, OrganizationAgentState>({
  agent: "organization-agent",
  name: organizationId,
  onMessage: (event) => { /* activity + invalidation */ },
  onStateUpdate: (state) => { /* cache state */ },
});

<OrganizationAgentProvider
  value={{
    call: agent.call,
    stub: agent.stub,
    setState: agent.setState,
    ready: agent.ready,
    identified: agent.identified,
  }}
/>
```

`src/routes/app.$organizationId.invoices.tsx` still routes invoice operations through server functions:

```tsx
const deleteInvoice = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(deleteInvoiceSchema))
  .handler(({ context: { runEffect }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        const validSession = yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
        );
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        yield* Effect.tryPromise(() => stub.softDeleteInvoice(data.invoiceId));
      }),
    ),
  );
```

`src/worker.ts` already protects agent connect/request routing:

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: async (req) => {
    const session = await runEffect(/* auth.getSession(req.headers) */);
    if (Option.isNone(session)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const agentName = extractAgentInstanceName(req);
    const activeOrganizationId = session.value.session.activeOrganizationId;
    if (!activeOrganizationId || agentName !== activeOrganizationId) {
      return new Response("Forbidden", { status: 403 });
    }
  },
  onBeforeRequest: async (req) => {
    // same active-organization check
  },
});
```

So the current app already does:

- websocket auth at the worker edge
- direct DO RPC inside the worker
- client agent connection in the org layout
- server functions as the main route/data/mutation API

## What The Docs Say

### Agents are Durable Objects with WebSocket RPC

Cloudflare Agents docs:

> "Each agent runs on a Durable Object ... with its own SQL database, WebSocket connections, and scheduling."

> "Methods marked with `@callable()` become typed RPC that clients can call directly over WebSocket."

Source: `refs/cloudflare-docs/src/content/docs/agents/index.mdx:31`, `refs/cloudflare-docs/src/content/docs/agents/index.mdx:72`

### `@callable()` is for external clients; worker code should use DO RPC directly

Agents callable docs:

> "The `@callable()` decorator is specifically for WebSocket-based RPC from external clients. When calling from within the same Worker or another agent, use standard Durable Object RPC directly."

Source: `refs/cloudflare-docs/src/content/docs/agents/api-reference/callable-methods.mdx:59`

And the Agents repo docs are even more direct:

> "DO RPC is more efficient for internal calls since it doesn't go through WebSocket serialization."

Source: `refs/agents/docs/callable-methods.md:509`

### Durable Objects are a good domain/coordination boundary

Durable Objects docs:

> "Each Durable Object is a single-threaded, globally-unique instance with its own persistent storage."

> "Workers are stateless functions ... A common pattern is to use Workers as the stateless entry point that routes requests to Durable Objects when coordination is needed. The Worker handles authentication, validation, and response formatting, while the Durable Object handles the stateful logic."

Source: `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx:10`, `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx:97`

This lines up well with this repo's current split: worker/server fn for auth and request context, organization agent for org-scoped stateful logic.

### `routeAgentRequest` hooks are the auth hook points

Agents routing docs:

> "These hooks are useful for authentication and validation."

Source: `refs/agents/docs/routing.md:295`

That validates the current `src/worker.ts` approach.

### But callable methods do not have request context

`getCurrentAgent()` docs show context availability:

| Invocation | `connection` | `request` |
| --- | --- | --- |
| `Custom method (via RPC)` | Yes | No |

Source: `refs/cloudflare-docs/src/content/docs/agents/api-reference/get-current-agent.mdx:232`

This is the key constraint. A websocket RPC method can see the current connection, but not the original request headers/cookies.

### Readonly is not a full authorization system

Readonly docs:

> "Only `this.setState()` is gated. A callable can still write to SQL, send emails, call external APIs, or do anything else."

> "The readonly check happens inside `this.setState()`, not at the start of the callable. If your method has side effects before the state write, those will still execute."

Source: `refs/agents/design/readonly-connections.md:174`, `refs/cloudflare-docs/src/content/docs/agents/api-reference/readonly-connections.mdx:500`

That matters a lot here because `OrganizationAgent` writes to SQLite via `OrganizationRepository`; it does not use `this.setState()` for invoice mutations.

### Same-origin cookie auth works for connect, but that is still connect-time auth

Cross-domain auth docs:

> "If the client and server share the origin, the browser will send cookies during the WebSocket handshake. Session based auth can work here."

Source: `refs/agents/docs/cross-domain-authentication.md:23`

That matches this repo: same-origin app, cookie-backed Better Auth session, worker checks it during websocket connect.

## The Real Security Difference

This is the core tradeoff.

### Server function path

Each mutation gets a fresh request boundary:

- cookies/headers are present
- `Auth.getSession(request.headers)` runs per call
- active org is checked per call
- env/secrets are available
- TanStack Start loader/query patterns remain simple

### Client WebSocket RPC path

Auth shifts from request-time to connection-time:

- the worker checks session when the socket connects
- later RPC calls run over the already-authorized connection
- the callable method has `connection`, but not `request`
- if the session is revoked, expires, or active org changes elsewhere, the existing socket may remain usable until disconnect/reconnect

So your concern is directionally right, but slightly more specific:

- it is not true that there are "no checks"
- there are checks at websocket connect in `src/worker.ts`
- there is not a built-in per-RPC session re-check like the current server function path gives you

## Why This Matters In This Repo

Some current operations naturally belong behind server functions.

### `getInvoices`

`src/routes/app.$organizationId.invoices.tsx` does more than fetch rows:

- checks active org from the request session
- in non-local env, signs R2 URLs using `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`

That is not a good direct-client-RPC candidate.

### `getInvoiceItems`

Less secret-heavy, but still currently depends on per-request org auth and fits the route loader/query model.

### `createInvoice` / `softDeleteInvoice`

These are technically possible over client RPC, but today they are not safe to move as-is because:

- `OrganizationAgent.createInvoice()` and `OrganizationAgent.softDeleteInvoice()` do not perform any authz checks
- readonly would not protect them because they mutate SQLite, not agent state
- current worker auth is connect-time, not per-call

## Pattern Options

## 1. Server functions for everything

Pros:

- strongest and simplest security story
- per-call auth remains obvious
- clean TanStack Start loaders/mutations
- easy access to env, request, cookies, secrets

Cons:

- does not use the existing websocket RPC path much
- extra worker hop for actions that could be low-latency client->agent
- duplicates some thin pass-through handlers

## 2. Client RPC for everything

Pros:

- fewer server function wrappers
- lower latency for some interactions
- one transport for reads/writes/realtime

Cons:

- weaker default auth posture in this app
- easy to accidentally expose SQL-writing methods without real authz
- harder to use TanStack loader/query patterns for canonical data
- secret-dependent operations still need a server path anyway

I would not recommend this for this codebase.

## 3. Hybrid control-plane / data-plane split

Recommended.

- **Control plane:** websocket agent connection from the org layout
- **Data plane:** server functions + loader/query for canonical reads/writes
- **Domain plane:** worker/server functions call the organization agent via DO RPC

This matches both the platform model and the current code.

## Recommended General Pattern

Use this as the default rule in the repo.

### 1. Keep one `useAgent()` in the org layout

Current direction is right:

- one connection per active org route
- put `stub`/`call` in context
- handle broadcasts/activity/invalidation centrally

This is a good fit for realtime behavior.

### 2. Keep TanStack Start server functions as the authority boundary

Use server functions for:

- mutations that require a valid current session on every call
- anything tied to active org membership/role checks
- anything that uses secrets, env, signed URLs, queues, or external credentials
- canonical data fetching used by loaders / `ensureQueryData` / React Query

This matches project guidance too:

> "Start loaders are isomorphic so generally create a server fn with server logic and call it from loader."

Source: `AGENTS.md:95`

### 3. Use direct client RPC only for explicitly connection-authorized operations

Good candidates:

- activity/presence/ephemeral commands
- local diagnostics like `getTestMessage()`
- realtime UX actions where connect-time auth is acceptable
- operations that do not require secrets and can tolerate reconnect-based auth refresh

Not good candidates by default:

- destructive mutations
- tenant-sensitive reads/writes without method-level authz
- anything that writes SQL unless the method checks connection-scoped permissions first

### 4. If you want client-side mutation RPC later, add explicit method-level authz

If the repo wants direct client RPC for writes in the future, I would only do it after adding a deliberate connection auth model:

- authenticate the connection in `onBeforeConnect` and/or `onConnect`
- derive per-connection claims like `organizationId`, `userId`, `role`, `canWrite`
- store those claims on the connection or otherwise make them available via `getCurrentAgent()`
- add a helper like `requireOrgWriteAccess()` and call it at the top of every SQL-writing callable
- do not rely on readonly alone for SQL-backed methods

For cross-origin or stronger revocation semantics, use short-lived signed tokens in `useAgent({ query: async () => ({ token }) })`, as the docs recommend for websocket auth.

## Concrete Recommendation For The Invoice Route

For `src/routes/app.$organizationId.invoices.tsx` specifically:

- keep `deleteInvoice` as a server function for now
- keep `createInvoice` as a server function for now
- keep `getInvoices` as a server function; it also signs R2 URLs
- keep `getInvoiceItems` as a server function unless there is a clear need to move it
- keep websocket agent usage for broadcasts/activity and cache invalidation

So the answer for delete is: viable in transport terms, not the best next move for the current security model.

## A Useful Mental Model

The cleanest framing for this repo is:

- **Durable Object / Agent** = per-organization actor and coordination engine
- **Worker + server functions** = auth boundary, request boundary, secret boundary
- **TanStack Query / loaders** = canonical UI data flow
- **WebSocket agent connection** = realtime subscription channel, plus carefully-selected RPC

That also lines up with Cloudflare Durable Objects docs and Effect's entity/RPC mental model: one per-entity sequential coordinator, with transport/auth decisions kept explicit at the edge.

Effect cluster docs describe entities similarly:

> "Entity handlers can keep in-memory state while the entity is active."

> "By default, messages are volatile and only sent over a network."

Source: `refs/effect4/ai-docs/src/80_cluster/10_entities.ts:29`, `refs/effect4/ai-docs/src/80_cluster/10_entities.ts:23`

Useful analogy, but Effect does not change the auth conclusion: RPC is a coordination primitive, not an authorization primitive.

## Proposed Default Rule For This Codebase

Use this unless a route has a strong reason to differ:

1. one `useAgent()` per org layout
2. websocket for pushes, presence, progress, targeted low-risk RPC
3. server functions for canonical reads/writes and all privileged operations
4. worker/server fn -> organization agent via DO RPC for domain logic
5. only expose direct client mutation RPC after adding explicit connection-scoped authz helpers

## Next Iteration If We Want To Explore Direct Mutation RPC

Smallest worthwhile spike:

1. define connection claims for org agent RPC (`userId`, `organizationId`, `canWrite`)
2. enforce them in a helper inside `src/organization-agent.ts`
3. add one non-secret write RPC behind that helper
4. compare UX/code complexity against the current server-fn path
5. only then revisit delete/create

My current recommendation: do not replace invoice delete with client RPC yet. Keep the hybrid pattern and make direct client RPC an explicit opt-in for methods designed around connection-scoped authorization.
