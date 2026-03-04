import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { Bomb, Flame, Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { OrganizationAgent } from "@/organization-agent";

export const Route = createFileRoute("/app/$organizationId/agent")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const agent = useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
  });
  useAgentChat({ agent });

  const feeFiMutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi(),
  });
  const feeFi1Mutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi1(),
  });
  const feeFi2Mutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi2(),
  });
  const bangMutation = useMutation<string>({
    mutationFn: () => agent.stub.bang(),
  });

  const actions = [
    {
      id: "feefi",
      title: "FeeFi",
      description: "Execute FeeFi RPC method",
      icon: Zap,
      mutation: feeFiMutation,
      color: "text-yellow-500",
      bgColor: "bg-yellow-500/10",
    },
    {
      id: "feefi1",
      title: "FeeFi 1",
      description: "Execute FeeFi1 RPC method",
      icon: Sparkles,
      mutation: feeFi1Mutation,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
    },
    {
      id: "feefi2",
      title: "FeeFi 2",
      description: "Execute FeeFi2 RPC method",
      icon: Flame,
      mutation: feeFi2Mutation,
      color: "text-orange-500",
      bgColor: "bg-orange-500/10",
    },
    {
      id: "bang",
      title: "Bang",
      description: "Execute Bang RPC method",
      icon: Bomb,
      mutation: bangMutation,
      color: "text-red-500",
      bgColor: "bg-red-500/10",
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Agent RPC</h1>
        <p className="text-muted-foreground">
          Execute remote procedure calls on your organization agent
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((action) => (
          <ActionCard key={action.id} action={action} isHydrated={isHydrated} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  action,
  isHydrated,
}: {
  action: {
    id: string;
    title: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    mutation: ReturnType<typeof useMutation<string>>;
    color: string;
    bgColor: string;
  };
  isHydrated: boolean;
}) {
  const Icon = action.icon;
  const isPending = action.mutation.isPending;
  const hasData = action.mutation.data !== undefined;
  const isError = action.mutation.isError;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${action.bgColor}`}
          >
            <Icon className={`h-5 w-5 ${action.color}`} />
          </div>
          <div className="flex flex-col">
            <CardTitle className="text-base">{action.title}</CardTitle>
            <CardDescription className="text-xs">
              {action.description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex-1">
          {isPending ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              <span>Executing...</span>
            </div>
          ) : isError ? (
            <Badge variant="destructive">Error</Badge>
          ) : hasData ? (
            <div className="bg-muted rounded-md p-3">
              <p className="text-foreground text-sm font-medium">
                {action.mutation.data}
              </p>
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic">
              No response yet
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isHydrated || isPending}
          onClick={() => {
            action.mutation.mutate();
          }}
          className="w-full"
        >
          {isPending ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Running...
            </>
          ) : (
            <>
              <Icon className="mr-2 h-4 w-4" />
              Execute
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
