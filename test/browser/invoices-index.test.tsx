/* oxlint-disable */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { fakeAgent, fakeOrg, fakeUser } from "./fixtures";

vi.mock("agents/react", () => ({
  useAgent: () => fakeAgent,
}));

const { Route: RootRoute } = await import("@/routes/__root");
const { Route: AppRoute } = await import("@/routes/app");
const { Route: OrgRoute } = await import("@/routes/app.$organizationId");
const { Route: InvoicesIndexRoute } = await import(
  "@/routes/app.$organizationId.invoices.index"
);
const { routeTree } = await import("@/routeTree.gen");

const patch = (route: { options: object }, overrides: object) =>
  Object.assign(route.options, overrides);

const extractedJson = JSON.stringify({ total: "123.45", currency: "USD" });

const readyInvoice = {
  id: "inv_test",
  name: "ACME Invoice",
  fileName: "acme.pdf",
  contentType: "application/pdf",
  createdAt: 1700000000,
  r2ActionTime: null,
  idempotencyKey: null,
  r2ObjectKey: "org_test/inv_test",
  status: "ready" as const,
  invoiceConfidence: 0.99,
  invoiceNumber: "INV-001",
  invoiceDate: "2026-01-01",
  dueDate: "2026-02-01",
  currency: "USD",
  vendorName: "ACME",
  vendorEmail: "billing@acme.com",
  vendorAddress: "1 ACME Way",
  billToName: "Test Org",
  billToEmail: "u@u.com",
  billToAddress: "Nowhere",
  subtotal: "100.00",
  tax: "23.45",
  total: "123.45",
  amountDue: "123.45",
  extractedJson,
  error: null,
  viewUrl: "/api/view/inv_test",
};

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
  patch(InvoicesIndexRoute, {
    loader: () => ({
      invoice: { ...readyInvoice, invoiceItems: [] },
      invoices: [readyInvoice],
      selectedInvoice: readyInvoice,
      selectedInvoiceId: readyInvoice.id,
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

describe("/app/$organizationId/invoices/", () => {
  it("copies extracted JSON to clipboard and flips the button label", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });

    renderAt(
      `/app/${fakeOrg.id}/invoices?selectedInvoiceId=${readyInvoice.id}`,
    );

    const copyButton = page.getByRole("button", { name: /copy json/i });
    await userEvent.click(copyButton);

    await expect
      .element(page.getByRole("button", { name: /copied/i }))
      .toBeInTheDocument();
    expect(writes).toEqual([extractedJson]);

    vi.advanceTimersByTime(2100);
    await expect
      .element(page.getByRole("button", { name: /copy json/i }))
      .toBeInTheDocument();

    vi.useRealTimers();
  });
});
