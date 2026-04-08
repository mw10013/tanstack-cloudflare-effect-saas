import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const ActivityAction = Schema.Literals([
  "invoice.uploaded",
  "invoice.created",
  "invoice.extraction.completed",
  "invoice.extraction.failed",
  "invoice.extraction.progress",
]);

export const ActivityMessage = Schema.Struct({
  createdAt: Schema.String,
  level: Schema.Literals(["info", "success", "error"]),
  text: Schema.String,
  action: ActivityAction,
});

export type ActivityMessage = typeof ActivityMessage.Type;

export const decodeActivityMessage = (
  event: MessageEvent,
): ActivityMessage | null => {
  const result = Schema.decodeUnknownExit(
    Schema.fromJsonString(ActivityMessage),
  )(String(event.data));
  return Exit.isSuccess(result) ? result.value : null;
};

const INVALIDATING_ACTIONS: ReadonlySet<string> = new Set([
  "invoice.uploaded",
  "invoice.created",
  "invoice.extraction.completed",
  "invoice.extraction.failed",
]);

export const shouldInvalidateForInvoice = (action: string) =>
  INVALIDATING_ACTIONS.has(action);
