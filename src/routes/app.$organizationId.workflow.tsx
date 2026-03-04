import type { OrganizationAgent } from "@/organization-agent";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Effect } from "effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { AlertCircle, Check, Play, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { organizationMessageSchema } from "@/organization-messages";

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(async ({ context: { runEffect }, data: organizationId }) => {
    return runEffect(
      Effect.gen(function* () {
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        return {
          requests: yield* Effect.tryPromise(() => stub.listApprovalRequests()),
        };
      }),
    );
  });

const requestApprovalSchema = Schema.Struct({
  title: Schema.Trim.check(Schema.isMinLength(1)),
  description: Schema.Trim,
});

export const Route = createFileRoute("/app/$organizationId/workflow")({
  loader: ({ params }) => getLoaderData({ data: params.organizationId }),
  component: RouteComponent,
});

const statusConfig = {
  pending: {
    label: "Pending",
    variant: "secondary" as const,
    className: "bg-yellow-500/10 text-yellow-700",
  },
  approved: {
    label: "Approved",
    variant: "secondary" as const,
    className: "bg-green-500/10 text-green-700",
  },
  rejected: {
    label: "Rejected",
    variant: "destructive" as const,
    className: "bg-red-500/10 text-red-700",
  },
} as const;

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const { requests } = Route.useLoaderData();
  const isHydrated = useHydrated();
  const router = useRouter();

  const agent = useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      const result = Schema.decodeUnknownExit(
        Schema.fromJsonString(organizationMessageSchema),
      )(String(event.data));
      if (Exit.isFailure(result)) return;
      if (
        result.value.type === "workflow_progress" ||
        result.value.type === "workflow_complete" ||
        result.value.type === "workflow_error" ||
        result.value.type === "approval_requested"
      ) {
        void router.invalidate();
      }
    },
  });

  const requestMutation = useMutation({
    mutationFn: ({ title, description }: typeof requestApprovalSchema.Type) =>
      agent.stub.requestApproval(title, description),
    onSuccess: () => {
      form.reset();
      void router.invalidate();
    },
  });

  const approveMutation = useMutation<boolean, Error, string>({
    mutationFn: (workflowId) => agent.stub.approveRequest(workflowId),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const rejectMutation = useMutation<boolean, Error, string>({
    mutationFn: (workflowId) => agent.stub.rejectRequest(workflowId),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues: {
      title: "",
      description: "",
    },
    validators: {
      onSubmit: Schema.toStandardSchemaV1(requestApprovalSchema),
    },
    onSubmit: ({ value }) => {
      requestMutation.mutate(value);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Workflow</h1>
        <p className="text-muted-foreground">
          Start approval workflows and manage pending requests
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Approval Request</CardTitle>
          <CardDescription>
            Start a workflow that requires human approval
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              {requestMutation.error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {requestMutation.error.message}
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex gap-3">
                <form.Field
                  name="title"
                  children={(field) => {
                    const isInvalid = field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={isInvalid} className="flex-1">
                        <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder="Title"
                          aria-invalid={isInvalid}
                          disabled={!isHydrated || requestMutation.isPending}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                />
                <form.Field
                  name="description"
                  children={(field) => {
                    const isInvalid = field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={isInvalid} className="flex-1">
                        <FieldLabel htmlFor={field.name}>
                          Description
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder="Description"
                          aria-invalid={isInvalid}
                          disabled={!isHydrated || requestMutation.isPending}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                />
              </div>
              <form.Subscribe
                selector={(state) => state.canSubmit}
                children={(canSubmit) => (
                  <Button
                    type="submit"
                    disabled={
                      !canSubmit || !isHydrated || requestMutation.isPending
                    }
                    className="self-end"
                  >
                    {requestMutation.isPending ? (
                      <Spinner className="mr-2 h-4 w-4" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    Start
                  </Button>
                )}
              />
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Approval Requests</h2>
        {requests.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No approval requests yet
          </p>
        ) : (
          <div className="grid gap-3">
            {requests.map((req) => (
              <Card key={req.id}>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{req.title}</span>
                      <Badge className={statusConfig[req.status].className}>
                        {statusConfig[req.status].label}
                      </Badge>
                    </div>
                    {req.description && (
                      <span className="text-muted-foreground text-sm">
                        {req.description}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {req.id.slice(0, 12)}… · {req.createdAt}
                    </span>
                    {req.reason && (
                      <span className="text-destructive text-xs">
                        {req.reason}
                      </span>
                    )}
                  </div>
                  {req.status === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          approveMutation.isPending || rejectMutation.isPending
                        }
                        onClick={() => {
                          approveMutation.mutate(req.id);
                        }}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          approveMutation.isPending || rejectMutation.isPending
                        }
                        onClick={() => {
                          rejectMutation.mutate(req.id);
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
