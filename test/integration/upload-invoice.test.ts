import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { RpcResponse } from "../agent-rpc-helpers";
import {
  callRpc,
  connectAgent,
  loginAndGetAuth,
} from "../agent-rpc-helpers";

describe("uploadInvoice", () => {
  it("upload → queue → workflow → ready invoice", async () => {
    const { sessionCookie, orgId } = await loginAndGetAuth();
    const ws = await connectAgent(orgId, sessionCookie);

    const uploadResult = await callRpc(ws, "uploadInvoice", [
      {
        fileName: "invoice-1-redacted.png",
        contentType: "image/png",
        base64: env.TEST_INVOICE_PNG_BASE64,
      },
    ]);
    expect(uploadResult.success).toBe(true);
    const { invoiceId } = (uploadResult as Extract<RpcResponse, { success: true }>).result as {
      invoiceId: string;
    };

    const r2Key = `${orgId}/invoices/${invoiceId}`;
    const head = await env.R2.head(r2Key);
    expect(head).not.toBeNull();
    expect(head?.customMetadata?.fileName).toBe("invoice-1-redacted.png");
    expect(head?.customMetadata?.organizationId).toBe(orgId);

    const invoice = await vi.waitUntil(
      async () => {
        const result = await callRpc(ws, "getInvoices", []);
        if (!result.success) return;
        const invoices = result.result as {
          id: string;
          status: string;
        }[];
        const inv = invoices.find((i) => i.id === invoiceId);
        if (inv?.status === "ready" || inv?.status === "error") return inv;
      },
      { timeout: 60_000, interval: 2000 },
    );

    expect(invoice).toBeDefined();
    expect(invoice.status).toBe("ready");

    ws.close();
  }, 90_000);

  it("rejects invalid content type", async () => {
    const { sessionCookie, orgId } = await loginAndGetAuth();
    const ws = await connectAgent(orgId, sessionCookie);

    const result = await callRpc(ws, "uploadInvoice", [
      {
        fileName: "test.txt",
        contentType: "text/plain",
        base64: "aGVsbG8=",
      },
    ]);

    expect(result.success).toBe(false);
    expect((result as Extract<RpcResponse, { success: false }>).error).toContain(
      "Invalid file type",
    );

    ws.close();
  });

  it("rejects base64 exceeding size limit", async () => {
    const { sessionCookie, orgId } = await loginAndGetAuth();
    const ws = await connectAgent(orgId, sessionCookie);

    const maxBase64Size = Math.ceil((10_000_000 * 4) / 3) + 4;
    const oversizedBase64 = "A".repeat(maxBase64Size + 1);

    const result = await callRpc(ws, "uploadInvoice", [
      {
        fileName: "huge.png",
        contentType: "image/png",
        base64: oversizedBase64,
      },
    ]);

    expect(result.success).toBe(false);
    expect((result as Extract<RpcResponse, { success: false }>).error).toContain(
      "File too large",
    );

    ws.close();
  });

  it("enforces invoice limit", async () => {
    const { sessionCookie, orgId } = await loginAndGetAuth();
    const ws = await connectAgent(orgId, sessionCookie);

    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const invoiceLimit = 3;

    for (let i = 0; i < invoiceLimit; i++) {
      const result = await callRpc(ws, "createInvoice", []);
      expect(result.success).toBe(true);
    }

    const result = await callRpc(ws, "uploadInvoice", [
      {
        fileName: "over-limit.png",
        contentType: "image/png",
        base64: tinyPng,
      },
    ]);

    expect(result.success).toBe(false);
    expect((result as Extract<RpcResponse, { success: false }>).error).toContain(
      "Invoice limit",
    );

    ws.close();
  });

  it("rejects WebSocket upgrade without session cookie", async () => {
    const res = await exports.default.fetch(
      "http://example.com/agents/organization-agent/test-org",
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(401);
  });
});
