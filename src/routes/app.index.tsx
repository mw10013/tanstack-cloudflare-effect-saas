import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
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
