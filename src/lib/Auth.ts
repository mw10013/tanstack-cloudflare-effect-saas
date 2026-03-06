import type { BetterAuthOptions } from "better-auth";
import type { Stripe as StripeTypes } from "stripe";
import type { Subscription as StripeSubscription } from "@better-auth/stripe";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, magicLink, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Config, Effect, Layer, Redacted, ServiceMap } from "effect";
import * as Option from "effect/Option";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { KV } from "./KV";
import { Repository } from "./Repository";
import { Stripe } from "./Stripe";

interface CreateBetterAuthOptions {
  db: D1Database;
  stripeClient: StripeTypes;
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, KV | Stripe | Repository>,
  ) => Promise<A>;
  betterAuthUrl: string;
  betterAuthSecret: Redacted.Redacted;
  transactionalEmail: string;
  stripeWebhookSecret: Redacted.Redacted;
  databaseHookUserCreateAfter?: NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["user"]
    >["create"]
  >["after"];
  databaseHookSessionCreateBefore?: NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
    >["create"]
  >["before"];
}

const createBetterAuthOptions = ({
  db,
  stripeClient,
  runEffect,
  betterAuthUrl,
  betterAuthSecret,
  transactionalEmail,
  stripeWebhookSecret,
  databaseHookUserCreateAfter,
  databaseHookSessionCreateBefore,
}: CreateBetterAuthOptions) =>
  ({
    baseURL: betterAuthUrl,
    secret: Redacted.value(betterAuthSecret),
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    database: db,
    user: { modelName: "User" },
    session: { modelName: "Session", storeSessionInDatabase: true },
    account: {
      modelName: "Account",
      accountLinking: { enabled: true },
    },
    verification: { modelName: "Verification" },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after:
            databaseHookUserCreateAfter ??
            ((user) =>
              runEffect(
                Effect.logDebug("databaseHooks.user.create.after", {
                  userId: user.id,
                }).pipe(
                  Effect.annotateLogs({
                    hook: "databaseHooks.user.create.after",
                  }),
                ),
              )),
        },
      },
      session: {
        create: {
          before:
            databaseHookSessionCreateBefore ??
            ((session) =>
              runEffect(
                Effect.logDebug("databaseHooks.session.create.before", {
                  sessionId: session.id,
                  userId: session.userId,
                }).pipe(
                  Effect.annotateLogs({
                    hook: "databaseHooks.session.create.before",
                  }),
                ),
              )),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware((ctx) =>
        runEffect(
          Effect.gen(function* () {
            if (
              ctx.path === "/subscription/upgrade" ||
              ctx.path === "/subscription/billing-portal" ||
              ctx.path === "/subscription/cancel-subscription"
            ) {
              yield* Effect.logInfo(
                "hooks.before.ensureBillingPortalConfiguration",
                {
                  path: ctx.path,
                },
              );
              const stripe = yield* Stripe;
              yield* stripe.ensureBillingPortalConfiguration();
            }
          }).pipe(
            Effect.annotateLogs({
              hook: "hooks.before",
              path: ctx.path,
            }),
          ),
        ),
      ),
    },
    plugins: [
      magicLink({
        storeToken: "hashed",
        sendMagicLink: (data) =>
          runEffect(
            Effect.gen(function* () {
              yield* Effect.logInfo("sendMagicLink", {
                email: data.email,
                url: data.url,
              });
              const kvService = yield* KV;
              yield* kvService.put("demo:magicLink", data.url, {
                expirationTtl: 60,
              });
              yield* Effect.logInfo("magicLink.email.simulation", {
                to: data.email,
                subject: "Your Magic Link",
                from: transactionalEmail,
              });
            }).pipe(
              Effect.annotateLogs({
                hook: "magicLink.sendMagicLink",
                email: data.email,
              }),
            ),
          ),
      }),
      admin(),
      organization({
        organizationLimit: 1,
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        schema: {
          organization: { modelName: "Organization" },
          member: { modelName: "Member" },
          invitation: { modelName: "Invitation" },
        },
        sendInvitationEmail: (data) =>
          runEffect(
            Effect.logInfo("organization.invitation.email.simulation", {
              email: data.email,
              from: transactionalEmail,
              subject: "You're invited!",
              url: `${betterAuthUrl}/accept-invitation/${data.id}`,
            }).pipe(
              Effect.annotateLogs({
                hook: "organization.sendInvitationEmail",
                invitationId: data.id,
              }),
            ),
          ),
      }),
      stripePlugin({
        stripeClient: stripeClient,
        stripeWebhookSecret: Redacted.value(stripeWebhookSecret),
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          requireEmailVerification: true,
          plans: () =>
            runEffect(
              Effect.gen(function* () {
                const stripe = yield* Stripe;
                return (yield* stripe.getPlans()).map((plan) => ({
                  name: plan.name,
                  priceId: plan.monthlyPriceId,
                  annualDiscountPriceId: plan.annualPriceId,
                  freeTrial: {
                    days: plan.freeTrialDays,
                    onTrialStart: (subscription: StripeSubscription) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialStart", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }).pipe(
                          Effect.annotateLogs({
                            hook: "stripe.subscription.onTrialStart",
                            planName: plan.name,
                            subscriptionId: subscription.id,
                          }),
                        ),
                      ),
                    onTrialEnd: ({
                      subscription,
                    }: {
                      subscription: StripeSubscription;
                    }) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialEnd", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }).pipe(
                          Effect.annotateLogs({
                            hook: "stripe.subscription.onTrialEnd",
                            planName: plan.name,
                            subscriptionId: subscription.id,
                          }),
                        ),
                      ),
                    onTrialExpired: (subscription: StripeSubscription) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialExpired", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }).pipe(
                          Effect.annotateLogs({
                            hook: "stripe.subscription.onTrialExpired",
                            planName: plan.name,
                            subscriptionId: subscription.id,
                          }),
                        ),
                      ),
                  },
                }));
              }).pipe(
                Effect.annotateLogs({ hook: "stripe.subscription.plans" }),
              ),
            ),
          authorizeReference: ({ user, referenceId, action }) =>
            runEffect(
              Effect.gen(function* () {
                const repository = yield* Repository;
                const member = yield* repository.getMemberByUserAndOrg({
                  userId: user.id,
                  organizationId: referenceId,
                });
                const result = Option.isSome(member) && member.value.role === "owner";
                yield* Effect.logDebug(
                  "stripe.subscription.authorizeReference",
                  {
                    userId: user.id,
                    referenceId,
                    action,
                    authorized: result,
                  },
                );
                return result;
              }).pipe(
                Effect.annotateLogs({
                  hook: "stripe.subscription.authorizeReference",
                  userId: user.id,
                  referenceId,
                  action,
                }),
              ),
            ),
          onSubscriptionComplete: ({ subscription, plan }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionComplete", {
                subscriptionId: subscription.id,
                planName: plan.name,
              }).pipe(
                Effect.annotateLogs({
                  hook: "stripe.subscription.onSubscriptionComplete",
                  subscriptionId: subscription.id,
                  planName: plan.name,
                }),
              ),
            ),
          onSubscriptionUpdate: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionUpdate", {
                subscriptionId: subscription.id,
              }).pipe(
                Effect.annotateLogs({
                  hook: "stripe.subscription.onSubscriptionUpdate",
                  subscriptionId: subscription.id,
                }),
              ),
            ),
          onSubscriptionCancel: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionCancel", {
                subscriptionId: subscription.id,
              }).pipe(
                Effect.annotateLogs({
                  hook: "stripe.subscription.onSubscriptionCancel",
                  subscriptionId: subscription.id,
                }),
              ),
            ),
          onSubscriptionDeleted: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionDeleted", {
                subscriptionId: subscription.id,
              }).pipe(
                Effect.annotateLogs({
                  hook: "stripe.subscription.onSubscriptionDeleted",
                  subscriptionId: subscription.id,
                }),
              ),
            ),
        },
        organization: {
          enabled: true,
          getCustomerCreateParams: (_organization, ctx) => {
            const userEmail = ctx.context.session?.user.email;
            return Promise.resolve(userEmail ? { email: userEmail } : {});
          },
        },
        schema: {
          subscription: {
            modelName: "Subscription",
          },
        },
        onCustomerCreate: ({ stripeCustomer, user }) =>
          runEffect(
            Effect.logInfo("stripe.onCustomerCreate", {
              stripeCustomerId: stripeCustomer.id,
              userEmail: user.email,
            }).pipe(
              Effect.annotateLogs({
                hook: "stripe.onCustomerCreate",
                stripeCustomerId: stripeCustomer.id,
                userEmail: user.email,
              }),
            ),
          ),
        onEvent: (event) =>
          runEffect(
            Effect.logInfo("stripe.onEvent", { type: event.type }).pipe(
              Effect.annotateLogs({
                hook: "stripe.onEvent",
                eventType: event.type,
              }),
            ),
          ),
      }),
      tanstackStartCookies(),
    ],
  }) satisfies BetterAuthOptions;

type BetterAuthInstance = ReturnType<
  typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>
>;

export class Auth extends ServiceMap.Service<Auth>()("Auth", {
  make: Effect.gen(function* () {
    const services = yield* Effect.services<KV | Stripe | Repository>();
    const runEffectBase = Effect.runPromiseWith(services);
    const runEffect = <A, E>(effect: Effect.Effect<A, E, KV | Stripe | Repository>) =>
      runEffectBase(effect.pipe(Effect.annotateLogs({ service: "Auth" })));
    const stripe = yield* Stripe;
    const authConfig = yield* Config.all({
      betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
      betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
      transactionalEmail: Config.nonEmptyString("TRANSACTIONAL_EMAIL"),
      stripeWebhookSecret: Config.redacted("STRIPE_WEBHOOK_SECRET"),
    });
    const { D1: db } = yield* CloudflareEnv;

    const auth: BetterAuthInstance = betterAuth(
      createBetterAuthOptions({
        db,
        stripeClient: stripe.stripe,
        runEffect,
        betterAuthUrl: authConfig.betterAuthUrl,
        betterAuthSecret: authConfig.betterAuthSecret,
        transactionalEmail: authConfig.transactionalEmail,
        stripeWebhookSecret: authConfig.stripeWebhookSecret,
        databaseHookUserCreateAfter: (user) =>
          runEffect(
            Effect.gen(function* () {
              if (user.role !== "user") return;
              yield* Effect.logInfo("databaseHooks.user.create.after", {
                userId: user.id,
                role: user.role,
              });
              const repository = yield* Repository;
              const org = yield* Effect.tryPromise(() =>
                auth.api.createOrganization({
                  body: {
                    name: `${user.email.charAt(0).toUpperCase() + user.email.slice(1)}'s Organization`,
                    slug: user.email.replace(/[^a-z0-9]/g, "-").toLowerCase(),
                    userId: user.id,
                  },
                }),
              );
              yield* Effect.logInfo("auth.organization.created", {
                userId: user.id,
                organizationId: org.id,
              });
              yield* repository.initializeActiveOrganizationForUserSessions({
                organizationId: org.id,
                userId: user.id,
              });
            }).pipe(
              Effect.withLogSpan("auth.user.create.after"),
              Effect.annotateLogs({
                hook: "databaseHooks.user.create.after",
                userId: user.id,
              }),
            ),
          ),
        databaseHookSessionCreateBefore: (session) =>
          runEffect(
            Effect.gen(function* () {
              yield* Effect.logDebug("databaseHooks.session.create.before", {
                sessionId: session.id,
                userId: session.userId,
              });
              const repository = yield* Repository;
              const activeOrganization = yield* repository.getOwnerOrganizationByUserId(
                session.userId,
              );
              return {
                data: {
                  ...session,
                  activeOrganizationId: Option.map(
                    activeOrganization,
                    (organization) => organization.id,
                  ).pipe(Option.getOrUndefined),
                },
              };
            }).pipe(
              Effect.withLogSpan("auth.session.create"),
              Effect.annotateLogs({
                hook: "databaseHooks.session.create.before",
                sessionId: session.id,
                userId: session.userId,
              }),
            ),
          ),
      }),
    );

    return {
      auth,
      api: auth.api,
      handler: Effect.fn("auth.handler")(function* (request: Request) {
        return yield* Effect.tryPromise(() => auth.handler(request));
      }),
      getSession: Effect.fn("auth.getSession")(function* (headers: Headers) {
        return yield* Effect.tryPromise(() =>
          auth.api.getSession({ headers }),
        );
      }),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

export type AuthTypes = ReturnType<
  typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>
>;


export const signOutServerFn = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect, request } }) =>
    runEffect(
      Effect.gen(function* () {
        const auth = yield* Auth;
        yield* Effect.tryPromise(() =>
          auth.api.signOut({ headers: request.headers }),
        );
        return yield* Effect.die(redirect({ to: "/" }));
      }),
    ),
);
