import * as Schema from "effect/Schema";

export const organizationMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upload_error"),
    name: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("upload_deleted"),
    name: Schema.String,
    eventTime: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow_progress"),
    workflowId: Schema.String,
    progress: Schema.Struct({
      status: Schema.String,
      message: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("workflow_complete"),
    workflowId: Schema.String,
    result: Schema.optionalKey(
      Schema.Struct({
        approved: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("workflow_error"),
    workflowId: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("approval_requested"),
    workflowId: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("classification_workflow_started"),
    name: Schema.String,
    idempotencyKey: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("classification_updated"),
    name: Schema.String,
    idempotencyKey: Schema.String,
    label: Schema.String,
    score: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("classification_error"),
    name: Schema.String,
    idempotencyKey: Schema.String,
    error: Schema.String,
  }),
]);

export type OrganizationMessage = typeof organizationMessageSchema.Type;
