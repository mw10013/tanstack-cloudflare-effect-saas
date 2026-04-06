# Invoice CRUD Integration Test Research

## Key Finding: All Invoice CRUD = Agent RPC (Not Server Functions)

No TanStack `createServerFn` exists for invoice operations. All CRUD goes through
`@callable()` methods on `OrganizationAgent` via WebSocket RPC.

**`callServerFn` auth modification is NOT needed** — invoice tests use `callAgentRpc`
over a WebSocket that already carries the session cookie (passed during upgrade in
`agentWebSocket(organizationId, sessionCookie)`).

---

## Agent RPC Methods to Test

| Method          | Args                                                          | Returns                    | Status Constraint                                           |
| --------------- | ------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `createInvoice` | none                                                          | `{ invoiceId }`            | — (enforces INVOICE_LIMIT)                                  |
| `getInvoices`   | none                                                          | `Invoice[]`                | —                                                           |
| `getInvoice`    | `{ invoiceId }`                                               | `InvoiceWithItems \| null` | —                                                           |
| `updateInvoice` | `{ invoiceId, name, invoiceNumber, ...fields, invoiceItems }` | `InvoiceWithItems`         | only "ready" or "error"                                     |
| `deleteInvoice` | `{ invoiceId }`                                               | void                       | only "ready" or "error"; no-op for "uploading"/"extracting" |

Source: `src/organization-agent.ts` lines 229-370
Input schemas: `src/lib/OrganizationAgentSchemas.ts`

---

## Test Pattern (from upload-invoice.test.ts)

```ts
import { env } from "cloudflare:workers";
import { Config, ConfigProvider, Effect, Layer, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { expect } from "vitest";

import * as OrganizationDomain from "@/lib/OrganizationDomain";
import {
  agentWebSocket,
  assertAgentRpcSuccess,
  assertAgentRpcFailure,
  callAgentRpc,
  login,
} from "../TestUtils";

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

layer(configLayer, { excludeTestServices: true })("suite name", (it) => {
  it.effect("test name", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("email@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const result = yield* callAgentRpc(ws, "methodName", [args]);
      assertAgentRpcSuccess(result);
      // assert on result.result
    }),
  );
});
```

Key points:

- Each test uses a **unique email** → gets its own user/org/session (isolated state)
- `login()` does full magic-link flow → returns `{ sessionCookie, organizationId }`
- `agentWebSocket()` is a scoped Effect resource (auto-closes when test ends)
- `callAgentRpc()` serializes RPC over WebSocket, waits for response by matching `id`
- `assertAgentRpcSuccess/Failure` are type-narrowing guards on `RPCResponse`

---

## Proposed Test Cases for `test/integration/invoice-crud.test.ts`

### createInvoice

1. **creates a blank invoice** — call `createInvoice`, decode `{ invoiceId }`, verify non-empty
2. **getInvoice returns the created invoice** — create → getInvoice → assert defaults (name="Untitled Invoice", status="ready", empty fields)
3. **getInvoices includes the created invoice** — create → getInvoices → find by id

### getInvoice / getInvoices

4. **getInvoice returns null for non-existent id** — call with random id → assert null result
5. **getInvoices returns empty when no invoices** — fresh user → getInvoices → assert empty array
6. **getInvoices orders by createdAt DESC** — create 2+ → getInvoices → verify ordering

### updateInvoice

7. **updates invoice fields** — create → update with name/invoiceNumber/vendor/dates/amounts → getInvoice → assert all fields match
8. **updates with invoiceItems** — create → update with line items → getInvoice → assert items present with correct values
~~9. **rejects update on non-ready status**~~ — SKIPPED (covered at repo layer in organization-repository.test.ts)

### deleteInvoice

9. **deletes an invoice** — create → delete → getInvoice → assert null
10. **getInvoices excludes deleted invoice** — create 2 → delete 1 → getInvoices → assert only 1 remains
11. **delete is idempotent / non-existent** — delete a random id → no error (agent returns void)

### Edge Cases

12. **createInvoice enforces INVOICE_LIMIT** — verify limit via createInvoice path (upload-invoice.test.ts covers upload path)

---

## Input Schema Details

### UpdateInvoiceInput (`src/lib/OrganizationAgentSchemas.ts:7-39`)

All string fields are trimmed via `trimFields()`. Items only need description/quantity/unitPrice/amount/period (no id/invoiceId/order — server assigns those).

```ts
{
  invoiceId: InvoiceId,           // required
  name: string,                   // max 500
  invoiceNumber: string,          // max 100
  invoiceDate: string,            // max 50
  dueDate: string,                // max 50
  currency: string,               // max 10
  vendorName: string,             // max 500
  vendorEmail: string,            // max 254
  vendorAddress: string,          // max 2000
  billToName: string,             // max 500
  billToEmail: string,            // max 254
  billToAddress: string,          // max 2000
  subtotal: string,               // max 50
  tax: string,                    // max 50
  total: string,                  // max 50
  amountDue: string,              // max 50
  invoiceItems: Array<{
    description: string,          // max 2000
    quantity: string,             // max 50
    unitPrice: string,            // max 50
    amount: string,               // max 50
    period: string,               // max 50
  }>
}
```

### Decode Helpers Needed

```ts
const InvoiceIdResult = Schema.Struct({
  invoiceId: OrganizationDomain.InvoiceId,
});
// reuse OrganizationDomain.Invoice for getInvoices results
// reuse OrganizationDomain.InvoiceWithItems for getInvoice results
```

---

## Auth/Session Flow (for reference)

No changes needed to `callServerFn` for these tests since everything is agent RPC.

Flow: `login(email)` → magic link → verify → extract `better-auth.session_token` cookie →
`agentWebSocket(orgId, cookie)` passes cookie in `{ headers: { Cookie } }` during WebSocket upgrade →
agent's `onConnect` resolves `x-organization-agent-user-id` from session → all subsequent RPC calls are authenticated.

---

## Implementation Notes

- Use unique emails per test to ensure isolated org state
- `createInvoice` creates with status="ready" so update/delete work immediately (no need to wait for extraction)
- `deleteInvoice` also triggers a queue message for R2 cleanup, but in tests we only need to verify the DB state via `getInvoice`/`getInvoices`
- `excludeTestServices: true` in layer config keeps real time (no TestClock)
- The `organization-repository.test.ts` already covers lower-level repo operations; these integration tests should focus on the full agent RPC path including auth, validation, and end-to-end behavior
