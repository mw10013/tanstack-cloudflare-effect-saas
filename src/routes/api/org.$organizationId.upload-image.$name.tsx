import { createFileRoute } from "@tanstack/react-router";
import { Config, Effect } from "effect";
import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export const Route = createFileRoute("/api/org/$organizationId/upload-image/$name")({
  server: {
    handlers: {
      GET: async ({ request, params: { organizationId, name }, context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const environment = yield* Config.nonEmptyString("ENVIRONMENT");
            const { R2 } = yield* CloudflareEnv;
            if (environment !== "local") {
              return new Response("Not Found", { status: 404 });
            }
            const auth = yield* Auth;
            const session = yield* Effect.fromNullishOr(
              yield* Effect.tryPromise(() =>
                auth.api.getSession({ headers: request.headers }),
              ),
            );
            if (session.session.activeOrganizationId !== organizationId) {
              return new Response("Forbidden", { status: 403 });
            }
            const key = `${organizationId}/${name}`;
            const object = yield* Effect.tryPromise(() => R2.get(key));
            if (!object?.body) {
              return new Response("Not Found", { status: 404 });
            }
            return new Response(object.body, {
              headers: {
                "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
                "Cache-Control": "private, max-age=60",
                ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
              },
            });
          }),
        ),
    },
  },
});
