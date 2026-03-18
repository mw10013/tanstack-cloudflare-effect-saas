import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("integration smoke", () => {
  it("serves /", async () => {
    const response = await exports.default.fetch("http://example.com/");
    expect([200, 302]).toContain(response.status);
  });
});
