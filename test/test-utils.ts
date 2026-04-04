import { env } from "cloudflare:workers";
import type { ClientFnMeta, RequiredFetcher } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { exports } from "cloudflare:workers";

export async function resetDb(resetFn?: (db: D1Database) => Promise<void>) {
  await env.D1.batch([
    ...["Session", "Member", "Invitation", "Verification", "Organization"].map(
      (table) => env.D1.prepare(`delete from ${table}`),
    ),
    env.D1.prepare(`delete from Account where id <> 'admin'`),
    env.D1.prepare(`delete from User where id <> 'admin'`),
  ]);
  if (resetFn) await resetFn(env.D1);
}

export type ServerFn<TInputValidator, TResponse> = RequiredFetcher<
  undefined,
  TInputValidator,
  TResponse
> & {
  serverFnMeta?: ClientFnMeta;
};

/**
 * Runs a server fn via the worker fetch handler using client RPC.
 * Bypasses client middleware and client-side routing.
 * Useful for integration tests that need to call server fns directly.
 */
export const runServerFn = async <TInputValidator, TResponse>({
  serverFn,
  data,
}: {
  serverFn: ServerFn<TInputValidator, TResponse>;
  data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"];
}) => {
  if (!serverFn.serverFnMeta) {
    throw new Error("Missing serverFnMeta in integration test");
  }
  const clientRpc = createClientRpc(serverFn.serverFnMeta.id);
  const fetchServerFn = (url: string, init?: RequestInit) =>
    exports.default.fetch(
      new Request(new URL(url, "http://example.com"), init),
    );
  const result = await runWithStartContext(
    {
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      getRouter: () => {
        throw new Error("unused in integration test");
      },
      request: new Request("http://example.com"),
      startOptions: {},
    },
    () => {
      return clientRpc({
        data,
        method: serverFn.method,
        fetch: fetchServerFn,
      }) as Promise<{
        result: Awaited<TResponse>;
        error?: unknown;
      }>;
    },
  );

  return result.result;
};

export function extractSessionCookie(response: Response): string {
  const setCookieHeader = response.headers.get("Set-Cookie");
  if (!setCookieHeader) throw new Error("Expected Set-Cookie header");
  const match = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`Missing session cookie: ${setCookieHeader}`);
  return `better-auth.session_token=${match[1]}`;
}

export function parseSetCookie(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    cookieHeader.split(";").map((cookie) => {
      const [key, value] = cookie.trim().split("=");
      return [key, value];
    }),
  );
}

export function getSetCookie(response: Response): string {
  const cookieHeader = response.headers.get("Set-Cookie");
  if (!cookieHeader) throw new Error("Expected Set-Cookie header");
  return cookieHeader;
}
