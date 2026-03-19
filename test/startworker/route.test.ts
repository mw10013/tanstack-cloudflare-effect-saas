import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyLocalMigrations,
  startWorker,
  type StartWorker,
} from "./utils";

describe("startWorker routes", () => {
  let worker: StartWorker;

  beforeAll(async () => {
    applyLocalMigrations();
    worker = await startWorker();
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
