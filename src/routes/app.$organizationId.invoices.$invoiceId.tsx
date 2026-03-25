import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useHydrated,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, ArrowLeft, ExternalLink, FilePenLine, Loader2, Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  getInvoices,
  getInvoiceWithItems,
  invoiceQueryKey,
  invoicesQueryKey,
  updateInvoice,
} from "@/lib/Invoices";
import type * as OrganizationDomain from "@/lib/OrganizationDomain";
import { Textarea } from "@/components/ui/textarea";

interface InvoiceFormValues {
  readonly name: string;
  readonly invoiceConfidence: number;
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
  readonly invoiceItems: readonly InvoiceItemFormValues[];
}

interface InvoiceItemFormValues {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
  readonly period: string;
}

const emptyInvoiceItem = (): InvoiceItemFormValues => ({
  description: "",
  quantity: "",
  unitPrice: "",
  amount: "",
  period: "",
});

const toFormValues = (
  invoice: OrganizationDomain.InvoiceWithItems,
): InvoiceFormValues => ({
  name: invoice.name,
  invoiceConfidence: invoice.invoiceConfidence,
  invoiceNumber: invoice.invoiceNumber,
  invoiceDate: invoice.invoiceDate,
  dueDate: invoice.dueDate,
  currency: invoice.currency,
  vendorName: invoice.vendorName,
  vendorEmail: invoice.vendorEmail,
  vendorAddress: invoice.vendorAddress,
  billToName: invoice.billToName,
  billToEmail: invoice.billToEmail,
  billToAddress: invoice.billToAddress,
  subtotal: invoice.subtotal,
  tax: invoice.tax,
  total: invoice.total,
  amountDue: invoice.amountDue,
  invoiceItems:
    invoice.items.length > 0
      ? invoice.items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          period: item.period,
        }))
      : [emptyInvoiceItem()],
});

export const Route = createFileRoute("/app/$organizationId/invoices/$invoiceId")({
  loader: async ({ params: { organizationId, invoiceId }, context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        queryKey: invoicesQueryKey(organizationId),
        queryFn: () => getInvoices({ data: { organizationId } }),
      }),
      context.queryClient.ensureQueryData({
        queryKey: invoiceQueryKey(organizationId, invoiceId),
        queryFn: () => getInvoiceWithItems({ data: { organizationId, invoiceId } }),
      }),
    ]);
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId, invoiceId } = Route.useParams();
  const isHydrated = useHydrated();
  const queryClient = useQueryClient();
  const getInvoiceWithItemsFn = useServerFn(getInvoiceWithItems);
  const updateInvoiceFn = useServerFn(updateInvoice);
  const invoiceQuery = useQuery({
    queryKey: [
      ...invoiceQueryKey(organizationId, invoiceId),
      getInvoiceWithItemsFn,
    ],
    queryFn: () => getInvoiceWithItemsFn({ data: { organizationId, invoiceId } }),
  });
  const invoicesQuery = useQuery({
    queryKey: invoicesQueryKey(organizationId),
    queryFn: () => getInvoices({ data: { organizationId } }),
  });
  const [form, setForm] = React.useState<InvoiceFormValues | null>(null);

  React.useEffect(() => {
    if (invoiceQuery.data) setForm(toFormValues(invoiceQuery.data));
  }, [invoiceQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (data: InvoiceFormValues) =>
      updateInvoiceFn({
        data: {
          organizationId,
          invoiceId,
          ...data,
        },
      }),
    onSuccess: (invoice) => {
      queryClient.setQueryData(invoiceQueryKey(organizationId, invoiceId), invoice);
      void queryClient.invalidateQueries({
        queryKey: invoicesQueryKey(organizationId),
      });
      setForm(toFormValues(invoice));
    },
  });

  const invoiceSummary = invoicesQuery.data?.find((invoice) => invoice.id === invoiceId);
  const invoice = invoiceQuery.data;
  const canEdit = invoice?.status === "ready" || invoice?.status === "error";

  if (invoiceQuery.isLoading || form === null) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading invoice...
        </div>
      </div>
    );
  }

  if (invoiceQuery.error) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{invoiceQuery.error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <p className="text-sm text-muted-foreground">Invoice not found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="outline" size="sm" render={(
            <Link to="/app/$organizationId/invoices" params={{ organizationId }} />
          )}>
            <ArrowLeft className="size-4" />
            Back to invoices
          </Button>
          <div className="flex items-center gap-2">
            {invoiceSummary?.viewUrl && (
              <Button variant="outline" size="sm" render={(
                <a href={invoiceSummary.viewUrl} target="_blank" rel="noreferrer">Open source file</a>
              )}>
                <ExternalLink className="size-4" />
                Open source file
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={!isHydrated || !canEdit || saveMutation.isPending}
              onClick={() => {
                if (form) saveMutation.mutate(form);
              }}
            >
              {saveMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FilePenLine className="size-4" />
              )}
              Save invoice
            </Button>
          </div>
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Invoice</h1>
          <p className="text-sm text-muted-foreground">
            Update invoice fields and manage line items.
          </p>
        </div>
      </header>

      {invoice.status === "error" && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Extraction failed</AlertTitle>
          <AlertDescription>
            {invoice.error ?? "Unknown extraction error"} Saving manual edits will clear the error and mark the invoice ready.
          </AlertDescription>
        </Alert>
      )}

      {!canEdit && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>
            {invoice.status === "extracting"
              ? "This invoice is still extracting and cannot be edited yet."
              : "This invoice cannot be edited."}
          </AlertDescription>
        </Alert>
      )}

      {saveMutation.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>{saveMutation.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Invoice Details</CardTitle>
            <CardDescription>Edit all invoice-owned fields.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-6">
              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  label="Invoice Name"
                  value={form.name}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, name: value } : current);
                  }}
                />
                <TextField
                  label="Invoice Number"
                  value={form.invoiceNumber}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, invoiceNumber: value } : current);
                  }}
                />
                <TextField
                  label="Invoice Date"
                  value={form.invoiceDate}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, invoiceDate: value } : current);
                  }}
                />
                <TextField
                  label="Due Date"
                  value={form.dueDate}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, dueDate: value } : current);
                  }}
                />
                <TextField
                  label="Currency"
                  value={form.currency}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, currency: value } : current);
                  }}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  label="Vendor Name"
                  value={form.vendorName}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, vendorName: value } : current);
                  }}
                />
                <TextField
                  label="Vendor Email"
                  value={form.vendorEmail}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, vendorEmail: value } : current);
                  }}
                />
              </div>

              <TextAreaField
                label="Vendor Address"
                value={form.vendorAddress}
                disabled={!isHydrated || !canEdit}
                onChange={(value) => {
                  setForm((current) => current ? { ...current, vendorAddress: value } : current);
                }}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  label="Bill To Name"
                  value={form.billToName}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, billToName: value } : current);
                  }}
                />
                <TextField
                  label="Bill To Email"
                  value={form.billToEmail}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, billToEmail: value } : current);
                  }}
                />
              </div>

              <TextAreaField
                label="Bill To Address"
                value={form.billToAddress}
                disabled={!isHydrated || !canEdit}
                onChange={(value) => {
                  setForm((current) => current ? { ...current, billToAddress: value } : current);
                }}
              />

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <TextField
                  label="Subtotal"
                  value={form.subtotal}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, subtotal: value } : current);
                  }}
                />
                <TextField
                  label="Tax"
                  value={form.tax}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, tax: value } : current);
                  }}
                />
                <TextField
                  label="Total"
                  value={form.total}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, total: value } : current);
                  }}
                />
                <TextField
                  label="Amount Due"
                  value={form.amountDue}
                  disabled={!isHydrated || !canEdit}
                  onChange={(value) => {
                    setForm((current) => current ? { ...current, amountDue: value } : current);
                  }}
                />
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Line Items</CardTitle>
                <CardDescription>Order follows the row order shown here.</CardDescription>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!isHydrated || !canEdit}
                onClick={() => {
                  setForm((current) =>
                    current
                      ? { ...current, invoiceItems: [...current.invoiceItems, emptyInvoiceItem()] }
                      : current,
                  );
                }}
              >
                <Plus className="size-4" />
                Add item
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {form.invoiceItems.map((item, index) => (
                <div key={index} className="rounded-lg border p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Item {index + 1}</p>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={!isHydrated || !canEdit || form.invoiceItems.length === 1}
                      onClick={() => {
                        setForm((current) =>
                          current
                            ? {
                                ...current,
                                invoiceItems: current.invoiceItems.filter((_, itemIndex) => itemIndex !== index),
                              }
                            : current,
                        );
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="grid gap-4">
                    <TextAreaField
                      label="Description"
                      value={item.description}
                      disabled={!isHydrated || !canEdit}
                      onChange={(value) => {
                        setForm((current) =>
                          current
                            ? {
                                ...current,
                                invoiceItems: current.invoiceItems.map((currentItem, itemIndex) =>
                                  itemIndex === index ? { ...currentItem, description: value } : currentItem,
                                ),
                              }
                            : current,
                        );
                      }}
                    />
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <TextField
                        label="Quantity"
                        value={item.quantity}
                        disabled={!isHydrated || !canEdit}
                        onChange={(value) => {
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  invoiceItems: current.invoiceItems.map((currentItem, itemIndex) =>
                                    itemIndex === index ? { ...currentItem, quantity: value } : currentItem,
                                  ),
                                }
                              : current,
                          );
                        }}
                      />
                      <TextField
                        label="Unit Price"
                        value={item.unitPrice}
                        disabled={!isHydrated || !canEdit}
                        onChange={(value) => {
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  invoiceItems: current.invoiceItems.map((currentItem, itemIndex) =>
                                    itemIndex === index ? { ...currentItem, unitPrice: value } : currentItem,
                                  ),
                                }
                              : current,
                          );
                        }}
                      />
                      <TextField
                        label="Amount"
                        value={item.amount}
                        disabled={!isHydrated || !canEdit}
                        onChange={(value) => {
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  invoiceItems: current.invoiceItems.map((currentItem, itemIndex) =>
                                    itemIndex === index ? { ...currentItem, amount: value } : currentItem,
                                  ),
                                }
                              : current,
                          );
                        }}
                      />
                      <TextField
                        label="Period"
                        value={item.period}
                        disabled={!isHydrated || !canEdit}
                        onChange={(value) => {
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  invoiceItems: current.invoiceItems.map((currentItem, itemIndex) =>
                                    itemIndex === index ? { ...currentItem, period: value } : currentItem,
                                  ),
                                }
                              : current,
                          );
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Field>
  );
}

function TextAreaField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Field>
  );
}
