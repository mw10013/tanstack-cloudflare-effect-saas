# Better Auth 1.5 Upgrade Research

**Current version:** 1.4.19  
**Target version:** 1.5.1 (latest stable as of Mar 2, 2026)

---

## 🎉 Big Win: Native Cloudflare D1 Support

**We can remove our custom `d1-adapter.ts` entirely.**

1.5 adds first-class D1 support — pass the D1 binding directly:

```ts
const auth = betterAuth({
  database: env.DB, // D1 binding, auto-detected
});
```

The built-in D1 dialect handles query execution, batch operations, and introspection. D1 doesn't support interactive transactions — Better Auth uses D1's `batch()` API for atomicity instead.

### What to Remove
- `src/lib/d1-adapter.ts` — entire file
- `test/d1/d1-adapter.test.ts` — associated tests
- `import { d1Adapter } from "@/lib/d1-adapter"` in `Auth.ts`
- `import type { CustomAdapter } from "@better-auth/core/db/adapter"` and related adapter imports

### What to Change in `Auth.ts`
```diff
- database: d1Adapter(db),
+ database: db, // D1 binding, auto-detected
```

### ⚠️ Open Questions
- Our custom adapter handles **capitalized table names** (e.g., `User` not `user`). The native D1 support may use lowercase by default. We need to verify that `modelName` config options (`user: { modelName: "User" }`, etc.) still work with the native D1 dialect. If not, we'd need a migration to rename tables or adjust our schema.
- Our adapter has `supportsDates: false` and `supportsBooleans: false` — the native D1 dialect should handle this since D1 is SQLite, but verify serialization behavior matches.
- We pass `{ prepare: d1.prepare } as D1Database` — the native adapter expects a real D1 binding. We'll need to refactor how we pass the D1 binding (currently wrapped in an Effect service).

---

## ⚠️ Breaking Changes Affecting Us

### 1. Adapter Imports (Low Risk)
- `better-auth/adapters/test` export removed → use `testUtils` plugin instead.
- We don't use this, so **no impact**.

### 2. Deprecated API Removals (Check Required)

| Removed | Replacement | Impact |
|---------|-------------|--------|
| `createAdapter` | `createAdapterFactory` | **We use `createAdapterFactory`** — no change needed unless removing d1-adapter |
| `onEmailVerification` | `afterEmailVerification` | Check if used |
| `sendChangeEmailVerification` | `sendChangeEmailConfirmation` | Check if used |
| Organization `permission` field | `permissions` (plural) | Check org plugin usage |

### 3. `/forget-password/email-otp` Endpoint Removed
- We don't use email-otp, so **no impact**.

### 4. API Key Plugin Moved to `@better-auth/api-key`
- We don't use the api-key plugin, so **no impact**.

### 5. After Hooks Now Run Post-Transaction
- Database "after" hooks (`create.after`, `update.after`, `delete.after`) now execute **after** the transaction commits, not during it.
- **Impact:** Our `databaseHookUserCreateAfter` calls `auth.api.createOrganization()`. This should still work since it's making a separate API call, not relying on being inside the same transaction. But verify the user record is committed before the org creation query runs.

### 6. `InferUser` / `InferSession` Types Removed
- We use `AuthTypes` via `ReturnType<typeof betterAuth<...>>` — check if this still works.
- If we reference `InferUser` or `InferSession` anywhere, update to:
```ts
import type { User, Session } from "better-auth";
```

---

## 💳 Stripe Plugin Changes

### New Subscription Schema Fields
The 1.5 Subscription table adds two new columns we don't have:

| Field | Type | Description |
|-------|------|-------------|
| `billingInterval` | string? | The billing interval ('month', 'year') |
| `stripeScheduleId` | string? | Stripe Subscription Schedule ID for pending plan changes |

**Action:** Add columns to `0001_init.sql` schema and reset the database.

### New Stripe Plugin Features (Non-Breaking)
- **Seat-based billing**: `seatPriceId` on plan config, `seats` parameter on upgrade
- **`scheduleAtPeriodEnd`**: Defer plan changes to end of billing period
- **`lineItems`**: Usage-based billing support
- **Organization as Stripe customer**: We already use `organization: { enabled: true }` ✅
- **Subscription schedule tracking**: Via new `stripeScheduleId` field
- **Flexible cancellation/termination**: New `restore` endpoint
- **`onSubscriptionCreated` hook**: New separate hook for subscriptions created outside checkout (e.g., Stripe dashboard)
- **Trial abuse prevention**: Checks all user subscriptions before granting a trial ✅ (security improvement)

### Stripe SDK Compatibility
The docs show `apiVersion: "2025-11-17.clover"` with Stripe SDK v20. We're on `stripe: 19.3.0`. The plugin note says "Upgrading from Stripe v18? Version 19 uses async webhook signature verification (`constructEventAsync`) which is handled internally by the plugin. No code changes required on your end!" — so our v19 should work fine.

### `onSubscriptionCreated` vs `onSubscriptionComplete`
1.5 adds a new `onSubscriptionCreated` hook that fires when a subscription is created **outside** the checkout flow (e.g., via Stripe dashboard). Our existing `onSubscriptionComplete` continues to work for checkout-created subscriptions.

---

## 🆕 Notable New Features (Not Breaking)

### New CLI: `npx auth`
Replaces `@better-auth/cli` (will be deprecated). New commands:
```bash
npx auth init      # Interactive setup wizard
npx auth migrate   # Run migrations
npx auth generate  # Generate schema
npx auth upgrade   # Upgrade better-auth
```

**Action:** Remove `@better-auth/cli` from devDependencies.

### Adapter Extraction
Adapters extracted to separate packages (`@better-auth/drizzle-adapter`, etc.). Main `better-auth` re-exports them, so existing imports still work. Since we're switching to native D1, this doesn't affect us.

### Test Utilities Plugin
New `testUtils` plugin for integration/E2E testing:
```ts
import { testUtils } from "better-auth/plugins";
plugins: [testUtils({ captureOTP: true })]
```
Could be useful for our E2E tests.

### Update Session Endpoint
New `/update-session` endpoint for updating custom session fields without re-auth.

### Rate Limiter Improvements
- Stricter defaults (sign-in/sign-up: 3 req/10s; password reset: 3 req/60s)
- We have `rateLimit: { enabled: false }` — no impact unless we enable it.

### Security Improvements
- OTP reuse prevention via race condition
- User/email enumeration prevention
- Trial abuse prevention
- IPv6 subnet support for rate limiting

---

## 📦 Package Changes

### Dependencies to Update
```json
{
  "better-auth": "1.5.1",
  "@better-auth/stripe": "1.5.1"
}
```

### Dependencies to Remove
- `@better-auth/core` — only used by our d1-adapter (`@better-auth/core/db/adapter`). Remove with the custom adapter.
- `@better-auth/cli` (devDependency) — replaced by `npx auth`.

---

## 🔄 Migration Plan

### Phase 1: Preparation
1. Audit all imports from `better-auth`, `@better-auth/core`, `@better-auth/stripe`
2. Run `grep -r "InferUser\|InferSession\|createAdapter\|onEmailVerification\|sendChangeEmailVerification" src/`

### Phase 2: Schema Update
1. Add `billingInterval text` and `stripeScheduleId text` to `Subscription` table in `0001_init.sql`
2. Reset database from scratch

### Phase 3: Code Changes
1. Update `package.json` dependencies
2. Remove `src/lib/d1-adapter.ts`
3. Remove `test/d1/d1-adapter.test.ts`
4. Update `Auth.ts`:
   - Remove d1-adapter import
   - Change `database: d1Adapter(db)` → `database: db` (real D1 binding)
   - Refactor D1 binding access to pass the actual `D1Database` binding, not `{ prepare: d1.prepare } as D1Database`
5. Verify `modelName` options work with native D1 dialect (capitalized table names)
6. Update `refs:better-auth` script in package.json to point to 1.5.0 tag

### Phase 4: Verification
1. `pnpm typecheck` — fix any type errors
2. `pnpm lint`
3. `pnpm dev` — verify login, signup, org creation
4. Test Stripe subscription flow (upgrade, cancel, webhook)
5. Run E2E tests: `npm run test:e2e --`

---

## ⚡ Risk Assessment

| Area | Risk | Notes |
|------|------|-------|
| D1 native adapter | **Medium** | Must verify capitalized table names + Date/Boolean serialization |
| Stripe schema migration | **Low** | Additive columns only |
| Stripe plugin API | **Low** | Our usage pattern is unchanged, new features are additive |
| After hooks post-transaction | **Low** | Our after hook makes a separate API call, should be fine |
| Type removals | **Low** | We don't directly use removed types |
| Custom adapter removal | **High value** | ~300 lines of code + tests removed |

---

## 📝 Summary

The 1.5 upgrade is **very favorable** for this project:
1. **Remove ~300 lines** of custom D1 adapter code — major maintenance win
2. **Stripe plugin gets richer** with seat-based billing, schedule support — no breaking changes to our usage
3. **Breaking changes are minimal** — mostly deprecated API removals that don't affect us
4. **New test utilities** could improve our E2E testing
5. **Main risk**: Verifying the native D1 dialect handles our capitalized table names and SQLite type coercion correctly
