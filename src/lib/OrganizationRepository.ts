import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrganizationDomain from "./OrganizationDomain";

const decodeInvoiceRow = Schema.decodeUnknownEffect(OrganizationDomain.InvoiceRow);
const decodeInvoices = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.InvoiceRow)),
);

export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
        function* (invoiceId: string) {
          const rows = yield* sql`select * from Invoice where id = ${invoiceId}`;
          return rows.length > 0
            ? yield* Effect.asSome(decodeInvoiceRow(rows[0]))
            : Option.none<OrganizationDomain.InvoiceRow>();
        },
      );

      const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(
        function* () {
          const rows = yield* sql`select * from Invoice order by createdAt desc`;
          return yield* decodeInvoices(rows);
        },
      );

      const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
        function* (input: {
          invoiceId: string;
          fileName: string;
          contentType: string;
          r2ActionTime: number;
          idempotencyKey: string;
          r2ObjectKey: string;
        }) {
          yield* sql`
            insert into Invoice (
              id, fileName, contentType, createdAt, r2ActionTime,
              idempotencyKey, r2ObjectKey, status,
              extractedJson, error
            ) values (
              ${input.invoiceId}, ${input.fileName}, ${input.contentType},
              ${input.r2ActionTime}, ${input.r2ActionTime}, ${input.idempotencyKey},
              ${input.r2ObjectKey}, 'uploaded',
              ${null}, ${null}
            )
            on conflict(id) do update set
              fileName = excluded.fileName,
              contentType = excluded.contentType,
              r2ActionTime = excluded.r2ActionTime,
              idempotencyKey = excluded.idempotencyKey,
              r2ObjectKey = excluded.r2ObjectKey,
              status = 'uploaded',
              extractedJson = null,
              error = null
          `;
        },
      );

      const setExtracting = Effect.fn("OrganizationRepository.setExtracting")(
        function* (invoiceId: string, idempotencyKey: string) {
          yield* sql`
            update Invoice
            set status = 'extracting'
            where id = ${invoiceId} and idempotencyKey = ${idempotencyKey}
          `;
        },
      );

      const deleteInvoice = Effect.fn("OrganizationRepository.deleteInvoice")(
        function* (invoiceId: string, r2ActionTime: number) {
          return yield* sql`
            delete from Invoice
            where id = ${invoiceId} and r2ActionTime <= ${r2ActionTime}
            returning id
          `;
        },
      );

      const saveExtractedJson = Effect.fn(
        "OrganizationRepository.saveExtractedJson",
      )(
        function* (input: {
          invoiceId: string;
          idempotencyKey: string;
          extractedJson: string;
        }) {
          return yield* sql`
            update Invoice
            set status = 'extracted',
                extractedJson = ${input.extractedJson},
                error = ${null}
            where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
            returning id, fileName
          `;
        },
      );

      const setError = Effect.fn("OrganizationRepository.setError")(
        function* (workflowId: string, error: string) {
          return yield* sql`
            update Invoice
            set status = 'error',
                error = ${error}
            where idempotencyKey = ${workflowId}
            returning id, fileName
          `;
        },
      );

      return {
        findInvoice,
        getInvoices,
        upsertInvoice,
        setExtracting,
        deleteInvoice,
        saveExtractedJson,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
