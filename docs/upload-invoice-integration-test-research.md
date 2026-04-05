# Upload Invoice Integration Test Research

## Goal

Design integration tests for `OrganizationAgent.uploadInvoice()` — the `@callable()` method that uploads a file to R2, optionally queues an R2 event notification, and inserts a DB row with status "uploading".

---

## uploadInvoice Flow

From `src/organization-agent.ts:278-336`:

```
1. Schema.decodeUnknownEffect(UploadInvoiceInput)(input)
2. getConnectionIdentity()           ← requires Agent connection context
3. Config.number("INVOICE_LIMIT")    ← from ConfigProvider (env vars)
4. repo.countInvoices()              ← DO SQLite
5. Validate base64 size              ← MAX_BASE64_SIZE check
6. Validate contentType              ← invoiceMimeTypes whitelist
7. Generate invoiceId + idempotencyKey
8. R2.put(key, bytes, options)       ← R2 upload with custom metadata
9. If ENVIRONMENT === "local":
   env.Q.send(r2EventNotification)  ← Queue send (simulates R2 event notification)
10. repo.insertUploadingInvoice()    ← DO SQLite insert
11. Return { invoiceId }
```

### Dependencies

| Dependency | Source | Test Availability |
|---|---|---|
| `UploadInvoiceInput` schema decode | `@/lib/OrganizationAgentSchemas` | Pure — works anywhere |
| `getConnectionIdentity()` | `getCurrentAgent()` from `agents` SDK | **Requires WebSocket connection context** |
| `Config.number("INVOICE_LIMIT")` | `ConfigProvider.fromUnknown(env)` | Via wrangler.jsonc vars |
| `OrganizationRepository` | `SqliteClient.layer` from DO SQLite | Via `runInDurableObject` |
| `R2.put` | `R2` service ← `CloudflareEnv` | Miniflare R2 binding available in vitest |
| `env.Q.send` | Queue producer binding | Miniflare queue binding available in vitest |
| `broadcastActivity` | `agent.broadcast()` WebSocket method | Only inside Agent context |

---

## The `getConnectionIdentity` Problem

`uploadInvoice` calls `getConnectionIdentity()` (line 283), which uses `getCurrentAgent()`:

```ts
const getConnectionIdentity = Effect.fn("OrganizationAgent.getConnectionIdentity")(
  function* () {
    const { agent, connection } = getCurrentAgent<OrganizationAgent>();
    const identity = connection?.state as OrganizationAgentConnectionState | null | undefined;
    if (!agent || !identity?.userId) {
      return yield* new OrganizationAgentError({ message: "Unauthorized" });
    }
    return identity;
  },
);
```

`getCurrentAgent()` uses `AsyncLocalStorage` — the Agents SDK wraps every custom method call with the agent's context. It's available:
- When called via WebSocket RPC (`@callable()` methods)
- When called via `onConnect`, `onMessage`, etc.

It is **NOT** available:
- Inside `runInDurableObject` callbacks (the callback runs inside the DO isolate but not through the Agent's method-wrapping infrastructure)
- In plain `Effect.runPromise` calls

### Implication

Testing `uploadInvoice` via `runInDurableObject` + `Effect.runPromise` (like `organization-repository.test.ts` does) will fail at `getConnectionIdentity()` because `getCurrentAgent()` returns `{ agent: undefined, connection: undefined }`.

---

## Testing Approaches

### Approach A: WebSocket RPC (Full Stack)

Call `uploadInvoice` through the Agent's WebSocket RPC protocol, the same way the client does. This exercises the full `@callable()` path including `getCurrentAgent()`.

**Pattern** (from `refs/agents/packages/agents/src/tests/callable.test.ts`):

```ts
import { env, exports } from "cloudflare:workers";

// 1. Connect via WebSocket with auth header
const res = await exports.default.fetch(
  `http://example.com/agents/organization-agent/${orgId}`,
  { headers: { Upgrade: "websocket", "x-organization-agent-user-id": userId } }
);
const ws = res.webSocket!;
ws.accept();

// 2. Skip initial messages (identity, state, mcp_servers)
for (let i = 0; i < 3; i++) await waitForMessage(ws);

// 3. Send RPC request
ws.send(JSON.stringify({
  type: "rpc",
  id: "1",
  method: "uploadInvoice",
  args: [{ fileName: "test.pdf", contentType: "application/pdf", base64: "..." }]
}));

// 4. Wait for response
const response = await waitForMessage(ws);
// response = { type: "rpc", id: "1", success: true, result: { invoiceId: "..." }, done: true }
```

**Pros:**
- Tests the actual code path including `@callable()`, `getConnectionIdentity()`, R2, queue
- Exercises auth middleware (`onBeforeConnect` in `worker.ts`)
- Closest to production behavior

**Cons:**
- Auth middleware (`authorizeAgentRequest`) requires a valid session — needs D1-seeded user/session/org/member data
- WebSocket RPC protocol boilerplate (skip initial messages, parse responses)
- Harder to isolate failures
- `onConnect` requires the `x-organization-agent-user-id` header, which `authorizeAgentRequest` sets after validating session

**Auth flow for WebSocket connection:**
```
1. Client sends: fetch(/agents/organization-agent/{orgId}, { Upgrade: websocket })
2. worker.ts: routeAgentRequest → onBeforeConnect → authorizeAgentRequest
3. authorizeAgentRequest: Auth.getSession → validate session → check activeOrganizationId matches orgId
4. Sets x-organization-agent-user-id header on request
5. OrganizationAgent.onConnect: reads that header → connection.setState({ userId })
6. @callable method: getCurrentAgent() → { agent, connection: { state: { userId } } }
```

This means WebSocket RPC tests need a fully seeded auth context (User + Session + Organization + Member in D1), which couples upload tests to the auth system.

### Approach B: runInDurableObject + Layer Override (Repository + R2 Only)

Skip `getConnectionIdentity` by testing the Effect pipeline directly, replacing the connection check with test-scoped wiring.

```ts
await runInDurableObject(stub, async (_instance: OrganizationAgent, state) => {
  const sqliteLayer = SqliteClient.layer({ db: state.storage.sql });
  const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
  const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
  const configLayer = Layer.succeedServices(
    ServiceMap.make(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
  );
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const layer = Layer.mergeAll(repoLayer, r2Layer, configLayer);

  await Effect.runPromise(Effect.provide(
    Effect.gen(function* () {
      // Test repo.insertUploadingInvoice + R2.put directly
      // Bypasses getConnectionIdentity
    }),
    layer,
  ));
});
```

**Pros:**
- No auth boilerplate
- Tests R2 put + DB insert in isolation
- Follows `organization-repository.test.ts` pattern

**Cons:**
- Cannot test `uploadInvoice` method directly — must decompose its steps
- Skips `getConnectionIdentity` entirely (not tested)
- Skips `broadcastActivity` (Agent WebSocket broadcast)
- Not testing the actual `@callable()` method — more of a unit test of its components

### Approach C: WebSocket RPC With Pre-seeded Auth (Recommended)

Full WebSocket RPC test, but with a helper that seeds the D1 auth context before connecting.

```ts
const setupAuth = Effect.fn("setupAuth")(function* () {
  const d1 = yield* D1;
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  // Seed User, Organization, Member, Session (with activeOrganizationId)
  yield* d1.run(d1.prepare("insert into User ...").bind(userId, ...));
  yield* d1.run(d1.prepare("insert into Organization ...").bind(orgId, ...));
  yield* d1.run(d1.prepare("insert into Member ...").bind(userId, orgId, "owner"));
  yield* d1.run(d1.prepare("insert into Session ...").bind(sessionToken, userId, orgId));
  return { userId, orgId, sessionToken };
});
```

Then connect with the session cookie:

```ts
const res = await exports.default.fetch(
  `http://example.com/agents/organization-agent/${orgId}`,
  {
    headers: {
      Upgrade: "websocket",
      Cookie: `better-auth.session_token=${sessionToken}`,
    },
  },
);
```

**Pros:**
- Tests full production path including auth, `@callable()`, `getConnectionIdentity()`
- Tests R2 put + DB insert + queue send
- Most realistic

**Cons:**
- More setup code (D1 seeding)
- Depends on better-auth internals for session cookie format
- Couples to auth system

---

## What the Tests Should Cover

### Happy Path
1. Upload a valid PDF → R2 object created, DB row with status "uploading", returns `{ invoiceId }`
2. Upload a valid PNG → same as above with different contentType

### Validation Errors
3. Empty fileName → schema decode error
4. Empty base64 → schema decode error
5. Invalid contentType (e.g., "text/plain") → `OrganizationAgentError("Invalid file type")`
6. Base64 too large → `OrganizationAgentError("File too large")`

### Invoice Limit
7. At limit → `InvoiceLimitExceededError`
8. Below limit → succeeds

### Auth
9. No session cookie → 401 or connection refused
10. Wrong organization → 403

### Idempotency
11. `insertUploadingInvoice` uses `on conflict(id) do nothing` — if `onInvoiceUpload` already ran, the "uploading" insert is a no-op

### R2 Verification
12. After upload, `env.R2.head(key)` returns the object with correct custom metadata

### Queue (Local Environment)
13. When `ENVIRONMENT=local`, `env.Q.send()` is called with the R2 event notification shape

---

## Sample Invoices

Available in `invoices/`:

| File | Type | Use for |
|---|---|---|
| `invoice-1-redacted.pdf` | application/pdf | PDF upload tests |
| `invoice-1-redacted.png` | image/png | PNG upload tests |
| `cloudflare-invoice-2026-03-04-redacted.pdf` | application/pdf | Alternative PDF |
| `invoice_EU-ES608274-redacted.pdf` | application/pdf | Alternative PDF |

To create base64 for tests:

```ts
import { readFileSync } from "node:fs";
const base64 = readFileSync("invoices/invoice-1-redacted.png").toString("base64");
```

**Size consideration:** Real invoice files are likely several hundred KB. For integration tests, a minimal valid base64 string (e.g., a 1x1 PNG = 68 bytes base64) is sufficient — the test exercises the code path, not the file content.

---

## Vitest Pool Workers Context

### Available Bindings in Tests

From `wrangler.jsonc`, Miniflare provides:

| Binding | Type | Available via |
|---|---|---|
| `env.ORGANIZATION_AGENT` | DurableObjectNamespace | `cloudflare:workers` |
| `env.R2` | R2Bucket | `cloudflare:workers` |
| `env.Q` | Queue | `cloudflare:workers` |
| `env.D1` | D1Database | `cloudflare:workers` |
| `env.INVOICE_EXTRACTION_WORKFLOW` | Workflow | `cloudflare:workers` |
| `env.INVOICE_LIMIT` | string ("3") | vars in wrangler.jsonc |

### R2 in Tests

`refs/workers-sdk/fixtures/vitest-pool-workers-examples/kv-r2-caches/test/r2.test.ts` confirms R2 bindings work in vitest-pool-workers. The test puts and gets objects directly. Miniflare provides in-memory R2 — no real bucket needed.

After `uploadInvoice`, we can verify:

```ts
const head = await env.R2.head(`${orgId}/invoices/${invoiceId}`);
expect(head).not.toBeNull();
expect(head!.customMetadata).toEqual({
  organizationId: orgId,
  invoiceId,
  idempotencyKey: expect.any(String),
  fileName: "test.pdf",
  contentType: "application/pdf",
});
```

### Queues in Tests

`refs/workers-sdk/fixtures/vitest-pool-workers-examples/queues/` shows queue testing patterns. The producer binding (`env.Q.send()`) works in Miniflare. For verifying the send happened, two options:

1. **Consumer integration test**: Let the queue consumer process the message and verify side effects
2. **No direct assertion**: Since `ENVIRONMENT=local` is a dev convenience path, verifying the R2 + DB side effects is sufficient

The queue consumer (`worker.ts:310`) processes messages by calling `processQueueMessage`, which for `PutObject` calls `stub.onInvoiceUpload()`. Testing the full R2 → Queue → `onInvoiceUpload` → DB pipeline is a separate concern from testing `uploadInvoice`.

### Workflow Binding

`env.INVOICE_EXTRACTION_WORKFLOW` is declared in `wrangler.jsonc`. `uploadInvoice` does NOT start a workflow — it only does R2 put + DB insert. The workflow is started by `onInvoiceUpload` (triggered by the R2 queue notification).

---

## Auth Seeding for WebSocket RPC Tests

To connect via WebSocket RPC, `authorizeAgentRequest` must find a valid session. better-auth's session lookup uses the `better-auth.session_token` cookie to find a Session row in D1.

### better-auth Session Lookup

better-auth stores sessions in the `Session` table with fields:
- `id` — session ID
- `token` — session token (used in cookie)
- `userId` — references User
- `expiresAt` — ISO date string
- `activeOrganizationId` — must match the agent's org ID

The cookie value is the `token` field, not the `id`.

### Seed Sequence

```
User (id, email, emailVerified=1)
  → Organization (id, name, slug)
    → Member (userId, organizationId, role="owner")
      → Session (token, userId, expiresAt=future, activeOrganizationId=orgId)
```

The `repository.test.ts` already has `seedUser`, `seedOrganization`, `seedMember`, `seedSession` helpers. These operate on D1 (not DO SQLite), so they work outside `runInDurableObject`.

### Auth + DO SQLite Interaction

WebSocket RPC tests combine both:
1. D1 seeding (auth context) — done at test level via `env.D1`
2. DO SQLite (invoice repo) — accessed inside the Agent when `@callable` runs

No `runInDurableObject` needed — the `@callable()` method runs inside the DO automatically when called via RPC.

---

## Approach C Detail: WebSocket RPC Test Structure

```ts
import { env, exports } from "cloudflare:workers";
import { Effect, Layer, ServiceMap } from "effect";
import { describe, expect, it } from "vitest";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";

// D1 layer for seeding auth data
const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);

// Seed helpers (same as repository.test.ts)
const seedUser = Effect.fn("seed.user")(function* (...) { ... });
const seedOrganization = Effect.fn("seed.organization")(function* (...) { ... });
const seedMember = Effect.fn("seed.member")(function* (...) { ... });
const seedSession = Effect.fn("seed.session")(function* (...) { ... });

// WebSocket RPC helpers
async function connectAgent(orgId: string, sessionToken: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/organization-agent/${orgId}`,
    {
      headers: {
        Upgrade: "websocket",
        Cookie: `better-auth.session_token=${sessionToken}`,
      },
    },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  // Skip initial messages (identity, state, mcp_servers)
  for (let i = 0; i < 3; i++) await waitForMessage(ws);
  return ws;
}

async function callRpc(ws: WebSocket, method: string, args: unknown[]) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  // Wait for done: true response
  return waitForRpcResponse(ws, id);
}

// Minimal valid base64 (1x1 transparent PNG)
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==";

describe("uploadInvoice", () => {
  it("uploads valid PDF", async () => {
    // 1. Seed auth context in D1
    const auth = await Effect.runPromise(Effect.provide(
      Effect.gen(function* () {
        const user = yield* seedUser();
        const org = yield* seedOrganization();
        yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });
        const session = yield* seedSession({
          userId: user.id,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          activeOrganizationId: org.id,
        });
        return { userId: user.id, orgId: org.id, sessionToken: session.token };
      }),
      d1Layer,
    ));

    // 2. Connect WebSocket
    const ws = await connectAgent(auth.orgId, auth.sessionToken);

    // 3. Call uploadInvoice via RPC
    const result = await callRpc(ws, "uploadInvoice", [{
      fileName: "test.png",
      contentType: "image/png",
      base64: TINY_PNG_BASE64,
    }]);

    // 4. Assert RPC response
    expect(result.success).toBe(true);
    expect(result.result).toHaveProperty("invoiceId");

    // 5. Verify R2 object exists
    const invoiceId = result.result.invoiceId;
    const r2Key = `${auth.orgId}/invoices/${invoiceId}`;
    const head = await env.R2.head(r2Key);
    expect(head).not.toBeNull();
    expect(head!.customMetadata?.organizationId).toBe(auth.orgId);
    expect(head!.customMetadata?.fileName).toBe("test.png");

    // 6. Verify DB row via runInDurableObject (optional — verifies "uploading" status)
    // ...

    ws.close();
  });
});
```

---

## Open Questions

### 1. Does `routeAgentRequest` work in vitest-pool-workers?

`routeAgentRequest` from the `agents` SDK routes HTTP/WebSocket requests to DO stubs. It needs the Agent binding (`env.ORGANIZATION_AGENT`). The binding exists in Miniflare. The `agents` SDK's `callable.test.ts` uses `exports.default.fetch()` with `Upgrade: websocket` which goes through the worker's fetch handler → `routeAgentRequest`, confirming this pattern works.

However, our `worker.ts` wraps `routeAgentRequest` with `onBeforeConnect`/`onBeforeRequest` callbacks that call `authorizeAgentRequest`, which needs Auth (better-auth) → Repository → D1. This adds more dependencies to the test.

### 2. Does the WebSocket upgrade go through the full worker fetch handler?

Yes. `exports.default.fetch()` in vitest-pool-workers calls the worker's `fetch` export. The full `worker.ts:fetch` handler runs:
1. Rate limiting check
2. `makeRunEffect` (creates Effect runtime)
3. `routeAgentRequest` with auth callbacks
4. Falls through to `serverEntry.fetch` if not agent request

For agent WebSocket requests, step 3 handles it. The auth callbacks need the full D1/Auth layer to be functional.

### 3. Can we bypass auth for test simplicity?

Not easily without modifying production code. `authorizeAgentRequest` is embedded in `worker.ts:fetch`. Options:
- **Seed the auth data** (Approach C) — cleanest, no prod code changes
- **Add a test-only bypass** — violates production code purity
- **Call the DO stub directly** — bypasses auth but also `routeAgentRequest` and `onConnect`, so no connection context for `getCurrentAgent()`

### 4. How does the RPC message type enum resolve?

From `refs/agents/packages/agents/src/types.ts`:

```ts
export enum MessageType {
  RPC = "rpc",
  CF_AGENT_IDENTITY = "cf_agent_identity",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
}
```

The RPC response format:

```ts
// Success
{ type: "rpc", id: string, success: true, result: unknown, done: boolean }
// Error
{ type: "rpc", id: string, success: false, error: string }
```

### 5. What about the `broadcastActivity` call?

`uploadInvoice` does NOT call `broadcastActivity` — only `onInvoiceUpload` does (line 197-201). So WebSocket broadcast is not a concern for this test.

Actually, looking more carefully at the code, `uploadInvoice` (lines 278-336) does not call `broadcastActivity` at all. The broadcast happens in `onInvoiceUpload` when triggered by the queue. So this is not a blocker.

### 6. DB row verification after WebSocket RPC

After the RPC call, the DB row exists in the DO's SQLite. To verify it, we can either:
- Call `getInvoices` via RPC (another `@callable` method)
- Use `runInDurableObject` with the same DO instance name to inspect SQLite directly

The second approach requires the same org ID as the DO instance name:

```ts
const id = env.ORGANIZATION_AGENT.idFromName(auth.orgId);
const stub = env.ORGANIZATION_AGENT.get(id);
await runInDurableObject(stub, async (_instance, state) => {
  const rows = state.storage.sql.exec("select * from Invoice").toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("uploading");
});
```

---

## Recommendation

**Approach C (WebSocket RPC with pre-seeded auth)** is the right choice:

1. It tests the actual production code path end-to-end
2. The auth seeding helpers already exist in `repository.test.ts` (can be extracted to shared `test/seed-helpers.ts`)
3. R2 and Queue bindings are available in Miniflare
4. The `callable.test.ts` reference in the agents SDK validates the WebSocket RPC pattern works in vitest-pool-workers
5. DB verification can use either RPC (`getInvoices`) or `runInDurableObject`

The WebSocket RPC boilerplate (connect, skip initial messages, send/receive) should be extracted to a shared test utility alongside the auth seeding helpers.

---

## File Plan

| File | Action |
|---|---|
| `test/integration/upload-invoice.test.ts` | New — WebSocket RPC tests for uploadInvoice |
| `test/seed-helpers.ts` | New (optional) — Extract D1 seeding helpers shared between repository.test.ts and upload tests |
| `test/agent-rpc-helpers.ts` | New (optional) — WebSocket RPC test utilities (connect, skipInitialMessages, callRpc) |
