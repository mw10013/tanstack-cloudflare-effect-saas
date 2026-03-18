import { Effect, Layer, ServiceMap } from "effect";
import * as Option from "effect/Option";

import { CloudflareEnv } from "../../src/lib/CloudflareEnv";
import { D1 } from "../../src/lib/D1";
import { Repository } from "../../src/lib/Repository";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/__test/d1") {
      const result = await env.D1.prepare(
        "select id, email, role from User where id = ?",
      )
        .bind("admin")
        .first();

      return Response.json(result ?? null);
    }

    if (url.pathname === "/__test/repository-user") {
      const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
      const d1Layer = Layer.provideMerge(D1.layer, envLayer);
      const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
      const user = await Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* Repository;
          return Option.getOrThrow(yield* repository.getUser("a@a.com"));
        }).pipe(Effect.provide(repositoryLayer)),
      );

      return Response.json(user);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
