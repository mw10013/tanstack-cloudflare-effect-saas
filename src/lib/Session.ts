import { Effect, Layer, ServiceMap } from "effect";
import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";

export class Session extends ServiceMap.Service<Session>()("Session", {
  make: Effect.gen(function* () {
    const request = yield* Request;
    const auth = yield* Auth;
    return (yield* auth.getSession(request.headers)) ?? undefined;
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
