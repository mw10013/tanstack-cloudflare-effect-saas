import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { loginAdmin, loginUser, workerFetch } from "../TestUtils";

describe("integration smoke", () => {
  it.effect("login user", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* loginUser("u@u.com");
      expect(sessionCookie).toContain("better-auth.session_token=");
      const appResponse = yield* workerFetch(`http://w/app/${organizationId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(appResponse.status).toBe(200);
    }),
  );

  it.effect("admin login → verify magic link → access admin route", () =>
    Effect.gen(function* () {
      const { sessionCookie } = yield* loginAdmin("a@a.com");
      expect(sessionCookie).toContain("better-auth.session_token=");
      const appResponse = yield* workerFetch("http://w/admin", {
        headers: { Cookie: sessionCookie },
      });
      expect(appResponse.status).toBe(200);
    }),
  );
});
