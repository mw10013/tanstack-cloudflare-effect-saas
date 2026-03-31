import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Invoice, InvoiceItem } from "./OrganizationDomain";
import { trimFields } from "./SchemaEx";

export const InvoiceItemFormSchema = Schema.Struct(
  trimFields(
    Struct.pick(InvoiceItem.fields, [
      "description",
      "quantity",
      "unitPrice",
      "amount",
      "period",
    ]),
  ),
);

export const InvoiceFormSchema = Schema.Struct({
  ...trimFields(
    Struct.pick(Invoice.fields, [
      "name",
      "invoiceNumber",
      "invoiceDate",
      "dueDate",
      "currency",
      "vendorName",
      "vendorEmail",
      "vendorAddress",
      "billToName",
      "billToEmail",
      "billToAddress",
      "subtotal",
      "tax",
      "total",
      "amountDue",
    ]),
  ),
  invoiceItems: Schema.mutable(Schema.Array(InvoiceItemFormSchema)),
});

export const UpdateInvoiceInput = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
  ...InvoiceFormSchema.fields,
});

export const UploadInvoiceInput = Schema.Struct({
  fileName: Schema.NonEmptyString,
  contentType: Schema.NonEmptyString,
  base64: Schema.NonEmptyString,
});

export const GetInvoiceInput = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
});

export const SoftDeleteInvoiceInput = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
});
