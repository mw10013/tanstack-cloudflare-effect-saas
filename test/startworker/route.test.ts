import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

type StartWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

const root = path.resolve(__dirname, "../..");
const configPath = path.resolve(root, "dist/server/wrangler.json");
const persistPath = path.resolve(root, ".wrangler/state");

describe("startWorker routes", () => {
  let worker: StartWorker;

  beforeAll(async () => {
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "d1-local",
        "--local",
        "--persist-to",
        persistPath,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, NO_D1_WARNING: "true" },
      },
    );

    worker = await unstable_startWorker({
      config: configPath,
      entrypoint: path.resolve(root, "dist/server/index.js"),
      dev: {
        persist: persistPath,
        server: { port: 0 },
        inspector: false,
      },
    });
    await worker.ready;
  }, 120_000);

  afterAll(async () => {
    await worker.dispose();
  });

  it("serves /login", async () => {
    const response = await worker.fetch("http://example.com/login");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Send magic link");
  });

  it("serves / with SSR html", async () => {
    const response = await worker.fetch("http://example.com/");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("<!DOCTYPE html>");
  });
});
