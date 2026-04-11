<h1 align="center">
<code>TanStack Cloudflare Effect SaaS</code>
</h1>

<div align="center">
  <p>
  Lightweight invoice template packed with essential functionality for TanStack, Cloudflare, and Effect
  </p>
  <p>
  TanStack • Cloudflare • Effect • Better Auth • Stripe • Shadcn on Base UI
  </p>
  <p>
    <a href="https://tces.devxo.workers.dev/">Demo</a>
  </p>

</div>

## Stack

- TanStack: Start, Router, Query, Form
- Cloudflare: D1, DO, Agent, Workflow, Queue, KV, Cron, Rate Limiting, Web Analytics
- Effect: v4
- Better Auth: Magic Link, Admin, Organization, Stripe
- UI: Shadcn on Base UI
- Testing: Vitest, Cloudflare Vitest-Integration, Playwright

## Template Functionality

Invoices are a vehicle to exercise Cloudflare primitives, Effect v4, and fault-tolerant eventual consistency patterns under at-least-once delivery, partial failures, and crashes.

- **Cloudflare Services:**
  - D1 (SQLite) for Better Auth + app data with idempotent-write retry
  - Durable Object Agents (`OrganizationAgent`) per organization with DO-local SQLite, `@callable` RPC, and WebSocket broadcast
  - Workflows: `UserProvisioningWorkflow` (Better Auth org/member reconciliation) and `InvoiceExtractionWorkflow` (AgentWorkflow: R2 load → LLM extract → DO save)
  - Queues for R2 event notifications and durable finalization safety nets
  - R2 object storage with event notifications and retry on retryable codes (10001/10043/10054/10058)
  - KV with exponential backoff + jitter
  - Cron Trigger for expired-session cleanup
  - Rate Limiting binding (IP-based) on magic-link endpoints
  - Web Analytics

- **Fault-Tolerant Eventual Consistency:**
  - Idempotency-key dedupe in `onInvoiceUpload` — three guards (stale `r2ActionTime`, active workflow instance, terminal status) tolerate at-least-once R2 events
  - Schedule-first invoice delete — `this.schedule(0, ...)` persists the R2 cleanup intent before the local row delete, so a crash converges on the next alarm tick (1s→30s, 3 retries)
  - Dual-path membership sync — `enqueue(FinalizeMembershipSync)` before the Better Auth mutation (durable safety net) + `stub.syncMembership()` after (best-effort eager); both re-read D1 as authoritative
  - `UserProvisioningWorkflow` reconciles all three states of Better Auth's non-transactional org creation (org + owner member are separate writes)
  - Workflow instance dedupe by idempotency key prevents double-extraction

- **Authentication & Organizations:**
  - Magic link authentication using Better Auth
  - Multi-tenant organization management with automatic organization creation via workflow
  - Role-based access control (user/admin/organization member roles)
  - Organization invitations and membership management
  - Agent WebSocket auth gated pre-upgrade (`onBeforeConnect`) with per-RPC membership re-check

- **Payments & Subscriptions:**
  - Stripe integration with subscription processing
  - Monthly and annual pricing plans with configurable trial periods
  - Stripe Checkout and Customer Portal integration
  - Webhook handling for subscription lifecycle events
  - Subscription management (cancel, reactivate, billing portal access)

- **Effect v4 Architecture:**
  - Services via `ServiceMap.Service` with explicit `Layer.effect` definitions
  - Traced functions with `Effect.fn` for observability
  - Type-safe error handling using `Schema.TaggedErrorClass`
  - Layer composition via `Layer.merge` for dependency injection
  - Service dependencies resolved via `yield*` for compile-time safety
  - Per-request `runEffect` built in `worker.fetch` and injected into TanStack Start's `ServerContext`; server functions pull it from `context: { runEffect }` and execute Effect pipelines without importing `@tanstack/react-start/server` (which would drag Node builtins into the client build graph)
  - Separate runtime layer per execution surface — Worker `fetch`, `scheduled` (Cron), `queue`, `OrganizationAgent` DO (DO-local SQLite via `@effect/sql-sqlite-do`), and each Workflow — so each entrypoint only materializes the services it needs
  - `runEffect` uses `runPromiseExit` + `Cause.pretty` to normalize failures into `Error` instances with non-empty `.message`, preserving server context across TanStack's `ShallowErrorPlugin` SSR dehydration, and re-throws TanStack `redirect`/`notFound` defects so router control flow works from inside Effect pipelines

- **Admin Panel:**
  - Admin interface for user management
  - Session monitoring and administration
  - Customer and subscription oversight

- **UI/UX Components:**
  - Shadcn with Base UI and TanStack Form integration
  - Theme switching (light/dark/system) with persistence

- **Testing Infrastructure:**
  - Unit and integration tests using Vitest
  - End-to-end testing with Playwright

- **Email Integration:**
  - Cloudflare transactional emails (coming)
  - Demo mode support for development without external email services

- **Security & Performance:**
  - IP-based rate limiting for authentication endpoints
  - Server-side route protection and authorization
  - Secure session handling with database storage

## Quick Start

### Stripe

- Install the [Stripe CLI](https://stripe.com/docs/stripe-cli).
- Go to stripe and create a sandbox for testing named `tces-int`
  - Remember secret key for `STRIPE_SECRET_KEY` environment variable.

### Local Env

- Copy `.env.example` to `.env`.
- Edit the `BETTER_AUTH_SECRET` and `STRIPE_SECRET_KEY` keys.
- Set `STRIPE_WEBHOOK_SECRET` later after you run `pnpm stripe:listen` below.

```
pnpm i
pnpm d1:reset
stripe login --project-name=tces-int
pnpm stripe:listen
# copy webhook signing secret to STRIPE_WEBHOOK_SECRET in .env
pnpm dev

# cron
curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=0%200%20*%20*%20*"
```

## Testing

### Stripe Test Card Details

- Card Number: `4242 4242 4242 4242`
- Expiration: Any future date
- CVC: Any 3-digit number

### Unit and Integration Tests

```
pnpm test
```

### E2E Tests

```
pnpm dev
pnpm stripe:listen
pnpm test:e2e
```

## Deploy

- Create stripe webhook
  - Endpoint URL: `https://[DOMAIN]/api/auth/stripe/webhook`
  - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`

- Cloudflare Web Analytics | Add a site
  - Remember token from script for ANALYTICS_TOKEN secret below.

- pnpm exec wrangler kv namespace create tces-kv-production
- Update wrangler.jsonc production kv_namespaces
- pnpm d1:reset:PRODUCTION
- pnpm deploy:PRODUCTION
- pnpm exec wrangler r2 bucket notification create tces-r2-production --event-type object-create --queue tces-q-production
- pnpm exec wrangler secret put SECRET --env production
  - BETTER_AUTH_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ANALYTICS_TOKEN, CF_ACCOUNT_ID, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY
- Workers & Pages Settings: tces
  - Git repository: connect to git repo
  - Build configuration
    - Build command: CLOUDFLARE_ENV=production pnpm build
    - Deploy command: pnpm exec wrangler deploy --env production
- Storage & databases: tces-d1-production: Settings
  - Enable read replication

## Shadcn with Base UI

```bash
pnpm dlx shadcn@latest add --overwrite accordion alert-dialog alert aspect-ratio avatar badge breadcrumb button-group button calendar card carousel chart checkbox collapsible combobox command context-menu dialog drawer dropdown-menu empty field hover-card input-group input item label pagination popover progress radio-group scroll-area select separator sidebar sonner spinner switch tabs table textarea toggle tooltip

pnpm dlx shadcn@latest add https://ai-sdk.dev/elements/api/registry/all.json
```

## Llms

```
pnpm add -g @playwright/cli@latest

```

## Credit

Homepage / Pricing design by [dev-xo](https://github.com/dev-xo). See his [remix-saas](https://github.com/dev-xo/remix-saas) for a production-ready saas template for remix.

## License

Licensed under the [MIT License](https://github.com/mw10013/tanstack-cloudflare-effect-saas/blob/main/LICENSE).
