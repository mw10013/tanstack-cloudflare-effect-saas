import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { Session } from "@/lib/Session";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const session = yield* Session;
        const validSession = yield* Effect.fromNullishOr(session);
        const activeOrganizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        return yield* Effect.die(
          redirect({
            to: "/app/$organizationId",
            params: { organizationId: activeOrganizationId },
          }),
        );
      }),
    ),
);

export const Route = createFileRoute("/app/")({
  beforeLoad: async () => await beforeLoadServerFn(),
});
