import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Context } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { expect, vi, afterEach } from "vitest";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { login as loginServerFn } from "@/lib/Login";
import { queue } from "@/lib/Q";
import { Repository } from "@/lib/Repository";
import { getUserProvisioningOrganization } from "@/lib/UserProvisioning";

import { callServerFn, resetDb, workerFetch } from "../TestUtils";

const envLayer = Layer.succeedContext(Context.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);

const decodeUserId = Schema.decodeUnknownSync(Domain.User.fields.id);
const decodeOrganizationId = Schema.decodeUnknownSync(Domain.Organization.fields.id);
const decodeQueueBatchResult = Schema.decodeUnknownSync(
  Schema.Struct({
    outcome: Schema.String,
    explicitAcks: Schema.Array(Schema.String),
  }),
);
const decodeWorkflowBatchItems = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      params: Schema.Struct({
        userId: Schema.String,
        email: Schema.String,
      }),
    }),
  ),
);

const seedUser = Effect.fn("seed.user")(function* (overrides?: {
  id?: Domain.User["id"];
  email?: Domain.User["email"];
}) {
  const d1 = yield* D1;
  const id = overrides?.id ?? decodeUserId(crypto.randomUUID());
  const email = overrides?.email ?? `${id}@test.com`;
  yield* d1.run(
    d1.prepare(
      "insert into User (id, name, email, role, emailVerified, stripeCustomerId) values (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(id, "Test User", email, "user", 1, null),
  );
  return { id, email };
});

const seedOrganization = Effect.fn("seed.organization")(function* (overrides?: {
  id?: Domain.Organization["id"];
  slug?: Domain.Organization["slug"];
}) {
  const d1 = yield* D1;
  const id = overrides?.id ?? decodeOrganizationId(crypto.randomUUID());
  const slug = overrides?.slug ?? `org-${id.slice(0, 8)}`;
  yield* d1.run(
    d1.prepare("insert into Organization (id, name, slug) values (?1, ?2, ?3)")
      .bind(id, "Test Org", slug),
  );
  return { id, slug };
});

const seedMember = Effect.fn("seed.member")(function* ({
  userId,
  organizationId,
  role,
}: {
  userId: Domain.User["id"];
  organizationId: Domain.Organization["id"];
  role: Domain.MemberRole;
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Member.fields.id)(crypto.randomUUID());
  yield* d1.run(
    d1.prepare("insert into Member (id, userId, organizationId, role) values (?1, ?2, ?3, ?4)")
      .bind(id, userId, organizationId, role),
  );
  return { id };
});

const seedSession = Effect.fn("seed.session")(function* ({
  userId,
  activeOrganizationId,
}: {
  userId: Domain.User["id"];
  activeOrganizationId?: Domain.Organization["id"] | null;
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Session.fields.id)(crypto.randomUUID());
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  yield* d1.run(
    d1.prepare(
      "insert into Session (id, expiresAt, token, userId, activeOrganizationId) values (?1, ?2, ?3, ?4, ?5)",
    ).bind(id, expiresAt, token, userId, activeOrganizationId ?? null),
  );
  return { id, token };
});

const countMembers = Effect.fn("countMembers")(function* ({
  userId,
  organizationId,
}: {
  userId: Domain.User["id"];
  organizationId: Domain.Organization["id"];
}) {
  const d1 = yield* D1;
  const row = yield* d1.first<{ cnt: number }>(
    d1.prepare("select count(*) as cnt from Member where userId = ?1 and organizationId = ?2")
      .bind(userId, organizationId),
  );
  return Option.getOrThrow(row).cnt;
});

const countOwnedOrganizations = Effect.fn("countOwnedOrganizations")(function* (
  userId: Domain.User["id"],
) {
  const d1 = yield* D1;
  const row = yield* d1.first<{ cnt: number }>(
    d1
      .prepare("select count(distinct organizationId) as cnt from Member where userId = ?1 and role = 'owner'")
      .bind(userId),
  );
  return Option.getOrThrow(row).cnt;
});

const getSessionActiveOrg = Effect.fn("getSessionActiveOrg")(function* (
  sessionId: Domain.Session["id"],
) {
  const d1 = yield* D1;
  const row = yield* d1.first<{ activeOrganizationId: string | null }>(
    d1.prepare("select activeOrganizationId from Session where id = ?1").bind(sessionId),
  );
  return Option.getOrThrow(row).activeOrganizationId;
});

interface StepModifier {
  disableSleeps(): Promise<void>;
  disableRetryDelays(): Promise<void>;
  mockStepError(step: { name: string }, error: Error, times?: number): Promise<void>;
}

const runWorkflow = async ({
  instanceId,
  params,
  modify,
}: {
  instanceId: string;
  params: { userId: string; email: string };
  modify?: (m: StepModifier) => Promise<void>;
}): Promise<{ orgId: unknown }> => {
  const instance = await introspectWorkflowInstance(
    env.USER_PROVISIONING_WORKFLOW,
    instanceId,
  );
  try {
    await instance.modify(async (m: StepModifier) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      if (modify) await modify(m);
    });
    await env.USER_PROVISIONING_WORKFLOW.create({ id: instanceId, params });
    const orgId = await instance.waitForStepResult({ name: "create-organization" });
    await instance.waitForStatus("complete");
    return { orgId };
  } finally {
    await instance.dispose();
  }
};

const runQueueBatch = async (messages: {
  id: string;
  timestamp: Date;
  attempts: number;
  body: unknown;
}[]) => {
  const batch = createMessageBatch("tces-q-local", messages);
  const ctx = createExecutionContext();
  if (!queue) throw new Error("Queue handler is not configured");
  await queue(batch, env, ctx);
  return decodeQueueBatchResult(await getQueueResult(batch, ctx));
};

afterEach(() => {
  vi.restoreAllMocks();
});

layer(repositoryLayer)("createOrganization idempotency", (it) => {
  it.effect("happy path — neither org nor member exist", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();

      const { orgId } = yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: user.id,
          params: { userId: user.id, email: user.email },
        }),
      );
      expect(orgId).toBeDefined();
      expect(typeof orgId).toBe("string");

      const repo = yield* Repository;
      const org = yield* repo.getOwnerOrganizationByUserId(user.id);
      expect(Option.isSome(org)).toBe(true);
      const { slug } = getUserProvisioningOrganization({ userId: user.id, email: user.email });
      expect(Option.getOrThrow(org).slug).toBe(slug);

      const member = yield* repo.getMemberByUserAndOrg({
        userId: user.id,
        organizationId: Option.getOrThrow(org).id,
      });
      expect(Option.isSome(member)).toBe(true);
      expect(Option.getOrThrow(member).role).toBe("owner");
      const ownerOrgCount = yield* countOwnedOrganizations(user.id);
      expect(ownerOrgCount).toBe(1);
    }));

  it.effect("short-circuit — org + owner member already exist", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();
      const { slug } = getUserProvisioningOrganization({ userId: user.id, email: user.email });
      const org = yield* seedOrganization({ slug });
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });

      const { orgId } = yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: user.id,
          params: { userId: user.id, email: user.email },
        }),
      );
      expect(orgId).toBe(org.id);

      const memberCount = yield* countMembers({ userId: user.id, organizationId: org.id });
      expect(memberCount).toBe(1);
    }));

  it.effect("recovery — org exists but owner member missing", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();
      const { slug } = getUserProvisioningOrganization({ userId: user.id, email: user.email });
      const org = yield* seedOrganization({ slug });

      const { orgId } = yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: user.id,
          params: { userId: user.id, email: user.email },
        }),
      );
      expect(orgId).toBe(org.id);

      const repo = yield* Repository;
      const member = yield* repo.getMemberByUserAndOrg({
        userId: user.id,
        organizationId: org.id,
      });
      expect(Option.isSome(member)).toBe(true);
      expect(Option.getOrThrow(member).role).toBe("owner");
    }));

  it.effect("double call — running workflow twice converges", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();

      const { orgId: orgId1 } = yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: `${user.id}-1`,
          params: { userId: user.id, email: user.email },
        }),
      );
      const { orgId: orgId2 } = yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: `${user.id}-2`,
          params: { userId: user.id, email: user.email },
        }),
      );
      expect(orgId1).toBe(orgId2);

      const memberCount = yield* countMembers({
        userId: user.id,
        organizationId: decodeOrganizationId(orgId1),
      });
      expect(memberCount).toBe(1);
      const ownerOrgCount = yield* countOwnedOrganizations(user.id);
      expect(ownerOrgCount).toBe(1);
    }));
});

layer(repositoryLayer)("workflow steps", (it) => {
  it.effect("full workflow completes all 4 steps", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();

      yield* Effect.tryPromise(async () => {
        const instance = await introspectWorkflowInstance(
          env.USER_PROVISIONING_WORKFLOW,
          user.id,
        );
        try {
          await instance.modify(async (m: StepModifier) => {
            await m.disableSleeps();
            await m.disableRetryDelays();
          });
          await env.USER_PROVISIONING_WORKFLOW.create({
            id: user.id,
            params: { userId: user.id, email: user.email },
          });

          const orgId = await instance.waitForStepResult({ name: "create-organization" });
          expect(orgId).toBeDefined();
          await instance.waitForStepResult({ name: "initialize-active-organization-for-sessions" });
          await instance.waitForStepResult({ name: "init-organization-agent" });
          await instance.waitForStepResult({ name: "sync-membership" });
          await instance.waitForStatus("complete");

          const output = await instance.getOutput();
          expect(output).toHaveProperty("organizationId");
        } finally {
          await instance.dispose();
        }
      });
    }));

  it.effect("session activeOrganizationId backfilled by workflow", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();
      const session = yield* seedSession({ userId: user.id });

      yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: user.id,
          params: { userId: user.id, email: user.email },
        }),
      );

      const activeOrg = yield* getSessionActiveOrg(session.id);
      expect(activeOrg).not.toBeNull();
    }));

  it.effect("session with existing activeOrganizationId not overwritten", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();
      const { slug } = getUserProvisioningOrganization({ userId: user.id, email: user.email });
      const existingOrg = yield* seedOrganization({ slug });
      yield* seedMember({ userId: user.id, organizationId: existingOrg.id, role: "owner" });
      const session = yield* seedSession({
        userId: user.id,
        activeOrganizationId: existingOrg.id,
      });

      yield* Effect.tryPromise(() =>
        runWorkflow({
          instanceId: `${user.id}-new`,
          params: { userId: user.id, email: user.email },
        }),
      );

      const activeOrg = yield* getSessionActiveOrg(session.id);
      expect(activeOrg).toBe(existingOrg.id);
    }));
});

layer(repositoryLayer)("queue safety net", (it) => {
  it.effect("enqueue before hook is durable fallback when inline provisioning fails", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const email = `${crypto.randomUUID()}@test.com`;

      const sendSpy = vi.spyOn(env.Q, "send").mockImplementation(() => Promise.resolve());
      const createBatchSpy = vi.spyOn(env.USER_PROVISIONING_WORKFLOW, "createBatch")
        .mockRejectedValueOnce(new Error("inline provisioning failure"))
        .mockResolvedValue([]);

      const loginResult = yield* callServerFn({
        serverFn: loginServerFn,
        data: { email },
      });
      expect(loginResult.magicLink).toBeDefined();
      yield* workerFetch(loginResult.magicLink ?? "", { redirect: "manual" });

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "EnsureUserProvisioned",
          email,
        }),
      );
      expect(createBatchSpy).toHaveBeenCalledTimes(1);

      const queuedMessage = sendSpy.mock.calls[0]?.[0] as {
        action: "EnsureUserProvisioned";
        email: string;
      };
      const msgId = crypto.randomUUID();
      const result = yield* Effect.tryPromise(() =>
        runQueueBatch([{
          id: msgId,
          timestamp: new Date(),
          attempts: 1,
          body: queuedMessage,
        }]),
      );

      expect(result.outcome).toBe("ok");
      expect(result.explicitAcks).toContain(msgId);
      expect(createBatchSpy).toHaveBeenCalledTimes(2);
    }));

  it.effect("processEnsureUserProvisioned triggers workflow for existing user", () =>
    Effect.gen(function* () {
      yield* resetDb();
      const user = yield* seedUser();

      const createBatchSpy = vi.spyOn(env.USER_PROVISIONING_WORKFLOW, "createBatch");

      const msgId = crypto.randomUUID();
      const result = yield* Effect.tryPromise(() =>
        runQueueBatch([{
          id: msgId,
          timestamp: new Date(),
          attempts: 1,
          body: { action: "EnsureUserProvisioned", email: user.email },
        }]),
      );

      expect(result.outcome).toBe("ok");
      expect(result.explicitAcks).toContain(msgId);
      expect(createBatchSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: user.id,
            params: { userId: user.id, email: user.email },
          }),
        ]),
      );
      const firstBatchItems = decodeWorkflowBatchItems(
        createBatchSpy.mock.calls[0]?.[0] ?? [],
      );
      expect(firstBatchItems[0]?.id).toBe(user.id);
      expect(firstBatchItems[0]?.params).toEqual({
        userId: user.id,
        email: user.email,
      });
    }));

  it.effect("processEnsureUserProvisioned skips nonexistent user", () =>
    Effect.gen(function* () {
      yield* resetDb();

      const createBatchSpy = vi.spyOn(env.USER_PROVISIONING_WORKFLOW, "createBatch");

      const msgId = crypto.randomUUID();
      const result = yield* Effect.tryPromise(() =>
        runQueueBatch([{
          id: msgId,
          timestamp: new Date(),
          attempts: 1,
          body: { action: "EnsureUserProvisioned", email: "nonexistent@test.com" },
        }]),
      );

      expect(result.outcome).toBe("ok");
      expect(result.explicitAcks).toContain(msgId);
      expect(createBatchSpy).not.toHaveBeenCalled();
    }));

  it.effect("invalid queue message is acked (schema error swallowed)", () =>
    Effect.gen(function* () {
      const msgId = crypto.randomUUID();
      const result = yield* Effect.tryPromise(() =>
        runQueueBatch([{
          id: msgId,
          timestamp: new Date(),
          attempts: 1,
          body: { action: "UnknownAction", foo: "bar" },
        }]),
      );

      expect(result.outcome).toBe("ok");
      expect(result.explicitAcks).toContain(msgId);
    }));
});
