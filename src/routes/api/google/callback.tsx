import { createFileRoute } from "@tanstack/react-router";
import { Config, Effect } from "effect";
import * as Option from "effect/Option";
import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { exchangeGoogleAuthorizationCode } from "@/lib/google-oauth-client";

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request, context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            const betterAuthUrl = yield* Config.nonEmptyString("BETTER_AUTH_URL");
            const googleClientId = yield* Config.nonEmptyString("GOOGLE_OAUTH_CLIENT_ID");
            const googleClientSecret = yield* Config.redacted("GOOGLE_OAUTH_CLIENT_SECRET");
            const googleRedirectUri = yield* Config.nonEmptyString("GOOGLE_OAUTH_REDIRECT_URI");
            const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
            const session = yield* Effect.tryPromise(() =>
              auth.api.getSession({ headers: request.headers }),
            );
            if (!session?.session.activeOrganizationId) {
              return new Response("Unauthorized", { status: 401 });
            }
            const organizationId = session.session.activeOrganizationId;
            const callbackUrl = new URL(request.url);
            const code = callbackUrl.searchParams.get("code");
            const state = callbackUrl.searchParams.get("state");
            const providerError = callbackUrl.searchParams.get("error");
            if (providerError) {
              return Response.redirect(
                `${betterAuthUrl}/app/${organizationId}/google?google=denied`,
                302,
              );
            }
            if (!code || !state) {
              return Response.redirect(
                `${betterAuthUrl}/app/${organizationId}/google?google=error`,
                302,
              );
            }
            const id = ORGANIZATION_AGENT.idFromName(organizationId);
            const stub = ORGANIZATION_AGENT.get(id);
            const stateResult = yield* Effect.tryPromise(async () =>
              stub.consumeGoogleOAuthState(state),
            );
            if (!stateResult.ok) {
              return Response.redirect(
                `${betterAuthUrl}/app/${organizationId}/google?google=error`,
                302,
              );
            }

            const tokenOption = yield* Effect.option(
              exchangeGoogleAuthorizationCode({
                clientId: googleClientId,
                clientSecret: googleClientSecret,
                redirectUri: googleRedirectUri,
                currentUrl: callbackUrl,
                codeVerifier: stateResult.codeVerifier,
                expectedState: state,
              }),
            );
            if (Option.isNone(tokenOption)) {
              return Response.redirect(
                `${betterAuthUrl}/app/${organizationId}/google?google=error`,
                302,
              );
            }
            const token = tokenOption.value;
            yield* Effect.tryPromise(() =>
              stub.saveGoogleTokens({
                accessToken: token.access_token,
                accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
                refreshToken: token.refresh_token,
                scope: token.scope ?? "",
                idToken: token.id_token,
              }),
            );
            return Response.redirect(
              `${betterAuthUrl}/app/${organizationId}/google?google=connected`,
              302,
            );
          }),
        ),
    },
  },
});
