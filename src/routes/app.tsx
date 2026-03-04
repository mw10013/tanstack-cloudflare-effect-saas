import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
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
