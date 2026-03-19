import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyLocalMigrations,
  resetDb,
  startWorker,
  type StartWorker,
} from "./utils";

describe("startWorker auth routes", () => {
  let worker: StartWorker;

  beforeAll(async () => {
    applyLocalMigrations();
    worker = await startWorker();
  }, 120_000);

  afterAll(async () => {
    await worker.dispose();
  });

  beforeEach(() => {
    resetDb();
  });

  it("serves the login page", async () => {
    const response = await worker.fetch("http://example.com/login");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Send magic link");
  });

  it("redirects invalid magic-link verification back to the error page", async () => {
    const verifyResponse = await worker.fetch(
      "http://example.com/api/auth/magic-link/verify?token=bad&callbackURL=%2Fmagic-link",
      {
      redirect: "manual",
      headers: { Host: "example.com" },
      },
    );

    expect([301, 302, 303, 307, 308]).toContain(verifyResponse.status);
    expect(verifyResponse.headers.get("Location")).toContain(
      "/magic-link?error=INVALID_TOKEN",
    );
  });

  it("redirects /app to /login without a session", async () => {
    const response = await worker.fetch("http://example.com/app", {
      redirect: "manual",
    });

    expect([301, 302, 303, 307, 308]).toContain(response.status);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("renders the magic-link error page", async () => {
    const response = await worker.fetch(
      "http://example.com/magic-link?error=INVALID_TOKEN",
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Magic Link Error");
  });
});
