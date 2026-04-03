import type { BrowserCommand } from "vitest/node";

export interface SerializedRequestInit {
  body: string | null;
  headers: [string, string][];
  method: string;
}

export interface SerializedResponse {
  body: string;
  headers: [string, string][];
  request: {
    body: string | null;
    headers: [string, string][];
    method: string;
    url: string;
  };
  status: number;
}

export const appFetch: BrowserCommand<
  [url: string, init: SerializedRequestInit]
> = async (_ctx, url, init) => {
  const appUrl = process.env.VITEST_BROWSER_APP_URL;

  if (!appUrl) {
    throw new Error("Missing VITEST_BROWSER_APP_URL");
  }

  const requestUrl = new URL(url, appUrl);
  const response = await fetch(requestUrl, {
    body: init.body ?? undefined,
    headers: init.headers,
    method: init.method,
  });

  return {
    body: await response.text(),
    headers: [...response.headers.entries()],
    request: {
      body: init.body,
      headers: init.headers,
      method: init.method,
      url: requestUrl.toString(),
    },
    status: response.status,
  } satisfies SerializedResponse;
};
