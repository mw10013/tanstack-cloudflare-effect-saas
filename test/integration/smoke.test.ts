import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("integration smoke", () => {
  it("dispatches to a minimal Worker entrypoint", async () => {
    const response = await exports.default.fetch("http://example.com/__test/ping");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      environment: env.ENVIRONMENT,
    });
  });

  it("can round-trip KV state", async () => {
    const response = await exports.default.fetch(
      "http://example.com/__test/kv?key=smoke&value=ok",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ key: "smoke", value: "ok" });
    await expect(env.KV.get("smoke")).resolves.toBe("ok");
  });

  it("can query D1 after migrations", async () => {
    const response = await exports.default.fetch("http://example.com/__test/d1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: 1 });
  });
});
