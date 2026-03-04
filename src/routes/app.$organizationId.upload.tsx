import type { OrganizationAgent } from "@/organization-agent";
import type { OrganizationMessage } from "@/organization-messages";
import * as React from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Cause, Config, Effect, Redacted } from "effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  AlertCircle,
  Check,
  CircleDot,
  Info,
  MessageSquare,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { organizationMessageSchema } from "@/organization-messages";

const organizationIdSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
});

const uploadNameSchema = Schema.Trim.check(Schema.isMinLength(1)).check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const uploadImageFileSchema = Schema.File.check(Schema.isMinSize(1))
  .check(Schema.isMaxSize(5_000_000))
  .check(
    Schema.makeFilter((file) =>
      imageMimeTypes.includes(file.type as (typeof imageMimeTypes)[number]),
    ),
  );

const uploadFormSchema = Schema.Struct({
  name: uploadNameSchema,
  file: uploadImageFileSchema,
});

const deleteUploadSchema = Schema.Struct({
  name: uploadNameSchema,
});

const uploadFile = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return Schema.decodeUnknownSync(uploadFormSchema)(Object.fromEntries(data));
  })
  .handler(({ context: { runEffect, session }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const validSession = yield* Effect.fromNullishOr(session);
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const r2BucketName = yield* Config.nonEmptyString("R2_BUCKET_NAME");
        const { R2, R2_UPLOAD_QUEUE } = yield* CloudflareEnv;
        const key = `${organizationId}/${data.name}`;
        const idempotencyKey = crypto.randomUUID();
        yield* Effect.tryPromise(() =>
          R2.put(key, data.file, {
            httpMetadata: { contentType: data.file.type },
            customMetadata: { organizationId, name: data.name, idempotencyKey },
          }),
        );
        if (environment === "local") {
          yield* Effect.tryPromise(() =>
            R2_UPLOAD_QUEUE.send({
              account: "local",
              action: "PutObject",
              bucket: r2BucketName,
              object: { key, size: data.file.size, eTag: "local" },
              eventTime: new Date().toISOString(),
              idempotencyKey,
            }),
          );
        }
        return {
          success: true,
          name: data.name,
          size: data.file.size,
          idempotencyKey,
        };
      }),
    ),
  );

const deleteUpload = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(deleteUploadSchema))
  .handler(({ context: { runEffect, session }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const validSession = yield* Effect.fromNullishOr(session);
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const r2BucketName = yield* Config.nonEmptyString("R2_BUCKET_NAME");
        const { R2, R2_UPLOAD_QUEUE } = yield* CloudflareEnv;
        const key = `${organizationId}/${data.name}`;
        yield* Effect.tryPromise(() => R2.delete(key));
        if (environment === "local") {
          yield* Effect.tryPromise(() =>
            R2_UPLOAD_QUEUE.send({
              account: "local",
              action: "DeleteObject",
              bucket: r2BucketName,
              object: { key },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        return { success: true, name: data.name };
      }),
    ),
  );

const getUploads = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(
    async ({ context: { runEffect, session }, data: { organizationId } }) => {
      return runEffect(
        Effect.gen(function* () {
          yield* Effect.fromNullishOr(session).pipe(
            Effect.filterOrFail(
              (s) => s.session.activeOrganizationId === organizationId,
              () => new Cause.NoSuchElementError(),
            ),
          );
          const environment = yield* Config.nonEmptyString("ENVIRONMENT");
          const r2BucketName = yield* Config.nonEmptyString("R2_BUCKET_NAME");
          const r2S3AccessKeyId = yield* Config.redacted("R2_S3_ACCESS_KEY_ID");
          const r2S3SecretAccessKey = yield* Config.redacted("R2_S3_SECRET_ACCESS_KEY");
          const cfAccountId = yield* Config.nonEmptyString("CF_ACCOUNT_ID");
          const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
          const id = ORGANIZATION_AGENT.idFromName(organizationId);
          const stub = ORGANIZATION_AGENT.get(id);
          const uploads = yield* Effect.tryPromise(() => stub.getUploads());
          if (environment === "local") {
            return uploads.map((upload) => ({
              ...upload,
              thumbnailUrl: `/api/org/${organizationId}/upload-image/${encodeURIComponent(upload.name)}`,
            }));
          }
          return yield* Effect.tryPromise(async () => {
            const { AwsClient } = await import("aws4fetch");
            const client = new AwsClient({
              service: "s3",
              region: "auto",
              accessKeyId: Redacted.value(r2S3AccessKeyId),
              secretAccessKey: Redacted.value(r2S3SecretAccessKey),
            });
            return Promise.all(
              uploads.map(async (upload) => {
                const signed = await client.sign(
                  new Request(
                    `https://${cfAccountId}.r2.cloudflarestorage.com/${r2BucketName}/${organizationId}/${upload.name}?X-Amz-Expires=900`,
                    { method: "GET" },
                  ),
                  { aws: { signQuery: true } },
                );
                return {
                  ...upload,
                  thumbnailUrl: signed.url,
                };
              }),
            );
          });
        }),
      );
    },
  );

export const Route = createFileRoute("/app/$organizationId/upload")({
  loader: ({ params: data }) => getUploads({ data }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const uploads = Route.useLoaderData();
  const router = useRouter();
  const [messages, setMessages] = React.useState<OrganizationMessage[]>([]);

  useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      const result = Schema.decodeUnknownExit(
        Schema.fromJsonString(organizationMessageSchema),
      )(String(event.data));
      if (Exit.isFailure(result)) return;
      if (result.value.type !== "upload_deleted") {
        setMessages((prev) => [result.value, ...prev]);
      }
      if (
        result.value.type === "upload_deleted" ||
        result.value.type === "classification_updated" ||
        result.value.type === "classification_error"
      ) {
        void router.invalidate();
      }
    },
  });
  const uploadServerFn = useServerFn(uploadFile);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      form.reset();
      void router.invalidate();
    },
  });
  const deleteUploadServerFn = useServerFn(deleteUpload);
  const deleteMutation = useMutation({
    mutationFn: ({ name }: { name: string }) =>
      deleteUploadServerFn({ data: { name } }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues: {
      name: "",
      file: null as File | null,
    },
    validators: {
      onSubmit: Schema.toStandardSchemaV1(uploadFormSchema),
    },
    onSubmit: ({ value }) => {
      const fd = new FormData();
      fd.append("name", value.name);
      if (value.file) fd.append("file", value.file);
      uploadMutation.mutate(fd);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Upload</h1>
        <p className="text-muted-foreground">
          Upload images (PNG, JPEG, WEBP, GIF) up to 5MB.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Upload Image</CardTitle>
            <CardDescription>
              Use letters, numbers, underscores, or hyphens for names.
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
                {uploadMutation.error && (
                  <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>
                      {uploadMutation.error.message}
                    </AlertDescription>
                  </Alert>
                )}
                {uploadMutation.isSuccess && (
                  <Alert>
                    <AlertTitle>Uploaded</AlertTitle>
                    <AlertDescription>
                      {uploadMutation.data.name} (
                      {Math.round(uploadMutation.data.size / 1024)} KB)
                    </AlertDescription>
                  </Alert>
                )}
                <form.Field
                  name="name"
                  children={(field) => {
                    const isInvalid = field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder="hero_image"
                          aria-invalid={isInvalid}
                          disabled={!isHydrated || uploadMutation.isPending}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                />
                <form.Field
                  name="file"
                  children={(field) => {
                    const isInvalid = field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>File</FieldLabel>
                        <Input
                          id={field.name}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.files?.[0] ?? null);
                          }}
                          aria-invalid={isInvalid}
                          disabled={!isHydrated || uploadMutation.isPending}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                />
                <form.Subscribe
                  selector={(state) => state.canSubmit}
                  children={(canSubmit) => (
                    <Button
                      type="submit"
                      disabled={
                        !canSubmit || !isHydrated || uploadMutation.isPending
                      }
                      className="self-end"
                    >
                      {uploadMutation.isPending ? "Uploading..." : "Upload"}
                    </Button>
                  )}
                />
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Messages messages={messages} />
      </div>

      {uploads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Uploads</CardTitle>
            <CardDescription>
              {uploads.length} image{uploads.length !== 1 && "s"} uploaded
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {uploads.map((upload) => (
                <div
                  key={upload.name}
                  className="bg-muted/20 flex items-center gap-3 rounded-md border p-3"
                >
                  <div className="bg-muted/40 flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border">
                    <img
                      src={upload.thumbnailUrl}
                      alt={upload.name}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {upload.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {new Date(upload.createdAt).toLocaleString()}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {upload.classificationLabel
                        ? `${upload.classificationLabel} (${String(Math.round((upload.classificationScore ?? 0) * 100))}%)`
                        : "Classifying..."}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        deleteMutation.mutate({ name: upload.name });
                      }}
                      disabled={deleteMutation.isPending}
                      className="mt-2"
                    >
                      {deleteMutation.isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Messages({ messages }: { messages: OrganizationMessage[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-5" />
          Messages
        </CardTitle>
        <CardDescription>Real-time events from the agent</CardDescription>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">No messages yet</p>
        ) : (
          <ul className="divide-y">
            {messages.map((msg, i) => (
              <li key={i} className="flex items-center gap-3 py-2">
                <MessageIcon type={msg.type} />
                <span className="text-sm">{formatMessage(msg)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MessageIcon({ type }: { type: OrganizationMessage["type"] }) {
  switch (type) {
    case "upload_error":
      return <XCircle className="text-destructive size-4" />;
    case "upload_deleted":
      return <Info className="size-4 text-blue-600" />;
    case "workflow_progress":
      return <CircleDot className="size-4 text-yellow-600" />;
    case "workflow_complete":
      return <Check className="size-4 text-green-600" />;
    case "workflow_error":
      return <XCircle className="text-destructive size-4" />;
    case "approval_requested":
      return <Info className="size-4 text-blue-600" />;
    case "classification_workflow_started":
      return <CircleDot className="size-4 text-yellow-600" />;
    case "classification_updated":
      return <Check className="size-4 text-green-600" />;
    case "classification_error":
      return <XCircle className="text-destructive size-4" />;
  }
}

function formatMessage(msg: OrganizationMessage): string {
  switch (msg.type) {
    case "upload_error":
      return `${msg.name} failed: ${msg.error}`;
    case "upload_deleted":
      return `${msg.name} deleted`;
    case "workflow_progress":
      return msg.progress.message;
    case "workflow_complete":
      return `Workflow ${msg.result?.approved ? "approved" : "completed"}`;
    case "workflow_error":
      return `Workflow error: ${msg.error}`;
    case "approval_requested":
      return `Approval requested: ${msg.title}`;
    case "classification_workflow_started":
      return `Classification started: ${msg.name}`;
    case "classification_updated":
      return `${msg.name}: ${msg.label} (${String(Math.round(msg.score * 100))}%)`;
    case "classification_error":
      return `Classification error: ${msg.name} - ${msg.error}`;
  }
}
