import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";

export interface UserProvisioningWorkflowParams {
  readonly userId: string;
  readonly email: string;
}

/**
 * Derives the name and slug for a user's auto-provisioned organization.
 *
 * The slug is a pure function of `userId` so the provisioning workflow can
 * recover idempotently: if `createOrganization` fails with
 * `ORGANIZATION_ALREADY_EXISTS` on retry, the workflow looks the org back up
 * by this exact slug (see `src/user-provisioning-workflow.ts`). Any scheme
 * that isn't deterministic from `userId` alone would break that guarantee.
 *
 * `userId` itself is used verbatim — it's already unique, and the slug is
 * never surfaced in URLs or UI, so no prefix or humanization is needed.
 */
export const getUserProvisioningOrganization = ({
  userId,
  email,
}: {
  readonly userId: Domain.User["id"];
  readonly email: Domain.User["email"];
}) => ({
  name: `${email.charAt(0).toUpperCase() + email.slice(1)}'s Organization`,
  slug: userId,
});

export const isWorkflowInstanceNotFoundError = (error: unknown) =>
  error instanceof Error && error.message.includes("instance.not_found");

export const ensureUserProvisionedWorkflow = Effect.fn(
  "ensureUserProvisionedWorkflow",
)(function* (params: UserProvisioningWorkflowParams) {
  const userId = yield* Schema.decodeUnknownEffect(Domain.User.fields.id)(
    params.userId,
  );
  const email = yield* Schema.decodeUnknownEffect(Domain.User.fields.email)(
    params.email,
  );
  const env = yield* CloudflareEnv;
  yield* Effect.tryPromise(() =>
    env.USER_PROVISIONING_WORKFLOW.createBatch([
      { id: userId, params: { userId, email } },
    ]),
  );
});
