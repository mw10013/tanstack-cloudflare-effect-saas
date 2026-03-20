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
