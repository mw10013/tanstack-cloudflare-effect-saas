import { env } from "cloudflare:workers";
import { ConfigProvider, Effect, Layer, Schedule, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { assertInclude } from "@effect/vitest/utils";
import { expect } from "vitest";

import { switchOrganizationServerFn } from "@/routes/app.$organizationId";
import { acceptInvitation } from "@/routes/app.$organizationId.index";
import {
  getLoaderData as getInvitationsLoaderData,
  invite,
} from "@/routes/app.$organizationId.invitations";
import {
  getLoaderData as getMembersLoaderData,
  removeMember,
} from "@/routes/app.$organizationId.members";

import {
  agentWebSocket,
  assertAgentRpcFailure,
  assertAgentRpcSuccess,
  callAgentRpc,
  callServerFn,
  login,
  workerFetch,
} from "../TestUtils";

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

const invoiceIdResult = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
});

const inviteMember = Effect.fn("inviteMember")(function* ({
  ownerSessionCookie,
  ownerOrganizationId,
  memberEmail,
}: {
  ownerSessionCookie: string;
  ownerOrganizationId: string;
  memberEmail: string;
}) {
  yield* callServerFn({
    serverFn: invite,
    data: {
      organizationId: ownerOrganizationId,
      emails: memberEmail,
      role: "member",
    },
    headers: { Cookie: ownerSessionCookie },
  });
});

const findInvitationId = Effect.fn("findInvitationId")(function* ({
  ownerSessionCookie,
  organizationId,
  email,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  email: string;
}) {
  const loaderData = yield* callServerFn({
    serverFn: getInvitationsLoaderData,
    data: { organizationId },
    headers: { Cookie: ownerSessionCookie },
  });
  const invitation = loaderData.invitations.find(
    (item) =>
      item.organizationId === organizationId &&
      item.email.toLowerCase() === email.toLowerCase() &&
      item.status === "pending",
  );
  if (!invitation)
    return yield* Effect.fail(new Error("Invitation not found for member"));
  return invitation.id;
});

const acceptInvitationInApp = Effect.fn("acceptInvitationInApp")(function* ({
  sessionCookie,
  invitationId,
  organizationId,
}: {
  sessionCookie: string;
  invitationId: string;
  organizationId: string;
}) {
  yield* callServerFn({
    serverFn: acceptInvitation,
    data: { invitationId, organizationId },
    headers: { Cookie: sessionCookie },
  });
});

const setActiveOrganization = Effect.fn("setActiveOrganization")(function* ({
  sessionCookie,
  organizationId,
}: {
  sessionCookie: string;
  organizationId: string;
}) {
  yield* callServerFn({
    serverFn: switchOrganizationServerFn,
    data: organizationId,
    headers: { Cookie: sessionCookie },
  });
});

const getMemberIdByEmail = Effect.fn("getMemberIdByEmail")(function* ({
  ownerSessionCookie,
  organizationId,
  memberEmail,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  memberEmail: string;
}) {
  const loaderData = yield* callServerFn({
    serverFn: getMembersLoaderData,
    data: { organizationId },
    headers: { Cookie: ownerSessionCookie },
  });
  const member = loaderData.members.find(
    (item) => item.user.email.toLowerCase() === memberEmail.toLowerCase(),
  );
  if (!member) return yield* Effect.fail(new Error("Member not found"));
  return member.id;
});

const removeMemberInApp = Effect.fn("removeMemberInApp")(function* ({
  ownerSessionCookie,
  organizationId,
  memberId,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  memberId: string;
}) {
  yield* callServerFn({
    serverFn: removeMember,
    data: { organizationId, memberId },
    headers: { Cookie: ownerSessionCookie },
  });
});

const waitForCreateInvoiceSuccess = Effect.fn("waitForCreateInvoiceSuccess")(
  function* (ws: WebSocket) {
    return yield* callAgentRpc(ws, "createInvoice", []).pipe(
      Effect.flatMap((result) =>
        result.success
          ? Effect.succeed(result)
          : Effect.fail(new Error(result.error)),
      ),
      Effect.retry(
        Schedule.spaced("1 second").pipe(
          Schedule.while(({ elapsed }) => elapsed < 60_000),
        ),
      ),
    );
  },
);

const waitForCreateInvoiceForbidden = Effect.fn(
  "waitForCreateInvoiceForbidden",
)(function* (ws: WebSocket) {
  return yield* callAgentRpc(ws, "createInvoice", []).pipe(
    Effect.flatMap((result) => {
      if (!result.success && result.error.includes("Forbidden")) {
        return Effect.succeed(result);
      }
      return Effect.fail(new Error("createInvoice is not forbidden yet"));
    }),
    Effect.retry(
      Schedule.spaced("1 second").pipe(
        Schedule.while(({ elapsed }) => elapsed < 60_000),
      ),
    ),
  );
});

layer(configLayer, { excludeTestServices: true })(
  "organization-agent-authorization",
  (it) => {
    it.effect("invited member is authorized for all invoice callables", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-owner-${crypto.randomUUID()}@test.com`;
        const memberEmail = `int-auth-member-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const member = yield* login(memberEmail);

        yield* inviteMember({
          ownerSessionCookie: owner.sessionCookie,
          ownerOrganizationId: owner.organizationId,
          memberEmail,
        });
        const invitationId = yield* findInvitationId({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          email: memberEmail,
        });
        yield* acceptInvitationInApp({
          sessionCookie: member.sessionCookie,
          invitationId,
          organizationId: owner.organizationId,
        });
        yield* setActiveOrganization({
          sessionCookie: member.sessionCookie,
          organizationId: owner.organizationId,
        });

        const ws = yield* agentWebSocket(owner.organizationId, member.sessionCookie);
        const createResult = yield* waitForCreateInvoiceSuccess(ws);
        assertAgentRpcSuccess(createResult);
        const { invoiceId } = Schema.decodeUnknownSync(invoiceIdResult)(
          createResult.result,
        );

        const getInvoicesResult = yield* callAgentRpc(ws, "getInvoices", []);
        assertAgentRpcSuccess(getInvoicesResult);

        const getInvoiceResult = yield* callAgentRpc(ws, "getInvoice", [
          { invoiceId },
        ]);
        assertAgentRpcSuccess(getInvoiceResult);

        const updateResult = yield* callAgentRpc(ws, "updateInvoice", [
          {
            invoiceId,
            name: "Auth Coverage",
            invoiceNumber: "AUTH-001",
            invoiceDate: "",
            dueDate: "",
            currency: "",
            vendorName: "",
            vendorEmail: "",
            vendorAddress: "",
            billToName: "",
            billToEmail: "",
            billToAddress: "",
            subtotal: "",
            tax: "",
            total: "",
            amountDue: "",
            invoiceItems: [],
          },
        ]);
        assertAgentRpcSuccess(updateResult);

        const uploadResult = yield* callAgentRpc(ws, "uploadInvoice", [
          {
            fileName: "invoice-1-redacted.png",
            contentType: "image/png",
            base64: env.TEST_INVOICE_PNG_BASE64,
          },
        ]);
        assertAgentRpcSuccess(uploadResult);

        const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [
          { invoiceId },
        ]);
        assertAgentRpcSuccess(deleteResult);
      }));

    it.effect("never-member is blocked by worker gate", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-never-owner-${crypto.randomUUID()}@test.com`;
        const outsiderEmail =
          `int-auth-never-outsider-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const outsider = yield* login(outsiderEmail);

        const response = yield* workerFetch(
          `http://w/agents/organization-agent/${owner.organizationId}`,
          {
            headers: {
              Upgrade: "websocket",
              Cookie: outsider.sessionCookie,
            },
          },
        );

        expect(response.status).toBe(403);
        const text = yield* Effect.promise(() => response.text());
        expect(text).toContain("Forbidden");
      }));

    it.effect("removed member is eventually forbidden", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-removed-owner-${crypto.randomUUID()}@test.com`;
        const memberEmail = `int-auth-removed-member-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const member = yield* login(memberEmail);

        yield* inviteMember({
          ownerSessionCookie: owner.sessionCookie,
          ownerOrganizationId: owner.organizationId,
          memberEmail,
        });
        const invitationId = yield* findInvitationId({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          email: memberEmail,
        });
        yield* acceptInvitationInApp({
          sessionCookie: member.sessionCookie,
          invitationId,
          organizationId: owner.organizationId,
        });
        yield* setActiveOrganization({
          sessionCookie: member.sessionCookie,
          organizationId: owner.organizationId,
        });

        const ws = yield* agentWebSocket(owner.organizationId, member.sessionCookie);
        const firstCreateResult = yield* waitForCreateInvoiceSuccess(ws);
        assertAgentRpcSuccess(firstCreateResult);

        const memberId = yield* getMemberIdByEmail({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          memberEmail,
        });
        yield* removeMemberInApp({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          memberId,
        });

        const forbiddenResult = yield* waitForCreateInvoiceForbidden(ws);
        assertAgentRpcFailure(forbiddenResult);
        assertInclude(forbiddenResult.error, "Forbidden");
      }), { timeout: 90_000 });
  },
);
