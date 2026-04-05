import { env } from "cloudflare:workers";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { describe, it } from "@effect/vitest";
import { assertFalse, assertInclude, assertTrue } from "@effect/vitest/utils";
import { expect } from "vitest";

import type { RPCResponse } from "agents";
import * as OrganizationDomain from "@/lib/OrganizationDomain";
import {
  agentWebSocket,
  callRpc,
  fetchWorker,
  loginAndGetAuth,
  pollInvoiceStatus,
} from "../TestUtils";

const InvoiceIdResult = Schema.Struct({ invoiceId: OrganizationDomain.InvoiceId });

describe("uploadInvoice", () => {
  it.live("upload → queue → workflow → ready invoice", () =>
    Effect.gen(function*() {
      const { sessionCookie, orgId } = yield* loginAndGetAuth();
      const ws = yield* agentWebSocket(orgId, sessionCookie);

      const uploadResult: RPCResponse = yield* callRpc(ws, "uploadInvoice", [
        {
          fileName: "invoice-1-redacted.png",
          contentType: "image/png",
          base64: env.TEST_INVOICE_PNG_BASE64,
        },
      ]);
      assertTrue(uploadResult.success);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(uploadResult.result);

      const r2Key = `${orgId}/invoices/${invoiceId}`;
      const head = yield* Effect.promise(() => env.R2.head(r2Key));
      expect(head).not.toBeNull();
      expect(head?.customMetadata?.fileName).toBe("invoice-1-redacted.png");
      expect(head?.customMetadata?.organizationId).toBe(orgId);

      const invoice = yield* pollInvoiceStatus(ws, invoiceId);
      expect(invoice).toBeDefined();
      expect(invoice.status).toBe("ready");
    }), { timeout: 90_000 });

  it.effect("rejects invalid content type", () =>
    Effect.gen(function*() {
      const { sessionCookie, orgId } = yield* loginAndGetAuth();
      const ws = yield* agentWebSocket(orgId, sessionCookie);

      const result: RPCResponse = yield* callRpc(ws, "uploadInvoice", [
        {
          fileName: "test.txt",
          contentType: "text/plain",
          base64: "aGVsbG8=",
        },
      ]);

      assertFalse(result.success);
      const errorResult = Schema.decodeUnknownSync(
        Schema.Struct({ success: Schema.Literal(false), error: Schema.String }),
      )(result);
      assertInclude(errorResult.error, "Invalid file type");
    }));

  it.effect("rejects base64 exceeding size limit", () =>
    Effect.gen(function*() {
      const { sessionCookie, orgId } = yield* loginAndGetAuth();
      const ws = yield* agentWebSocket(orgId, sessionCookie);

      const maxBase64Size = Math.ceil((10_000_000 * 4) / 3) + 4;
      const oversizedBase64 = "A".repeat(maxBase64Size + 1);

      const result: RPCResponse = yield* callRpc(ws, "uploadInvoice", [
        {
          fileName: "huge.png",
          contentType: "image/png",
          base64: oversizedBase64,
        },
      ]);

      assertFalse(result.success);
      const errorResult = Schema.decodeUnknownSync(
        Schema.Struct({ success: Schema.Literal(false), error: Schema.String }),
      )(result);
      assertInclude(errorResult.error, "File too large");
    }));

  it.effect("enforces invoice limit", () =>
    Effect.gen(function*() {
      const { sessionCookie, orgId } = yield* loginAndGetAuth();
      const ws = yield* agentWebSocket(orgId, sessionCookie);

      const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const invoiceLimit = 3;

      for (let i = 0; i < invoiceLimit; i++) {
        const result: RPCResponse = yield* callRpc(ws, "createInvoice", []);
        assertTrue(result.success);
      }

      const result: RPCResponse = yield* callRpc(ws, "uploadInvoice", [
        {
          fileName: "over-limit.png",
          contentType: "image/png",
          base64: tinyPng,
        },
      ]);

      assertFalse(result.success);
      const errorResult = Schema.decodeUnknownSync(
        Schema.Struct({ success: Schema.Literal(false), error: Schema.String }),
      )(result);
      assertInclude(errorResult.error, "Invoice limit");
    }));

  it.effect("rejects WebSocket upgrade without session cookie", () =>
    Effect.gen(function*() {
      const res = yield* fetchWorker(
        "http://example.com/agents/organization-agent/test-org",
        { headers: { Upgrade: "websocket" } },
      );
      expect(res.status).toBe(401);
    }));
});
