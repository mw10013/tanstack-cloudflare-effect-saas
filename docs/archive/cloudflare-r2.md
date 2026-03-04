# Cloudflare R2

## What Problem Does R2 Solve?

R2 is S3-compatible object storage with **zero egress fees**, strongly consistent, built on Cloudflare's global network.

> Cloudflare R2 Storage allows developers to store large amounts of unstructured data without the costly egress bandwidth fees associated with typical cloud storage services.

Use cases: web assets, user-generated content, AI model artifacts, data lakes, podcast episodes.

### Architecture

R2 Gateway (Workers at edge) → Metadata Service (Durable Objects) → Tiered Read Cache → Distributed Storage Infrastructure.

- **R2 Gateway**: Entry point for all API requests; handles auth and routing. Deployed across Cloudflare's global network via Workers.
- **Metadata Service**: Distributed layer on Durable Objects storing object metadata (key, checksum) for strong consistency. Includes built-in cache.
- **Tiered Read Cache**: Caching layer using Cloudflare Tiered Cache to serve data closer to the client.
- **Distributed Storage Infrastructure**: Persistently stores encrypted object data.

Write path: Gateway → Metadata Service (get encryption key, determine storage cluster) → write encrypted data → metadata commit → HTTP 200.

Read path: Gateway → Metadata Service (lookup) → tiered cache or storage → decrypt → serve.

---

## API: Two Primary Interfaces

### 1. Workers Binding API (in-Worker, server-side)

Bind in wrangler config:

```jsonc
{
  "r2_buckets": [
    {
      "binding": "MY_BUCKET",
      "bucket_name": "<YOUR_BUCKET_NAME>"
    }
  ]
}
```

Bucket methods on the binding object:

| Method | Signature |
|--------|-----------|
| `head` | `(key: string): Promise<R2Object \| null>` |
| `get` | `(key: string, options?: R2GetOptions): Promise<R2ObjectBody \| R2Object \| null>` |
| `put` | `(key: string, value: ReadableStream \| ArrayBuffer \| string \| null \| Blob, options?: R2PutOptions): Promise<R2Object \| null>` |
| `delete` | `(key: string \| string[]): Promise<void>` (up to 1000 keys) |
| `list` | `(options?: R2ListOptions): Promise<R2Objects>` (up to 1000 entries) |
| `createMultipartUpload` | `(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload>` |
| `resumeMultipartUpload` | `(key: string, uploadId: string): R2MultipartUpload` |

Basic usage:

```ts
await env.MY_BUCKET.put("image.png", request.body);

const object = await env.MY_BUCKET.get(key, {
  onlyIf: request.headers,
  range: request.headers,
});

await env.MY_BUCKET.delete(key);
```

### 2. S3-Compatible API (external access)

Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const S3 = new S3Client({
  region: "auto",
  endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: "<ACCESS_KEY_ID>",
    secretAccessKey: "<SECRET_ACCESS_KEY>",
  },
});

await S3.send(
  new PutObjectCommand({
    Bucket: "my-bucket",
    Key: "image.png",
    Body: fileContent,
  }),
);
```

---

## Naming Conventions

### Bucket Names

- Lowercase letters (a-z), numbers (0-9), hyphens (-) only
- Cannot begin or end with a hyphen
- 3-63 characters

### Binding Names

Valid JavaScript variable identifiers, conventionally `SCREAMING_SNAKE_CASE` (e.g., `MY_BUCKET`).

### Object Keys (Hierarchical Naming in a Flat Structure)

Buckets are flat -- no real folders. Use `/`-delimited prefixes to simulate hierarchy.

Common patterns:

```
# Entity-scoped
users/{userId}/avatars/{filename}
users/{userId}/documents/{docId}.pdf
organizations/{orgId}/invoices/2025/01/{invoiceId}.pdf

# Content-type scoped
images/originals/{uuid}.png
images/thumbnails/{uuid}.png
videos/raw/{uuid}.mp4

# Date-partitioned (logs/analytics)
logs/2025/01/15/{timestamp}-{uuid}.json

# Environment-scoped
production/assets/{hash}.js
staging/assets/{hash}.js
```

Best practices:

- Use `/` as delimiter (universal convention)
- Lowercase, no spaces -- use hyphens or underscores
- Use UUIDs or hashes for uniqueness, not raw user-supplied names
- Avoid special characters: `\ { } ^ % ~ # | [ ] " < >`
- Safe characters: `a-z 0-9 ! - _ . * ' ( )`
- Keys sort lexicographically by UTF-8 bytes, so date-based keys like `2025/01/15/...` sort chronologically
- Max key length: 1024 bytes

### Browsing Hierarchy with `list`

Use `prefix` + `delimiter` to simulate folder browsing:

```ts
const listed = await env.MY_BUCKET.list({
  prefix: "users/123/documents/",
  delimiter: "/",
});
// listed.objects = objects directly in this "folder"
// listed.delimitedPrefixes = ["users/123/documents/invoices/", ...]
```

> `delimitedPrefixes`: If a delimiter has been specified, contains all prefixes between the specified prefix and the next occurrence of the delimiter.

---

## Metadata

R2 supports two kinds of metadata on objects.

### HTTP Metadata (`R2HTTPMetadata`)

```
contentType, contentLanguage, contentDisposition,
contentEncoding, cacheControl, cacheExpiry
```

Set on `put`:

```ts
await env.MY_BUCKET.put(key, request.body, {
  httpMetadata: request.headers,
});
```

Read back with `writeHttpMetadata`:

```ts
const object = await env.MY_BUCKET.get(key);
const headers = new Headers();
object.writeHttpMetadata(headers);
```

### Custom Metadata (`Record<string, string>`)

> A map of custom, user-defined metadata that will be stored with the object.

```ts
await env.MY_BUCKET.put(key, body, {
  customMetadata: { "uploaded-by": "user-123", category: "avatar" },
});

const obj = await env.MY_BUCKET.head(key);
console.log(obj.customMetadata);
```

Include in list results:

```ts
const listed = await env.MY_BUCKET.list({
  include: ["httpMetadata", "customMetadata"],
});
```

---

## Presigned URLs & Upload Links

> Presigned URLs are an S3 concept for granting temporary access to objects without exposing your API credentials. A presigned URL includes signature parameters in the URL itself.

Specify: resource identifier, operation (GET/PUT/HEAD/DELETE), expiry (1s to 7 days).

### Using `aws4fetch` (Recommended for Workers)

The AWS SDK (`@aws-sdk/client-s3`) does **not** work inside Cloudflare Workers due to Node.js `fs` dependencies. Use [`aws4fetch`](https://www.npmjs.com/package/aws4fetch) instead -- it's lightweight (~4KB), uses only `fetch` and `SubtleCrypto` (Web APIs), and is documented in Cloudflare's own R2 examples.

```ts
import { AwsClient } from "aws4fetch";

const client = new AwsClient({
  service: "s3",
  region: "auto",
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
});

const R2_URL = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

// GET presigned URL (for <img src="..."> or downloads)
const getUrl = (
  await client.sign(
    new Request(`${R2_URL}/my-bucket/photos/cat.png?X-Amz-Expires=3600`),
    { aws: { signQuery: true } },
  )
).url.toString();

// PUT presigned URL (for client-side uploads)
const putUrl = (
  await client.sign(
    new Request(`${R2_URL}/my-bucket/uploads/file.png?X-Amz-Expires=3600`, {
      method: "PUT",
    }),
    { aws: { signQuery: true } },
  )
).url.toString();
```

The key is `signQuery: true` -- puts the signature in URL query params instead of headers.

### Using `@aws-sdk/s3-request-presigner` (Server-side only, not Workers)

```ts
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const putUrl = await getSignedUrl(
  S3,
  new PutObjectCommand({
    Bucket: "my-bucket",
    Key: "image.png",
    ContentType: "image/png",
  }),
  { expiresIn: 3600 },
);
```

### Signing Options Summary

| Approach | Works in Workers? | Dependency |
|---|---|---|
| `aws4fetch` | Yes | ~4KB, Web Crypto only |
| `@aws-sdk/s3-request-presigner` | No (uses `fs`) | Heavy, Node.js |
| Manual SigV4 with `crypto.subtle` | Yes | Zero deps |
| Worker binding proxy (no signing) | Yes | N/A |

### Using Presigned URLs in `<img>` Tags

Presigned GET URLs work directly as `src` attributes:

```html
<img src="https://my-bucket.ACCOUNT_ID.r2.cloudflarestorage.com/photos/cat.png?X-Amz-Algorithm=..." />
```

> You can also use presigned URLs directly in web browsers, mobile apps, or any HTTP client.

### Content-Type Gotcha for Browser Uploads

When using `aws4fetch` with `signQuery: true`, only the `host` header is signed. If you set `Content-Type` in the signed request, the browser upload will fail because R2 sees unsigned headers.

Don't set Content-Type in the `Request` constructor for PUT presigned URLs. Let the browser add it automatically.

### Alternative: Worker Binding Proxy

Skip presigned URLs entirely. Use the Workers binding to `get()` the object and stream it back:

```ts
const object = await env.MY_BUCKET.get(key);
const headers = new Headers();
object.writeHttpMetadata(headers);
return new Response(object.body, { headers });
```

Your Worker URL becomes the img src. Auth happens in your Worker code, not the URL.

### Alternative: Public Bucket + Custom Domain + WAF HMAC

> If you need authentication with R2 buckets accessed via custom domains (public buckets), use the WAF HMAC validation feature (requires Pro plan or above).

Signed URLs through Cloudflare's WAF rather than AWS SigV4.

### Best Practices

- **Restrict Content-Type**: Specify allowed `Content-Type` in SDK params. Signature includes this header; uploads fail with `403/SignatureDoesNotMatch` if mismatched.
- **Configure CORS**: Set up CORS rules on the bucket for browser-based presigned URL usage.
- **Short expiry**: Treat presigned URLs as bearer tokens. Use short expiration for sensitive operations.
- **Custom domains not supported**: Presigned URLs only work with `<ACCOUNT_ID>.r2.cloudflarestorage.com`.

### Supported Operations

- `GET`: Fetch an object
- `HEAD`: Fetch object metadata
- `PUT`: Upload an object
- `DELETE`: Delete an object
- `POST` (multipart form uploads via HTML forms) is **not** supported.

---

## Searching a Bucket

R2 has **no full-text search or query-by-metadata capability**.

### Prefix Filtering (Only Built-in "Search")

```ts
const listed = await env.MY_BUCKET.list({
  prefix: "images/",
  limit: 1000,
});
```

Matches against the beginning of the key only. No wildcard, suffix-only, regex, or metadata filtering.

### Iterate + Filter in Worker

Page through results with `cursor` and filter application-side (expensive):

```ts
let cursor: string | undefined;
do {
  const listed = await env.MY_BUCKET.list({
    prefix: "uploads/",
    cursor,
    include: ["customMetadata"],
  });
  const matches = listed.objects.filter(
    (obj) => obj.customMetadata?.category === "avatar",
  );
  cursor = listed.truncated ? listed.cursor : undefined;
} while (cursor);
```

### External Index (The Real Answer)

For any real search, maintain an external index in D1, KV, or a search service. Store metadata (key, tags, timestamps, user IDs) in D1 when you upload, then query D1 to find keys, then `get()` from R2.

### R2 SQL (Beta)

> R2 SQL is Cloudflare's serverless, distributed, analytics query engine for querying Apache Iceberg tables stored in R2 Data Catalog.

SQL over structured data (Iceberg tables) in R2. For analytics workloads on tabular data, not for searching arbitrary objects/files by metadata.

---

## Event Notifications & Event Subscriptions

There are **two distinct notification systems** for R2.

### R2 Event Notifications (Object-Level)

Configured on the R2 bucket. Send messages to a Queue when objects change.

> Event notifications send messages to your queue when data in your R2 bucket changes. You can consume these messages with a consumer Worker or pull over HTTP.

Event types:

| Type | Trigger Actions |
|------|-----------------|
| `object-create` | `PutObject`, `CopyObject`, `CompleteMultipartUpload` |
| `object-delete` | `DeleteObject`, `LifecycleDeletion` |

Setup via Wrangler:

```sh
npx wrangler r2 bucket notification create <BUCKET_NAME> \
  --event-type object-create \
  --queue <QUEUE_NAME> \
  --prefix "uploads/" \
  --suffix ".png"
```

Message format received by queue consumer:

```json
{
  "account": "3f4b7e3dcab231cbfdaa90a6a28bd548",
  "action": "PutObject",
  "bucket": "my-bucket",
  "object": {
    "key": "my-new-object",
    "size": 65536,
    "eTag": "c846ff7a18f28c2e262116d6e8719ef0"
  },
  "eventTime": "2024-05-24T19:36:44.379Z"
}
```

- Up to 100 notification rules per bucket
- Queue throughput limit: 5,000 messages/sec -- split across multiple queues if needed

### Queues Event Subscriptions (Bucket-Level Lifecycle)

Configured on the Queue, not the bucket. A broader Queues feature that many Cloudflare products publish to.

> Event subscriptions allow you to receive messages when events occur across your Cloudflare account. Cloudflare products (e.g., KV, Workers AI, Workers) can publish structured events to a queue.

R2-specific events available via event subscriptions are bucket lifecycle events:

- **`cf.r2.bucket.created`** -- triggered when a bucket is created
- **`cf.r2.bucket.deleted`** -- triggered when a bucket is deleted

Example payload:

```json
{
  "type": "cf.r2.bucket.created",
  "source": { "type": "r2" },
  "payload": {
    "name": "my-bucket",
    "jurisdiction": "default",
    "location": "WNAM",
    "storageClass": "Standard"
  },
  "metadata": {
    "accountId": "...",
    "eventSubscriptionId": "...",
    "eventSchemaVersion": 1,
    "eventTimestamp": "2025-05-01T02:48:57.132Z"
  }
}
```

Other sources that publish to event subscriptions: KV, Workers AI, Workers Builds, Vectorize, Workflows, Access.

### Comparison

| | R2 Event Notifications | Queues Event Subscriptions |
|---|---|---|
| **Scope** | Object-level (`object-create`, `object-delete`) | Bucket-level (`bucket.created`, `bucket.deleted`) |
| **Configured on** | The R2 bucket | The Queue |
| **Use case** | React to uploads/deletes of individual objects | React to infrastructure changes (bucket lifecycle) |
| **Sources** | R2 only | R2, KV, Workers AI, Workers Builds, Vectorize, Workflows, Access |

### Connecting to Workflows

R2 doesn't directly trigger Workflows. The pipeline is:

**R2 event notification → Queue → Consumer Worker → `env.MY_WORKFLOW.create()`**

The consumer Worker receives the queue message and kicks off a Workflow instance.

---

## Multipart Uploads

For large files, R2 supports multipart uploads via the Workers API:

```ts
const mpu = await env.MY_BUCKET.createMultipartUpload(key);
const part1 = await mpu.uploadPart(1, chunk1);
const part2 = await mpu.uploadPart(2, chunk2);
const obj = await mpu.complete([part1, part2]);
```

- Uncompleted multipart uploads auto-abort after 7 days
- Min part size: 5MB (except last part)
- State (`uploadId`, uploaded parts) must be tracked externally since Workers are stateless
- Can be tracked in client app, Durable Object, or database

---

## R2Object Properties

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` | The object's key |
| `version` | `string` | Random unique string per upload |
| `size` | `number` | Size in bytes |
| `etag` | `string` | Etag of the upload |
| `httpEtag` | `string` | Quoted etag for response headers |
| `uploaded` | `Date` | Upload timestamp |
| `httpMetadata` | `R2HTTPMetadata` | HTTP headers (contentType, cacheControl, etc.) |
| `customMetadata` | `Record<string, string>` | User-defined metadata |
| `checksums` | `R2Checksums` | MD5, SHA-1, SHA-256, SHA-384, SHA-512 |
| `storageClass` | `'Standard' \| 'InfrequentAccess'` | Storage tier |

### R2ObjectBody (extends R2Object)

Returned by `get()`. Adds:

| Property | Type |
|----------|------|
| `body` | `ReadableStream` |
| `bodyUsed` | `boolean` |
| `arrayBuffer()` | `Promise<ArrayBuffer>` |
| `text()` | `Promise<string>` |
| `json<T>()` | `Promise<T>` |
| `blob()` | `Promise<Blob>` |

---

## Conditional Operations

Pass `R2Conditional` to `get()` or `put()` options:

```ts
const object = await env.MY_BUCKET.get(key, {
  onlyIf: {
    etagMatches: "abc123",
    uploadedAfter: new Date("2025-01-01"),
  },
});
```

| Field | Description |
|-------|-------------|
| `etagMatches` | Perform if etag matches |
| `etagDoesNotMatch` | Perform if etag doesn't match |
| `uploadedBefore` | Perform if uploaded before date |
| `uploadedAfter` | Perform if uploaded after date |

Also accepts standard HTTP conditional headers (`If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`).

---

## References

- `refs/cloudflare-docs/src/content/docs/r2/` -- Full R2 documentation
- `refs/cloudflare-docs/src/content/docs/r2-sql/` -- R2 SQL (beta) documentation
- `refs/cloudflare-docs/src/content/docs/queues/event-subscriptions/` -- Queues event subscriptions
- `refs/cloudflare-templates/r2-explorer-template/` -- R2 explorer template example
