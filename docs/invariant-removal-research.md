# Invariant Removal Research

## Goal

Find where `import { invariant } from "@epic-web/invariant"` is used, and check Effect v4 refs for assertion APIs we can use instead.

## Where invariant is used in this repo

Search pattern used:

- `import { invariant } from "@epic-web/invariant"`
- `invariant(` call sites

Direct import sites: 8 files.
Call sites: 23 total.

### By file

| File | Calls | Primary use |
| --- | ---: | --- |
| `e2e/invite.spec.ts` | 5 | `baseURL` existence + trailing slash precondition |
| `e2e/organization-agent-authorization.spec.ts` | 5 | `baseURL` precondition + URL id extraction guards |
| `e2e/stripe.spec.ts` | 4 | `baseURL` existence + trailing slash precondition |
| `e2e/new-invoice.spec.ts` | 2 | `baseURL` existence + trailing slash precondition |
| `e2e/edit-invoice.spec.ts` | 2 | `baseURL` existence + trailing slash precondition |
| `e2e/upload.spec.ts` | 2 | `baseURL` existence + trailing slash precondition |
| `e2e/delete-invoice.spec.ts` | 1 | `baseURL` existence precondition |
| `src/routes/app.$organizationId.billing.tsx` | 2 | Guard `subscription.stripeSubscriptionId` before mutation |

### Distribution

- E2E tests: 21/23 calls
- App runtime route code: 2/23 calls

### Representative code excerpts

E2E precondition style:

```ts
invariant(baseURL, "Missing baseURL");
invariant(baseURL.endsWith("/"), "baseURL must have a trailing slash");
```

Used in `e2e/new-invoice.spec.ts:61`, `e2e/new-invoice.spec.ts:80`, and similarly in other e2e files.

E2E parsed id guard style:

```ts
const organizationId = new URL(url).pathname.split("/")[2];
invariant(organizationId, `Could not parse organizationId from URL: ${url}`);
```

From `e2e/organization-agent-authorization.spec.ts:43` and `e2e/organization-agent-authorization.spec.ts:44`.

Runtime UI mutation guard style:

```ts
invariant(subscription.stripeSubscriptionId, "Missing stripeSubscriptionId");
```

From `src/routes/app.$organizationId.billing.tsx:131` and `src/routes/app.$organizationId.billing.tsx:149`.

## Dependency footprint

`@epic-web/invariant` is a direct dependency:

```json
"@epic-web/invariant": "1.0.0"
```

From `package.json:59`.

If we remove all usages, this package can likely be removed from `dependencies`.

## Effect v4 refs: assertion options

### 1) `@effect/vitest` assert object (Effect test style)

Effect v4 examples use:

```ts
import { assert, describe, it } from "@effect/vitest"
```

From `refs/effect4/ai-docs/src/09_testing/10_effect-tests.ts:6` and `refs/effect4/ai-docs/src/09_testing/20_layer-tests.ts:6`.

Example assertions in refs:

```ts
assert.deepStrictEqual(upper, ["ADA", "LIN"])
assert.strictEqual(upper.length, 2)
assert.isTrue(upper.includes("ADA"))
```

From `refs/effect4/ai-docs/src/09_testing/10_effect-tests.ts:14` to `refs/effect4/ai-docs/src/09_testing/10_effect-tests.ts:16`.

### 2) `@effect/vitest/utils` typed helper assertions

Effect v4 provides extra helpers:

```ts
export function assertTrue(self: unknown, message?: string, ..._: Array<never>): asserts self
export function assertFalse(self: boolean, message?: string, ..._: Array<never>)
export function assertDefined<A>(a: A | undefined, ..._: Array<never>): asserts a is Exclude<A, undefined>
export function assertInclude(actual: string | undefined, expected: string, ..._: Array<never>)
```

From `refs/effect4/packages/vitest/src/utils.ts:97`, `refs/effect4/packages/vitest/src/utils.ts:106`, `refs/effect4/packages/vitest/src/utils.ts:198`, `refs/effect4/packages/vitest/src/utils.ts:115`.

These are already used in this repo:

- `test/TestUtils.ts:6` imports `assertFalse`, `assertTrue`
- `test/integration/invoice-crud.test.ts:4` imports `assertInclude`

### 3) Scope caveat: Effect test helpers are Vitest oriented

Package description:

```json
"description": "A set of helpers for testing Effects with vitest"
```

From `refs/effect4/packages/vitest/package.json:6`.

So this is a strong fit for `test/integration/*` and other Vitest tests, but not ideal as a general runtime assertion dependency for app route code.

## What can replace invariant here

### A) E2E (Playwright) files

Best low-friction replacements:

1. Node assert (no extra dependency):

```ts
import assert from "node:assert/strict";

assert(baseURL, "Missing baseURL");
assert(baseURL.endsWith("/"), "baseURL must have a trailing slash");
```

2. Small local assert helper with TS narrowing:

```ts
export const assertDefined = <T>(value: T, message: string): asserts value is NonNullable<T> => {
  if (value == null) throw new Error(message);
};
```

Both remove `@epic-web/invariant` and preserve readable failure messages.

### B) Vitest integration tests

Use existing Effect test helpers (`@effect/vitest` and `@effect/vitest/utils`) where assertions are needed. This is already the current pattern in `test/*`.

### C) Runtime route code (`src/routes/app.$organizationId.billing.tsx`)

Prefer explicit control-flow guards over test assertion libs. Example direction:

- derive `const subscriptionId = subscription.stripeSubscriptionId`
- if absent, return a user-facing error path or no-op mutation path
- only invoke cancel/restore server functions when `subscriptionId` exists

## Recommendation

1. Remove `invariant` from e2e first via Node `assert` or a tiny shared helper.
2. Replace runtime route `invariant` with explicit guard branches.
3. Keep using `@effect/vitest` / `@effect/vitest/utils` for Effect Vitest tests only.
4. After replacements, remove `@epic-web/invariant` from `package.json`.
