import type { Locator, Page } from "@playwright/test";

import { invariant } from "@epic-web/invariant";
import { expect, test } from "@playwright/test";

import { scopeEmail } from "./utils";

const invoiceData = {
  name: "Delete Test Invoice",
  invoiceNumber: "INV-DEL-001",
  invoiceDate: "2026-04-06",
  dueDate: "2026-04-20",
  currency: "USD",
  vendorName: "Northwind Studio",
  vendorEmail: "billing@northwind.studio",
  vendorAddress: "123 Market Street, Suite 400, San Francisco, CA 94105",
  billToName: "Acme Corp",
  billToEmail: "ap@acme.example",
  billToAddress: "500 Howard Street, Floor 9, San Francisco, CA 94105",
  subtotal: "$1,500.00",
  tax: "$150.00",
  total: "$1,650.00",
  amountDue: "$1,650.00",
  invoiceItems: [
    {
      description: "UX audit",
      quantity: "5",
      unitPrice: "$200.00",
      amount: "$1,000.00",
      period: "Apr 1, 2026 - Apr 3, 2026",
    },
    {
      description: "Copywriting review",
      quantity: "2",
      unitPrice: "$250.00",
      amount: "$500.00",
      period: "Apr 4, 2026",
    },
  ],
} as const;

const getFieldInput = (scope: Page | Locator, label: string) =>
  scope
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::*[@role="group"][1]')
    .getByRole("textbox");

const getSummaryRow = (page: Page, label: string) =>
  page.locator("div.flex.gap-8").filter({
    has: page.getByText(label, { exact: true }),
  });

test.describe("delete invoice", () => {
  const email = scopeEmail("delete-invoice@e2e.com");

  test.beforeAll(async ({ request }) => {
    await request.post(`/api/e2e/delete/user/${email}`);
  });

  test("creates an invoice then deletes it", async ({ page, baseURL }) => {
    invariant(baseURL, "Missing baseURL");

    await login(page, email);
    await goToInvoices(page);
    const invoiceId = await createInvoice(page);
    await fillInvoiceForm(page, invoiceData);
    await saveInvoice(page, invoiceId);
    await expectInvoiceSelected(page, invoiceData);
    await deleteInvoice(page, invoiceData.name);
    await expectInvoiceGone(page, invoiceData.name);
  });
});

const login = async (page: Page, email: string) => {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
  await page.getByRole("link", { name: /magic-link/ }).click();
  await page.waitForURL(/\/app\//);
};

const goToInvoices = async (page: Page) => {
  await page.getByRole("link", { name: /^Invoices$/ }).click();
  await page.waitForURL(/\/invoices/);
};

const createInvoice = async (page: Page) => {
  await page.getByRole("button", { name: "New Invoice" }).click();
  await page.waitForURL(/\/app\/[^/]+\/invoices\/[^/?]+$/);
  const invoiceId = page.url().split("/").at(-1) ?? "";
  expect(invoiceId).not.toBe("");
  return invoiceId;
};

const fillInvoiceForm = async (page: Page, data: typeof invoiceData) => {
  await getFieldInput(page, "Invoice Name").fill(data.name);
  await getFieldInput(page, "Invoice Number").fill(data.invoiceNumber);
  await getFieldInput(page, "Invoice Date").fill(data.invoiceDate);
  await getFieldInput(page, "Due Date").fill(data.dueDate);
  await getFieldInput(page, "Currency").fill(data.currency);
  await getFieldInput(page, "Vendor Name").fill(data.vendorName);
  await getFieldInput(page, "Vendor Email").fill(data.vendorEmail);
  await getFieldInput(page, "Vendor Address").fill(data.vendorAddress);
  await getFieldInput(page, "Bill To Name").fill(data.billToName);
  await getFieldInput(page, "Bill To Email").fill(data.billToEmail);
  await getFieldInput(page, "Bill To Address").fill(data.billToAddress);
  await getFieldInput(page, "Subtotal").fill(data.subtotal);
  await getFieldInput(page, "Tax").fill(data.tax);
  await getFieldInput(page, "Total").fill(data.total);
  await getFieldInput(page, "Amount Due").fill(data.amountDue);

  for (let index = 0; index < data.invoiceItems.length; index++) {
    await page.getByRole("button", { name: "Add item" }).click();
    const itemCard = page
      .locator("div.rounded-lg.border.p-4")
      .filter({ hasText: `Item ${String(index + 1)}` })
      .first();
    const item = data.invoiceItems[index];
    await expect(itemCard).toBeVisible();
    await getFieldInput(itemCard, "Description").fill(item.description);
    await getFieldInput(itemCard, "Quantity").fill(item.quantity);
    await getFieldInput(itemCard, "Unit Price").fill(item.unitPrice);
    await getFieldInput(itemCard, "Amount").fill(item.amount);
    await getFieldInput(itemCard, "Period").fill(item.period);
  }
};

const saveInvoice = async (page: Page, invoiceId: string) => {
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.waitForURL(/selectedInvoiceId=/);
  const url = new URL(page.url());
  expect(url.searchParams.get("selectedInvoiceId")).toBe(invoiceId);
};

const expectInvoiceSelected = async (page: Page, data: typeof invoiceData) => {
  const selectedRow = page
    .locator("tbody tr[data-state='selected']")
    .filter({ hasText: data.name });

  await expect(selectedRow).toBeVisible();
  await expect(selectedRow).toContainText("ready");

  await expect(page.getByRole("link", { name: "Edit invoice" })).toBeVisible();
  await expect(page.getByText(`Invoice #${data.invoiceNumber}`)).toBeVisible();
  await expect(page.getByText(`Date: ${data.invoiceDate}`)).toBeVisible();
  await expect(page.getByText(`Due: ${data.dueDate}`)).toBeVisible();
  await expect(page.getByText(`Currency: ${data.currency}`)).toBeVisible();
  await expect(page.getByText(data.vendorName)).toBeVisible();
  await expect(page.getByText(data.vendorEmail)).toBeVisible();
  await expect(page.getByText(data.vendorAddress)).toBeVisible();
  await expect(page.getByText(data.billToName)).toBeVisible();
  await expect(page.getByText(data.billToEmail)).toBeVisible();
  await expect(page.getByText(data.billToAddress)).toBeVisible();
  await expect(getSummaryRow(page, "Subtotal").getByText(data.subtotal, { exact: true })).toBeVisible();
  await expect(getSummaryRow(page, "Tax").getByText(data.tax, { exact: true })).toBeVisible();
  await expect(getSummaryRow(page, "Total").getByText(data.total, { exact: true })).toBeVisible();
  await expect(getSummaryRow(page, "Amount Due").getByText(data.amountDue, { exact: true })).toBeVisible();

  for (const item of data.invoiceItems) {
    const itemRow = page.getByRole("row").filter({ hasText: item.description }).first();
    await expect(itemRow).toBeVisible();
    await expect(itemRow).toContainText(item.period);
    await expect(itemRow.getByRole("cell").nth(1)).toHaveText(item.quantity);
    await expect(itemRow.getByRole("cell").nth(2)).toHaveText(item.unitPrice);
    await expect(itemRow.getByRole("cell").nth(3)).toHaveText(item.amount);
  }
};

const deleteInvoice = async (page: Page, name: string) => {
  const invoiceRow = page
    .locator("tbody tr[data-state='selected']")
    .filter({ hasText: name });
  await invoiceRow.getByRole("button").filter({ has: page.locator("svg") }).click();
};

const expectInvoiceGone = async (page: Page, name: string) => {
  await expect(
    page.locator("tbody tr").filter({ hasText: name }),
  ).toHaveCount(0);
};
