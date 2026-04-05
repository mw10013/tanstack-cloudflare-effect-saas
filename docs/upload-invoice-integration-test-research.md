# Upload Invoice Integration Test Research

## Goal

Design an end-to-end integration test for `OrganizationAgent.uploadInvoice()` that exercises the full pipeline: auth → WebSocket RPC → R2 upload → queue → `onInvoiceUpload` → workflow → `saveInvoiceExtraction` → verify final invoice via `getInvoices` RPC.

---

## Full Pipeline

```
uploadInvoice (RPC)
  ├─ getConnectionIdentity()        ← requires WebSocket connection context
  ├─ Config.number("INVOICE_LIMIT") ← from env vars
  ├─ repo.countInvoices()           ← DO SQLite
  ├─ validate base64 size + contentType
  ├─ R2.put(key, bytes, metadata)   ← R2 upload
  ├─ env.Q.send(r2EventNotification)  ← queue (ENVIRONMENT=local)
  └─ repo.insertUploadingInvoice()  ← DO SQLite, status="uploading"

Queue consumer (worker.ts:queue)
  └─ processInvoiceUpload
      ├─ R2.head(key)               ← reads custom metadata
      └─ stub.onInvoiceUpload()     ← calls DO method on agent stub

onInvoiceUpload (organization-agent.ts)
  ├─ idempotency checks
  ├─ repo.upsertInvoice()          ← status="extracting"
  ├─ broadcastActivity("invoice.uploaded")
  └─ this.runWorkflow("INVOICE_EXTRACTION_WORKFLOW", ...)

InvoiceExtractionWorkflow (invoice-extraction-workflow.ts)
  ├─ step.do("load-file")          ← R2.get → base64
  ├─ step.do("extract-invoice")    ← AI Gateway → Gemini
  └─ step.do("save-extraction")    ← agent.saveInvoiceExtraction()
      ├─ repo.saveInvoiceExtraction()  ← status="ready", fields populated
      └─ broadcastActivity("invoice.extraction.completed")
```

### Dependencies

| Dependency | Source | Test Availability |
|---|---|---|
| `getConnectionIdentity()` | `getCurrentAgent()` from agents SDK | Requires WebSocket connection context |
| `Config.number("INVOICE_LIMIT")` | `ConfigProvider.fromUnknown(env)` | Via wrangler.jsonc vars (`"3"`) |
| `OrganizationRepository` | `SqliteClient.layer` from DO SQLite | Auto-created by Agent constructor |
| `R2.put` / `R2.get` / `R2.head` | `R2` service ← `CloudflareEnv` | Miniflare in-memory R2 |
| `env.Q.send` | Queue producer binding | Miniflare queue binding |
| `INVOICE_EXTRACTION_WORKFLOW` | Workflow binding | Miniflare workflow runtime |
| `InvoiceExtraction.extract` | AI Gateway → Gemini via `HttpClient` | Available — secrets loaded from `.env` |

---

## Env Vars and Secrets in Tests

`@cloudflare/vitest-pool-workers` uses Wrangler's `getVarsForDev()` to load environment variables. When no `.dev.vars` file exists, it falls back to `.env` files automatically (`refs/workers-sdk/packages/wrangler/src/dev/dev-vars.ts:89-99`).

This project has `.env` with the needed secrets:

```
AI_GATEWAY_TOKEN=...
GOOGLE_AI_STUDIO_API_KEY=...
```

These are available on the worker's `env` object in tests, so `InvoiceExtraction` (which reads them via `Config.nonEmptyString`) works without mocking. The workflow's `extract-invoice` step calls the real AI Gateway → Gemini.

From `wrangler.jsonc`, plain vars are also available:

| Var | Value |
|---|---|
| `ENVIRONMENT` | `"local"` |
| `INVOICE_LIMIT` | `"3"` |
| `CF_ACCOUNT_ID` | `"1422451be59cc2401532ad67d92ae773"` |
| `AI_GATEWAY_ID` | `"tcei-ai-gateway"` |
| `R2_BUCKET_NAME` | `"tcei-r2-local"` |

---

## Auth Setup: Login Server Fn Flow

Use the same login flow as `login.test.ts` instead of manual D1 seeding. This is the production auth path and avoids coupling to better-auth's internal schema.

From `test/TestUtils.ts`:

```ts
const result = yield* runServerFn({ serverFn: login, data: { email: "u@u.com" } });
// result.magicLink → /api/auth/magic-link/verify?token=...

const verifyResponse = yield* fetchWorker(result.magicLink, { redirect: "manual" });
// 302 → /magic-link, Set-Cookie: better-auth.session_token=...

const sessionCookie = yield* extractSessionCookie(verifyResponse);
// "better-auth.session_token=...; ..."
```

After login, the user has a session with `activeOrganizationId` set (better-auth's organization plugin creates an org and sets it as active on first login). The `sessionCookie` is used to authenticate the WebSocket connection.

The `orgId` for the agent connection path comes from the session's `activeOrganizationId`. Extract it from the redirect URL (`/app/{orgId}`).

From `login.test.ts:41-47`:

```ts
const appResponse = yield* fetchWorker(
  new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink).toString(),
  { headers: { Cookie: sessionCookie } },
);
// appResponse.url pathname is /app/{orgId}
const orgId = new URL(appResponse.url).pathname.split("/")[2];
```

---

## Waiting for Workflow Completion

The workflow runs asynchronously after the queue delivers the message. Two mechanisms to wait:

### Option A: `introspectWorkflow` from `cloudflare:test`

```ts
import { introspectWorkflow } from "cloudflare:test";

await using introspector = await introspectWorkflow(env.INVOICE_EXTRACTION_WORKFLOW);
// ... trigger uploadInvoice ...
const instances = introspector.get();
await instances[0].waitForStatus("complete");
```

`agent.runWorkflow` calls `workflow.create()` on the standard Workflow binding (`refs/agents/packages/agents/src/index.ts:3387`), so `introspectWorkflow` can intercept instances created by the Agent.

### Option B: Poll `getInvoices` via RPC

```ts
import { vi } from "vitest";

const invoice = await vi.waitUntil(async () => {
  const result = await callRpc(ws, "getInvoices", []);
  const invoices = result.result as Array<{ id: string; status: string }>;
  const inv = invoices.find((i) => i.id === invoiceId);
  if (inv?.status === "ready" || inv?.status === "error") return inv;
}, { timeout: 30000 });
```

Option B is simpler and avoids questions about `introspectWorkflow` + `AgentWorkflow` compatibility. Option A gives access to workflow output and more precise status tracking.

---

## WebSocket RPC Protocol

### Connection

The WebSocket upgrade goes through `worker.ts:fetch` → `routeAgentRequest` with `onBeforeConnect` → `authorizeAgentRequest`.

`authorizeAgentRequest` (`worker.ts:236-252`):
1. `Auth.getSession(request.headers)` — validates session cookie
2. Checks `activeOrganizationId` matches the agent name in the URL path
3. Sets `x-organization-agent-user-id` header

`OrganizationAgent.onConnect` (`organization-agent.ts:145-155`) reads that header and stores `{ userId }` in connection state.

```ts
const res = await exports.default.fetch(
  `http://example.com/agents/organization-agent/${orgId}`,
  {
    headers: {
      Upgrade: "websocket",
      Cookie: sessionCookie,
    },
  },
);
const ws = res.webSocket!;
ws.accept();
```

### Initial Messages

On connect, the Agent sends 3 messages (from `refs/agents/packages/agents/src/tests/callable.test.ts:68-72`):

```ts
const INITIAL_MESSAGE_TYPES = new Set([
  "cf_agent_identity",
  "cf_agent_state",
  "cf_agent_mcp_servers",
]);
// Skip all 3 before sending RPC
for (let i = 0; i < 3; i++) await waitForMessage(ws);
```

### RPC Request/Response

```ts
// Request
{ type: "rpc", id: string, method: string, args: unknown[] }

// Success response
{ type: "rpc", id: string, success: true, result: unknown, done: true }

// Error response
{ type: "rpc", id: string, success: false, error: string }
```

---

## Queue Delivery in Tests

`uploadInvoice` calls `env.Q.send(r2EventNotification)` when `ENVIRONMENT=local` (set in `wrangler.jsonc`). Miniflare delivers queue messages to the worker's `queue()` handler automatically.

From `refs/workers-sdk/fixtures/vitest-pool-workers-examples/queues/test/queue-producer-integration-self.test.ts`, after producing a message, the test polls for the consumer's side effects using `vi.waitUntil`.

### Queue Message Shape

`uploadInvoice` sends (`organization-agent.ts:311-320`):

```ts
queue.send({
  account: "local",
  action: "PutObject",
  bucket: "tcei-r2-local",
  object: { key, size: bytes.byteLength, eTag: "local" },
  eventTime: new Date().toISOString(),
})
```

The queue consumer (`worker.ts:222-233`) decodes this via `queueMessageSchema` → `processInvoiceUpload` → `R2.head(key)` → reads custom metadata → `stub.onInvoiceUpload()`.

---

## Sample Invoices

Available in `invoices/`:

| File | Type |
|---|---|
| `invoice-1-redacted.pdf` | application/pdf |
| `invoice-1-redacted.png` | image/png |
| `cloudflare-invoice-2026-03-04-redacted.pdf` | application/pdf |
| `invoice_EU-ES608274-redacted.pdf` | application/pdf |

Since the workflow runs real AI extraction, using an actual invoice file produces meaningful extracted fields to assert on. `invoice-1-redacted.png` is a good candidate — it's an image (simpler to base64 encode) and the extraction result will have real vendor/amount data.

---

## Test Structure

```ts
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { login } from "@/lib/Login";
import {
  extractSessionCookie,
  fetchWorker,
  resetDb,
  runServerFn,
} from "../TestUtils";

// --- Helpers ---

function waitForMessage(ws: WebSocket, timeout = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    ws.addEventListener("message", (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(e.data as string));
    }, { once: true });
  });
}

async function skipInitialMessages(ws: WebSocket) {
  for (let i = 0; i < 3; i++) await waitForMessage(ws);
}

async function callRpc(ws: WebSocket, method: string, args: unknown[], timeout = 10000) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  return new Promise<{ success: boolean; result?: unknown; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), timeout);
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "rpc" && msg.id === id) {
        if (msg.success === true && msg.done === false) return;
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function loginAndGetAuth() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* resetDb();
      const result = yield* runServerFn({ serverFn: login, data: { email: "u@u.com" } });
      const verifyResponse = yield* fetchWorker(result.magicLink ?? "", { redirect: "manual" });
      const sessionCookie = yield* extractSessionCookie(verifyResponse);
      const appResponse = yield* fetchWorker(
        new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink).toString(),
        { headers: { Cookie: sessionCookie } },
      );
      const orgId = new URL(appResponse.url).pathname.split("/")[2]!;
      return { sessionCookie, orgId };
    }),
  );
}

async function connectAgent(orgId: string, sessionCookie: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/organization-agent/${orgId}`,
    { headers: { Upgrade: "websocket", Cookie: sessionCookie } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  await skipInitialMessages(ws);
  return ws;
}

// --- Tests ---

describe("uploadInvoice", () => {
  it("upload → queue → workflow → ready invoice", async () => {
    // 1. Login via server fn
    const { sessionCookie, orgId } = await loginAndGetAuth();

    // 2. Connect WebSocket to agent
    const ws = await connectAgent(orgId, sessionCookie);

    // 3. Upload invoice via RPC (use real invoice file for meaningful extraction)
    const base64 = /* base64 of invoices/invoice-1-redacted.png */;
    const uploadResult = await callRpc(ws, "uploadInvoice", [{
      fileName: "invoice-1-redacted.png",
      contentType: "image/png",
      base64,
    }]);
    expect(uploadResult.success).toBe(true);
    const { invoiceId } = uploadResult.result as { invoiceId: string };

    // 4. Verify R2 object
    const r2Key = `${orgId}/invoices/${invoiceId}`;
    const head = await env.R2.head(r2Key);
    expect(head).not.toBeNull();
    expect(head!.customMetadata?.fileName).toBe("invoice-1-redacted.png");

    // 5. Wait for workflow to complete (queue → onInvoiceUpload → workflow → save)
    const invoice = await vi.waitUntil(async () => {
      const result = await callRpc(ws, "getInvoices", []);
      const invoices = result.result as Array<{ id: string; status: string }>;
      const inv = invoices.find((i) => i.id === invoiceId);
      if (inv?.status === "ready" || inv?.status === "error") return inv;
    }, { timeout: 60000 });

    // 6. Verify final invoice state
    expect(invoice!.status).toBe("ready");

    ws.close();
  }, 90000);
});
```

---

## What the Tests Should Cover

### End-to-End Happy Path
1. Upload real invoice PNG → queue → workflow (real AI extraction) → `getInvoices` returns invoice with status="ready"

### Validation Errors
2. Invalid contentType (e.g., "text/plain") → RPC error `"Invalid file type"`
3. Base64 too large → RPC error `"File too large"`
4. Empty fileName or base64 → RPC error (schema decode failure)

### Invoice Limit
5. Upload `INVOICE_LIMIT` (3) invoices → 4th upload returns `InvoiceLimitExceededError`

### Workflow Error Path
6. Upload non-invoice file → workflow extracts with low confidence or errors → verify status

### Auth
7. No session cookie → WebSocket upgrade fails (401)
8. Wrong organization → WebSocket upgrade fails (403)

---

## Open Questions

### 1. Does `introspectWorkflow` work with `AgentWorkflow`?

`agent.runWorkflow` calls `workflow.create()` on the standard Workflow binding (`refs/agents/packages/agents/src/index.ts:3387`). `introspectWorkflow` intercepts instances created via the binding. This should work, but `AgentWorkflow` extends `AgentWorkflowBase` (not `WorkflowEntrypoint`), so the `introspect` mechanism might not recognize it. Using `vi.waitUntil` + `getInvoices` polling avoids this question entirely.

### 2. Does queue delivery happen synchronously or async?

Miniflare delivers queue messages asynchronously. After `uploadInvoice` returns, the queue message may not be processed yet. The `vi.waitUntil` polling handles this naturally.

### 3. `getOrganizationAgentStub` calls `stub.setName()`

The queue consumer (`worker.ts:174-182`) calls `stub.setName(organizationId)` before `stub.onInvoiceUpload()`. This is needed because queue-created stubs don't get the Agent instance name automatically. If `setName` doesn't work in Miniflare, `this.runWorkflow` will fail (it needs `this.name` for the `__agentName` param). The agents SDK callable test doesn't exercise this path, so it needs verification.

### 4. AI extraction latency in tests

Real AI extraction adds 5-30s per test depending on model latency. The test timeout needs to accommodate this (90s suggested). For faster CI, `introspectWorkflow` + `mockStepResult` could replace real extraction if needed later.

---

## File Plan

| File | Action |
|---|---|
| `test/integration/upload-invoice.test.ts` | New — end-to-end test |
| `test/agent-rpc-helpers.ts` | New — WebSocket RPC helpers (connect, skipInitialMessages, callRpc) |
