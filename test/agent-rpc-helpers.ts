import { exports } from "cloudflare:workers";
import { Effect } from "effect";

import { login } from "@/lib/Login";

import {
  extractSessionCookie,
  fetchWorker,
  resetDb,
  runServerFn,
} from "./TestUtils";

export interface RpcSuccessResponse {
  type: "rpc";
  id: string;
  success: true;
  result: unknown;
  done: boolean;
}

export interface RpcErrorResponse {
  type: "rpc";
  id: string;
  success: false;
  error: string;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export function waitForMessage(
  ws: WebSocket,
  timeout = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout waiting for WebSocket message"));
    }, timeout);
    ws.addEventListener(
      "message",
      (e: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data as string));
      },
      { once: true },
    );
  });
}

export async function skipInitialMessages(ws: WebSocket) {
  for (let i = 0; i < 3; i++) await waitForMessage(ws);
}

export function callRpc(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 10_000,
): Promise<RpcResponse> {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RPC timeout: ${method}`));
    }, timeout);
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RpcResponse;
      if (msg.type === "rpc" && msg.id === id) {
        if (msg.success && !msg.done) return;
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

export async function connectAgent(orgId: string, sessionCookie: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/organization-agent/${orgId}`,
    { headers: { Upgrade: "websocket", Cookie: sessionCookie } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed: ${String(res.status)}`);
  ws.accept();
  await skipInitialMessages(ws);
  return ws;
}

export function loginAndGetAuth() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* resetDb();
      const result = yield* runServerFn({
        serverFn: login,
        data: { email: "u@u.com" },
      });
      const verifyResponse = yield* fetchWorker(result.magicLink ?? "", {
        redirect: "manual",
      });
      const sessionCookie = yield* extractSessionCookie(verifyResponse);
      const appResponse = yield* fetchWorker(
        new URL(
          verifyResponse.headers.get("location") ?? "/",
          result.magicLink,
        ).toString(),
        { headers: { Cookie: sessionCookie } },
      );
      const orgId = new URL(appResponse.url).pathname.split("/")[2];
      if (!orgId) throw new Error("Could not extract orgId from redirect URL");
      return { sessionCookie, orgId };
    }),
  );
}
