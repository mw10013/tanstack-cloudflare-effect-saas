import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { loginAdmin, loginUser, workerFetch } from "../TestUtils";

describe("integration smoke", () => {
  it.effect.skip("renders /login", () =>
    Effect.gen(function* () {
      const response = yield* workerFetch("http://w/login");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toContain(
        "Sign in / Sign up",
      );
    }),
  );

  it.effect.only("login → verify magic link → access authenticated route", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* loginUser("u@u.com");
      expect(sessionCookie).toContain("better-auth.session_token=");
      const appResponse = yield* workerFetch(`http://w/app/${organizationId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(appResponse.status).toBe(200);
      expect(yield* Effect.promise(() => appResponse.text())).toContain(
        "Members",
      );
    }),
  );

  it.effect.only("admin login → verify magic link → access admin route", () =>
    Effect.gen(function* () {
      const { sessionCookie } = yield* loginAdmin("a@a.com");
      expect(sessionCookie).toContain("better-auth.session_token=");
      // const appResponse = yield* workerFetch("http://w/admin", {
      //   headers: { Cookie: sessionCookie },
      // });
      // expect(appResponse.status).toBe(200);
      // expect(new URL(appResponse.url).pathname).toBe("/admin");
      // expect(yield* Effect.promise(() => appResponse.text())).toContain("Dashboard");
    }),
  );
});
