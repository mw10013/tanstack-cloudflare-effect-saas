/* oxlint-disable */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { fakeAgent, fakeOrg, fakeUser } from "./fixtures";

vi.mock("agents/react", () => ({
  useAgent: () => fakeAgent,
}));

const { Route: RootRoute } = await import("@/routes/__root");
const { Route: AppRoute } = await import("@/routes/app");
const { Route: OrgRoute } = await import("@/routes/app.$organizationId");
const { Route: OrgIndexRoute } = await import(
  "@/routes/app.$organizationId.index"
);
const { routeTree } = await import("@/routeTree.gen");

const patch = (route: { options: object }, overrides: object) =>
  Object.assign(route.options, overrides);

beforeAll(() => {
  patch(RootRoute, {
    loader: () => ({ analyticsToken: "" }),
    shellComponent: ({ children }: { children: ReactNode }) => children,
  });
  patch(AppRoute, { beforeLoad: () => ({ sessionUser: fakeUser }) });
  patch(OrgRoute, {
    beforeLoad: () => ({
      organization: fakeOrg,
      organizations: [fakeOrg],
      sessionUser: fakeUser,
    }),
  });
  patch(OrgIndexRoute, {
    loader: () => ({
      userInvitations: [],
      memberCount: 7,
      pendingInvitationCount: 3,
    }),
  });
});

const renderAt = (path: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe("/app/$organizationId/ dashboard", () => {
  it("renders member and pending invitation counts from the loader", async () => {
    renderAt(`/app/${fakeOrg.id}`);

    await expect
      .element(page.getByTestId("member-count"))
      .toHaveTextContent("7");
    await expect.element(page.getByText("3")).toBeInTheDocument();
  });

  it("hides the invitations card when the user has none", async () => {
    renderAt(`/app/${fakeOrg.id}`);

    await expect
      .element(page.getByRole("heading", { name: "Invitations" }))
      .not.toBeInTheDocument();
  });

  it("renders the sidebar with the active org via the real route tree", async () => {
    renderAt(`/app/${fakeOrg.id}`);

    await expect.element(page.getByText(fakeOrg.name)).toBeInTheDocument();
    await expect.element(page.getByText(fakeUser.email)).toBeInTheDocument();
  });
});
