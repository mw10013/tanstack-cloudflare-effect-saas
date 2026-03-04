<h1 align="center">
<code>TanStack Cloudflare Effect Saas</code>
</h1>

<div align="center">
  <p>
  Lightweight saas template packed with essential functionality for TanStack, Cloudflare, and Effect
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
- Cloudflare: D1 with read replication, KV, Cron, Rate Limiting, Web Analytics
- Effect: v4
- Better Auth: Magic Link, Admin, Organization, Stripe, D1 Database Adapter
- UI: Shadcn on Base UI
- Testing: Vitest, Playwright

## Template Functionality

- **Authentication & Organizations:**
  - Magic link authentication using Better Auth
  - Multi-tenant organization management with automatic organization creation
  - Role-based access control (user/admin/organization member roles)
  - Organization invitations and membership management

- **Payments & Subscriptions:**
  - Stripe integration with subscription processing
  - Monthly and annual pricing plans with configurable trial periods
  - Stripe Checkout and Customer Portal integration
  - Webhook handling for subscription lifecycle events
  - Subscription management (cancel, reactivate, billing portal access)

- **Database & Data Management:**
  - Cloudflare D1 (SQLite) database with read replication and schema migrations
  - Type-safe database operations with Zod schema validation
  - Session management with automatic cleanup of expired sessions
  - Database seeding utilities for development and testing

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
  - AWS SES for transactional email delivery
  - Demo mode support for development without external email services

- **Security & Performance:**
  - IP-based rate limiting for authentication endpoints using Cloudflare Rate Limiting
  - Server-side route protection and authorization
  - Secure session handling with database storage

## Quick Start

### Stripe

- Install the [Stripe CLI](https://stripe.com/docs/stripe-cli).
- Go to stripe and create a sandbox for testing named `tca-int`
  - Remember secret key for `STRIPE_SECRET_KEY` environment variable.

### Local Env

- Copy `.env.example` to `.env`.
- Edit the `BETTER_AUTH_SECRET` and `STRIPE_SECRET_KEY` keys.
- Set `STRIPE_WEBHOOK_SECRET` later after you run `pnpm stripe:listen` below.

```
pnpm i
pnpm d1:reset
stripe login --project-name=tca-int
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

- pnpm exec wrangler kv namespace create tca-kv-production
- Update wrangler.jsonc production kv_namespaces
- pnpm exec wrangler queues create r2-upload-notifications
- pnpm d1:reset:PRODUCTION
- pnpm deploy:PRODUCTION
- pnpm exec wrangler secret put SECRET --env production
  - BETTER_AUTH_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ANALYTICS_TOKEN
- Workers & Pages Settings: tces
  - Git repository: connect to git repo
  - Build configuration
    - Build command: CLOUDFLARE_ENV=production pnpm build
    - Deploy command: pnpm exec wrangler deploy --env production
- Storage & databases: tca-d1-production: Settings
  - Enable read replication

## Shadcn with Base UI

```bash
pnpm dlx shadcn@latest add --overwrite accordion alert-dialog alert aspect-ratio avatar badge breadcrumb button-group button calendar card carousel chart checkbox collapsible combobox command context-menu dialog drawer dropdown-menu empty field hover-card input-group input item label pagination popover progress radio-group scroll-area select separator sidebar sonner spinner switch tabs table textarea toggle tooltip

pnpm dlx shadcn@latest add https://ai-sdk.dev/elements/api/registry/all.json
```

## Llms

```
ln -s AGENTS.md CLAUDE.md
pnpm add -g @playwright/cli@latest

codex -m gpt-5.3-codex -c 'model_reasoning_effort="high"'
codex -m gpt-5.3-codex -c 'model_reasoning_effort="xhigh"'

npm install -g @openai/codex
```

- OpenAI model docs: GPT-5.2-Codex supports low, medium, high, xhigh

## Effect

```
https://effecttalk.dev/
https://www.effective.software/

https://discord.com/channels/795981131316985866/1474166367530909958

Effect.services + Effect.runPromiseWith
Or use a FiberSet
```

```Okay, imagine you have a toy box (your program), and you need helpers to do things for you — like a robot that fetches snacks or a teddy bear that tells you stories. In the old version (v3), there were four different ways to ask for a helper: Context.Tag, Context.GenericTag, Effect.Tag, and Effect.Service. That's confusing — like having four different doors into the same room.
So in v4, they knocked down all four doors and built one nice door: ServiceMap.Service. Now there's only one way to make a helper, and everyone uses the same door.
Here's what else changed, in kid terms:
No more magic shortcuts. Effect.Tag used to let you call a helper's abilities directly, like saying "Robot, get snacks!" without first going to find the robot. But this magic trick had a problem — it would sometimes forget important details about what the robot could do (generic types got erased). So they removed the magic. Now you either find the robot first (yield*), or use .use() which is like saying "hey robot, do this one thing for me."
No more auto-built instruction manuals. Effect.Service used to automatically create a "layer" (think: instructions for building your helper) and wire up everything it needed. Now you build that yourself with Layer.effect. It's a little more work, but you can see exactly what's happening — no hidden magic.
The toy box got renamed. The container that holds all your helpers changed from Context to ServiceMap — same idea, new name.
TL;DR: Too many ways to do the same thing → one way. Magic that lost information → removed. Hidden wiring → explicit wiring. Everything is simpler and more honest about what it does.
```
## Credit

Homepage / Pricing design by [dev-xo](https://github.com/dev-xo). See his [remix-saas](https://github.com/dev-xo/remix-saas) for a production-ready saas template for remix.

## License

Licensed under the [MIT License](https://github.com/mw10013/tanstack-cloudflare-effect-saas/blob/main/LICENSE).
