import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Navigate,
  redirect,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getProvisioningStatusServerFn } from "@/lib/UserProvisioningStatus";

/**
 * Route shown while the Cloudflare `USER_PROVISIONING_WORKFLOW` is still
 * running for the signed-in user.
 *
 * The loader performs a single server-side status check so SSR can skip the
 * spinner entirely when provisioning has already finished:
 * - `"ready"` → throws a `redirect()` to the user's owner organization.
 * - `"pending"` / `"failed"` → returned as loader data and rendered by
 *   {@link RouteComponent}, which continues polling client-side.
 */
export const Route = createFileRoute("/app/provisioning")({
  loader: async () => {
    const status = await getProvisioningStatusServerFn();
    if (status.status === "ready") {
      // oxlint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({
        to: "/app/$organizationId",
        params: { organizationId: status.organizationId },
      });
    }
    return status;
  },
  component: RouteComponent,
});

/**
 * Client component that polls provisioning status until it reaches a terminal
 * state.
 *
 * Polling is driven by react-query's `refetchInterval` with exponential
 * backoff: starts at 500 ms and doubles on each pending refetch up to a 5 s
 * ceiling, so a wedged workflow does not hammer the worker. Polling halts
 * (`false`) once the workflow reaches `"ready"` or `"failed"`. Loader data
 * seeds `initialData` so the first paint reflects the SSR status with no
 * loading flash.
 *
 * On `"ready"` the component returns `<Navigate>` to the owner organization
 * declaratively — no `useEffect` is needed for the side-effectful redirect.
 * On `"failed"` the component renders a destructive alert instructing the
 * user to contact support. Transient fetch errors (network blips) surface as
 * a secondary alert without halting the poll.
 */
function RouteComponent() {
  const initialData = Route.useLoaderData();
  const { data: status, error } = useQuery({
    queryKey: ["provisioning-status"],
    queryFn: () => getProvisioningStatusServerFn(),
    initialData,
    // Exponential backoff: 500ms → 1s → 2s → 4s → 5s (capped). Halts on
    // terminal states. `dataUpdateCount` increments per successful refetch,
    // so a stuck workflow stays backed-off even after transient errors.
    refetchInterval: ({ state }) =>
      state.data?.status === "pending"
        ? Math.min(500 * 2 ** state.dataUpdateCount, 5000)
        : false,
  });

  if (status.status === "ready") {
    return (
      <Navigate
        to="/app/$organizationId"
        params={{ organizationId: status.organizationId }}
        replace
      />
    );
  }

  const isFailed = status.status === "failed";

  return (
    <div className="flex min-h-[50svh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {isFailed ? "Provisioning failed" : "Setting up your account"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isFailed ? (
            <Alert variant="destructive">
              <AlertTitle>We couldn't provision your workspace</AlertTitle>
              <AlertDescription>
                Something went wrong setting up your account. Please contact
                support.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Please wait while we provision your workspace.</span>
            </div>
          )}
          {error && !isFailed ? (
            <Alert variant="destructive">
              <AlertTitle>Provisioning check failed</AlertTitle>
              <AlertDescription>
                {error instanceof Error ? error.message : String(error)}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
