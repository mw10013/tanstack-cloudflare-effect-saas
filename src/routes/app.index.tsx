import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { getProvisioningStatusServerFn } from "@/lib/UserProvisioningStatus";

const beforeLoadServerFn = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const provisioningStatus = yield* Effect.tryPromise(() =>
          getProvisioningStatusServerFn(),
        );
        if (provisioningStatus.status === "ready") {
          return yield* Effect.die(
            redirect({
              to: "/app/$organizationId",
              params: { organizationId: provisioningStatus.organizationId },
            }),
          );
        }
        return yield* Effect.die(redirect({ to: "/app/provisioning" }));
      }),
    ),
);

export const Route = createFileRoute("/app/")({
  beforeLoad: async () => await beforeLoadServerFn(),
});
