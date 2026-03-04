import type { AgentContext } from "agents";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
  WorkflowInfo,
} from "agents/workflows";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { AgentWorkflow } from "agents/workflows";
import { convertToModelMessages, generateText, streamText } from "ai";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { createWorkersAI } from "workers-ai-provider";
import {
  appendSpreadsheetValuesRequest,
  getSpreadsheetValuesRequest,
  listDriveSpreadsheetsRequest,
} from "@/lib/google-client";
import { refreshGoogleToken } from "@/lib/google-oauth-client";
import { type OrganizationMessage } from "@/organization-messages";

const AgentState = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
});
export type AgentState = typeof AgentState.Type;

const AgentQueue = Schema.Struct({
  id: Schema.String,
  payload: Schema.NullOr(Schema.String),
  callback: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.Number),
});
export type AgentQueue = typeof AgentQueue.Type;

const AgentSchedule = Schema.Struct({
  id: Schema.String,
  callback: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
  type: Schema.Literals(["scheduled", "delayed", "cron", "interval"]),
  time: Schema.NullOr(Schema.Number),
  delayInSeconds: Schema.NullOr(Schema.Number),
  cron: Schema.NullOr(Schema.String),
  intervalSeconds: Schema.NullOr(Schema.Number),
  running: Schema.NullOr(Schema.Number),
  created_at: Schema.NullOr(Schema.Number),
  execution_started_at: Schema.NullOr(Schema.Number),
});
export type AgentSchedule = typeof AgentSchedule.Type;

const AgentWorkflowRow = Schema.Struct({
  id: Schema.String,
  workflow_id: Schema.String,
  workflow_name: Schema.String,
  status: Schema.String,
  metadata: Schema.NullOr(Schema.String),
  error_name: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
});
export type AgentWorkflowRow = typeof AgentWorkflowRow.Type;

const ChatMessage = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  created_at: Schema.String,
});
export type ChatMessage = typeof ChatMessage.Type;

const ChatStreamChunk = Schema.Struct({
  id: Schema.String,
  stream_id: Schema.String,
  body: Schema.String,
  chunk_index: Schema.Number,
  created_at: Schema.Number,
});
export type ChatStreamChunk = typeof ChatStreamChunk.Type;

const ChatStreamMetadata = Schema.Struct({
  id: Schema.String,
  request_id: Schema.String,
  status: Schema.String,
  created_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
});
export type ChatStreamMetadata = typeof ChatStreamMetadata.Type;

const UploadRow = Schema.Struct({
  name: Schema.String,
  createdAt: Schema.Number,
  eventTime: Schema.Number,
  idempotencyKey: Schema.String,
  classificationLabel: Schema.NullOr(Schema.String),
  classificationScore: Schema.NullOr(Schema.Number),
  classifiedAt: Schema.NullOr(Schema.Number),
});
export type UploadRow = typeof UploadRow.Type;

const GoogleConnectionRow = Schema.Struct({
  id: Schema.Number,
  provider: Schema.String,
  googleUserEmail: Schema.NullOr(Schema.String),
  scopes: Schema.String,
  accessToken: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshToken: Schema.NullOr(Schema.String),
  idToken: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type GoogleConnectionRow = typeof GoogleConnectionRow.Type;

const GoogleSpreadsheetCacheRow = Schema.Struct({
  spreadsheetId: Schema.String,
  name: Schema.String,
  modifiedTime: Schema.NullOr(Schema.String),
  webViewLink: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.Number,
});
type GoogleSpreadsheetCacheRow = typeof GoogleSpreadsheetCacheRow.Type;

const ResnetPredictions = Schema.Array(
  Schema.Struct({
    label: Schema.String,
    score: Schema.Number,
  }),
).check(Schema.isMinLength(1));

const ApprovalProgress = Schema.Struct({
  status: Schema.Literals(["pending", "approved", "rejected"]),
  message: Schema.String,
});

const ApprovalResult = Schema.UndefinedOr(
  Schema.Struct({
    approved: Schema.Boolean,
  }),
);

const activeWorkflowStatuses = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

export const extractAgentName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export interface ApprovalRequestInfo {
  id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
}

export class OrganizationWorkflow extends AgentWorkflow<
  OrganizationAgent,
  { title: string; description: string },
  { status: "pending" | "approved" | "rejected"; message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ title: string; description: string }>,
    step: AgentWorkflowStep,
  ): Promise<{
    approved: boolean;
    title: string;
    resolvedAt: string;
    approvalData?: unknown;
  }> {
    const { title } = event.payload;

    // eslint-disable-next-line @typescript-eslint/require-await
    await step.do("prepare-request", async () => ({
      title,
      requestedAt: Date.now(),
    }));

    await this.reportProgress({
      status: "pending",
      message: `Waiting for approval: ${title}`,
    });

    try {
      const approvalData = await this.waitForApproval<{ approvedBy?: string }>(
        step,
        { timeout: "7 days" },
      );

      const result = {
        approved: true as const,
        title,
        resolvedAt: new Date().toISOString(),
        approvalData,
      };

      await this.reportProgress({
        status: "approved",
        message: `Approved: ${title}`,
      });

      await step.reportComplete(result);
      return result;
    } catch {
      await this.reportProgress({
        status: "rejected",
        message: `Rejected: ${title}`,
      });

      return {
        approved: false,
        title,
        resolvedAt: new Date().toISOString(),
      };
    }
  }
}

export class OrganizationImageClassificationWorkflow extends AgentWorkflow<
  OrganizationAgent,
  { idempotencyKey: string; r2ObjectKey: string },
  { status: string; message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ idempotencyKey: string; r2ObjectKey: string }>,
    step: AgentWorkflowStep,
  ): Promise<{ idempotencyKey: string; label: string; score: number }> {
    const { idempotencyKey, r2ObjectKey } = event.payload;
    await this.reportProgress({
      status: "running",
      message: `Classifying ${r2ObjectKey}`,
    });
    const bytes = await step.do("load-image-bytes", async () => {
      const object = await this.env.R2.get(r2ObjectKey);
      const body = object?.body;
      if (!body) {
        throw new Error(`R2 object not found: ${r2ObjectKey}`);
      }
      const arr = new Uint8Array(await new Response(body).arrayBuffer());
      return Array.from(arr);
    });
    const top = await step.do("classify-image", async () => {
      const response = await this.env.AI.run(
        "@cf/microsoft/resnet-50",
        { image: bytes },
        {
          gateway: {
            id: this.env.AI_GATEWAY_ID,
            skipCache: false,
            cacheTtl: 7 * 24 * 60 * 60,
          },
        },
      );
      const predictions = Schema.decodeUnknownSync(ResnetPredictions)(response);
      const first = predictions[0];
      return first;
    });
    await step.do("apply-classification-result", async () => {
      await this.agent.applyClassificationResult({
        idempotencyKey,
        label: top.label,
        score: top.score,
      });
    });
    return { idempotencyKey, label: top.label, score: top.score };
  }
}

export class OrganizationAgent extends AIChatAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    void this
      .sql`create table if not exists Upload (
        name text primary key,
        createdAt integer not null,
        eventTime integer not null,
        idempotencyKey text not null unique,
        classificationLabel text,
        classificationScore real,
        classifiedAt integer
      )`;
    void this
      .sql`create table if not exists GoogleConnection (
        id integer primary key check (id = 1),
        provider text not null,
        googleUserEmail text,
        scopes text not null,
        accessToken text,
        accessTokenExpiresAt integer,
        refreshToken text,
        idToken text,
        createdAt integer not null,
        updatedAt integer not null
      )`;
    void this
      .sql`create table if not exists GoogleOAuthState (
        state text primary key,
        codeVerifier text not null,
        createdAt integer not null,
        expiresAt integer not null
      )`;
    void this
      .sql`create table if not exists GoogleSheetsConfig (
        id integer primary key check (id = 1),
        defaultSpreadsheetId text,
        defaultSheetName text,
        updatedAt integer not null
      )`;
    void this
      .sql`create table if not exists GoogleSpreadsheetCache (
        spreadsheetId text primary key,
        name text not null,
        modifiedTime text,
        webViewLink text,
        lastSeenAt integer not null
      )`;
  }

  ping() {
    return {
      ok: true,
      now: new Date().toISOString(),
      agentId: this.ctx.id.toString(),
    };
  }

  @callable()
  bang() {
    return "bang";
  }

  protected broadcastMessage(msg: OrganizationMessage) {
    this.broadcast(JSON.stringify(msg));
  }

  /**
   * Create-first workflow orchestration for upload classification.
   * 1) Clean up agent-tracked workflow if active.
   * 2) Attempt workflow creation directly — create() itself is the existence check.
   * 3) On duplicate-ID failure, enter recovery: get → terminate → retry create.
   *    In recovery, .get() is only called when we know the instance exists, so any
   *    failure is genuinely transient and propagates (no silent swallow).
   * Avoids speculative .get() probing because the binding throws the same error for
   * "not found" and transient failures (undocumented, confirmed in miniflare source).
   * If any step in recovery fails, throw so queue retries preserve invariants.
   */
  async onUpload(upload: {
    name: string;
    eventTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(upload.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new Error(`Invalid eventTime: ${upload.eventTime}`);
    }
    const existing = Schema.decodeUnknownSync(Schema.NullOr(UploadRow))(this
      .sql<UploadRow>`select * from Upload where name = ${upload.name}`[0] ?? null);
    if (existing && eventTime < existing.eventTime) {
      console.log("classification workflow skipped for stale upload event", {
        name: upload.name,
        idempotencyKey: upload.idempotencyKey,
      });
      return;
    }
    void this.sql`
      insert into Upload (
        name,
        createdAt,
        eventTime,
        idempotencyKey,
        classificationLabel,
        classificationScore,
        classifiedAt
      ) values (
        ${upload.name},
        ${eventTime},
        ${eventTime},
        ${upload.idempotencyKey},
        null,
        null,
        null
      )
      on conflict(name) do update set
        createdAt = excluded.createdAt,
        eventTime = excluded.eventTime,
        idempotencyKey = excluded.idempotencyKey,
        classificationLabel = null,
        classificationScore = null,
        classifiedAt = null
    `;
    const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      await this.terminateWorkflow(upload.idempotencyKey);
    }
    const workflowParams = {
      idempotencyKey: upload.idempotencyKey,
      r2ObjectKey: upload.r2ObjectKey,
    } as const;
    const workflowOpts = { id: upload.idempotencyKey } as const;
    try {
      await this.runWorkflow(
        "OrganizationImageClassificationWorkflow",
        workflowParams,
        workflowOpts,
      );
    } catch {
      const instance = await this.env.OrganizationImageClassificationWorkflow
        .get(upload.idempotencyKey);
      const status = await instance.status();
      if (activeWorkflowStatuses.has(status.status)) {
        await instance.terminate();
      }
      await this.runWorkflow(
        "OrganizationImageClassificationWorkflow",
        workflowParams,
        workflowOpts,
      );
    }
    this.broadcastMessage({
      type: "classification_workflow_started",
      name: upload.name,
      idempotencyKey: upload.idempotencyKey,
    });
  }

  async onDelete(input: {
    name: string;
    eventTime: string;
    action: "DeleteObject" | "LifecycleDeletion";
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(input.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new Error(`Invalid eventTime: ${input.eventTime}`);
    }
    const existing = Schema.decodeUnknownSync(Schema.NullOr(UploadRow))(this
      .sql<UploadRow>`select * from Upload where name = ${input.name}`[0] ?? null);
    if (!existing || eventTime < existing.eventTime) {
      return;
    }
    const trackedWorkflow = this.getWorkflow(existing.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      try {
        await this.terminateWorkflow(existing.idempotencyKey);
      } catch (error) {
        console.warn("delete workflow termination failed", {
          name: input.name,
          idempotencyKey: existing.idempotencyKey,
          action: input.action,
          r2ObjectKey: input.r2ObjectKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const deleted = this.sql<{ name: string }>`
      delete from Upload
      where name = ${input.name} and eventTime <= ${eventTime}
      returning name
    `;
    if (deleted.length === 0) {
      return;
    }
    this.broadcastMessage({
      type: "upload_deleted",
      name: input.name,
      eventTime,
    });
  }

  applyClassificationResult(input: {
    idempotencyKey: string;
    label: string;
    score: number;
  }) {
    const classifiedAt = Date.now();
    const updated = this.sql<{ name: string; idempotencyKey: string }>`
      update Upload
      set classificationLabel = ${input.label},
          classificationScore = ${input.score},
          classifiedAt = ${classifiedAt}
      where idempotencyKey = ${input.idempotencyKey}
      returning name, idempotencyKey
    `;
    if (updated.length === 0) {
      return;
    }
    const row = updated[0];
    this.broadcastMessage({
      type: "classification_updated",
      name: row.name,
      idempotencyKey: row.idempotencyKey,
      label: input.label,
      score: input.score,
    });
  }

  @callable()
  getUploads() {
    return Schema.decodeUnknownSync(Schema.Array(UploadRow))(
      this.sql`select * from Upload order by createdAt desc`,
    );
  }

  @callable()
  beginGoogleOAuth(input: {
    state: string;
    codeVerifier: string;
    expiresAt: number;
  }) {
    const now = Date.now();
    void this.sql`insert or replace into GoogleOAuthState (
      state, codeVerifier, createdAt, expiresAt
    ) values (
      ${input.state}, ${input.codeVerifier}, ${now}, ${input.expiresAt}
    )`;
    return { ok: true };
  }

  @callable()
  consumeGoogleOAuthState(state: string) {
    const now = Date.now();
    const rows = this.sql<{
      state: string;
      codeVerifier: string;
      expiresAt: number;
    }>`select state, codeVerifier, expiresAt from GoogleOAuthState where state = ${state}`;
    if (rows.length === 0) {
      return { ok: false as const, reason: "missing" as const };
    }
    const row = rows[0];
    if (row.expiresAt < now) {
      void this.sql`delete from GoogleOAuthState where state = ${state}`;
      return { ok: false as const, reason: "expired" as const };
    }
    void this.sql`delete from GoogleOAuthState where state = ${state}`;
    return { ok: true as const, codeVerifier: row.codeVerifier };
  }

  @callable()
  saveGoogleTokens(input: {
    accessToken: string;
    accessTokenExpiresAt: number;
    refreshToken?: string;
    scope: string;
    idToken?: string;
  }) {
    const now = Date.now();
    const existingRows = this.sql<{ refreshToken: string | null }>`
      select refreshToken from GoogleConnection where id = 1
    `;
    const existingRefreshToken = existingRows.length > 0
      ? existingRows[0].refreshToken
      : null;
    const refreshToken = input.refreshToken ?? existingRefreshToken;
    void this.sql`insert into GoogleConnection (
      id, provider, googleUserEmail, scopes, accessToken, accessTokenExpiresAt,
      refreshToken, idToken, createdAt, updatedAt
    ) values (
      1, ${"google"}, null, ${input.scope}, ${input.accessToken},
      ${input.accessTokenExpiresAt}, ${refreshToken}, ${input.idToken ?? null},
      ${now}, ${now}
    )
    on conflict(id) do update set
      scopes = excluded.scopes,
      accessToken = excluded.accessToken,
      accessTokenExpiresAt = excluded.accessTokenExpiresAt,
      refreshToken = excluded.refreshToken,
      idToken = excluded.idToken,
      updatedAt = excluded.updatedAt`;
    return { ok: true };
  }

  @callable()
  getGoogleConnectionStatus() {
    const row = Schema.decodeUnknownSync(Schema.NullOr(GoogleConnectionRow))(this.sql<GoogleConnectionRow>`
      select * from GoogleConnection where id = 1
    `[0] ?? null);
    return {
      connected: Boolean(row?.refreshToken),
      scopes: row?.scopes ?? "",
      accessTokenExpiresAt: row?.accessTokenExpiresAt ?? null,
    };
  }

  @callable()
  disconnectGoogle() {
    void this.sql`delete from GoogleConnection where id = 1`;
    void this.sql`delete from GoogleOAuthState`;
    void this.sql`delete from GoogleSheetsConfig where id = 1`;
    void this.sql`delete from GoogleSpreadsheetCache`;
    return { ok: true };
  }

  @callable()
  getCachedDriveSpreadsheets() {
    return Schema.decodeUnknownSync(Schema.Array(GoogleSpreadsheetCacheRow))(this.sql<GoogleSpreadsheetCacheRow>`
      select * from GoogleSpreadsheetCache order by name asc
    `).map((row) => ({ ...row }));
  }

  @callable()
  setDefaultSpreadsheet(input: { spreadsheetId: string; sheetName?: string }) {
    const now = Date.now();
    void this.sql`insert into GoogleSheetsConfig (
      id, defaultSpreadsheetId, defaultSheetName, updatedAt
    ) values (
      1, ${input.spreadsheetId}, ${input.sheetName ?? "Sheet1"}, ${now}
    ) on conflict(id) do update set
      defaultSpreadsheetId = excluded.defaultSpreadsheetId,
      defaultSheetName = excluded.defaultSheetName,
      updatedAt = excluded.updatedAt`;
    return { ok: true };
  }

  @callable()
  getDefaultSpreadsheet() {
    const rows = this.sql<{
      defaultSpreadsheetId: string | null;
      defaultSheetName: string | null;
    }>`select defaultSpreadsheetId, defaultSheetName from GoogleSheetsConfig where id = 1`;
    if (rows.length === 0) {
      return { defaultSpreadsheetId: null, defaultSheetName: null };
    }
    return rows[0];
  }

  @callable()
  async listDriveSpreadsheets() {
    const accessToken = await this.getValidGoogleAccessToken();
    const data = await Effect.runPromise(
      Effect.provide(listDriveSpreadsheetsRequest(accessToken), FetchHttpClient.layer),
    );
    const now = Date.now();
    const files = (data.files ?? []).map((file) => ({
      spreadsheetId: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime ?? null,
      webViewLink: file.webViewLink ?? null,
    }));
    for (const file of files) {
      void this.sql`insert into GoogleSpreadsheetCache (
        spreadsheetId, name, modifiedTime, webViewLink, lastSeenAt
      ) values (
        ${file.spreadsheetId}, ${file.name}, ${file.modifiedTime},
        ${file.webViewLink}, ${now}
      ) on conflict(spreadsheetId) do update set
        name = excluded.name,
        modifiedTime = excluded.modifiedTime,
        webViewLink = excluded.webViewLink,
        lastSeenAt = excluded.lastSeenAt`;
    }
    return files;
  }

  @callable()
  async readDefaultRange(range?: string) {
    const cfg = this.getDefaultSpreadsheet();
    if (!cfg.defaultSpreadsheetId) {
      throw new Error("No default spreadsheet selected");
    }
    const sheetName = cfg.defaultSheetName ?? "Sheet1";
    const resolvedRange = range ?? `${sheetName}!A1:C20`;
    const accessToken = await this.getValidGoogleAccessToken();
    return Effect.runPromise(
      Effect.provide(
        getSpreadsheetValuesRequest(accessToken, cfg.defaultSpreadsheetId, resolvedRange),
        FetchHttpClient.layer,
      ),
    );
  }

  @callable()
  async appendDefaultRow(values: string[]) {
    const cfg = this.getDefaultSpreadsheet();
    if (!cfg.defaultSpreadsheetId) {
      throw new Error("No default spreadsheet selected");
    }
    const sheetName = cfg.defaultSheetName ?? "Sheet1";
    const accessToken = await this.getValidGoogleAccessToken();
    return Effect.runPromise(
      Effect.provide(
        appendSpreadsheetValuesRequest(accessToken, cfg.defaultSpreadsheetId, `${sheetName}!A:Z`, values),
        FetchHttpClient.layer,
      ),
    );
  }

  getAgentState() {
    const rows = this.sql`select * from cf_agents_state`;
    return Schema.decodeUnknownSync(Schema.Array(AgentState))(
      rows.map((r) => ({
        ...r,
        state: typeof r.state === "string" ? r.state : JSON.stringify(r.state),
      })),
    );
  }

  getAgentQueues() {
    return Schema.decodeUnknownSync(Schema.Array(AgentQueue))(
      this.sql`select * from cf_agents_queues order by created_at`,
    );
  }

  getAgentSchedules() {
    return Schema.decodeUnknownSync(Schema.Array(AgentSchedule))(
      this.sql`select * from cf_agents_schedules order by created_at`,
    );
  }

  getAgentWorkflows() {
    return Schema.decodeUnknownSync(Schema.Array(AgentWorkflowRow))(
      this.sql`select * from cf_agents_workflows order by created_at`,
    );
  }

  getChatMessages() {
    const rows = this
      .sql`select * from cf_ai_chat_agent_messages order by created_at`;
    return Schema.decodeUnknownSync(Schema.Array(ChatMessage))(
      rows.map((r) => ({
        ...r,
        message:
          typeof r.message === "string" ? r.message : JSON.stringify(r.message),
      })),
    );
  }

  getChatStreamChunks() {
    return Schema.decodeUnknownSync(Schema.Array(ChatStreamChunk))(
      this
        .sql`select * from cf_ai_chat_stream_chunks order by stream_id, chunk_index`,
    );
  }

  getChatStreamMetadata() {
    return Schema.decodeUnknownSync(Schema.Array(ChatStreamMetadata))(
      this.sql`select * from cf_ai_chat_stream_metadata order by created_at`,
    );
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 7 * 24 * 60 * 60,
      },
    });
    const result = streamText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      messages: await convertToModelMessages(this.messages),
      onFinish,
    });
    return result.toUIMessageStreamResponse();
  }

  private _toApprovalRequest(w: WorkflowInfo): ApprovalRequestInfo {
    const metadata = w.metadata as {
      title?: string;
      description?: string;
    } | null;

    let status: "pending" | "approved" | "rejected" = "pending";
    if (w.status === "complete") {
      status = "approved";
    } else if (w.status === "errored" || w.status === "terminated") {
      status = "rejected";
    }

    return {
      id: w.workflowId,
      title: metadata?.title ?? "Untitled",
      description: metadata?.description ?? "",
      status,
      createdAt: w.createdAt.toISOString(),
      resolvedAt: w.completedAt?.toISOString(),
      reason: w.error?.message,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown,
  ): Promise<void> {
    if (workflowName !== "OrganizationWorkflow") {
      return;
    }
    const approvalProgress = Schema.decodeUnknownSync(ApprovalProgress)(progress);
    this.broadcastMessage({ type: "workflow_progress", workflowId, progress: approvalProgress });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown,
  ): Promise<void> {
    if (workflowName !== "OrganizationWorkflow") {
      return;
    }
    const approvalResult = Schema.decodeUnknownSync(ApprovalResult)(result);
    this.broadcastMessage({ type: "workflow_complete", workflowId, result: approvalResult });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName === "OrganizationWorkflow") {
      this.broadcastMessage({ type: "workflow_error", workflowId, error });
      return;
    }
    if (workflowName !== "OrganizationImageClassificationWorkflow") {
      return;
    }
    const row = Schema.decodeUnknownSync(Schema.NullOr(UploadRow))(this
      .sql<UploadRow>`select * from Upload where idempotencyKey = ${workflowId}`[0] ?? null);
    if (row?.idempotencyKey !== workflowId) {
      return;
    }
    this.broadcastMessage({
      type: "classification_error",
      name: row.name,
      idempotencyKey: workflowId,
      error,
    });
  }

  @callable()
  async requestApproval(
    title: string,
    description: string,
  ): Promise<ApprovalRequestInfo> {
    const workflowId = await this.runWorkflow(
      "OrganizationWorkflow",
      { title, description },
      { metadata: { title, description } },
    );

    this.broadcastMessage({ type: "approval_requested", workflowId, title });

    return {
      id: workflowId,
      title,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  }

  @callable()
  async approveRequest(workflowId: string): Promise<boolean> {
    const workflow = this.getWorkflow(workflowId);
    if (
      !workflow ||
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    await this.approveWorkflow(workflowId, {
      reason: "Approved",
      metadata: { approvedBy: "user" },
    });

    return true;
  }

  @callable()
  async rejectRequest(workflowId: string, reason?: string): Promise<boolean> {
    const workflow = this.getWorkflow(workflowId);
    if (
      !workflow ||
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    await this.rejectWorkflow(workflowId, {
      reason: reason ?? "Rejected",
    });

    return true;
  }

  @callable()
  listApprovalRequests(): ApprovalRequestInfo[] {
    const { workflows } = this.getWorkflows({
      workflowName: "OrganizationWorkflow",
    });
    return workflows.map((w) => this._toApprovalRequest(w));
  }

  @callable()
  async feeFi(): Promise<string> {
    const ai = this.env.AI;
    const response = await ai.run(
      "@cf/meta/llama-3.1-8b-instruct-awq",
      { prompt: "fee fi" },
      {
        gateway: {
          id: this.env.AI_GATEWAY_ID,
          skipCache: false,
          cacheTtl: 7 * 24 * 60 * 60,
        },
      },
    );
    const output = response.response;
    return output && output.trim().length > 0 ? output : "No response";
  }

  @callable()
  async feeFi1(): Promise<string> {
    const gatewayUrl = await this.env.AI.gateway(this.env.AI_GATEWAY_ID).getUrl(
      "workers-ai",
    );
    const openai = createOpenAI({
      baseURL: `${gatewayUrl}/v1`,
      apiKey: this.env.WORKERS_AI_API_TOKEN,
      headers: {
        "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
      },
    });
    const { text } = await generateText({
      model: openai.chat("@cf/meta/llama-3.1-8b-instruct-awq"),
      prompt: "fee fi",
    });
    return text && text.trim().length > 0 ? text : "No response";
  }

  @callable()
  async feeFi2(): Promise<string> {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 7 * 24 * 60 * 60,
      },
    });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      prompt: "fee fi",
    });
    return text && text.trim().length > 0 ? text : "No response";
  }

  private getGoogleConnectionRow() {
    return Schema.decodeUnknownSync(Schema.NullOr(GoogleConnectionRow))(this.sql<GoogleConnectionRow>`
      select * from GoogleConnection where id = 1
    `[0] ?? null);
  }

  private async getValidGoogleAccessToken() {
    const row = this.getGoogleConnectionRow();
    if (!row?.refreshToken) {
      throw new Error("Google not connected");
    }
    if (
      row.accessToken &&
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt > Date.now() + 60_000
    ) {
      return row.accessToken;
    }
    await this.refreshGoogleAccessToken(row.refreshToken);
    const refreshed = this.getGoogleConnectionRow();
    if (!refreshed?.accessToken) {
      throw new Error("Google token refresh failed");
    }
    return refreshed.accessToken;
  }

  private async refreshGoogleAccessToken(refreshToken: string) {
    const token = await Effect.runPromise(
      refreshGoogleToken({
        clientId: this.env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: Redacted.make(this.env.GOOGLE_OAUTH_CLIENT_SECRET),
        redirectUri: this.env.GOOGLE_OAUTH_REDIRECT_URI,
        refreshToken,
      }),
    );
    const current = this.getGoogleConnectionRow();
    if (!current) {
      throw new Error("Google connection missing");
    }
    const now = Date.now();
    void this.sql`update GoogleConnection
      set accessToken = ${token.access_token},
          accessTokenExpiresAt = ${now + token.expires_in * 1000},
          scopes = ${token.scope ?? current.scopes},
          idToken = ${token.id_token ?? current.idToken},
          updatedAt = ${now}
      where id = 1`;
  }
}
