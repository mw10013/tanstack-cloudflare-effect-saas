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
 * Provisions a user's owner organization idempotently.
 *
 * Flow:
 * 1) create organization by deterministic slug (`slug = userId`)
 * 2) on ORGANIZATION_ALREADY_EXISTS or YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS,
 *    resolve organization by that same slug
 * 3) add owner membership
 * 4) on USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION, treat as success
 *
 * If slug lookup fails during recovery, the error is propagated so we do not
 * silently attach the user to an unrelated organization.
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
    const { name, slug } = getUserProvisioningOrganization({ userId, email });
    const organizationId = yield* Effect.tryPromise({
      try: () => auth.api.createOrganization({ body: { name, slug, userId } }),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((created) => decodeOrganizationId(created.id)),
      Effect.catch((error) =>
        isAPIError(error) &&
        (error.body?.code === "ORGANIZATION_ALREADY_EXISTS" ||
          error.body?.code ===
            "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS")
          ? Effect.gen(function* () {
              const organizationBySlug =
                yield* repository.getOrganizationBySlug(slug);
              if (Option.isSome(organizationBySlug)) {
                return organizationBySlug.value.id;
              }
              return yield* Effect.fail(error);
            })
          : Effect.fail(error),
      ),
    );
    yield* Effect.tryPromise({
      try: () =>
        auth.api.addMember({
          body: {
            userId,
            organizationId,
            role: "owner",
          },
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) =>
        isAPIError(error) &&
        error.body?.code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"
          ? Effect.void
          : Effect.fail(error),
      ),
    );
    return organizationId;
  },
);

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
              Effect.gen(function* () {
                const repository = yield* Repository;
                yield* repository.initializeActiveOrganizationForUserSessions({
                  userId,
                  organizationId,
                });
              }),
            ),
          ),
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
