# File Upload with TanStack Start, Form, Query, and Zod

## HTML Form File Upload Fundamentals

### Encoding types (`enctype`)

An HTML `<form>` has three possible `enctype` values that control how form data is encoded in the HTTP request body:

1. **`application/x-www-form-urlencoded`** (default) — key=value pairs separated by `&`, values URL-encoded. **Cannot transmit files** — file inputs send only the filename string.
2. **`multipart/form-data`** — splits each field into a separate "part" with its own `Content-Type` header. **Required for file uploads.** The browser generates a random boundary string to delimit parts.
3. **`text/plain`** — rarely used; not for file uploads.

Raw HTTP body with `multipart/form-data`:

```
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name="title"

My Document
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name="file"; filename="doc.pdf"
Content-Type: application/pdf

<binary bytes>
------WebKitFormBoundary7MA4YWxk--
```

### The `<input type="file">` element

- `accept="image/*,.pdf"` — filters the file picker (client-side hint only, not security)
- `multiple` — allows selecting multiple files
- The DOM element's `.files` property is a `FileList` of `File` objects (subclass of `Blob`)
- A `File` has: `.name`, `.size`, `.type` (MIME), `.lastModified`, `.arrayBuffer()`, `.text()`, `.stream()`
- **Inherently uncontrolled** — you cannot set `value` on a file input (browser security). Only `onChange` works.

### The `FormData` Web API

`FormData` is the JavaScript representation of `multipart/form-data`:

- Construct from a `<form>`: `new FormData(formElement)`
- Build manually: `const fd = new FormData(); fd.append('file', fileObj); fd.append('title', 'hello')`
- `fd.get('file')` returns a `File` object (or string for text fields)
- When passed to `fetch()`, the browser automatically sets `Content-Type: multipart/form-data` with the boundary — **do not set Content-Type manually** or you'll break the boundary.

## Zod `z.file()` — native File validation (Zod 4)

From `refs/zod/packages/docs/content/api.mdx`:

```ts
const fileSchema = z.file();

fileSchema.min(10_000);                         // minimum .size (bytes)
fileSchema.max(1_000_000);                      // maximum .size (bytes)
fileSchema.mime("image/png");                    // single MIME type
fileSchema.mime(["image/png", "image/jpeg"]);    // multiple MIME types
```

## Architecture

### Why `FormData` is required as transport

TanStack Form manages field state as a plain JS object — a field value can be `File | null`. But server functions cross a network boundary (client calls become `fetch` requests). A `File` object can't be JSON-serialized. `FormData` is the web-standard way to send binary data over HTTP.

This means:

- **Client-side schema** validates `{ title: string, file: File }` from the form state object
- **Server fn `inputValidator`** receives `FormData`, converts via `Object.fromEntries(data)`, and Zod-parses the result
- **`.handler`** receives fully validated, typed data

### Validation flow

| Layer | What validates | What it sees |
|---|---|---|
| `validators.onSubmit` (client) | Zod schema with `z.file()` | Raw `File` object from form state |
| `inputValidator` (server fn) | `instanceof FormData` check + `Object.fromEntries` + Zod parse | `FormData` (HTTP transport) |
| `.handler` (server) | Nothing — data is already validated | Typed `{ title: string, file: File }` |

## Codebase form pattern

The established pattern (see `src/routes/login.tsx`, `src/routes/app.$organizationId.invitations.tsx`, `src/routes/app.$organizationId.workflow.tsx`):

1. Schema defined once at module level
2. `inputValidator` on the server fn uses the schema
3. `validators.onSubmit` on `useForm` uses the same schema for client-side validation
4. `useMutation.mutationFn` typed with `z.input<typeof schema>`
5. `onSubmit` calls `mutation.mutate(value)`

For file upload, the difference is that `onSubmit` must convert the form value to `FormData` before calling `mutate`, and the `inputValidator` must convert from `FormData` via `Object.fromEntries` before Zod-parsing.

## Example

```tsx
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { AlertCircle } from "lucide-react";
import * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

// --- Client-side schema: validates the form state object ---
const uploadFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  file: z
    .file()
    .min(1, "File is required")
    .max(5_000_000, "File must be under 5MB")
    .mime(["image/png", "image/jpeg", "application/pdf"]),
});

// --- Server fn: receives FormData, converts and validates in inputValidator ---
// Object.fromEntries(data) avoids stringly-typed .get() calls — field names defined once in the schema.
// Zod handles type discrimination: z.string() rejects File, z.file() rejects string.
// Caveat: Object.fromEntries keeps only the last value per key, so not suitable for <input type="file" multiple>.
const uploadFile = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return z
      .object({
        title: z.string().trim().min(1),
        file: z.file().max(5_000_000).mime(["image/png", "image/jpeg", "application/pdf"]),
      })
      .parse(Object.fromEntries(data));
  })
  .handler(({ data }) => {
    // data is already { title: string, file: File } — fully validated
    // const bytes = await data.file.arrayBuffer();
    // await env.R2_BUCKET.put(data.file.name, bytes);
    return { success: true, name: data.file.name };
  });

export const Route = createFileRoute("/upload")({
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const isHydrated = useHydrated();
  const uploadServerFn = useServerFn(uploadFile);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      form.reset();
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues: {
      title: "",
      file: null as File | null,
    },
    validators: {
      onSubmit: uploadFormSchema,
    },
    onSubmit: ({ value }) => {
      const fd = new FormData();
      fd.append("title", value.title);
      if (value.file) fd.append("file", value.file);
      uploadMutation.mutate(fd);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload File</CardTitle>
          <CardDescription>Upload an image or PDF (max 5MB)</CardDescription>
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
              <form.Field
                name="title"
                children={(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                        }}
                        placeholder="Document title"
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
                        accept="image/png,image/jpeg,application/pdf"
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
    </div>
  );
}
```

## Gotchas

| Topic | Detail |
|---|---|
| Don't set `Content-Type` manually | When passing `FormData` to `fetch`, the browser auto-generates `multipart/form-data; boundary=...`. Setting it yourself breaks parsing. |
| File in TanStack Form state | Store `File \| null` in `defaultValues`. Convert to `FormData` before sending. |
| `<input type="file">` is uncontrolled | No `value` prop — only `onChange`. The `Input` component already has `file:` prefixed styles. |
| Zod can't validate `FormData` directly | Use `Object.fromEntries(data)` to convert to a plain object, then pass to Zod. Zod handles type discrimination (`z.string()` rejects `File`, `z.file()` rejects `string`). |
| `Object.fromEntries` caveat | Keeps only the last value per key. Not suitable for `<input type="file" multiple>` (multiple files under one key) — use `data.getAll()` for that. |
| Cloudflare Workers body size | 100MB request body limit (free plan). For large files, consider presigned URLs to R2 directly. |
| Two schemas | Client schema validates form state (`File` object). Server `inputValidator` converts `FormData` via `Object.fromEntries` then Zod-parses. They validate the same constraints but operate on different input shapes. |

## Doc sources

- TanStack Start server functions: `refs/tan-start/docs/start/framework/react/guide/server-functions.md`
- TanStack Form basic concepts: `refs/tan-form/docs/framework/react/guides/basic-concepts.md`
- TanStack Form SSR/Start integration: `refs/tan-form/docs/framework/react/guides/ssr.md`
- TanStack Query mutations: `refs/tan-query/docs/framework/react/guides/mutations.md`
- Zod API (Files, instanceof): `refs/zod/packages/docs/content/api.mdx`
