# Vitest Integration Research

## Conclusion

This repo was in a half-migrated state. The Vitest 4 / Cloudflare integration is now wired up enough to prove a TanStack SSR route works under `vitest`.

- `vitest` is already on `4.1.0` in `package.json`
- dependency versions are now aligned on `@cloudflare/vitest-pool-workers@0.14.0`
- `pnpm test` and `pnpm test:integration` now run through the same working integration config
- `test/integration/smoke.test.ts` now proves `exports.default.fetch("http://example.com/login")` renders a TanStack route

Short version: the fix was to finish the migration to the `cloudflareTest()` plugin API, stop pointing tests at `dist/server/index.js`, treat `src/worker.ts` / `wrangler.jsonc` as the Worker under test, and make the integration Vite config look enough like the app's real Vite config for TanStack Start virtual entries to resolve.

## Current Status

Working now:

- `pnpm typecheck:test`
- `pnpm test`
- `pnpm test:integration`

Current passing proof:

`test/integration/smoke.test.ts:1-10`

```ts
import { exports } from "cloudflare:workers";

const response = await exports.default.fetch("http://example.com/login");
expect(response.status).toBe(200);
expect(await response.text()).toContain("Sign in / Sign up");
```

That is the useful milestone here: the dynamic TanStack Start route-entry problem is no longer blocking Worker integration tests.

## Current Repo State

### 1. Original failure: old integration config failed immediately

`test/integration/vitest.config.ts:2-5`:

```ts
import {
  defineWorkersProject,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";
```

`pnpm typecheck:test` currently fails:

```txt
test/integration/vitest.config.ts(5,8): error TS2307: Cannot find module '@cloudflare/vitest-pool-workers/config' or its corresponding type declarations.
```

Running the suite directly fails the same way:

```txt
Missing "./config" specifier in "@cloudflare/vitest-pool-workers" package
```

### 2. Original failure: removed pool options were still present

`test/integration/vitest.config.ts:34-39`:

```ts
poolOptions: {
  workers: {
    main: path.resolve(__dirname, "../../dist/server/index.js"),
    isolatedStorage: false,
    singleWorker: true,
```

Cloudflare removed both `isolatedStorage` and `singleWorker` in the Vitest 4 migration.

From `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:158-160`:

```md
`isolatedStorage` & `singleWorker`: These have been removed ...
use the Vitest flags `--max-workers=1 --no-isolate`
```

### 3. Dependency versions are now consistent

`package.json:95` says:

```json
"@cloudflare/vitest-pool-workers": "0.14.0"
```

`pnpm-lock.yaml` now agrees:

```yaml
'@cloudflare/vitest-pool-workers':
  specifier: 0.14.0
  version: 0.14.0
```

And `node_modules/@cloudflare/vitest-pool-workers/package.json:3` is also `0.14.0`.

So the reinstall fixed the earlier package drift. The remaining startup failure is not a version mismatch. It is the stale `@cloudflare/vitest-pool-workers/config` import in `test/integration/vitest.config.ts`.

### 4. Original failure: suite pointed at built app output, not the Worker entrypoint

Current config uses:

```ts
main: path.resolve(__dirname, "../../dist/server/index.js")
```

But the actual Worker entrypoint is `wrangler.jsonc:11`:

```jsonc
"main": "./src/worker.ts"
```

And `src/worker.ts:254-256` exports a normal module Worker:

```ts
export default {
  async fetch(request, env, _ctx) {
```

That is the thing the Cloudflare Vitest integration wants to run as `main`.

`dist/server/index.js` is a build artifact path, and currently it does not exist in the repo until after a build.

## What Upstream Says Now

### 1. Vitest 4 uses `cloudflareTest()`

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/write-your-first-test.mdx:41-55`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
```

From `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:125-156`:

```md
`defineWorkersProject` and `defineWorkersConfig` from
`@cloudflare/vitest-pool-workers/config` have been replaced with a
`cloudflareTest()` Vite plugin exported from `@cloudflare/vitest-pool-workers`.
```

### 2. `main` can be source TypeScript and can come from Wrangler

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/configuration.mdx:121-123`:

```md
Entry point to Worker run in the same isolate/context as tests.
This file goes through Vite transforms and can be TypeScript.
If `wrangler.configPath` is defined and this option is not, it will be read from the `main` field in that configuration file.
```

That means this repo should not need a prebuilt `dist/server/index.js` just to run Worker integration tests.

### 3. Auxiliary workers are the special case that require built JS

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/configuration.mdx:127-133`:

```md
auxiliary Workers:
- Cannot have TypeScript entrypoints. You must compile auxiliary Workers to JavaScript first.
- Cannot access the `cloudflare:test` module.
```

This repo does not look like it needs an auxiliary-worker setup for `test/integration/*.test.ts`. It is testing the app Worker itself.

### 4. D1 migrations are still the right pattern

From `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/vitest.config.ts:1-29`:

```ts
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
```

From `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/test/apply-migrations.ts:1-6`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
```

So the repo's `test/apply-migrations.ts` pattern is fine. The config API around it is what is stale.

### 5. Cloudflare docs are a little behind the package surface

`refs/cloudflare-docs/.../configuration.mdx:60-94` still says `readD1Migrations()` is exported from `@cloudflare/vitest-pool-workers/config`.

But current upstream fixture code and the installed package types show it on the root package:

- `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/vitest.config.ts:2-5`
- `node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.d.mts:106-132`

So for this repo, treat the `workers-sdk` fixture and installed package as the source of truth:

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
```

## Recommended Shape For This Repo

### 1. Use the app Worker directly

Implemented config direction:

- load Worker config from `../../wrangler.jsonc`
- let Vitest use `src/worker.ts` as `main` via Wrangler
- keep the D1 migration binding in `miniflare.bindings`
- remove `poolOptions`, `isolatedStorage`, `singleWorker`, manual `resolve.conditions`, and `ssr.target`
- disable remote bindings for tests with `remoteBindings: false`
- add `tanstackStart()` and `@vitejs/plugin-react` so TanStack Start virtual modules resolve in the test runtime
- pin `root` to the repo root so TanStack Start does not try to resolve entries from `test/integration/src`

Current working shape:

```ts
import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: path.join(rootDir, "wrangler.jsonc") },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
      tsconfigPaths({
        projects: [path.join(rootDir, "tsconfig.json")],
      }),
      tanstackStart(),
      viteReact(),
    ],
    resolve: {
      alias: { "@": path.join(rootDir, "src") },
    },
    test: {
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});
```

Reason: this matches the Vitest 4 API, avoids the unnecessary build-output indirection, and gives TanStack Start the same plugin environment it expects in the main app Vite config.

### 2. Replace the old custom Cloudflare typing file

Current file: `test/cloudflare-test.d.ts`

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
```

Upstream fixtures now use `Cloudflare.Env` augmentation instead.

From `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/test/env.d.ts:1-5`:

```ts
declare namespace Cloudflare {
  interface Env {
    DATABASE: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

For this repo, a `test/env.d.ts` file is the cleaner direction:

```ts
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

That aligns with `worker-configuration.d.ts`, which already declares `Cloudflare.Env`.

### 3. Migrate tests from `SELF` to `cloudflare:workers`

Cloudflare's migration notes say:

From `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:159-160`:

```md
`import { env, SELF } from "cloudflare:test"`:
These have been removed in favour of
`import { env, exports } from "cloudflare:workers"`.
`exports.default.fetch()` has the same behaviour as `SELF.fetch()`
```

Original tests used `SELF`:

- `test/integration/auth.test.ts:1-115`

Current smoke test already uses the new direction:

```ts
import { env, exports } from "cloudflare:workers";

const response = await exports.default.fetch("http://example.com/");
```

Important nuance from the package types: `cloudflare:test` still exposes deprecated `env`/`SELF` in the currently installed `0.14.0`, so this was not the first blocker. But `cloudflare:workers` is the right end state and is now used by the smoke test.

### 4. Root `vitest.config.ts` must not use broken project discovery

One subtle failure only showed up under `pnpm test`.

Old root config:

```ts
export default defineConfig({
  test: {
    projects: ["test/*/vitest.config.ts"],
  },
});
```

That caused Vitest to initialize the integration project with an effective root under `test/integration`, which broke TanStack Start entry resolution with:

```txt
Could not resolve entry for router entry: router in .../test/integration/src
```

Current fix:

```ts
export { default } from "./test/integration/vitest.config";
```

That makes `pnpm test` and `pnpm test:integration` run the same known-good config.

### 4. If tests need shared storage across files, use Vitest flags, not config knobs

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/isolation-and-concurrency.mdx:28-31`:

```md
Storage isolation is per test file.
To make test files share the same storage ... use
`--max-workers=1 --no-isolate`
```

So if the suite eventually needs cross-file shared state, update the command, not the config.

## Likely Follow-Up Fixes After The Config Migration

### 1. Dependency sync is no longer the blocker

`package.json`, `pnpm-lock.yaml`, and `node_modules` now agree on `@cloudflare/vitest-pool-workers@0.14.0`.

Current failures still point at the same thing:

- `pnpm typecheck:test`: `Cannot find module '@cloudflare/vitest-pool-workers/config'`
- `pnpm vitest --config test/integration/vitest.config.ts run`: `Missing "./config" specifier`

That migration is now done.

### 2. The test script should stop building first

Current script:

```json
"test:integration": "pnpm build && pnpm vitest --config test/integration/vitest.config.ts run"
```

If the config uses `wrangler.jsonc` / `src/worker.ts` directly, the build step is probably unnecessary.

Current command:

```json
"test:integration": "pnpm vitest --config test/integration/vitest.config.ts run"
```

### 3. `process.env.BETTER_AUTH_URL` in the auth test is suspicious

`test/integration/auth.test.ts:29-32`:

```ts
magicLink: magicLink.replace(
  process.env.BETTER_AUTH_URL,
  "http://example.com",
),
```

But app auth config reads `BETTER_AUTH_URL` from Worker config/env, not Node process env.

`src/lib/Auth.ts:33-35`:

```ts
const authConfig = yield* Config.all({
  betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
```

After the Vitest config was fixed, auth was still failing for separate reasons. The direct auth endpoint tests are stale against the current app routing and are skipped for now.

### 4. `test/test-worker.ts` looks stale

I could not find any repo references to `test/test-worker.ts`.

That file looks like leftover sample code, not part of the real suite.

## Recommended Plan

1. Keep the current integration harness as the baseline.
2. Rewrite auth tests around the app's current `/login` server-function flow instead of old direct Better Auth endpoints.
3. Add more route-level integration tests using `exports.default.fetch()`.
4. Only after that, expand into auth/session flows.

## Bottom Line

This was not a case where the repo had fully migrated and the tests merely regressed.

It looked like the repo started moving toward Vitest 4, updated package metadata, but left the integration test harness on the old Cloudflare config API. The biggest win was not a big test rewrite. It was finishing the config migration cleanly, using the real Worker entrypoint instead of a built server artifact, and making the integration Vite config closely match the real app config so TanStack Start virtual entries resolve.
