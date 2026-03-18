# Vitest 4 Route-Testing Blocker

> Sources: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/`, `refs/cloudflare-docs/src/content/docs/workers/testing/unstable_startworker.mdx`, `refs/cloudflare-docs/src/content/docs/workers/vite-plugin/reference/vite-environments.mdx`, `refs/tan-start/docs/start/framework/react/guide/server-entry-point.md`, `refs/workers-sdk/packages/miniflare/src/plugins/core/modules.ts`  
> Date: 2026-03-18

## Bottom Line

- `vitest-pool-workers` works in this repo for Worker-level tests, D1 migrations, and shared-module tests.
- It does not currently work for real TanStack Start route execution through `exports.default.fetch()`.
- Best next route-testing candidates:
  1. auxiliary Worker, if we can produce a Miniflare-friendly app bundle
  2. `unstable_startWorker()` if we want Wrangler/dev-server behavior directly

## Why `exports.default.fetch()` Fails Here

Cloudflare docs say:

> When using `exports.default.fetch()` for integration tests, your Worker code runs in the same context as the test runner ... your Worker uses the subtly different module resolution behavior provided by Vite.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/write-your-first-test.mdx:192`

That same-context path is likely the wrong harness for this app's SSR route execution.

Why:

- TanStack Start on Cloudflare is built around the Cloudflare Vite plugin owning the `ssr` environment
- our app Worker delegates into `@tanstack/react-start/server-entry`
- route handling pulls in TanStack Start SSR/router machinery during request handling
- inside the Vitest same-context mode, requests hang and get canceled

Cloudflare also documents a related known issue:

> Dynamic `import()` statements do not work inside `export default { ... }` handlers when writing integration tests with `exports.default.fetch()`

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/known-issues.mdx:22`

## Auxiliary Workers, Plain English

An auxiliary Worker is another Worker in the same local `workerd` process, but not the special Vitest `main` Worker.

- tests still run in the Vitest runner Worker
- the app routes run in the auxiliary Worker
- tests call it via a binding like `env.APP.fetch(...)`

Cloudflare docs say auxiliary Workers:

> run in the same `workerd` process as your tests and can be bound to.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/configuration.mdx:127`

## Architecture

### Current `main` Worker path

```mermaid
flowchart LR
  A[Vitest runner Worker] --> B[Test file]
  B --> C[exports.default.fetch]
  C --> D[main Worker in same context]
  D --> E[TanStack Start SSR route handling]
```

### Auxiliary Worker path

```mermaid
flowchart LR
  A[Vitest runner Worker] --> B[Test file]
  B --> C[env.APP.fetch]
  C --> D[Auxiliary app Worker]
  D --> E[TanStack Start SSR route handling]
  D --> F[D1]
  D --> G[KV]
```

### `unstable_startWorker()` path

```mermaid
flowchart LR
  A[Node test process] --> B[Wrangler unstable_startWorker]
  B --> C[Wrangler dev server internals]
  C --> D[Real app Worker]
  D --> E[TanStack Start SSR route handling]
  D --> F[D1 from Wrangler config]
```

## What We Tried With Auxiliary Worker

We attempted this shape:

- tiny runner Worker as `main`
- built TanStack Start app as auxiliary Worker
- test calls app via `env.APP.fetch(...)`

This got farther, but failed on the built app bundle itself.

### Failure 1: built server `.js` needed ESM handling

Miniflare initially parsed `dist/server/assets/worker-entry-*.js` as non-ESM.

### Failure 2: dynamic module specifiers in the built app bundle

After fixing ESM parsing, Miniflare failed with:

> `ERR_MODULE_DYNAMIC_SPEC`: dynamic module specifiers are unsupported. You must manually define your modules when constructing Miniflare.

Source of that error text: `refs/workers-sdk/packages/miniflare/src/plugins/core/modules.ts:280`

This is the key new finding.

Meaning:

- the auxiliary-Worker idea is still plausible
- but the current TanStack Start server build is not directly consumable by Miniflare as a simple `scriptPath` Worker
- Miniflare wants a fully enumerated `modules: [...]` graph when the bundle uses dynamic specifiers

## What This Means

If we want real TanStack Start route tests inside `vitest-pool-workers`, we likely need one of these:

1. a different app build output that Miniflare can consume cleanly
2. generated/manual `modules: [...]` for the auxiliary Worker
3. a different route-test harness

## Is `unstable_startWorker()` Better For Routes?

Possibly yes.

Cloudflare docs say:

> `unstable_startWorker()` ... exposes the internals of Wrangler's dev server ... you can pass in a Wrangler configuration file, and it will automatically load the configuration for you.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/unstable_startworker.mdx:21`

That matters because TanStack Start on Cloudflare is designed around Wrangler + the Cloudflare Vite plugin + SSR environment wiring.

So `unstable_startWorker()` is a better conceptual fit for real route tests than `exports.default.fetch()` on the Vitest `main` Worker.

## Does `unstable_startWorker()` Allow Migrated D1?

Probably yes, but not via the same helper path as `vitest-pool-workers`.

What is grounded:

- `unstable_startWorker()` loads Wrangler config automatically
- Wrangler config includes D1 bindings
- therefore the started Worker should have D1 available through normal Wrangler/dev-server wiring

What is not yet proven in this repo:

- the exact migration workflow we should use with `unstable_startWorker()`

Important distinction:

- `vitest-pool-workers` gives us `readD1Migrations()` and `applyD1Migrations()` helpers designed for its test runtime
- `unstable_startWorker()` is not that runtime

Grounded migration pattern from Cloudflare D1 docs:

```sh
wrangler d1 migrations apply your-database --local
```

Source: `refs/cloudflare-docs/src/content/docs/d1/best-practices/local-development.mdx:197`

The same doc shows the intended testing pattern with Wrangler dev APIs:

- run local migrations first
- then start the Worker

Source: `refs/cloudflare-docs/src/content/docs/d1/best-practices/local-development.mdx:205`

Wrangler's `unstable_startWorker()` also supports explicit local persistence via `dev.persist`, and Wrangler resolves that to a local persistence path.

Source: `refs/workers-sdk/packages/wrangler/src/api/startDevWorker/types.ts:148`, `refs/workers-sdk/packages/wrangler/src/api/startDevWorker/ConfigController.ts:155`, `refs/workers-sdk/packages/wrangler/src/dev/get-local-persistence-path.ts:14`

So the question is not "can it have D1?". It almost certainly can.

The real question is:

- how do we ensure the D1 database is migrated before route assertions?

Best current answer:

1. choose a persistence directory
2. run `wrangler d1 migrations apply d1-local --local --persist-to <same-dir>`
3. start `unstable_startWorker()` with `dev.persist: <same-dir>`

That should make the started Worker see the same migrated local D1 state.

## `unstable_startWorker()` Prototype Result

Two variants mattered.

### Variant 1: source entrypoint

```ts
unstable_startWorker({
  config: wrangler.jsonc,
  entrypoint: src/worker.ts,
  dev: { persist: .wrangler/state },
})
```

Result:

- migrations succeeded
- local D1/KV bindings were visible
- route requests hung and timed out

### Variant 2: built server entrypoint

```ts
unstable_startWorker({
  config: dist/server/wrangler.json,
  entrypoint: dist/server/index.js,
  dev: { persist: .wrangler/state },
})
```

Result:

- `/login` responded `200`
- `/` responded `200`
- SSR HTML came back correctly

Meaning:

- `unstable_startWorker()` plus migrated local D1 does work for real route tests here
- the failing path is specifically the source-entrypoint/dev-style route execution path
- the built server artifact is currently the viable harness for route testing

## Current Recommendation

- keep `vitest-pool-workers` for D1/shared-module/Worker-level tests
- do not keep pushing `exports.default.fetch()` for real TanStack Start routes
- next research/implementation target should be one of:
  1. use `unstable_startWorker()` with the built server entrypoint for route tests
  2. only revisit auxiliary Worker if we specifically want those tests inside `vitest-pool-workers`
