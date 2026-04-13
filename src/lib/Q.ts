import { Effect, Layer } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";
import { ensureUserProvisionedWorkflow } from "@/lib/UserProvisioning";

const R2PutObjectNotification = Schema.Struct({
  action: Schema.Literals(["PutObject"]),
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

export const membershipSyncChangeValues = [
  "added",
  "removed",
  "role_changed",
] as const;

export const MembershipSyncChange = Schema.Literals(membershipSyncChangeValues);

export type MembershipSyncChange = typeof MembershipSyncChange.Type;

export const FinalizeMembershipSyncQueueMessage = Schema.Struct({
  action: Schema.Literals(["FinalizeMembershipSync"]),
  organizationId: Domain.Organization.fields.id,
  userId: Domain.User.fields.id,
  change: MembershipSyncChange,
});

export const EnsureUserProvisionedQueueMessage = Schema.Struct({
  action: Schema.Literals(["EnsureUserProvisioned"]),
  email: Domain.User.fields.email,
});

export const QueueMessage = Schema.Union([
  R2PutObjectNotification,
  FinalizeMembershipSyncQueueMessage,
  EnsureUserProvisionedQueueMessage,
]);

export type QueueMessage = typeof QueueMessage.Type;

export const enqueue = Effect.fn("enqueue")(function* (message: QueueMessage) {
  const env = yield* CloudflareEnv;
  yield* Effect.tryPromise(() => env.Q.send(message));
});

/**
 * Handles Cloudflare R2 event notification messages for object uploads.
 *
 * This function processes queue messages where `action` is `PutObject`.
 * Cloudflare's R2 notification payload includes `action`, `object.key`, and
 * `eventTime`, so this handler routes the event to the organization Durable
 * Object and leaves R2 metadata reads to `onInvoiceUpload`.
 */
const processInvoiceUpload = Effect.fn("processInvoiceUpload")(function* (
  notification: typeof R2PutObjectNotification.Type,
) {
  const [organizationId] = notification.object.key.split("/", 1);
  const organizationIdValue = yield* Schema.decodeUnknownEffect(
    Domain.Organization.fields.id,
  )(organizationId);
  const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
  const id = ORGANIZATION_AGENT.idFromName(organizationIdValue);
  const stub = ORGANIZATION_AGENT.get(id);
  yield* Effect.tryPromise(() =>
    stub.onInvoiceUpload({
      r2ActionTime: notification.eventTime,
      r2ObjectKey: notification.object.key,
    }),
  );
});

const processFinalizeMembershipSync = Effect.fn(
  "processFinalizeMembershipSync",
)(function* (message: typeof FinalizeMembershipSyncQueueMessage.Type) {
  const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
  const id = ORGANIZATION_AGENT.idFromName(message.organizationId);
  const stub = ORGANIZATION_AGENT.get(id);
  yield* Effect.tryPromise(() =>
    stub.onFinalizeMembershipSync({
      userId: message.userId,
      change: message.change,
    }),
  );
});

const processEnsureUserProvisioned = Effect.fn(
  "processEnsureUserProvisioned",
)(function* (message: typeof EnsureUserProvisionedQueueMessage.Type) {
  const repository = yield* Repository;
  const user = yield* repository.getUser(message.email);
  if (Option.isNone(user)) return;
  yield* ensureUserProvisionedWorkflow({
    userId: user.value.id,
    email: user.value.email,
  });
});

const processMessage = Effect.fn("processMessage")(function* (
  rawMessage: unknown,
) {
  const message = yield* Schema.decodeUnknownEffect(QueueMessage)(rawMessage);
  switch (message.action) {
    case "PutObject": {
      return yield* processInvoiceUpload(message);
    }
    case "FinalizeMembershipSync": {
      return yield* processFinalizeMembershipSync(message);
    }
    case "EnsureUserProvisioned": {
      return yield* processEnsureUserProvisioned(message);
    }
  }
});

const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  return Layer.mergeAll(envLayer, repositoryLayer, makeLoggerLayer(env));
};

export const queue: ExportedHandler<Env>["queue"] = async (batch, env) => {
  await Effect.forEach(
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is not Array.prototype.forEach
    batch.messages,
    (queueMessage) =>
      processMessage(queueMessage.body).pipe(
        Effect.catchTag("SchemaError", () => Effect.void),
        Effect.match({
          onSuccess: () => {
            queueMessage.ack();
          },
          onFailure: () => {
            queueMessage.retry();
          },
        }),
      ),
    { discard: true },
  ).pipe(Effect.provide(makeRuntimeLayer(env)), Effect.runPromise);
};
