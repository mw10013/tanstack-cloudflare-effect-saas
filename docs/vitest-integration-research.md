# Vitest Integration Research

## Conclusion

This repo is in a half-migrated state.

- `vitest` is already on `4.1.0` in `package.json`
- `test/integration/vitest.config.ts` still uses the pre-Vitest-4 Cloudflare API
- the lockfile and installed package are still on `@cloudflare/vitest-pool-workers@0.13.3`

Short version: finish the migration to the `cloudflareTest()` plugin API, stop pointing tests at `dist/server/index.js`, and treat `src/worker.ts` / `wrangler.jsonc` as the Worker under test.

## Current Repo State

### 1. Current integration config is old and fails immediately

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

### 2. The config still uses removed pool options

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

### 3. The repo dependency state is inconsistent

`package.json:95` says:

```json
"@cloudflare/vitest-pool-workers": "0.14.0"
```

But `pnpm-lock.yaml:126-128` says:

```yaml
'@cloudflare/vitest-pool-workers':
  specifier: 0.13.3
  version: 0.13.3
```

And `node_modules/@cloudflare/vitest-pool-workers/package.json:3` is also `0.13.3`.

So someone bumped `package.json`, but the install/lockfile did not follow.

### 4. The suite is pointing at built app output, not the Worker entrypoint

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

Recommended config direction:

- load Worker config from `../../wrangler.jsonc`
- let Vitest use `src/worker.ts` as `main` via Wrangler
- keep the D1 migration binding in `miniflare.bindings`
- remove `poolOptions`, `isolatedStorage`, `singleWorker`, manual `resolve.conditions`, and `ssr.target`

Minimal target shape:

```ts
import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "../../migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "../../wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
      tsconfigPaths({
        projects: [path.resolve(__dirname, "../../tsconfig.json")],
      }),
    ],
    test: {
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
    },
  };
});
```

Reason: this matches the Vitest 4 API and avoids the unnecessary build-output indirection.

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

Current tests still use `SELF`:

- `test/integration/smoke.test.ts:1-6`
- `test/integration/auth.test.ts:1-115`

Recommended direction:

```ts
import { env, exports } from "cloudflare:workers";

const response = await exports.default.fetch("http://example.com/");
```

Important nuance from the package types: `cloudflare:test` still exposes deprecated `env`/`SELF` in the currently installed `0.13.3`, so this is not necessarily the first blocker. But it is the right end state.

### 4. If tests need shared storage across files, use Vitest flags, not config knobs

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/isolation-and-concurrency.mdx:28-31`:

```md
Storage isolation is per test file.
To make test files share the same storage ... use
`--max-workers=1 --no-isolate`
```

So if the suite eventually needs cross-file shared state, update the command, not the config.

## Likely Follow-Up Fixes After The Config Migration

### 1. Reinstall dependencies first

Because `package.json`, `pnpm-lock.yaml`, and `node_modules` disagree, any migration work should start with a dependency sync.

Otherwise it will be unclear whether a failure comes from:

- stale package contents
- stale lockfile
- actual config/test bugs

### 2. The test script likely should stop building first

Current script:

```json
"test:integration": "pnpm build && pnpm vitest --config test/integration/vitest.config.ts run"
```

If the config uses `wrangler.jsonc` / `src/worker.ts` directly, the build step is probably unnecessary.

Recommended end-state command:

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

After the Vitest config is fixed, this test may still need to rewrite using Worker env instead of `process.env`.

### 4. `test/test-worker.ts` looks stale

I could not find any repo references to `test/test-worker.ts`.

That file looks like leftover sample code, not part of the real suite.

## Recommended Plan

1. Sync dependencies so lockfile and installed packages match `package.json`.
2. Rewrite `test/integration/vitest.config.ts` to `defineConfig(...)+cloudflareTest(...)`.
3. Stop overriding `main` with `dist/server/index.js`; use `wrangler.jsonc` / `src/worker.ts`.
4. Replace `test/cloudflare-test.d.ts` with `test/env.d.ts` augmenting `Cloudflare.Env`.
5. Run `pnpm typecheck:test`.
6. Run `pnpm vitest --config test/integration/vitest.config.ts run`.
7. If the suite gets past startup but still fails, migrate tests from `cloudflare:test` `SELF` to `cloudflare:workers` `exports.default.fetch()` and fix any `process.env` assumptions.

## Bottom Line

This does not look like a case where the repo fully migrated and the tests merely regressed.

It looks like the repo started moving toward Vitest 4, updated some top-level package metadata, but left the integration test harness on the old Cloudflare config API. The biggest win is not a big test rewrite. It is finishing the config migration cleanly and using the real Worker entrypoint instead of a built server artifact.
