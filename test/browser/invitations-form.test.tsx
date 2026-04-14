/* oxlint-disable */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { InviteForm } from "@/routes/app.$organizationId.invitations";

import { fakeOrg } from "./fixtures";

vi.mock("@tanstack/react-start", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-start")>();
  return {
    ...actual,
    useServerFn: () => async () => undefined,
  };
});

const renderForm = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => <InviteForm organizationId={fakeOrg.id} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe("InviteForm", () => {
  it("rejects invalid comma-separated emails on submit", async () => {
    renderForm();

    const input = page.getByLabelText("Email Addresses");
    await userEvent.fill(input, "not-an-email, also-bad");
    await userEvent.click(page.getByRole("button", { name: "Invite" }));

    await expect.element(page.getByRole("alert").first()).toBeInTheDocument();
  });

  it("rejects more than 10 emails on submit", async () => {
    renderForm();

    const tooMany = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(",");
    const input = page.getByLabelText("Email Addresses");
    await userEvent.fill(input, tooMany);
    await userEvent.click(page.getByRole("button", { name: "Invite" }));

    await expect.element(page.getByRole("alert").first()).toBeInTheDocument();
  });

  it("can open the role select with the keyboard and pick Admin", async () => {
    renderForm();

    const trigger = page.getByRole("combobox");
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("option", { name: "Admin" }));

    await expect.element(trigger).toHaveTextContent(/admin/i);
  });
});
