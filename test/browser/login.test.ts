import { login } from "@/lib/Login";
import { commands } from "vitest/browser";
import { describe, expect, it } from "vitest";

import type { SerializedResponse } from "./app-fetch-command";

const fetchThroughApp = async (
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<SerializedResponse & { response: Response }> => {
  let requestUrl: string;

  if (typeof url === "string") {
    requestUrl = url;
  } else if (url instanceof URL) {
    requestUrl = url.toString();
  } else {
    requestUrl = url.url;
  }

  const result = await commands.appFetch(
    requestUrl,
    {
    body: typeof init?.body === "string" ? init.body : null,
    headers: [...new Headers(init?.headers).entries()],
    method: init?.method ?? "GET",
    },
  );

  return {
    ...result,
    response: new Response(result.body, {
      headers: result.headers,
      status: result.status,
    }),
  };
};

describe("login browser integration", () => {
  it("routes the client login server fn through the app HTTP boundary", async () => {
    let request: SerializedResponse["request"] | undefined;

    const result = await login({
      data: { email: "u@u.com" },
      fetch: async (url, init) => {
        const appResult = await fetchThroughApp(url, init);
        request = appResult.request;
        return appResult.response;
      },
    });

    expect(result.success).toBe(true);
    expect(result.magicLink).toContain("/api/auth/magic-link/verify");
    expect(request).toBeDefined();

    if (!request) {
      throw new Error("Missing request metadata");
    }

    expect(request.body).toContain("u@u.com");
    expect(request.method).toBe("POST");
    expect(request.url).toMatch(/^http:\/\/localhost:3100\/_serverFn\//);
    expect(new Headers(request.headers).get("x-tsr-serverfn")).toBe("true");
  });
});
