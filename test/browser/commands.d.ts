import type {
  SerializedRequestInit,
  SerializedResponse,
} from "./app-fetch-command";

declare module "vitest/browser" {
  interface BrowserCommands {
    appFetch: (
      url: string,
      init: SerializedRequestInit,
    ) => Promise<SerializedResponse>;
  }
}

export type VitestBrowserCommandsModule = never;
