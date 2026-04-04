import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { login } from "@/lib/Login";

import { resetDb, runServerFn } from "../test-utils";

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
