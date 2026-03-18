import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("integration smoke", () => {
  it("can query D1 after migrations", async () => {
    const response = await exports.default.fetch("http://example.com/__test/d1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "admin",
      email: "a@a.com",
      role: "admin",
    });
  });

  it("can exercise a shared app module through Repository", async () => {
    const response = await exports.default.fetch(
      "http://example.com/__test/repository-user",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "admin",
      email: "a@a.com",
      role: "admin",
    });
  });
});
