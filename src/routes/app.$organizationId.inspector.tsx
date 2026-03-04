import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

const inspectorServerFn = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(async ({ context: { runEffect }, data: organizationId }) => {
    return runEffect(
      Effect.gen(function* () {
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        return yield* Effect.tryPromise(() =>
          Promise.all([
            stub.getAgentState(),
            stub.getAgentQueues(),
            stub.getAgentSchedules(),
            stub.getAgentWorkflows(),
            stub.getChatMessages(),
            stub.getChatStreamChunks(),
            stub.getChatStreamMetadata(),
          ]).then(
            ([
              agentState,
              agentQueues,
              agentSchedules,
              agentWorkflows,
              chatMessages,
              chatStreamChunks,
              chatStreamMetadata,
            ]) => ({
              agentState,
              agentQueues,
              agentSchedules,
              agentWorkflows,
              chatMessages,
              chatStreamChunks,
              chatStreamMetadata,
            }),
          ),
        );
      }),
    );
  });

export const Route = createFileRoute("/app/$organizationId/inspector")({
  loader: ({ params }) => inspectorServerFn({ data: params.organizationId }),
  component: RouteComponent,
});

function RouteComponent() {
  const data = Route.useLoaderData();

  const sections: { title: string; data: unknown }[] = [
    { title: "Agent State", data: data.agentState },
    { title: "Agent Queues", data: data.agentQueues },
    { title: "Agent Schedules", data: data.agentSchedules },
    { title: "Agent Workflows", data: data.agentWorkflows },
    { title: "Chat Messages", data: data.chatMessages },
    { title: "Chat Stream Chunks", data: data.chatStreamChunks },
    { title: "Chat Stream Metadata", data: data.chatStreamMetadata },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Inspector</h1>
        <p className="text-muted-foreground">
          Internal Durable Object SQLite tables
        </p>
      </div>
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{section.title}</h2>
          <pre className="bg-muted overflow-auto rounded-md p-4 text-sm">
            {JSON.stringify(section.data, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
