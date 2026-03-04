import { useAgentChat } from "@cloudflare/ai-chat/react";
import { createFileRoute } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { OrganizationAgent } from "@/organization-agent";

export const Route = createFileRoute("/app/$organizationId/chat")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const agent = useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
  });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight">Agent Chat</h1>
          <p className="text-muted-foreground">
            Chat with your organization agent
          </p>
        </div>

        <div className="flex-1 overflow-hidden rounded-md border">
          <Conversation className="h-full">
            <ConversationContent>
              {messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) =>
                      part.type === "text" ? (
                        <MessageResponse key={`${message.id}-${String(index)}`}>
                          {part.text}
                        </MessageResponse>
                      ) : null,
                    )}
                  </MessageContent>
                </Message>
              ))}

              {messages.length === 0 && (
                <ConversationEmptyState
                  description="Send a message to start the conversation."
                  title="No messages"
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        <PromptInput
          onSubmit={async ({ text }) => {
            if (!text.trim()) {
              return;
            }
            await sendMessage({
              role: "user",
              parts: [{ type: "text", text }],
            });
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask your agent..." />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
