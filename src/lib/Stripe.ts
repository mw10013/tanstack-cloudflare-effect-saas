import type { Plan } from "@/lib/Domain";
import type { Stripe as StripeTypes } from "stripe";
import { Cause, Config, Data, Effect, Layer, Redacted, ServiceMap } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as StripeClient from "stripe";
import { planData, Plan as PlanSchema } from "@/lib/Domain";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

type Price = StripeTypes.Price;
type PriceWithLookupKey = Price & { lookup_key: string };

const isPriceWithLookupKey = (price: Price): price is PriceWithLookupKey =>
  price.lookup_key !== null;

export class StripeError extends Data.TaggedError("StripeError")<{
  readonly op: string;
  readonly message: string;
  readonly cause: Error;
}> {}

const toCause = (error: unknown) =>
  Cause.isUnknownError(error) && error.cause instanceof Error
    ? error.cause
    : error instanceof Error
      ? error
      : new Error(String(error));

const tryStripe = <A>(op: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause = toCause(error);
      return new StripeError({ op, message: cause.message, cause });
    }),
  );

const failStripe = (op: string, message: string) =>
  Effect.fail(new StripeError({ op, message, cause: new Error(message) }));

const requirePriceWithLookupKey = (price: Price) =>
  price.lookup_key === null
    ? failStripe("Stripe.getPlans", "Missing lookup_key")
    : Effect.succeed(price);

export class Stripe extends ServiceMap.Service<Stripe>()("Stripe", {
  make: Effect.gen(function* () {
    const stripeSecretKey = yield* Config.redacted("STRIPE_SECRET_KEY");
    const { KV } = yield* CloudflareEnv;
    const stripe = new StripeClient.Stripe(Redacted.value(stripeSecretKey), {
      apiVersion: "2025-10-29.clover",
    });

    const getPrices = Effect.fn("Stripe.getPrices")(function* () {
        const lookupKeys = planData.flatMap((plan) => [
          plan.monthlyPriceLookupKey,
          plan.annualPriceLookupKey,
        ]);
        const priceList = yield* tryStripe("Stripe.prices.list", () =>
          stripe.prices.list({
            lookup_keys: lookupKeys,
            expand: ["data.product"],
          }),
        );
        if (priceList.data.length === 0) {
          const products = yield* Effect.all(
            planData.map((plan) =>
              tryStripe("Stripe.products.create", () =>
                stripe.products.create({
                  name: plan.displayName,
                  description: `${plan.displayName} plan.`,
                }),
              ).pipe(Effect.map((product) => ({ plan, product }))),
            ),
          );
          const prices = yield* Effect.all(
            products.flatMap(({ plan, product }) => [
              tryStripe("Stripe.prices.create", () =>
                stripe.prices.create({
                  product: product.id,
                  unit_amount: plan.monthlyPriceInCents,
                  currency: "usd",
                  recurring: { interval: "month" },
                  lookup_key: plan.monthlyPriceLookupKey,
                  expand: ["product"],
                }),
              ),
              tryStripe("Stripe.prices.create", () =>
                stripe.prices.create({
                  product: product.id,
                  unit_amount: plan.annualPriceInCents,
                  currency: "usd",
                  recurring: { interval: "year" },
                  lookup_key: plan.annualPriceLookupKey,
                  expand: ["product"],
                }),
              ),
            ]),
          );
          return yield* Effect.all(prices.map(requirePriceWithLookupKey));
        }
        const prices = priceList.data.filter(isPriceWithLookupKey);
        if (prices.length !== planData.length * 2) {
          return yield* failStripe(
            "Stripe.getPlans",
            `Count of prices not ${String(planData.length * 2)} (${String(prices.length)})`,
          );
        }
        return prices;
      });

    const getPlans = Effect.fn("Stripe.getPlans")(function* () {
        const key = "stripe:plans";
        const cachedPlans = yield* tryStripe("KV.get(stripe:plans)", () =>
          KV.get(key, { type: "json" }),
        );
        if (cachedPlans) {
          const parseResult = Schema.decodeUnknownOption(Schema.Array(PlanSchema))(
            cachedPlans,
          );
          if (Option.isSome(parseResult)) {
            console.log(`stripeService: getPlans: cache hit`);
            return [...parseResult.value] as readonly Plan[];
          }
        }
        console.log(`stripeService: getPlans: cache miss`);
        const prices = yield* getPrices();
        const plans = yield* Effect.all(
          planData.map((plan) =>
            Effect.gen(function* () {
              const monthlyPrice = prices.find(
                (price) => price.lookup_key === plan.monthlyPriceLookupKey,
              );
              if (!monthlyPrice) {
                return yield* failStripe(
                  "Stripe.getPlans",
                  `Missing monthly price for ${plan.name}`,
                );
              }
              if (typeof monthlyPrice.product === "string") {
                return yield* failStripe(
                  "Stripe.getPlans",
                  "Product should be expanded",
                );
              }
              const annualPrice = prices.find(
                (price) => price.lookup_key === plan.annualPriceLookupKey,
              );
              if (!annualPrice) {
                return yield* failStripe(
                  "Stripe.getPlans",
                  `Missing annual price for ${plan.name}`,
                );
              }
              return {
                name: plan.name,
                displayName: plan.displayName,
                description: plan.description,
                productId: monthlyPrice.product.id,
                monthlyPriceId: monthlyPrice.id,
                monthlyPriceLookupKey: plan.monthlyPriceLookupKey,
                monthlyPriceInCents: plan.monthlyPriceInCents,
                annualPriceId: annualPrice.id,
                annualPriceLookupKey: plan.annualPriceLookupKey,
                annualPriceInCents: plan.annualPriceInCents,
                freeTrialDays: plan.freeTrialDays,
              };
            }),
          ),
        );
        yield* tryStripe("KV.put(stripe:plans)", () =>
          KV.put(key, JSON.stringify(plans)),
        );
        return plans as readonly Plan[];
      });

    const ensureBillingPortalConfiguration = Effect.fn("Stripe.ensureBillingPortalConfiguration")(function* () {
        const key = "stripe:isBillingPortalConfigured";
        const isConfigured = yield* tryStripe(
          "KV.get(stripe:isBillingPortalConfigured)",
          () => KV.get(key),
        );
        if (isConfigured === "true") return;
        const configurations = yield* tryStripe(
          "Stripe.billingPortal.configurations.list",
          () =>
            stripe.billingPortal.configurations.list({
              limit: 2,
            }),
        );
        if (configurations.data.length === 0) {
          const plans = yield* getPlans();
          const basicPlan = plans.find((plan) => plan.name === "basic");
          if (!basicPlan) {
            return yield* failStripe(
              "Stripe.ensureBillingPortalConfiguration",
              "Missing basic plan",
            );
          }
          const proPlan = plans.find((plan) => plan.name === "pro");
          if (!proPlan) {
            return yield* failStripe(
              "Stripe.ensureBillingPortalConfiguration",
              "Missing pro plan",
            );
          }
          yield* tryStripe("Stripe.billingPortal.configurations.create", () =>
            stripe.billingPortal.configurations.create({
              business_profile: {
                headline: "Manage your subscription and billing information",
              },
              features: {
                customer_update: {
                  enabled: true,
                  allowed_updates: ["name", "phone"],
                },
                invoice_history: {
                  enabled: true,
                },
                payment_method_update: {
                  enabled: true,
                },
                subscription_cancel: {
                  enabled: true,
                  mode: "immediately",
                  proration_behavior: "create_prorations",
                },
                subscription_update: {
                  enabled: true,
                  default_allowed_updates: ["price"],
                  proration_behavior: "create_prorations",
                  products: [
                    {
                      product: basicPlan.productId,
                      prices: [basicPlan.monthlyPriceId, basicPlan.annualPriceId],
                    },
                    {
                      product: proPlan.productId,
                      prices: [proPlan.monthlyPriceId, proPlan.annualPriceId],
                    },
                  ],
                },
              },
            }),
          );
          console.log(
            `stripeService: ensureBillingPortalConfiguration: created billing portal configuration`,
          );
        } else {
          if (configurations.data.length > 1) {
            console.log(
              "WARNING: More than 1 billing portal configuration found. Should not be more than 1.",
            );
          }
          yield* tryStripe("KV.put(stripe:isBillingPortalConfigured)", () =>
            KV.put(key, "true"),
          );
        }
      });

    return {
      stripe,
      getPlans,
      ensureBillingPortalConfiguration,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
