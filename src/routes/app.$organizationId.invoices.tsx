import { Outlet, createFileRoute } from "@tanstack/react-router";

import {
  getInvoices,
  invoicesQueryKey,
} from "@/lib/Invoices";

export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: async ({ params: { organizationId }, context }) => {
    await context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
      revalidateIfStale: true,
    });
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
