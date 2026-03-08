import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { Session } from "@/lib/Session";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const session = yield* Session;
        if (!session?.user)
          return yield* Effect.die(redirect({ to: "/login" }));
        if (session.user.role !== "user")
          return yield* Effect.die(redirect({ to: "/" }));
        return { sessionUser: session.user };
      }),
    ),
);

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    return await beforeLoadServerFn();
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
