import type { Locator, Page } from "@playwright/test";

import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";

import { scopeEmail } from "./utils";

interface InvoiceItemData {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
  readonly period: string;
}

interface InvoiceData {
  readonly name: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly vendorEmail: string;
  readonly vendorAddress: string;
  readonly billToName: string;
  readonly billToEmail: string;
  readonly billToAddress: string;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
  readonly amountDue: string;
  readonly invoiceItems: readonly InvoiceItemData[];
}

const initialInvoiceData: InvoiceData = {
  name: "April 2026 Retainer",
  invoiceNumber: "INV-2026-04-001",
  invoiceDate: "2026-04-06",
  dueDate: "2026-04-20",
  currency: "USD",
  vendorName: "Northwind Studio",
  vendorEmail: "billing@northwind.studio",
  vendorAddress: "123 Market Street, Suite 400, San Francisco, CA 94105",
  billToName: "Acme Corp",
  billToEmail: "ap@acme.example",
  billToAddress: "500 Howard Street, Floor 9, San Francisco, CA 94105",
  subtotal: "$2,100.00",
  tax: "$210.00",
  total: "$2,310.00",
  amountDue: "$2,310.00",
  invoiceItems: [
    {
      description: "Product design sprint",
      quantity: "10",
      unitPrice: "$200.00",
      amount: "$2,000.00",
      period: "Apr 1, 2026 - Apr 5, 2026",
    },
    {
      description: "Workshop facilitation",
      quantity: "1",
      unitPrice: "$100.00",
      amount: "$100.00",
      period: "Apr 6, 2026",
    },
  ],
};

const editedInvoiceData: InvoiceData = {
  ...initialInvoiceData,
  name: "April 2026 Retainer Revised",
  invoiceItems: [
    initialInvoiceData.invoiceItems[1],
    initialInvoiceData.invoiceItems[0],
  ],
};

const getFieldInput = (scope: Page | Locator, label: string) =>
  scope
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::*[@role="group"][1]')
    .getByRole("textbox");

const getSummaryRow = (page: Page, label: string) =>
  page.locator("div.flex.gap-8").filter({
    has: page.getByText(label, { exact: true }),
  });

const getInvoiceItemCard = (scope: Page | Locator, itemNumber: number) =>
  scope
    .locator("div.rounded-lg.border.p-4")
    .filter({ has: scope.getByText(`Item ${String(itemNumber)}`, { exact: true }) })
    .first();

test.describe("edit invoice", () => {
  const email = scopeEmail("edit-invoice@e2e.com");

  test.beforeAll(async ({ request }) => {
    await request.post(`/api/e2e/delete/user/${email}`);
  });

  test("creates, verifies, edits, and reorders a manual invoice", async ({
    page,
    baseURL,
  }) => {
    assert.ok(baseURL, "Missing baseURL");
    const pom = createEditInvoicePom({ page, baseURL });

    await pom.login({ email });
    await pom.goToInvoices();
    await pom.createInvoice();
    await pom.fillInvoiceForm(initialInvoiceData);
    await pom.saveInvoice();
    await pom.expectInvoiceSelected(initialInvoiceData);
    await pom.openSelectedInvoiceForEdit();
    await pom.expectInvoiceFormValues(initialInvoiceData);
    await pom.updateInvoiceName(editedInvoiceData.name);
    await pom.moveInvoiceItemDown(1);
    await pom.expectInvoiceFormValues(editedInvoiceData);
    await pom.saveInvoice();
    await pom.expectInvoiceSelected(editedInvoiceData);
    await pom.openSelectedInvoiceForEdit();
    await pom.expectInvoiceFormValues(editedInvoiceData);
  });
});

const createEditInvoicePom = ({
  page,
  baseURL,
}: {
  readonly page: Page;
  readonly baseURL: string;
}) => {
  assert.ok(baseURL.endsWith("/"), "baseURL must have a trailing slash");

  let createdInvoiceId = "";

  const login = async ({ email }: { readonly email: string }) => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Send magic link" }).click();
    await page.getByRole("link", { name: /magic-link/ }).click();
    await page.waitForURL(/\/app\//);
  };

  const goToInvoices = async () => {
    await page.getByRole("link", { name: /^Invoices$/ }).click();
    await page.waitForURL(/\/invoices/);
  };

  const createInvoice = async () => {
    await page.getByRole("button", { name: "New Invoice" }).click();
    await page.waitForURL(/\/app\/[^/]+\/invoices\/[^/?]+$/);
    createdInvoiceId = page.url().split("/").at(-1) ?? "";
    expect(createdInvoiceId).not.toBe("");
  };

  const fillInvoiceForm = async ({
    name,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency,
    vendorName,
    vendorEmail,
    vendorAddress,
    billToName,
    billToEmail,
    billToAddress,
    subtotal,
    tax,
    total,
    amountDue,
    invoiceItems,
  }: InvoiceData) => {
    await getFieldInput(page, "Invoice Name").fill(name);
    await getFieldInput(page, "Invoice Number").fill(invoiceNumber);
    await getFieldInput(page, "Invoice Date").fill(invoiceDate);
    await getFieldInput(page, "Due Date").fill(dueDate);
    await getFieldInput(page, "Currency").fill(currency);
    await getFieldInput(page, "Vendor Name").fill(vendorName);
    await getFieldInput(page, "Vendor Email").fill(vendorEmail);
    await getFieldInput(page, "Vendor Address").fill(vendorAddress);
    await getFieldInput(page, "Bill To Name").fill(billToName);
    await getFieldInput(page, "Bill To Email").fill(billToEmail);
    await getFieldInput(page, "Bill To Address").fill(billToAddress);
    await getFieldInput(page, "Subtotal").fill(subtotal);
    await getFieldInput(page, "Tax").fill(tax);
    await getFieldInput(page, "Total").fill(total);
    await getFieldInput(page, "Amount Due").fill(amountDue);

    for (let index = 0; index < invoiceItems.length; index++) {
      await page.getByRole("button", { name: "Add item" }).click();
      const itemCard = getInvoiceItemCard(page, index + 1);
      const item = invoiceItems[index];
      await expect(itemCard).toBeVisible();
      await getFieldInput(itemCard, "Description").fill(item.description);
      await getFieldInput(itemCard, "Quantity").fill(item.quantity);
      await getFieldInput(itemCard, "Unit Price").fill(item.unitPrice);
      await getFieldInput(itemCard, "Amount").fill(item.amount);
      await getFieldInput(itemCard, "Period").fill(item.period);
    }
  };

  const saveInvoice = async () => {
    await page.getByRole("button", { name: "Save invoice" }).click();
    await page.waitForURL(/selectedInvoiceId=/);
    const url = new URL(page.url());
    expect(url.searchParams.get("selectedInvoiceId")).toBe(createdInvoiceId);
  };

  const expectInvoiceSelected = async ({
    name,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency,
    vendorName,
    vendorEmail,
    vendorAddress,
    billToName,
    billToEmail,
    billToAddress,
    subtotal,
    tax,
    total,
    amountDue,
    invoiceItems,
  }: InvoiceData) => {
    const selectedRow = page
      .locator("tbody tr[data-state='selected']")
      .filter({ hasText: name });
    const itemRows = page.locator("table").last().locator("tbody tr");

    await expect(selectedRow).toBeVisible();
    await expect(selectedRow).toContainText("ready");
    await expect(page.getByRole("link", { name: "Edit invoice" })).toBeVisible();
    await expect(page.getByText(`Invoice #${invoiceNumber}`)).toBeVisible();
    await expect(page.getByText(`Date: ${invoiceDate}`)).toBeVisible();
    await expect(page.getByText(`Due: ${dueDate}`)).toBeVisible();
    await expect(page.getByText(`Currency: ${currency}`)).toBeVisible();
    await expect(page.getByText(vendorName)).toBeVisible();
    await expect(page.getByText(vendorEmail)).toBeVisible();
    await expect(page.getByText(vendorAddress)).toBeVisible();
    await expect(page.getByText(billToName)).toBeVisible();
    await expect(page.getByText(billToEmail)).toBeVisible();
    await expect(page.getByText(billToAddress)).toBeVisible();
    await expect(
      getSummaryRow(page, "Subtotal").getByText(subtotal, { exact: true }),
    ).toBeVisible();
    await expect(getSummaryRow(page, "Tax").getByText(tax, { exact: true })).toBeVisible();
    await expect(getSummaryRow(page, "Total").getByText(total, { exact: true })).toBeVisible();
    await expect(
      getSummaryRow(page, "Amount Due").getByText(amountDue, { exact: true }),
    ).toBeVisible();
    await expect(itemRows).toHaveCount(invoiceItems.length);

    for (const [index, item] of invoiceItems.entries()) {
      const itemRow = itemRows.nth(index);
      await expect(itemRow).toContainText(item.description);
      await expect(itemRow).toContainText(item.period);
      await expect(itemRow.getByRole("cell").nth(1)).toHaveText(item.quantity);
      await expect(itemRow.getByRole("cell").nth(2)).toHaveText(item.unitPrice);
      await expect(itemRow.getByRole("cell").nth(3)).toHaveText(item.amount);
    }
  };

  const openSelectedInvoiceForEdit = async () => {
    await page.getByRole("link", { name: "Edit invoice" }).click();
    await page.waitForURL(new RegExp(`/app/[^/]+/invoices/${createdInvoiceId}$`));
  };

  const expectInvoiceFormValues = async ({
    name,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency,
    vendorName,
    vendorEmail,
    vendorAddress,
    billToName,
    billToEmail,
    billToAddress,
    subtotal,
    tax,
    total,
    amountDue,
    invoiceItems,
  }: InvoiceData) => {
    await expect(getFieldInput(page, "Invoice Name")).toHaveValue(name);
    await expect(getFieldInput(page, "Invoice Number")).toHaveValue(invoiceNumber);
    await expect(getFieldInput(page, "Invoice Date")).toHaveValue(invoiceDate);
    await expect(getFieldInput(page, "Due Date")).toHaveValue(dueDate);
    await expect(getFieldInput(page, "Currency")).toHaveValue(currency);
    await expect(getFieldInput(page, "Vendor Name")).toHaveValue(vendorName);
    await expect(getFieldInput(page, "Vendor Email")).toHaveValue(vendorEmail);
    await expect(getFieldInput(page, "Vendor Address")).toHaveValue(vendorAddress);
    await expect(getFieldInput(page, "Bill To Name")).toHaveValue(billToName);
    await expect(getFieldInput(page, "Bill To Email")).toHaveValue(billToEmail);
    await expect(getFieldInput(page, "Bill To Address")).toHaveValue(billToAddress);
    await expect(getFieldInput(page, "Subtotal")).toHaveValue(subtotal);
    await expect(getFieldInput(page, "Tax")).toHaveValue(tax);
    await expect(getFieldInput(page, "Total")).toHaveValue(total);
    await expect(getFieldInput(page, "Amount Due")).toHaveValue(amountDue);

    for (const [index, item] of invoiceItems.entries()) {
      const itemCard = getInvoiceItemCard(page, index + 1);
      await expect(itemCard).toBeVisible();
      await expect(getFieldInput(itemCard, "Description")).toHaveValue(item.description);
      await expect(getFieldInput(itemCard, "Quantity")).toHaveValue(item.quantity);
      await expect(getFieldInput(itemCard, "Unit Price")).toHaveValue(item.unitPrice);
      await expect(getFieldInput(itemCard, "Amount")).toHaveValue(item.amount);
      await expect(getFieldInput(itemCard, "Period")).toHaveValue(item.period);
    }
  };

  const updateInvoiceName = async (name: string) => {
    await getFieldInput(page, "Invoice Name").fill(name);
  };

  const moveInvoiceItemDown = async (itemNumber: number) => {
    const itemCard = getInvoiceItemCard(page, itemNumber);
    await expect(itemCard).toBeVisible();
    await itemCard.locator("button").nth(1).click();
  };

  return {
    login,
    goToInvoices,
    createInvoice,
    fillInvoiceForm,
    saveInvoice,
    expectInvoiceSelected,
    openSelectedInvoiceForEdit,
    expectInvoiceFormValues,
    updateInvoiceName,
    moveInvoiceItemDown,
  };
};
