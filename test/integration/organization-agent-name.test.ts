import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("organization-agent name propagation", () => {
  it("idFromName sets name on id and stub", () => {
    const name = `org-name-${crypto.randomUUID()}`;
    const id = env.ORGANIZATION_AGENT.idFromName(name);
    const stub = env.ORGANIZATION_AGENT.get(id);

    expect(id.name).toBe(name);
    expect(stub.name).toBe(name);
  });
});
