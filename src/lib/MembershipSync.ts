import { Effect } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import type * as Domain from "@/lib/Domain";
import type { MembershipSyncQueueMessage } from "@/lib/Q";

export const sendMembershipSync = Effect.fn("sendMembershipSync")(
  function* (input: {
    organizationId: Domain.Organization["id"];
    userId: Domain.User["id"];
    change: "added" | "removed" | "role_changed";
  }) {
    const env = yield* CloudflareEnv;
    const message: MembershipSyncQueueMessage = {
      action: "MembershipSync",
      organizationId: input.organizationId,
      userId: input.userId,
      change: input.change,
    };
    yield* Effect.tryPromise(() =>
      env.Q.send(message),
    );
  },
);
