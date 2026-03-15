import { Agent, callable } from "agents";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import * as Schema from "effect/Schema";

export interface OrganizationAgentState {
  readonly message: string;
}

interface InvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
}

const InvoiceRowSchema = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  eventTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: Schema.String,
  processedAt: Schema.NullOr(Schema.Number),
  markdown: Schema.NullOr(Schema.String),
  markdownError: Schema.NullOr(Schema.String),
});

const activeWorkflowStatuses = new Set(["queued", "running", "waiting"]);
type InvoiceRow = typeof InvoiceRowSchema.Type;
const decodeInvoiceRow = Schema.decodeUnknownSync(Schema.NullOr(InvoiceRowSchema));
const decodeInvoices = Schema.decodeUnknownSync(Schema.Array(InvoiceRowSchema));

export const extractAgentInstanceName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  initialState: OrganizationAgentState = {
    message: "Organization agent ready",
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.sql`create table if not exists Invoice (
      id text primary key,
      fileName text not null,
      contentType text not null,
      createdAt integer not null,
      eventTime integer not null,
      idempotencyKey text not null unique,
      r2ObjectKey text not null,
      status text not null default 'uploaded',
      processedAt integer,
      markdown text,
      markdownError text
    )`;
    const columns = this.sql<{ name: string }>`pragma table_info(Invoice)`;
    if (!columns.some(({ name }) => name === "markdown")) {
      void this.sql`alter table Invoice add column markdown text`;
    }
    if (!columns.some(({ name }) => name === "markdownError")) {
      void this.sql`alter table Invoice add column markdownError text`;
    }
  }

  @callable()
  getTestMessage() {
    return this.state.message;
  }

  @callable()
  async onInvoiceUpload(upload: {
    invoiceId: string;
    eventTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    const eventTime = Date.parse(upload.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${upload.eventTime}`);
    }
    const existing = decodeInvoiceRow(
      this.sql<InvoiceRow>`select * from Invoice where id = ${upload.invoiceId}`[0] ??
        null,
    );
    if (existing && eventTime < existing.eventTime) {
      return;
    }
    const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      return;
    }
    if (
      existing?.idempotencyKey === upload.idempotencyKey &&
      (existing.markdown !== null ||
        existing.processedAt !== null ||
        existing.status === "extracting" ||
        existing.status === "ready")
    ) {
      return;
    }
    void this.sql`
      insert into Invoice (
        id,
        fileName,
        contentType,
        createdAt,
        eventTime,
        idempotencyKey,
        r2ObjectKey,
        status,
        processedAt,
        markdown,
        markdownError
      ) values (
        ${upload.invoiceId},
        ${upload.fileName},
        ${upload.contentType},
        ${eventTime},
        ${eventTime},
        ${upload.idempotencyKey},
        ${upload.r2ObjectKey},
        'uploaded',
        null,
        null,
        null
      )
      on conflict(id) do update set
        fileName = excluded.fileName,
        contentType = excluded.contentType,
        eventTime = excluded.eventTime,
        idempotencyKey = excluded.idempotencyKey,
        r2ObjectKey = excluded.r2ObjectKey,
        status = 'uploaded',
        processedAt = null,
        markdown = null,
        markdownError = null
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_uploaded",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
    if (upload.contentType !== "application/pdf") {
      return;
    }
    await this.runWorkflow(
      "INVOICE_EXTRACTION_WORKFLOW",
      {
        invoiceId: upload.invoiceId,
        idempotencyKey: upload.idempotencyKey,
        r2ObjectKey: upload.r2ObjectKey,
        fileName: upload.fileName,
      },
      {
        id: upload.idempotencyKey,
        metadata: { invoiceId: upload.invoiceId },
      },
    );
    void this.sql`
      update Invoice
      set status = 'extracting'
      where id = ${upload.invoiceId} and idempotencyKey = ${upload.idempotencyKey}
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_started",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    eventTime: string;
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(input.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${input.eventTime}`);
    }
    const deleted = this.sql<{ id: string }>`
      delete from Invoice
      where id = ${input.invoiceId} and eventTime <= ${eventTime}
      returning id
    `;
    if (deleted.length === 0) return;
    this.broadcast(
      JSON.stringify({
        type: "invoice_deleted",
        invoiceId: input.invoiceId,
      }),
    );
  }

  applyInvoiceMarkdown(input: {
    invoiceId: string;
    idempotencyKey: string;
    markdown: string;
  }) {
    const processedAt = Date.now();
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'ready',
          processedAt = ${processedAt},
          markdown = ${input.markdown},
          markdownError = null
      where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
      returning id, fileName
    `;
    if (updated.length === 0) {
      return;
    }
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_complete",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") {
      return;
    }
    const processedAt = Date.now();
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'extract_error',
          processedAt = ${processedAt},
          markdown = null,
          markdownError = ${error}
      where idempotencyKey = ${workflowId}
      returning id, fileName
    `;
    if (updated.length === 0) {
      return;
    }
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_error",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
        error,
      }),
    );
  }

  @callable()
  getInvoices() {
    return decodeInvoices(this.sql`select * from Invoice order by createdAt desc`);
  }
}

export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  { readonly status: string; readonly message: string }
> {
  async run(
    event: AgentWorkflowEvent<InvoiceExtractionWorkflowParams>,
    step: AgentWorkflowStep,
  ) {
    const pdfBytes = await step.do("load-pdf", async () => {
      const object = await this.env.R2.get(event.payload.r2ObjectKey);
      if (!object) {
        throw new Error(`Invoice PDF not found: ${event.payload.r2ObjectKey}`);
      }
      return new Uint8Array(await object.arrayBuffer());
    });
    const markdown = await step.do("convert-pdf-to-markdown", async () => {
      const result = await this.env.AI.toMarkdown(
        {
          name: event.payload.fileName,
          blob: new Blob([pdfBytes], { type: "application/pdf" }),
        },
        { conversionOptions: { pdf: { metadata: false } } },
      );
      if (result.format === "error") {
        throw new Error(result.error);
      }
      return result.data;
    });
    await step.do("save-markdown", async () => {
      await this.agent.applyInvoiceMarkdown({
        invoiceId: event.payload.invoiceId,
        idempotencyKey: event.payload.idempotencyKey,
        markdown,
      });
    });
    return { invoiceId: event.payload.invoiceId };
  }
}
