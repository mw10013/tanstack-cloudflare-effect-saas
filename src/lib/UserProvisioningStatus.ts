import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { Request } from "@/lib/Request";
import { isWorkflowInstanceNotFoundError } from "@/lib/UserProvisioning";

export type ProvisioningStatus =
  | {
      readonly status: "ready";
      readonly organizationId: Domain.Organization["id"];
    }
  | { readonly status: "pending" }
  | { readonly status: "failed" };

export const getProvisioningStatusServerFn = createServerFn({ method: "GET" })
  .handler(({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const session = yield* auth
          .getSession(request.headers)
          .pipe(Effect.flatMap(Effect.fromOption));
        const userId = yield* Schema.decodeUnknownEffect(Domain.User.fields.id)(
          session.user.id,
        );
        const repository = yield* Repository;
        const ownerOrganization =
          yield* repository.getOwnerOrganizationByUserId(userId);
        if (Option.isSome(ownerOrganization)) {
          return {
            status: "ready",
            organizationId: ownerOrganization.value.id,
          } as const;
        }
        const env = yield* CloudflareEnv;
        const instance = yield* Effect.tryPromise(() =>
          env.USER_PROVISIONING_WORKFLOW.get(userId),
        ).pipe(
          Effect.catch((error) =>
            isWorkflowInstanceNotFoundError(error)
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        if (!instance) return { status: "pending" } as const;
        const snapshot = yield* Effect.tryPromise(() => instance.status());
        return snapshot.status === "errored" || snapshot.status === "terminated"
          ? ({ status: "failed" } as const)
          : ({ status: "pending" } as const);
      }),
    ),
  );
