import type { ClientFnMeta, RequiredFetcher } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { env, exports } from "cloudflare:workers";
import { Effect, Option } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";

export type ServerFn<TInputValidator, TResponse> = RequiredFetcher<
  undefined,
  TInputValidator,
  TResponse
> & {
  serverFnMeta?: ClientFnMeta;
};

export const resetDb = Effect.fn("resetDb")(function*() {
  yield* Effect.promise(() =>
    env.D1.batch([
      ...["Session", "Member", "Invitation", "Verification", "Organization"].map(
        (table) => env.D1.prepare(`delete from ${table}`),
      ),
      env.D1.prepare(`delete from Account where id <> 'admin'`),
      env.D1.prepare(`delete from User where id <> 'admin'`),
    ])
  );
});

export const fetchWorker = Effect.fn("fetchWorker")(
  function*(url: string, init?: RequestInit) {
    return yield* Effect.promise(() =>
      exports.default.fetch(new Request(new URL(url, "http://example.com"), init))
    );
  },
);

export const runServerFn = Effect.fn("runServerFn")(
  function*<TInputValidator, TResponse>({
    serverFn,
    data,
  }: {
    serverFn: ServerFn<TInputValidator, TResponse>;
    data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"];
  }): Effect.fn.Return<Awaited<TResponse>, Error> {
    return yield* Effect.promise(() => {
      if (!serverFn.serverFnMeta)
        throw new Error("Missing serverFnMeta in integration test");
      const clientRpc = createClientRpc(serverFn.serverFnMeta.id);
      const fetchServerFn = (url: string, init?: RequestInit) =>
        exports.default.fetch(
          new Request(new URL(url, "http://example.com"), init),
        );
      return runWithStartContext(
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
            method: serverFn.method,
            fetch: fetchServerFn,
          }) as Promise<{ result: Awaited<TResponse>; error?: unknown }>,
      ).then((r) => r.result);
    });
  },
);

export const extractSessionCookie = Effect.fn("extractSessionCookie")(
  function*(response: Response): Effect.fn.Return<string, Error> {
    const cookies = Cookies.fromSetCookie(response.headers.getSetCookie());
    const token = Cookies.getValue(cookies, "better-auth.session_token");
    if (Option.isNone(token))
      return yield* Effect.fail(new Error("Missing session cookie"));
    return Cookies.toCookieHeader(cookies);
  },
);
