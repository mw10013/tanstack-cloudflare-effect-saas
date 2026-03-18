# Vitest 4 Runtime Blocker Research

> Sources: `src/worker.ts`, `src/router.tsx`, `test/integration/vitest.config.ts`, `refs/cloudflare-docs/src/content/docs/workers/framework-guides/web-apps/tanstack-start.mdx`, `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx`  
> Date: 2026-03-18

## Short Version

The Vitest 3 -> 4 migration is mostly done. TypeScript is green. The remaining problem is not the migration API anymore.

The blocker is: our integration test now boots the real TanStack Start Worker entrypoint, but that Worker does not finish handling the request inside the Vitest Workers runtime. The request hangs during TanStack Start SSR/module loading, then workerd cancels it.

## What Works Already

- `pnpm typecheck:test` passes.
- test files now use the Vitest 4 import style:

```ts
import { exports } from "cloudflare:workers";
```

Source: `test/integration/smoke.test.ts:1`

- the test dispatch style is now the Cloudflare-recommended Vitest 4 pattern:

```ts
const response = await exports.default.fetch("http://example.com/");
```

Source: `test/integration/smoke.test.ts:6`

Cloudflare docs explicitly say:

> Use `exports.default.fetch()` to write integration tests against your Worker's default export handler.

Source: `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx:46`

## What The Test Is Actually Doing

Current Vitest config runs the Worker from source:

```ts
cloudflareTest({
  main: path.resolve(__dirname, "../../src/worker.ts"),
  wrangler: { configPath: wranglerConfigPath },
  miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
})
```

Source: `test/integration/vitest.config.ts:35`

That means `exports.default.fetch()` is calling the default export from `src/worker.ts`.

Our Worker is not a tiny handler. It delegates into TanStack Start:

```ts
return serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
  },
});
```

Source: `src/worker.ts:174`

And the TanStack router setup pulls in SSR router/query machinery:

```ts
const queryClient = new QueryClient();
const router = createRouter({ ... });
setupRouterSsrQueryIntegration({ router, queryClient });
```

Source: `src/router.tsx:8`, `src/router.tsx:10`, `src/router.tsx:17`

## What Fails

The smoke test:

```ts
it("serves /", async () => {
  const response = await exports.default.fetch("http://example.com/");
  expect([200, 302]).toContain(response.status);
});
```

Source: `test/integration/smoke.test.ts:5`

fails with:

> The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.

and Vitest also reports follow-on cross-context errors like:

> Cannot perform I/O on behalf of a different Durable Object.

From the captured run, the most important trace is:

- request starts in `test/integration/smoke.test.ts:6`
- Worker logs `fetch: http://example.com/`
- module loading continues through `src/worker.ts`
- then through `@tanstack/start-server-core`
- then into `src/router.tsx`
- then workerd cancels the request as hung

One concrete line from the failure:

> `Cannot load '/node_modules/.pnpm/@tanstack+react-query.../index.js' imported from /Users/mw/Documents/src/tanstack-cloudflare-effect-saas/src/router.tsx after the environment was torn down.`

This is not the root cause by itself. It is a symptom of the request hanging first, then teardown happening while module loading is still in flight.

## Why This Is Confusing

On paper, the setup looks correct:

- Cloudflare says use `exports.default.fetch()` for Vitest 4 integration tests.
- Cloudflare says TanStack Start on Workers should use `@tanstack/react-start/server-entry` or a custom entrypoint wrapping it.

Cloudflare's TanStack Start guide says:

> `"main": "@tanstack/react-start/server-entry"`

Source: `refs/cloudflare-docs/src/content/docs/workers/framework-guides/web-apps/tanstack-start.mdx:101`

and for custom entrypoints:

```ts
import handler from "@tanstack/react-start/server-entry";

export default {
  fetch: handler.fetch,
}
```

Source: `refs/cloudflare-docs/src/content/docs/workers/framework-guides/web-apps/tanstack-start.mdx:152`

Our `src/worker.ts` matches that general model. So the issue is not "wrong concept". It is a runtime interaction between:

- Vitest Workers integration
- TanStack Start SSR request bootstrapping
- Vite module loading inside the test runtime

## What I Tried

### Attempt 1: use the old built output as `main`

Used `dist/server/index.js` as `main`.

Result:

- avoided some source-resolution issues
- but still hung during SSR request handling / environment teardown

### Attempt 2: use Wrangler/main source entrypoint

Used `src/worker.ts` as `main`.

Result:

- fixes the old build-artifact path mismatch
- loads the real Worker entrypoint
- still hangs during request handling

### Attempt 3: include app plugins in Vitest config

Added enough Vite/TanStack plugin config so private TanStack Start specifiers resolve.

Result:

- private entry imports resolve
- request now gets farther into real app code
- still hangs in runtime

### Attempt 4: merge more of the main Vite config

Tried bringing over more of `vite.config.ts`.

Result:

- `@cloudflare/vite-plugin` conflicts with the Vitest Workers runtime because it validates Worker environment options and rejects Vite's `resolve.external` setup for the `ssr` environment
- so we cannot simply reuse the whole app Vite config inside Vitest

## Best Current Theory

The migration exposed a deeper issue:

`exports.default.fetch()` is invoking a TanStack Start SSR Worker that lazily loads framework/router modules during the request, and that loading path does not complete cleanly inside this Vitest Workers execution model.

In other words:

- Vitest 4 migration itself is not the blocker anymore
- the blocker is full-framework runtime execution under this specific integration style

## What This Probably Is Not

- not a missing `cloudflareTest()` migration step
- not a `SELF` -> `exports.default` migration bug
- not a typing issue
- not a missing D1 migration binding
- not a lint/typecheck problem

## Most Likely Ways Forward

### Option 1. Create a test-only Worker entrypoint

Make a special Worker entrypoint for Vitest integration that wraps only the server behavior we want to exercise, without the full runtime path that currently hangs.

Why this may help:

- keeps Cloudflare Vitest integration for Worker-level testing
- gives us control over what loads eagerly vs lazily
- lets us isolate whether TanStack Start's default server boot path is the real problem

Risk:

- test entrypoint may drift from production entrypoint if we are not careful

### Option 2. Move route-level coverage to browser/dev-server tests

Use Playwright or a dev-worker-based flow for route assertions like `/` and auth flows, and keep Vitest integration focused on lower-level Worker concerns.

Why this may help:

- browser/dev-server path is closer to how TanStack Start is usually exercised end-to-end
- avoids forcing full SSR app boot inside `exports.default.fetch()` in the test pool

Risk:

- changes the purpose of this integration suite
- slower than current Worker-level tests

### Option 3. Reduce what these integration tests cover

Use Vitest Workers integration only for things like:

- D1/KV helpers
- Worker bindings
- small handler-level logic

and stop treating it as the primary place to test end-to-end SSR routes.

## Current Direction

This is a runtime architecture question, not a migration bug.

Decisions so far:

1. Keep the Vitest 4 migration changes already made.
2. Defer full TanStack Start SSR route validation until we get a simpler Worker-pool test green.
3. Try a very small test-only Worker entrypoint if needed, as a stepping stone.
4. Replace the current `/` smoke test with a simpler first-base test instead of proving the whole SSR path immediately.

## Clarified Goals

1. We eventually do want TanStack Start in the integration path.
2. It is fine to defer that while we first prove the Vitest 4 Worker setup can run something simple and stable.
3. The immediate goal is not feature coverage. The immediate goal is establishing one working integration test path we can trust and extend.

## Useful File References

- `test/integration/vitest.config.ts`
- `test/integration/smoke.test.ts`
- `src/worker.ts`
- `src/router.tsx`
- `vite.config.ts`
- `docs/vitest4-cloudflare-workers-research.md`
