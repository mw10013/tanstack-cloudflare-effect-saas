import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const ActivityLevel = Schema.Literals(["info", "success", "error"]);

export const ActivityMessageSchema = Schema.Struct({
  createdAt: Schema.String,
  level: ActivityLevel,
  text: Schema.String,
});

export const WorkflowProgressSchema = Schema.Struct({
  level: ActivityLevel,
  text: Schema.String,
});

export const ActivityEnvelopeSchema = Schema.Struct({
  type: Schema.Literals(["activity"]),
  message: ActivityMessageSchema,
});

export type ActivityMessage = typeof ActivityMessageSchema.Type;
export type ActivityEnvelope = typeof ActivityEnvelopeSchema.Type;
export type WorkflowProgress = typeof WorkflowProgressSchema.Type;

export const activityQueryKey = (organizationId: string) =>
  ["organization", organizationId, "activity"] as const;

export const decodeActivityMessage = (
  event: MessageEvent,
): ActivityMessage | null => {
  const result = Schema.decodeUnknownExit(
    Schema.fromJsonString(ActivityEnvelopeSchema),
  )(String(event.data));
  return Exit.isSuccess(result) ? result.value.message : null;
};

export const shouldInvalidateForInvoice = (text: string) =>
  text.startsWith("Invoice uploaded:") ||
  text.startsWith("Invoice extraction completed:") ||
  text.startsWith("Invoice extraction failed:") ||
  text.startsWith("Invoice updated:") ||
  text === "Invoice deleted";
