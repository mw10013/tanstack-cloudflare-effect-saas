import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { TestProject } from "vitest/node";

const rootDir = path.resolve(import.meta.dirname, "../..");

const getPort = () =>
  execFileSync("pnpm", ["port"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .findLast((line) => /^\d+$/.test(line));

const waitForServer = async (appUrl: string) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const ready = await fetch(new URL("/login", appUrl))
      .then((response) => response.ok)
      .catch(() => false);

    if (ready) return;

    await delay(1000);
  }

  throw new Error(`Timed out waiting for ${appUrl}`);
};

export async function setup(_project: TestProject) {
  const port = getPort();

  if (!port) {
    throw new Error("Failed to resolve app port");
  }

  const appUrl = `http://localhost:${port}`;
  const devServer = spawn("pnpm", ["dev"], {
    cwd: rootDir,
    detached: true,
    env: { ...process.env },
    stdio: "ignore",
  });

  process.env.VITEST_BROWSER_APP_URL = appUrl;
  devServer.unref();

  try {
    await waitForServer(appUrl);
  } catch (error) {
    if (devServer.pid) {
      process.kill(-devServer.pid, "SIGTERM");
    }
    throw error;
  }

  return () => {
    if (devServer.pid) {
      try {
        process.kill(-devServer.pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
}
