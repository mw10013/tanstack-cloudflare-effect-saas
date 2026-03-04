# Agents callable decorators in Vite SSR

## Issue

The dev server fails to start with `SyntaxError: Invalid or unexpected token` when using `@callable()` decorator on agent methods.

## Root Cause

**Vite's default esbuild transformer does not support ES2022 (stage-3) decorators.**

The Agents SDK uses standard ES2022 decorators (`ClassMethodDecoratorContext`), not legacy `experimentalDecorators`. When Vite processes `src/user-agent.ts`, esbuild sees `@callable()` as invalid syntax and throws a parse error.

### Why Agents Examples Work

The Agents examples use `@vitejs/plugin-react` without explicit decorator config because they run directly on workerd via wrangler, not through Vite's SSR transform pipeline. When running TanStack Start with the Cloudflare Vite plugin, Vite must transpile decorators before workerd receives the code.

## Solution

Configure `@vitejs/plugin-react` to transpile ES2022 decorators using Babel:

1. Install the Babel decorator plugin:

   ```bash
   pnpm add -D @babel/plugin-proposal-decorators
   ```

2. Configure vite.config.ts:
   ```ts
   viteReact({
     babel: {
       plugins: [["@babel/plugin-proposal-decorators", { version: "2023-11" }]],
     },
   }),
   ```

The `version: "2023-11"` option uses the finalized decorator spec (stage-3), which matches the Agents SDK's decorator implementation.

## Notes

- Do NOT enable `experimentalDecorators` in tsconfig.json — that's for legacy TypeScript decorators and will cause type errors with the Agents SDK.
- The `2023-11` version corresponds to the TC39 decorators proposal that reached stage-3 in 2022 and was finalized.
