import { Agent, callable } from "agents";
import { Effect, Layer, Option } from "effect";
import * as Schema from "effect/Schema";
import { SqliteClient } from "@effect/sql-sqlite-do";

import type { ActivityEnvelope, WorkflowProgress } from "@/lib/Activity";
import { WorkflowProgressSchema } from "@/lib/Activity";
import { makeLoggerLayer } from "@/lib/LoggerLayer";
import {
  OrganizationAgentError,
  activeWorkflowStatuses,
} from "@/lib/OrganizationDomain";
import { OrganizationRepository } from "@/lib/OrganizationRepository";

export interface OrganizationAgentState {
  readonly message: string;
}

const broadcastActivity = (
  agent: OrganizationAgent,
  input: { level: WorkflowProgress["level"]; text: string },
) =>
  Effect.sync(() => {
    agent.broadcast(
      JSON.stringify({
        type: "activity",
        message: {
          createdAt: new Date().toISOString(),
          level: input.level,
          text: input.text,
        },
      } satisfies ActivityEnvelope),
    );
  });

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

  // Type-only declaration (no runtime initializer); assigned in constructor.
  private declare runEffect: <A, E>(
    effect: Effect.Effect<A, E, OrganizationRepository>,
  ) => Promise<A>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No blockConcurrencyWhile needed — everything here is synchronous:
    // - SQLite ops don't yield the event loop (atomic without gating)
    // - Layer construction is lazy (descriptions only, built at runPromise time)
    void this.sql`create table if not exists Invoice (
      id text primary key,
      fileName text not null,
      contentType text not null,
      createdAt integer not null,
      r2ActionTime integer not null,
      idempotencyKey text not null unique,
      r2ObjectKey text not null,
      status text not null,
      extractedJson text,
      error text
    )`;
    const sqliteLayer = SqliteClient.layer({ db: ctx.storage.sql });
    const repoLayer = Layer.provideMerge(
      OrganizationRepository.layer,
      sqliteLayer,
    );
    const loggerLayer = makeLoggerLayer(env);
    this.runEffect = (effect) =>
      Effect.runPromise(
        Effect.provide(effect, Layer.merge(repoLayer, loggerLayer)),
      );
  }

  @callable()
  getTestMessage() {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logDebug("getTestMessage called");
        return this.state.message;
      }),
    );
  }

  @callable()
  onInvoiceUpload(upload: {
    invoiceId: string;
    r2ActionTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const r2ActionTime = Date.parse(upload.r2ActionTime);
        if (!Number.isFinite(r2ActionTime)) {
          return yield* new OrganizationAgentError({
            message: `Invalid r2ActionTime: ${upload.r2ActionTime}`,
          });
        }
        const repo = yield* OrganizationRepository;
        const existing = yield* repo.findInvoice(upload.invoiceId);
        if (
          Option.isSome(existing) &&
          r2ActionTime < existing.value.r2ActionTime
        )
          return;
        const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
        if (
          trackedWorkflow &&
          activeWorkflowStatuses.has(trackedWorkflow.status)
        )
          return;
        if (
          Option.isSome(existing) &&
          existing.value.idempotencyKey === upload.idempotencyKey &&
          (existing.value.status === "extracting" ||
            existing.value.status === "extracted")
        )
          return;
        yield* repo.upsertInvoice({ ...upload, r2ActionTime });
        yield* broadcastActivity(this, {
          level: "info",
          text: `Invoice uploaded: ${upload.fileName}`,
        });
        yield* Effect.tryPromise({
          try: () =>
            this.runWorkflow(
              "INVOICE_EXTRACTION_WORKFLOW",
              {
                invoiceId: upload.invoiceId,
                idempotencyKey: upload.idempotencyKey,
                r2ObjectKey: upload.r2ObjectKey,
                fileName: upload.fileName,
                contentType: upload.contentType,
              },
              {
                id: upload.idempotencyKey,
                metadata: { invoiceId: upload.invoiceId },
              },
            ),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* repo.setExtracting(upload.invoiceId, upload.idempotencyKey);
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    r2ActionTime: string;
    r2ObjectKey: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const r2ActionTime = Date.parse(input.r2ActionTime);
        if (!Number.isFinite(r2ActionTime)) {
          return yield* new OrganizationAgentError({
            message: `Invalid r2ActionTime: ${input.r2ActionTime}`,
          });
        }
        const repo = yield* OrganizationRepository;
        const deleted = yield* repo.deleteInvoice(
          input.invoiceId,
          r2ActionTime,
        );
        if (deleted.length === 0) return;
        yield* broadcastActivity(this, {
          level: "info",
          text: "Invoice deleted",
        });
      }),
    );
  }

  saveExtractedJson(input: {
    invoiceId: string;
    idempotencyKey: string;
    extractedJson: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.saveExtractedJson(input);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          level: "success",
          text: `Invoice extraction completed: ${(updated[0] as { fileName: string }).fileName}`,
        });
      }),
    );
  }

  async onWorkflowProgress(
    workflowName: string,
    _workflowId: string,
    progress: unknown,
  ): Promise<void> {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") return;
        const message =
          Schema.decodeUnknownExit(WorkflowProgressSchema)(progress);
        if (message._tag === "Failure") return;
        yield* broadcastActivity(this, message.value);
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") return;
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.setError(workflowId, error);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          level: "error",
          text: `Invoice extraction failed: ${(updated[0] as { fileName: string }).fileName}`,
        });
      }),
    );
  }

  @callable()
  getInvoices() {
    return this.runEffect(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        return yield* repo.getInvoices();
      }),
    );
  }
}
