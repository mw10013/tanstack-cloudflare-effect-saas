# Build Error: "Readable" is not exported by "\_\_vite-browser-external"

## Error

```
router-core/dist/esm/ssr/transformStreamWithRouter.js (2:9):
"Readable" is not exported by "__vite-browser-external"
```

## Root Cause

The import chain that causes the error:

```
src/routes/login.tsx (CLIENT bundle)
  → import { getRequest } from "@tanstack/react-start/server"
    → @tanstack/react-start/server  re-exports  @tanstack/react-start-server
      → @tanstack/start-server-core/index.js  imports from  @tanstack/router-core/ssr/server
        → router-core/ssr/server.js  imports  ./transformStreamWithRouter.js
          → import { Readable } from "node:stream"   ← FAILS in client build
```

`@tanstack/start-server-core/index.js` is a barrel file that re-exports **everything** — `getRequest`, `getCookie`, but also `transformPipeableStreamWithRouter` and `transformReadableStreamWithRouter` from `@tanstack/router-core/ssr/server`. That SSR module imports `node:stream`, which Vite replaces with an empty `__vite-browser-external` shim during the client build. Rollup then fails because the named export `Readable` doesn't exist on the empty shim.

**Key point**: This is NOT a bug we can fix in library code. The library's `index.js` barrel re-exports SSR + request utilities together. When we `import { getRequest } from "@tanstack/react-start/server"` at the **top level** of a route file, the entire barrel is resolved — including the SSR stream code — pulling `node:stream` into the client bundle.

## Why It Works in Dev

Vite dev uses on-demand module resolution (no bundling). Unused exports from `@tanstack/start-server-core` are never actually loaded. In production build, Rollup resolves the entire module graph upfront, hitting the `node:stream` import before tree-shaking can remove it.

## Import Protection (TanStack Start Built-in)

TanStack Start has an [import protection](https://tanstack.com/start/latest/docs/framework/react/guide/import-protection) plugin enabled by default:

- **Dev**: `behavior: 'mock'` — warns and replaces with a proxy. This is why dev works.
- **Build**: `behavior: 'error'` — fails the build.

Default client-environment denials include the specifier `@tanstack/react-start/server`.

### How the Compiler Handles `createServerFn`

From the docs:

> The compiler rewrites environment-specific *implementations* for the current target. When it replaces a `createServerFn()` handler with a client RPC stub, it can also remove server-only imports that were only used by the removed implementation.

So if `getRequest` is **only** referenced inside a `createServerFn` handler, the compiler removes the handler body for the client build, and the now-unused `getRequest` import gets pruned.

### Why Our Code Still Fails

The compiler **does** prune `getRequest` calls inside handlers. But the **static top-level import** `import { getRequest } from "@tanstack/react-start/server"` is resolved **before** the compiler runs. The module graph already includes `@tanstack/start-server-core` → `router-core/ssr/server` → `node:stream`.

The import protection plugin catches the specifier violation, but the underlying `node:stream` resolution in Rollup happens at a different stage and errors first.

## The Fix

**Replace static top-level imports with dynamic `await import()` inside `createServerFn` handlers.**

Dynamic imports inside handler bodies are only resolved at runtime on the server — they never enter the client module graph.

### Before (broken)

```ts
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";   // ← pulls node:stream into client

const myServerFn = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  // ...
});
```

### After (fixed)

```ts
import { createServerFn } from "@tanstack/react-start";

const myServerFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");  // ← server-only
  const request = getRequest();
  // ...
});
```

## Files Fixed

All files that had a top-level `import { getRequest } from "@tanstack/react-start/server"`:

- `src/routes/login.tsx`
- `src/routes/_mkt.pricing.tsx`
- `src/routes/admin.users.tsx`
- `src/routes/app.$organizationId.index.tsx`
- `src/routes/app.$organizationId.tsx`
- `src/routes/app.$organizationId.billing.tsx`
- `src/routes/app.$organizationId.invitations.tsx`
- `src/routes/app.$organizationId.members.tsx`
- `src/lib/Auth.ts`

## References

- [TanStack/router#4022](https://github.com/TanStack/router/issues/4022) — same error, confirmed by maintainer `@schiller-manuel`
- [Import Protection docs](https://tanstack.com/start/latest/docs/framework/react/guide/import-protection) — explains compiler behavior and why imports stay alive
- TanStack Start docs: `verbatimModuleSyntax` must be `false` (already set in our `tsconfig.json`)
