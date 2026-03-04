# Better Auth Upgrade Research

Updated: 2026-02-26

## Goal

Deep upgrade assessment for Better Auth in this codebase (not just custom D1 adapter), including Cloudflare service constraints that affect rollout risk.

## Current codebase grounding

Current versions (`package.json`):

- `better-auth`: `1.4.17`
- `@better-auth/core`: `1.4.17`
- `@better-auth/stripe`: `1.4.17`
- `@better-auth/cli`: `1.4.17`

Current auth surface in app code:

- Core auth setup with plugins in `src/lib/auth-service.ts`
- Plugins in use: `magicLink`, `admin`, `organization`, `stripe`, `tanstackStartCookies`
- Custom DB adapter in `src/lib/d1-adapter.ts`
- Auth handler route in `src/routes/api/auth/$.tsx`

Code excerpts:

```ts
// src/lib/auth-service.ts
plugins: [
  magicLink(...),
  admin(),
  organization(...),
  stripe(...),
  tanstackStartCookies(),
]
```

```ts
// src/lib/d1-adapter.ts
config: {
  adapterId: "d1-adapter",
  adapterName: "D1 Adapter",
  supportsNumericIds: false,
  supportsDates: false,
  supportsBooleans: false,
}
```

## Upstream status (web-verified)

As of **2026-02-26**:

- Latest stable Better Auth release: `v1.4.19` (2026-02-23)
- Latest prerelease: `v1.5.0-beta.19` (2026-02-26)

Primary sources:

- GitHub releases: https://github.com/better-auth/better-auth/releases
- Better Auth changelog: https://beta.better-auth.com/changelogs
- npm package: https://www.npmjs.com/package/better-auth

## What changed after 1.4.17 (impactful items)

### 1) Stable patch line (1.4.18, 1.4.19)

`1.4.18` includes security and auth-flow hardening:

- Security fix: validate redirect URL origins in callback handlers.
- Fixes around auth callback URL construction.
- Organization/plugin fixes (active org and related behaviors).

`1.4.19` includes:

- Worker-specific fix: construct a new `Request` to avoid immutable headers error on Cloudflare Workers.
- Additional fixes across org/stripe/session/plugin edge cases.

Why this matters here:

- App runs on Cloudflare Workers and routes all auth via `context.authService.handler(request)` in `src/routes/api/auth/$.tsx`.
- App heavily uses organization + stripe plugin paths.

### 2) 1.5 beta line (beta.12 -> beta.19)

Notable 1.5 beta changes intersecting this app:

- Adapter/where improvements (nested field references in where parser).
- Transaction deadlock mitigation (`getCurrentAdapter` usage in a core path).
- Cookie/session handling fixes (`parseSetCookieHeader`, session middleware fixes).
- Organization plugin fixes and features (including API key auth support in org plugin).
- Additional Cloudflare immutable header-related fix in auth client path.

Interpretation:

- 1.5 betas are still moving, with many bug-fix style commits.
- Good signal for future stability, but not yet a stable target for production unless you need beta-only features now.

## Security advisory check

Reviewed Better Auth security advisories on GitHub Security tab:

- Active advisories mostly target older ranges (for example `<1.3.x` lines).
- Current app version `1.4.17` is newer than the vulnerable ranges shown for those advisories.
- Still, `1.4.18` and `1.4.19` include security-hardening commits; staying on `1.4.17` is unnecessary risk.

Source:

- https://github.com/better-auth/better-auth/security

## Cloudflare service constraints (from `refs/cloudflare-docs`)

### D1 specifics relevant to Better Auth + custom adapter

From `refs/cloudflare-docs/src/content/docs/d1/worker-api/index.mdx`:

- Booleans are stored as integer (`1`/`0`) and read back as numbers.
- Type conversion is one-way in practice on write/read boundaries.

From `refs/cloudflare-docs/src/content/docs/d1/sql-api/query-json.mdx`:

- JSON data is stored as `TEXT` in D1.

From `refs/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`:

- Read replication only works with Sessions API (`withSession`).
- Sessions provide sequential consistency with bookmark flow.

From `refs/cloudflare-docs/src/content/docs/d1/platform/limits.mdx`:

- Max bound parameters per query: `100`.
- Max SQL statement length: `100 KB`.

From `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx`:

- D1 auto-retries read-only queries up to two more times.
- Write retries should be app-level and idempotency-safe.

### KV specifics relevant to this codebase

From `refs/cloudflare-docs/src/content/docs/kv/concepts/how-kv-works.mdx`:

- KV is eventually consistent; cross-region visibility can lag (commonly up to ~60s+).

Impact here:

- `demo:magicLink` and Stripe plan cache in KV are acceptable use cases.
- KV should not be treated as transactional/session-consistent auth state.

## Adapter-specific assessment (broader than adapter-only)

The current adapter sets:

- `supportsDates: false`
- `supportsBooleans: false`
- no explicit `supportsJSON`

Better Auth adapter docs (`refs/better-auth/docs/content/docs/guides/create-a-db-adapter.mdx`) state:

- `supportsJSON`: if false, Better Auth stringifies/parses JSON fields.
- `supportsDates`: if false, dates stored as ISO string.
- `supportsBooleans`: if false, booleans stored as `0`/`1`.

Given D1 behavior:

- `supportsBooleans: false` aligns with D1.
- `supportsDates: false` aligns with your schema storing date/time in `text`.
- `supportsJSON`: either setting can work in D1; keep current behavior unless/until you explicitly migrate JSON handling and test all model fields.

## Recommendation

1. Upgrade now to `1.4.19` (all Better Auth packages pinned together).
2. Do not move production to `1.5.0-beta.*` yet unless you need a beta-only fix/feature immediately.
3. Re-evaluate `1.5` on first stable release; expect lower risk once changelog stabilizes.

Reasoning:

- `1.4.19` is low-diff from `1.4.17` but adds concrete Cloudflare and auth-flow fixes.
- Your app relies on multiple plugin surfaces (`organization`, `stripe`, `tanstackStartCookies`), and 1.4.18/1.4.19 include fixes directly in those areas.
- 1.5 branch currently looks active and corrective, but still prerelease.

## What to wait for in 1.5

Move to `1.5.x` once stable only if one or more are true:

- You want org plugin API-key auth support from the 1.5 line.
- You hit adapter/query edge cases covered by 1.5 where-parser and deadlock fixes.
- You need newer cookie/session handling fixes not backported to 1.4.x.

If none apply, `1.4.19` is the safer production target now.

## Evidence snippets

From Better Auth releases/changelog:

- `1.4.18`: "security: validate redirect URL origins in callback handlers"
- `1.4.19`: "Construct the new Request to avoid immutable headers error on Cloudflare Workers"
- `1.5.0-beta.19`: "feat: support api key auth in organization plugin"

From Cloudflare D1/KV docs:

- D1 read replication: "must use the D1 Sessions API (`withSession`)"
- D1 types: booleans are converted to `INTEGER` (`1`/`0`)
- KV consistency: changes may take "up to 60 seconds or more" across locations

## If you choose to trial 1.5 before stable

Use a branch-only canary and verify:

- Magic-link sign-in + callback + sign-out
- Org switching/invitation/role changes
- Stripe checkout + billing portal + webhook path
- Cookie behavior across TanStack Start request/response cycle
- `test/d1/d1-adapter.test.ts` + auth integration tests

Block production rollout unless all pass against local and remote D1.

## Sources

- Better Auth releases: https://github.com/better-auth/better-auth/releases
- Better Auth changelog: https://beta.better-auth.com/changelogs
- Better Auth security advisories: https://github.com/better-auth/better-auth/security
- Better Auth adapter guide (repo ref): `refs/better-auth/docs/content/docs/guides/create-a-db-adapter.mdx`
- D1 worker API: `refs/cloudflare-docs/src/content/docs/d1/worker-api/index.mdx`
- D1 read replication: `refs/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`
- D1 JSON: `refs/cloudflare-docs/src/content/docs/d1/sql-api/query-json.mdx`
- D1 limits: `refs/cloudflare-docs/src/content/docs/d1/platform/limits.mdx`
- D1 retries: `refs/cloudflare-docs/src/content/docs/d1/best-practices/retry-queries.mdx`
- KV consistency: `refs/cloudflare-docs/src/content/docs/kv/concepts/how-kv-works.mdx`
