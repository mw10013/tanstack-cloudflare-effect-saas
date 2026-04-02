# D1 Reset `metadata.sqlite` Research

## Summary

`pnpm d1:reset` is failing because `scripts/d1-reset.ts` assumes local D1 creates exactly one `*.sqlite` file under `.wrangler/state/v3/d1/`, but newer Wrangler/Miniflare/workerd versions can also create `metadata.sqlite` in that same namespace directory.

This looks like an upstream local-storage layout change, not an app-level D1 schema problem.

## The Breaking Assumption

From `scripts/d1-reset.ts`:

```ts
const sqliteFiles = await glob("./.wrangler/state/v3/d1/**/*.sqlite");
if (sqliteFiles.length !== 1) {
  console.error("Expected exactly one sqlite file under .wrangler");
  process.exit(1);
}
```

This used to work when Miniflare only created the actual D1 backing file.

Now the script sees both:

```txt
./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/metadata.sqlite
```

## What Cloudflare Docs Still Say

Cloudflare's D1 docs still describe local D1 as a SQLite file in `.wrangler/state`:

- `refs/cloudflare-docs/src/content/docs/d1/tutorials/d1-and-prisma-orm.mdx:251`

> `--local`: Executes the statement against a _local_ version of D1. This local version of D1 is a SQLite database file that will be located in the `.wrangler/state` directory of your project.

- `refs/cloudflare-docs/src/content/docs/workers/development-testing/local-data.mdx:84-90`

> By default, both Wrangler and the Vite plugin store local binding data in the same location: the `.wrangler/state` folder in your project directory.

Useful, but not specific enough to explain `metadata.sqlite`.

## Upstream Evidence For `metadata.sqlite`

The clearest explanation is in the Workers SDK refs.

- `refs/workers-sdk/packages/miniflare/CHANGELOG.md:178-180`

> Exclude `metadata.sqlite` when listing Durable Object instances
>
> An upcoming version of workerd stores per-namespace alarm metadata in a `metadata.sqlite` file alongside per-actor `.sqlite` files.

- `refs/workers-sdk/packages/miniflare/src/workers/local-explorer/resources/do.ts:226-235`

```ts
// Each DO object gets a sqlite file named <objectId>.sqlite,
// so filter for those and use that to extract object IDs.
// Exclude metadata.sqlite which is used by workerd for per-namespace
// metadata (e.g. alarm storage) and is not a DO object.
```

- `refs/workers-sdk/packages/vitest-pool-workers/src/pool/loopback.ts:80-83`

```ts
// Exclude metadata.sqlite, added by newer workerd versions for
// per-namespace metadata.
if (name.endsWith(".sqlite") && name !== "metadata.sqlite") {
```

So upstream already had to patch their own tooling to ignore this extra file.

## Why This Shows Up Under D1

Local D1 in Miniflare is backed by a Durable Object namespace.

- `refs/workers-sdk/packages/miniflare/src/plugins/d1/index.ts:52-56`

```ts
const D1_DATABASE_OBJECT_CLASS_NAME = "D1DatabaseObject";
```

- `refs/workers-sdk/packages/miniflare/src/plugins/d1/index.ts:165-166`

```ts
// Store Durable Object SQL databases in persist path
durableObjectStorage: { localDisk: D1_STORAGE_SERVICE_NAME },
```

That matches the path your script printed:

```txt
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
```

So even though the user-facing feature is D1, the local persistence layout inherits Durable Object/workerd storage behavior.

## Likely Version Window

Your project currently pins:

- `package.json:113` -> `wrangler: 4.79.0`

In the upstream refs for Wrangler `4.79.0`:

- `refs/workers-sdk/packages/wrangler/CHANGELOG.md:45-46`

> `workerd` from `1.20260317.1` to `1.20260329.1`

- `refs/workers-sdk/packages/wrangler/CHANGELOG.md:67-68`

> `miniflare@4.20260329.0`

And the Miniflare ref at that version includes the `metadata.sqlite` note.

Most likely: the script started breaking after a Wrangler upgrade that pulled in this newer workerd/Miniflare behavior.

## Conclusion

Most likely root cause:

1. Local D1 is implemented on top of Miniflare Durable Object storage.
2. Newer workerd versions now create `metadata.sqlite` alongside the actual object database file.
3. `scripts/d1-reset.ts` still assumes there will be exactly one `*.sqlite` file.
4. That assumption is no longer valid.

## Recommended Script Change

The minimal fix is to ignore `metadata.sqlite` and validate exactly one non-metadata SQLite file.

Example shape:

```ts
const sqliteFiles = (await glob("./.wrangler/state/v3/d1/**/*.sqlite")).filter(
  (file) => !file.endsWith("/metadata.sqlite"),
);
```

Slightly more robust: also verify the remaining file is the hashed/object sqlite file, not just any other future `.sqlite` artifact.

## Short Answer

`metadata.sqlite` is probably expected now with newer local Cloudflare tooling. The script broke because it assumes one SQLite file total, while upstream now treats `metadata.sqlite` as an extra bookkeeping file that should be excluded.
