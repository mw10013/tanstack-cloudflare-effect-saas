import { login } from "@/lib/Login";
import { exports } from "cloudflare:workers";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { describe, expect, it } from "vitest";

import { resetDb } from "../test-utils";

type ServerFnArgs<T> = T extends (...args: infer A) => unknown ? A : never;

type ServerFnInput<T> = ServerFnArgs<T> extends [infer P, ...unknown[]]
  ? P
  : never;

type ServerFnData<T> = ServerFnInput<T> extends { data: infer D } ? D : never;

type ServerFnResult<T> = T extends (...args: infer _A) => infer R
  ? Awaited<R>
  : never;

interface RunServerFnArgs<T> {
  serverFn: T;
  data: ServerFnData<T>;
}

const runServerFn = async <T>({
  serverFn,
  data,
}: RunServerFnArgs<T>) => {
  const serverFnWithMeta = serverFn as T & { serverFnMeta: { id: string } };
  const clientRpc = createClientRpc(serverFnWithMeta.serverFnMeta.id);
  const fetchServerFn = (url: string, init?: RequestInit) =>
    exports.default.fetch(new Request(new URL(url, "http://example.com"), init));
  const result = await runWithStartContext<{
    result: ServerFnResult<T>;
  }>(
    {
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      getRouter: () => {
        throw new Error("unused in integration test");
      },
      request: new Request("http://example.com"),
      startOptions: {},
    },
    () =>
      clientRpc({
        data,
        method: "POST",
        fetch: fetchServerFn,
      } as ServerFnInput<T>),
  );

  return result.result;
};

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });

  it("calls the login server fn", async () => {
    await resetDb();
    const result = await runServerFn({
      serverFn: login,
      data: { email: "u@u.com" },
    });

    expect(result.success).toBe(true);
    expect(result.magicLink).toContain("/api/auth/magic-link/verify");
  });
});
