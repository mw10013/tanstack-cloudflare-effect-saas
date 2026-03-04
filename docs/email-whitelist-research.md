# EMAIL_WHITELIST Environment Variable Research

## What It Does

`EMAIL_WHITELIST` is an optional, comma-separated list of email addresses that restricts who can sign up/sign in to the application.

## Implementation Details

The whitelist is implemented in `src/routes/login.tsx:56-68`:

```typescript
const emailWhitelist = yield * Config.nonEmptyString("EMAIL_WHITELIST");
// ...
if (environment !== "local") {
  const whitelist = emailWhitelist
    .split(",")
    .map((email: string) => email.trim().toLowerCase())
    .filter(Boolean);
  if (whitelist.length > 0 && !whitelist.includes(normalizedEmail)) {
    return (
      yield *
      Effect.fail(new Error("Email not allowed. Please contact support."))
    );
  }
}
```

## Behavior

1. **Only enforced in non-local environments** - The whitelist check is skipped when `ENVIRONMENT === "local"`, allowing unrestricted access during local development
2. **Empty string = no restriction** - When set to empty (current default in wrangler.jsonc), the whitelist check passes for all emails
3. **Comma-separated format** - Multiple emails can be whitelisted: `admin@example.com,user@example.com`
4. **Case-insensitive** - Emails are normalized to lowercase before comparison

## Configuration Locations

| File                                   | Current Value | Purpose                        |
| -------------------------------------- | ------------- | ------------------------------ |
| `wrangler.jsonc` (vars)                | `""`          | Local dev defaults             |
| `wrangler.jsonc` (env.production.vars) | _not set_     | Production (defaults to empty) |
| `.env.example`                         | `""`          | Documentation                  |

## Current State

The whitelist is currently **not enforced** in any environment:

- Local: bypassed due to `ENVIRONMENT === "local"` check
- Production: `EMAIL_WHITELIST` is not set in the production env vars, defaulting to empty string

## If Removed

Removing `EMAIL_WHITELIST` would:

- Remove the email restriction logic entirely from the login flow
- Simplify the code (remove ~12 lines in login.tsx)
- Remove the env var from type definitions and wrangler config
- No impact on current behavior since it was never actually restricting access

## Recommendation

The whitelist was likely intended as a SaaS access control mechanism during early development but is currently inactive. If the intent is to allow anyone to sign up (typical for public SaaS), removing it would clean up dead code. If access control is still needed, consider:

- Domain-based filtering (e.g., `@company.com`)
- A proper admin/user role system
- A database-backed allowlist for flexibility
