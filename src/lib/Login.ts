import { createServerFn } from "@tanstack/react-start";
import { Config, Effect } from "effect";
import * as Schema from "effect/Schema";

import { Auth } from "@/lib/Auth";
import { KV } from "@/lib/KV";
import { Request } from "@/lib/Request";

export const loginSchema = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
});

export const login = createServerFn({
  method: "POST",
})
  .inputValidator(Schema.toStandardSchemaV1(loginSchema))
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const demoMode = yield* Config.boolean("DEMO_MODE").pipe(
          Config.withDefault(false),
        );

        const result = yield* Effect.tryPromise(() =>
          auth.api.signInMagicLink({
            headers: request.headers,
            body: { email: data.email, callbackURL: "/magic-link" },
          }),
        );
        if (!result.status) {
          return yield* Effect.fail(
            new Error("Failed to send magic link. Please try again."),
          );
        }
        const magicLink = demoMode
          ? ((yield* (yield* KV).get("demo:magicLink")) ?? undefined)
          : undefined;
        yield* Effect.logInfo("auth.magicLink.generated", { magicLink });
        return { success: true as const, magicLink };
      }),
    ),
  );
