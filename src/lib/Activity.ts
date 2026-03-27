import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const ActivityMessageSchema = Schema.Struct({
  createdAt: Schema.String,
  level: Schema.Literals(["info", "success", "error"]),
  text: Schema.String,
});

export type ActivityMessage = typeof ActivityMessageSchema.Type;

export const activityQueryKey = (organizationId: string) =>
  ["organization", organizationId, "activity"] as const;

export const decodeActivityMessage = (
  event: MessageEvent,
): ActivityMessage | null => {
  const result = Schema.decodeUnknownExit(
    Schema.fromJsonString(ActivityMessageSchema),
  )(String(event.data));
  return Exit.isSuccess(result) ? result.value : null;
};

export const shouldInvalidateForInvoice = (text: string) =>
  text.startsWith("Invoice uploaded:") ||
  text.startsWith("Invoice extraction completed:") ||
  text.startsWith("Invoice extraction failed:") ||
  text.startsWith("Invoice updated:") ||
  text === "Invoice deleted";
