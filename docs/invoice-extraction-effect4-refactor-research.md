# Invoice Extraction Workflow -> Effect v4 Refactor Research

## Verdict

The original direction was mostly correct, but a few key parts needed correction:

- `Encoding.encodeBase64(fileBytes)` is the right replacement for `Buffer.from(fileBytes).toString("base64")` per `refs/effect4/packages/effect/src/Encoding.ts:70`.
- `HttpClientResponse.schemaBodyJson(...)` is the idiomatic Effect v4 response decode path per `refs/effect4/ai-docs/src/50_http-client/10_basics.ts:46`.
- `FetchHttpClient.layer` is the right minimal runtime layer for Worker `fetch` per `refs/effect4/packages/effect/src/unstable/http/FetchHttpClient.ts:71`.
- Tagged domain errors should follow the same `Schema.TaggedErrorClass` pattern as `src/lib/D1.ts:57`, `src/lib/R2.ts:46`, and `src/lib/Stripe.ts:227`.

But:

- The workflow does not need to be fully converted to one large Effect as a first step.
- If we use nested `Effect.runPromise(...)`, the layer must be provided to the exact Effect being run; an outer provided layer does not automatically flow into a separate inner runtime call.
- Using `filterStatusOk` too early would throw away the current non-2xx response body, which is currently useful for diagnosis in `src/invoice-extraction-workflow.ts:167`.
- `run()` currently returns `{ invoiceId }` but the workflow generic declares `{ readonly status: string; readonly message: string }` in `src/invoice-extraction-workflow.ts:57`. That mismatch should be fixed as part of or before the refactor.

## Current State

`src/invoice-extraction-workflow.ts` is plain async/await inside `AgentWorkflow.run()`:

- raw `fetch` to Gemini via AI Gateway
- manual base64 via `Buffer`
- `Schema.decodeUnknownSync` for Gemini envelope and extracted JSON
- bare `throw new Error(...)`
- direct `this.env.*` secret access
- workflow output type mismatch: declared output does not match actual return value

Current code:

```ts
const extractedJson = await step.do("extract-invoice", async () => {
  const result = await runInvoiceExtraction({
    accountId: this.env.CF_ACCOUNT_ID,
    gatewayId: this.env.AI_GATEWAY_ID,
    googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY,
    aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
    fileBytes,
    contentType: event.payload.contentType,
  });
  return result;
});
```

## Constraint: AgentWorkflow Boundary

`AgentWorkflow.run()` is an async method owned by the Cloudflare Agents framework, so Effect must still be run at the boundary as a promise. We are not replacing the class shape.

```ts
async run(event, step) {
  return Effect.runPromise(program)
}
```

That said, the best first refactor is not necessarily "convert the entire method body into one giant Effect". The more incremental and codebase-aligned move is:

- keep `run()` and `step.do(...)` as the workflow boundary
- move invoice extraction into a dedicated Effect service
- run that service inside the `step.do("extract-invoice", ...)` promise boundary

## Recommended Architecture

### 1. Introduce an `InvoiceExtraction` service

This should follow the same service shape used elsewhere in the repo:

- `ServiceMap.Service` service definition
- `Layer.effect(this, this.make)` layer
- pull `CloudflareEnv` from context for secrets and bindings
- use `Effect.fn(...)` for the main operation

References:

- `src/lib/D1.ts:5`
- `src/lib/R2.ts:5`
- `src/lib/Repository.ts:7`

Sketch:

```ts
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as Encoding from "effect/Encoding";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class InvoiceExtraction extends ServiceMap.Service<InvoiceExtraction>()(
  "InvoiceExtraction",
  {
    make: Effect.gen(function* () {
      const env = yield* CloudflareEnv;
      const client = yield* HttpClient.HttpClient;

      const extract = Effect.fn("InvoiceExtraction.extract")(function* ({
        fileBytes,
        contentType,
      }: {
        readonly fileBytes: Uint8Array;
        readonly contentType: string;
      }) {
        const response = yield* HttpClientRequest.post(gatewayUrl(env), {
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.GOOGLE_AI_STUDIO_API_KEY,
            "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
          },
          body: HttpBody.jsonUnsafe({
            contents: [
              {
                parts: [
                  { text: invoiceExtractionPrompt },
                  {
                    inlineData: {
                      mimeType: contentType,
                      data: Encoding.encodeBase64(fileBytes),
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: invoiceExtractionJsonSchema,
            },
          }),
        }).pipe(client.execute);

        return yield* decodeGeminiResponse(response);
      });

      return { extract };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

Why service instead of free function with secret params:

- aligns with the existing repo's Effect style
- removes direct secret plumbing through call sites
- makes `CloudflareEnv` useful in the same way it is in `src/lib/D1.ts:7` and `src/lib/R2.ts:7`
- makes testing easier via service substitution

### 2. Keep the workflow step boundary as the owner of the promise

The durable boundary is still `step.do("extract-invoice", ...)`.

Recommended shape:

```ts
async run(event, step) {
  const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, this.env));
  const runtimeLayer = Layer.provideMerge(
    InvoiceExtraction.layer,
    Layer.merge(envLayer, FetchHttpClient.layer),
  );

  const fileBytes = await step.do("load-file", async () => {
    const object = await this.env.R2.get(event.payload.r2ObjectKey);
    if (!object) throw new Error(`Invoice file not found: ${event.payload.r2ObjectKey}`);
    return new Uint8Array(await object.arrayBuffer());
  });

  const extractedJson = await step.do("extract-invoice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const invoiceExtraction = yield* InvoiceExtraction;
        return yield* invoiceExtraction.extract({
          fileBytes,
          contentType: event.payload.contentType,
        });
      }).pipe(Effect.provide(runtimeLayer)),
    ),
  );

  await step.do("save-extracted-json", async () => {
    await this.agent.saveExtractedJson({
      invoiceId: event.payload.invoiceId,
      idempotencyKey: event.payload.idempotencyKey,
      extractedJson: JSON.stringify(extractedJson),
    });
  });

  return { invoiceId: event.payload.invoiceId };
}
```

Important correction: if we call `Effect.runPromise(...)` inside `step.do`, we must provide the layer to that exact Effect. The outer workflow async function does not magically share its Effect context with a separate runtime invocation.

This matches the general boundary pattern in `src/worker.ts:64-66` and `src/worker.ts:120-122`, where the layer is provided to the specific effect being run.

### 3. Use `CloudflareEnv` in the runtime layer

This repo already has:

```ts
export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");
```

Source: `src/lib/CloudflareEnv.ts:3`

So the workflow can construct a minimal local layer:

```ts
const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, this.env));
const runtimeLayer = Layer.provideMerge(
  InvoiceExtraction.layer,
  Layer.merge(envLayer, FetchHttpClient.layer),
);
```

We do not need the full `worker.ts` layer graph for this workflow. The minimal dependencies here are:

- `CloudflareEnv` for secrets
- `HttpClient.HttpClient` via `FetchHttpClient.layer`
- `InvoiceExtraction` via its service layer

### 4. Do not use `filterStatusOk` too early

The initial research proposed:

```ts
Effect.flatMap(HttpClientResponse.filterStatusOk),
Effect.flatMap(HttpClientResponse.schemaBodyJson(GeminiResponseSchema)),
```

That is not ideal here.

`HttpClientResponse.filterStatusOk` fails immediately on non-2xx status with `HttpClientError` in `refs/effect4/packages/effect/src/unstable/http/HttpClientResponse.ts:201`. If we do that first, we lose the current behavior of inspecting and persisting the AI Gateway response body for debugging.

Recommended approach:

- execute request
- inspect `response.status`
- for non-2xx, read `response.text` or `response.json`
- fail with `InvoiceExtractionError` that includes status and body excerpt
- only decode success responses with `schemaBodyJson`

Sketch:

```ts
const decodeGeminiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? HttpClientResponse.schemaBodyJson(GeminiResponseSchema)(response).pipe(
        Effect.flatMap(({ candidates }) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(InvoiceExtractionSchema))(
            candidates[0].content.parts[0].text,
          ),
        ),
      )
    : response.text.pipe(
        Effect.flatMap((body) =>
          Effect.fail(
            new InvoiceExtractionError({
              message: `AI Gateway ${response.status}: ${body}`,
              cause: new Error(`AI Gateway ${response.status}`),
            }),
          ),
        ),
      );
```

This preserves the main diagnostic value of the current implementation in `src/invoice-extraction-workflow.ts:167-174`.

### 5. Typed domain error remains correct

The existing service pattern in this repo is:

```ts
export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

Source: `src/lib/D1.ts:57`

So this remains correct:

```ts
export class InvoiceExtractionError extends Schema.TaggedErrorClass<InvoiceExtractionError>()(
  "InvoiceExtractionError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}
```

And the service helper should follow the repo pattern:

```ts
const failInvoiceExtraction = (message: string, cause: unknown) =>
  new InvoiceExtractionError({
    message,
    cause,
  });
```

or via `Effect.tryPromise({ try, catch })` / `Effect.mapError(...)` depending on where the failure originates.

### 6. Base64 replacement is correct

Current code:

```ts
data: Buffer.from(fileBytes).toString("base64")
```

Recommended:

```ts
Encoding.encodeBase64(fileBytes)
```

Verified in `refs/effect4/packages/effect/src/Encoding.ts:70-71`.

### 7. JSON decode path is correct, but needs one more domain check

This part is fine:

```ts
Schema.decodeUnknownEffect(Schema.fromJsonString(InvoiceExtractionSchema))(
  text,
)
```

`Schema.fromJsonString(...)` is specifically meant for "decode a JSON string, then decode parsed value with the given schema" per `refs/effect4/packages/effect/src/Schema.ts:7072-7079`.

But one extra validation branch is needed before assuming:

```ts
candidates[0].content.parts[0].text
```

We should explicitly handle:

- empty `candidates`
- missing `parts`
- non-text content
- refusal / blocked output shapes if Gemini returns them

The envelope schema can stay strict, but the domain error message should clearly say whether the failure was:

- transport
- non-2xx gateway response
- malformed Gemini envelope
- invalid extracted JSON payload
- empty/no-text model response

## Whole `run()` as Effect?

Possible, but not recommended as the first implementation step.

Reasons:

- the workflow durability boundary is already expressed by `step.do(...)`
- the real value here is typed extraction logic, not wrapping every workflow line in Effect
- wrapping `step.do(...)` in `Effect.tryPromise(() => ...)` without explicit `catch` mapping weakens typed errors
- using `this.env` / `this.agent` inside `Effect.gen(function* () { ... })` requires careful capture of `this`

If we ever do move the whole method to Effect, capture first:

```ts
const env = this.env;
const agent = this.agent;
```

before entering `Effect.gen(...)`.

For now, the recommended split is:

- async workflow shell
- Effect service for extraction logic
- minimal workflow-local runtime layer

## Recommended Design

### Module boundaries

- keep `InvoiceExtractionSchema` and prompt close to the invoice extraction module
- move extraction HTTP/decode logic out of `src/invoice-extraction-workflow.ts`
- create `src/lib/InvoiceExtraction.ts` or similar service module

### Static values to hoist

These are pure and should be computed once at module load time:

```ts
const invoiceExtractionJsonSchema =
  Schema.toJsonSchemaDocument(InvoiceExtractionSchema).schema;

const GeminiResponseSchema = Schema.Struct({
  candidates: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
});
```

Current code already builds the JSON schema inline in `src/invoice-extraction-workflow.ts:162`; hoisting it avoids recreating it on every request.

### Logging

Inside the new service, use the same pattern as existing services:

```ts
Effect.tapError((error) => Effect.logError(error))
```

References:

- `src/lib/D1.ts:79`
- `src/lib/R2.ts:66`
- `src/lib/Stripe.ts:243`

For the first implementation, relying on the default logger is acceptable. A shared workflow logger layer can come later if needed.

### Retry

Effect-level retry is optional but reasonable for transport and 5xx failures.

The Effect docs demonstrate `HttpClient.retryTransient(...)` with exponential backoff in `refs/effect4/ai-docs/src/50_http-client/10_basics.ts:39-42`.

Recommendation:

- keep workflow-level retry via Agents step durability
- optionally add `HttpClient.retryTransient(...)` or `Effect.retry(...)` inside the extraction service for transport and 5xx only
- do not retry schema failures or model-output failures

## Pattern Alignment Table

| Pattern | Reference | Recommendation |
|---|---|---|
| `ServiceMap.Service` + `Layer.effect` | `src/lib/D1.ts:5`, `src/lib/R2.ts:5` | Use for `InvoiceExtraction` |
| pull env from context | `src/lib/D1.ts:7`, `src/lib/R2.ts:7` | Use `CloudflareEnv` instead of passing secrets as params |
| tagged domain errors | `src/lib/D1.ts:57`, `src/lib/R2.ts:46`, `src/lib/Stripe.ts:227` | Use `InvoiceExtractionError` |
| `Effect.fn("...")` named operations | `src/lib/Repository.ts:10`, `src/lib/R2.ts:8` | Name `InvoiceExtraction.extract` |
| `schemaBodyJson` response decode | `refs/effect4/ai-docs/src/50_http-client/10_basics.ts:46` | Use for 2xx body decode |
| `FetchHttpClient.layer` | `refs/effect4/packages/effect/src/unstable/http/FetchHttpClient.ts:71` | Provide in workflow-local runtime |
| `Encoding.encodeBase64` | `refs/effect4/packages/effect/src/Encoding.ts:70` | Replace `Buffer` usage |
| `Schema.fromJsonString(...)` | `refs/effect4/packages/effect/src/Schema.ts:7072` | Decode Gemini text payload |
| `Effect.tapError(Effect.logError)` | `src/lib/D1.ts:79`, `src/lib/R2.ts:66` | Use in service helper |

## Implementation Notes

### Recommended imports

```ts
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as Encoding from "effect/Encoding";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { FetchHttpClient } from "effect/unstable/http";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
```

### Workflow output type

Fix this mismatch during refactor:

```ts
export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  { readonly status: string; readonly message: string }
>
```

but `run()` currently returns:

```ts
return { invoiceId: event.payload.invoiceId };
```

The declared output type should match the actual payload.

## What Is Still Needed Before Implementation

1. Decide final module placement
   - likely `src/lib/InvoiceExtraction.ts`
   - optionally keep schema/prompt in workflow file, but service ownership is cleaner

2. Decide retry policy
   - `step.do` retry only
   - or add transient HTTP retry inside the service as well

3. Define precise error messages persisted to `onWorkflowError`
   - `src/organization-agent.ts:201` stores a string
   - choose how much raw gateway body to include vs truncate/sanitize

4. Add test coverage before or alongside refactor
   - success response
   - non-2xx AI Gateway response
   - malformed Gemini envelope
   - valid Gemini envelope with invalid JSON payload
   - empty/no-text candidate response

5. Decide whether to also Effect-ify `load-file`
   - not necessary for first pass
   - can stay plain async in the workflow shell

## Final Recommendation

Implement the refactor in two layers:

1. First pass
   - create `InvoiceExtraction` Effect service
   - use `CloudflareEnv` and `FetchHttpClient.layer`
   - preserve gateway error body visibility
   - keep `AgentWorkflow.run()` and `step.do(...)` mostly async

2. Later, only if it proves useful
   - move more workflow orchestration into Effect
   - extract shared workflow runtime helpers if more workflows adopt the same pattern

This gives the project the main benefits of Effect v4 - typed dependencies, typed failures, idiomatic HTTP/schema composition, and service alignment with the rest of the repo - without overcomplicating the workflow boundary.
