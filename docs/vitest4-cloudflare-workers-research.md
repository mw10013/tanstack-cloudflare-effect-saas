# Cloudflare Workers Vitest 4 Migration Research

> Sources: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/`, `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md`, `refs/workers-sdk/fixtures/vitest-pool-workers-examples/`  
> Date: 2026-03-18

## Current Status

- Project versions already match the new integration floor: `vitest: 4.1.0`, `@cloudflare/vitest-pool-workers: 0.13.2`, `wrangler: 4.75.0` in `package.json`.
- Test code is still on the pre-Vitest-4 API.
- Immediate hard failure: `pnpm typecheck:test` fails with `Cannot find module '@cloudflare/vitest-pool-workers/config'` from `test/integration/vitest.config.ts`.

## What Cloudflare Changed For Vitest 4

Cloudflare's v4 support is a breaking change in `@cloudflare/vitest-pool-workers`:

> `defineWorkersProject` and `defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config` have been replaced with a `cloudflareTest()` Vite plugin exported from `@cloudflare/vitest-pool-workers`.

Source: `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:39`

> `isolatedStorage` and `singleWorker` have been removed... Storage isolation is now on a per test file basis, and you can make your test files share the same storage by using the Vitest flags `--max-workers=1 --no-isolate`.

Source: `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:72`, `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/isolation-and-concurrency.mdx:28`

> `import { env, SELF } from "cloudflare:test"` has been removed in favour of `import { env, exports } from "cloudflare:workers"`.

Source: `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:73`

> `exports.default.fetch()` has the same behaviour as `SELF.fetch()`, except that it does not expose Assets.

Source: `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md:73`, `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx:44`

> `readD1Migrations()` is now shown imported from `@cloudflare/vitest-pool-workers`, while `applyD1Migrations()` remains a runtime helper from `cloudflare:test`.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/configuration.mdx:87`, `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx:233`, `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/vitest.config.ts:2`

Also important:

> The `cloudflareTest()` plugin configures Vitest to use the Workers integration with the correct module resolution settings.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/configuration.mdx:41`

## Breaking Changes That Hit This Repo

### 1. Config entrypoint is removed

Current code in `test/integration/vitest.config.ts:2`:

```ts
import {
  defineWorkersProject,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";
```

That package subpath is gone in `0.13.2`. `refs/workers-sdk/packages/vitest-pool-workers/package.json:29` only exports:

- `.`
- `./types`
- `./codemods/vitest-v3-to-v4`

Impact: config cannot typecheck or run until migrated to `cloudflareTest()`.

### 2. `SELF`-based integration tests must move

Current code in `test/integration/auth.test.ts:1` and `test/integration/smoke.test.ts:1`:

```ts
import { env, SELF } from "cloudflare:test";
```

Vitest 4 integration expects:

```ts
import { env, exports } from "cloudflare:workers";
```

Then calls become:

```ts
await exports.default.fetch("http://example.com/");
```

Impact: every `SELF.fetch(...)` use must change.

### 3. Ambient typing moves from `cloudflare:test` to `cloudflare:workers`

Current local typing shim in `test/cloudflare-test.d.ts:1` declares `ProvidedEnv` inside `cloudflare:test`.

Cloudflare's Vitest 4 docs now show:

```ts
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
```

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/write-your-first-test.mdx:106`

Impact: local env typing should move to a new ambient module for `cloudflare:workers`. Runtime helpers like `applyD1Migrations()` still come from `cloudflare:test`.

### 4. Old storage options are removed

Current config in `test/integration/vitest.config.ts:37`:

```ts
isolatedStorage: false,
singleWorker: true,
```

Those options no longer exist. The new model is per-file storage isolation by default.

Impact: we need to decide whether this suite really needs shared storage across files. If yes, use CLI flags. If not, delete these options and keep per-file isolation.

We do not need shared storage across files.

### 5. Some manual worker-resolution config is probably obsolete

Current config sets:

- `resolve.conditions = ["workerd", "worker", "browser"]`
- `ssr.target = "webworker"`
- `ssr.resolve.conditions = ["workerd", "worker", "browser"]`

The new `cloudflareTest()` plugin says it configures the correct Workers module resolution settings itself.

Impact: these settings are likely removable unless we discover a project-specific need during migration.

## Project-Specific Migration Notes

### D1 migrations still fit the new model

Current setup:

- `readD1Migrations(...)` in `test/integration/vitest.config.ts:11`
- `applyD1Migrations(env.D1, env.TEST_MIGRATIONS)` in `test/apply-migrations.ts:3`

This pattern is still valid, with one import change:

- `readD1Migrations` -> import from `@cloudflare/vitest-pool-workers`
- `applyD1Migrations` -> keep importing from `cloudflare:test`

This is the same split used in Cloudflare's D1 example at `refs/workers-sdk/fixtures/vitest-pool-workers-examples/d1/vitest.config.ts:2`.

### The current suite likely does not need shared cross-file storage

Both test files reset or avoid persistent state:

- `test/integration/auth.test.ts:38`, `:47`, `:73`, `:98` call `resetDb()` per test.
- `test/integration/smoke.test.ts` is stateless.

This suggests the old `isolatedStorage: false` / `singleWorker: true` settings may be legacy, not required. Per-file isolation is likely fine.

per-file isolation is fine.

### The biggest repo-specific question is the `main` entrypoint

Current Vitest config points `main` at a built artifact:

```ts
main: path.resolve(__dirname, "../../dist/server/index.js"),
```

Current test script also forces a build first:

```json
"test:integration": "pnpm build && pnpm vitest --config test/integration/vitest.config.ts run"
```

But Wrangler's actual Worker entrypoint is `./src/worker.ts` in `wrangler.jsonc:11`.

This is the main migration decision:

- keep testing the built app bundle via `dist/server/index.js`
- or switch to `src/worker.ts` and see if the suite can run without a prebuild

I would default to keeping the built entrypoint first, then revisit once tests pass.

Agreed. but let's not forget to revisit.

## Recommended Migration Plan

### Step 1. Replace the config API

Target shape:

```ts
import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "../../migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      tsconfigPaths({
        projects: [path.resolve(__dirname, "../../tsconfig.json")],
      }),
      cloudflareTest({
        main: path.resolve(__dirname, "../../dist/server/index.js"),
        wrangler: {
          configPath: "../../wrangler.jsonc",
        },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
    },
  };
});
```

Notes:

- `cloudflareTest()` replaces `defineWorkersProject(...)`.
- `main`, `wrangler`, and `miniflare` move into the plugin options.
- `isolatedStorage` and `singleWorker` disappear.
- manual `resolve.conditions` / `ssr.target` likely disappear.

### Step 2. Move env imports to `cloudflare:workers`

Expected import split:

```ts
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
```

Apply to:

- `test/integration/auth.test.ts`
- `test/integration/smoke.test.ts`
- `test/test-utils.ts`
- `test/apply-migrations.ts`

### Step 3. Replace `SELF.fetch()` calls

Replace:

```ts
await SELF.fetch(url, init)
```

With:

```ts
await exports.default.fetch(url, init)
```

Cloudflare docs say this is the direct replacement for most integration tests, with the caveat that assets are not exposed.

### Step 4. Move the ambient module declaration

Replace `test/cloudflare-test.d.ts` with a `cloudflare:workers` ambient module, for example:

```ts
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

Likely result:

- delete `env` export declarations from the local shim
- delete `SELF` declaration entirely
- keep no local declarations for helpers already supplied by the package unless TypeScript proves they are still needed

### Step 5. Recheck the npm script semantics

If we keep `main: ../../dist/server/index.js`, `pnpm build` probably stays required in `test:integration`.

If we move to `main: ../../src/worker.ts`, we can test whether the build step can be removed.

### Step 6. Only add `--max-workers=1 --no-isolate` if we prove we need it

Cloudflare's new default is per-file isolation. Based on current tests, I would not add shared-storage flags unless a real failure shows cross-file coupling.

## Likely Non-Blocking Follow-Up

`test/integration/auth.test.ts:30` currently rewrites URLs using `process.env.BETTER_AUTH_URL`.

```ts
magicLink.replace(process.env.BETTER_AUTH_URL, "http://example.com")
```

That is not the new recommended env access path. Since Vitest 4 moves test env access to `cloudflare:workers`, it may be cleaner to use `env.BETTER_AUTH_URL` instead, assuming `Env` already includes it from `worker-configuration.d.ts`.

This is not the main breaking change, but it is worth cleaning up during the migration.

## Open Questions

1. `main` entrypoint: should we keep `dist/server/index.js` for parity with the built app, or try `src/worker.ts` and remove the prebuild? My default: keep `dist/server/index.js` first.

ok

2. Storage model: do we actually need cross-file shared storage anywhere, or can we accept Cloudflare's new per-file default? My default: use per-file isolation.

ok with your default.

3. Assets: do we need integration coverage for static assets? If yes, `exports.default.fetch()` is not enough and we may need `startDevWorker()` for that slice.

i don't think we currently need.

4. Env access: should test code stop using `process.env.BETTER_AUTH_URL` and use `env.BETTER_AUTH_URL` instead? My default: yes.

ok

## Short Checklist For The Actual Migration PR

- migrate `test/integration/vitest.config.ts` to `cloudflareTest()`
- import `readD1Migrations` from `@cloudflare/vitest-pool-workers`
- replace `SELF` with `exports.default`
- move `env` imports to `cloudflare:workers`
- replace `test/cloudflare-test.d.ts` with a `cloudflare:workers` ambient module
- remove deleted pool options
- rerun `pnpm typecheck:test`
- rerun `pnpm test:integration`
