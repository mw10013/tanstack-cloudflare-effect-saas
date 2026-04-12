import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { isAPIError } from "better-auth/api";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Auth } from "@/lib/Auth";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { KV } from "@/lib/KV";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";
import { Stripe } from "@/lib/Stripe";
import {
  getUserProvisioningOrganization,
  type UserProvisioningWorkflowParams,
} from "@/lib/UserProvisioning";

const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const kvLayer = Layer.provideMerge(KV.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const d1KvLayer = Layer.merge(d1Layer, kvLayer);
  const stripeLayer = Layer.provideMerge(
    Stripe.layer,
    Layer.merge(repositoryLayer, d1KvLayer),
  );
  const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
  return Layer.mergeAll(authLayer, repositoryLayer, makeLoggerLayer(env));
};

/**
 * Idempotently provisions the user's owner organization and returns its id.
 *
 * Better Auth's `auth.api.createOrganization` is not transactional: the org
 * row and the owner `Member` row are two separate adapter writes
 * (`refs/better-auth/.../routes/crud-org.ts` steps 6 and 8). A crash between
 * them leaves an org with no member for the creator. This function reconciles
 * all three observable states:
 *
 * 1. Org + owner member exist → short-circuit via `getOwnerOrganizationByUserId`.
 * 2. Neither exists → `createOrganization` succeeds normally.
 * 3. Org exists, owner member missing → `createOrganization` throws
 *    `ORGANIZATION_ALREADY_EXISTS` (slug collision on the unique slug), we
 *    look the org up by slug and call `addMember` to finish provisioning.
 *
 * The slug is derived from `userId` (see `getUserProvisioningOrganization`),
 * so the `ORGANIZATION_ALREADY_EXISTS` path can only ever match this user's
 * own org — it cannot capture a different user's org.
 */
const createOrganization = Effect.fn("userProvisioning.createOrganization")(
  function* ({
    userId,
    email,
  }: {
    userId: Domain.User["id"];
    email: Domain.User["email"];
  }) {
    const repository = yield* Repository;
    const auth = yield* Auth;
    const decodeOrganizationId = Schema.decodeUnknownEffect(
      Domain.Organization.fields.id,
    );
    const ownerOrganization =
      yield* repository.getOwnerOrganizationByUserId(userId);
    if (Option.isSome(ownerOrganization)) return ownerOrganization.value.id;
    const { name, slug } = getUserProvisioningOrganization({ userId, email });
    return yield* Effect.tryPromise(() =>
      auth.api.createOrganization({ body: { name, slug, userId } }),
    ).pipe(
      Effect.flatMap((created) => decodeOrganizationId(created.id)),
      Effect.catch((error) =>
        isAPIError(error) &&
        error.body?.code === "ORGANIZATION_ALREADY_EXISTS"
          ? Effect.gen(function* () {
              const organizationBySlug =
                yield* repository.getOrganizationBySlug(slug);
              if (Option.isNone(organizationBySlug)) {
                return yield* Effect.fail(error);
              }
              const organizationId = organizationBySlug.value.id;
              const existingMember = yield* repository.getMemberByUserAndOrg({
                userId,
                organizationId,
              });
              if (Option.isNone(existingMember)) {
                yield* Effect.tryPromise(() =>
                  auth.api.addMember({
                    body: { userId, organizationId, role: "owner" },
                  }),
                ).pipe(
                  Effect.catch((addMemberError) =>
                    isAPIError(addMemberError) &&
                    addMemberError.body?.code ===
                      "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"
                      ? Effect.void
                      : Effect.fail(addMemberError),
                  ),
                );
              }
              return organizationId;
            })
          : Effect.fail(error),
      ),
    );
  },
);

const initializeActiveOrganizationForUserSessions = Effect.fn(
  "userProvisioning.initializeActiveOrganizationForUserSessions",
)(function* ({
  userId,
  organizationId,
}: {
  userId: Domain.User["id"];
  organizationId: Domain.Organization["id"];
}) {
  const repository = yield* Repository;
  yield* repository.initializeActiveOrganizationForUserSessions({
    userId,
    organizationId,
  });
});

export class UserProvisioningWorkflow extends WorkflowEntrypoint<
  Env,
  UserProvisioningWorkflowParams
> {
  async run(event: WorkflowEvent<UserProvisioningWorkflowParams>, step: WorkflowStep) {
    const runtimeLayer = makeRuntimeLayer(this.env);
    const organizationAgent = this.env.ORGANIZATION_AGENT;
    return Effect.runPromise(
      Effect.gen(function* () {
        const userId = yield* Schema.decodeUnknownEffect(Domain.User.fields.id)(
          event.payload.userId,
        );
        const email = yield* Schema.decodeUnknownEffect(
          Domain.User.fields.email,
        )(event.payload.email);
        const services = yield* Effect.context<Layer.Success<typeof runtimeLayer>>();
        const runEffect = Effect.runPromiseWith(services);
        const organizationId = yield* Effect.tryPromise(() =>
          step.do("create-organization", () =>
            runEffect(createOrganization({ userId, email })),
          ),
        );
        yield* Effect.tryPromise(() =>
          step.do("initialize-active-organization-for-sessions", () =>
            runEffect(
              initializeActiveOrganizationForUserSessions({
                userId,
                organizationId,
              }),
            ),
          ),
        );
        yield* Effect.tryPromise(() =>
          step.do("init-organization-agent", async () => {
            const id = organizationAgent.idFromName(organizationId);
            const stub = organizationAgent.get(id);
            await stub.setName(organizationId);
          }),
        );
        yield* Effect.tryPromise(() =>
          step.do("sync-membership", async () => {
            const id = organizationAgent.idFromName(organizationId);
            const stub = organizationAgent.get(id);
            await stub.syncMembership({ userId, change: "added" });
          }),
        );
        return { organizationId };
      }).pipe(Effect.provide(runtimeLayer)),
    );
  }
}
