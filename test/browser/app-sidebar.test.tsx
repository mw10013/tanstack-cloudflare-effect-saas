/* oxlint-disable */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { OrganizationAgentProvider } from "@/lib/OrganizationAgentContext";
import { AppSidebar } from "@/routes/app.$organizationId";

import { fakeAgent, fakeOrg, fakeUser } from "./fixtures";

const buildTestRouter = (initialPath: string) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    component: () => <Outlet />,
  });
  const orgRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "$organizationId",
    component: () => (
      <SidebarProvider>
        <AppSidebar
          organization={fakeOrg}
          organizations={[fakeOrg]}
          user={fakeUser}
        />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const childPaths = [
    "/",
    "invoices",
    "invitations",
    "members",
    "billing",
  ] as const;
  const childRoutes = childPaths.map((path) =>
    createRoute({
      getParentRoute: () => orgRoute,
      path,
      component: () => null,
    }),
  );
  const routeTree = rootRoute.addChildren([
    appRoute.addChildren([orgRoute.addChildren(childRoutes)]),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

const renderSidebar = (initialPath: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = buildTestRouter(initialPath);
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationAgentProvider value={fakeAgent}>
        <RouterProvider router={router} />
      </OrganizationAgentProvider>
    </QueryClientProvider>,
  );
};

describe("AppSidebar", () => {
  it("renders nav links with the active organization context", async () => {
    renderSidebar(`/app/${fakeOrg.id}/invoices`);

    await expect
      .element(page.getByRole("link", { name: "Invoices" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Members" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Billing" }))
      .toBeInTheDocument();
  });

  it("shows the organization name and user email", async () => {
    renderSidebar(`/app/${fakeOrg.id}`);

    await expect.element(page.getByText(fakeOrg.name)).toBeInTheDocument();
    await expect.element(page.getByText(fakeUser.email)).toBeInTheDocument();
  });

  it("points the invoices link at the correct org-scoped href", async () => {
    renderSidebar(`/app/${fakeOrg.id}`);

    await expect
      .element(page.getByRole("link", { name: "Invoices" }))
      .toHaveAttribute("href", `/app/${fakeOrg.id}/invoices`);
  });
});
