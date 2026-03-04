# Agents routing and auth

## Summary

`routeAgentRequest` is the Agents SDK helper that maps requests to agent instances based on the `/agents/:agent/:name` URL pattern. The `:agent` segment is the Agent class name converted to kebab-case, and `:name` is the agent instance identifier (for example, a user id).

From the docs:

- "The `routeAgentRequest` helper: this will automatically map requests to an individual Agent based on the `/agents/:agent/:name` URL pattern. The value of `:agent` will be the name of your Agent class converted to `kebab-case`, and the value of `:name` will be the name of the Agent instance you want to create or retrieve." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/calling-agents.mdx:21`)
- "Automatically routes HTTP requests and/or WebSocket connections to `/agents/:agent/:name`" (`refs/cloudflare-docs/src/content/docs/agents/api-reference/calling-agents.mdx:40`)

This means a single helper can handle both HTTP and WebSocket traffic for agents, and route them to a named agent instance.

## When to use `routeAgentRequest`

Use it when you want to expose agent instances directly to client apps (for example, React apps using `useAgent`). It provides a standardized route and integrates directly with the Agents client tooling.

The Agents starter uses it as the primary handler:

```ts
// refs/agents-starter/src/server.ts
return (
  (await routeAgentRequest(request, env)) ||
  new Response("Not found", { status: 404 })
);
```

## Security and auth hooks

The docs are explicit that you should authenticate **before** letting a request reach the agent. They recommend `onBeforeConnect` and `onBeforeRequest` hooks on `routeAgentRequest`:

- "Handle authentication in your Workers code, before you invoke your Agent."
- "Use the built-in hooks when using the `routeAgentRequest` helper - `onBeforeConnect` and `onBeforeRequest`" (`refs/cloudflare-docs/src/content/docs/agents/api-reference/calling-agents.mdx:183`)
- The example shows you can return a `Response` to block the request (403 or 401), which stops the Agent from being invoked (`refs/cloudflare-docs/src/content/docs/agents/api-reference/calling-agents.mdx:195`).

### What these hooks do

- `onBeforeConnect(request)` runs before a **WebSocket** connection is accepted.
- `onBeforeRequest(request)` runs before a **HTTP** request is forwarded to the agent.

If either hook returns a `Response`, the call is rejected and the Agent is never created or invoked.

### Agent name enforcement

With route-based addressing, a client can request `/agents/:agent/:name`. For per-user agents, you should enforce that `:name` matches the authenticated user id. This prevents one user from opening a connection to another user’s agent instance.

To enforce this, parse the request URL and compare the `:name` segment to `session.user.id`, returning a 403 when it does not match.

## Example implementation for this codebase

Below is a pattern that matches our app’s auth flow: reuse Better Auth’s session check, block unauthorized users, and ensure that the agent name maps to the authenticated user id.

```ts
import { routeAgentRequest } from "agents";

const extractAgentName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const d1SessionService = createD1SessionService({ d1: env.D1, request });
    const authService = createAuthService({
      db: d1SessionService.getSession(),
      stripeService: createStripeService(),
      kv: env.KV,
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      demoMode: env.DEMO_MODE === "true",
      transactionalEmail: env.TRANSACTIONAL_EMAIL,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    });

    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: async (req) => {
        const session = await authService.api.getSession({
          headers: req.headers,
        });
        if (!session) return new Response("Unauthorized", { status: 401 });
        const agentName = extractAgentName(req);
        if (agentName !== `user:${session.user.id}`) {
          return new Response("Forbidden", { status: 403 });
        }
      },
      onBeforeRequest: async (req) => {
        const session = await authService.api.getSession({
          headers: req.headers,
        });
        if (!session) return new Response("Unauthorized", { status: 401 });
        const agentName = extractAgentName(req);
        if (agentName !== `user:${session.user.id}`) {
          return new Response("Forbidden", { status: 403 });
        }
      },
    });

    if (routed) return routed;

    return serverEntry.fetch(request, {
      context: {
        env,
        authService,
        stripeService: createStripeService(),
        repository: createRepository({ db: d1SessionService.getSession() }),
        session:
          (await authService.api.getSession({ headers: request.headers })) ??
          undefined,
      },
    });
  },
} satisfies ExportedHandler<Env>;
```

Notes:

- This uses the same session check you already perform in server functions, but in the Worker entrypoint so direct client calls are authenticated.
- You can swap `user:${session.user.id}` with `org:${organizationId}` if you decide on per-org agents.

## HTTP and WebSocket behavior

`routeAgentRequest` supports both transport types:

- HTTP requests are routed to the agent’s `onRequest` handler.
- WebSocket connections are routed to `onConnect` and `onMessage` on the agent.

The docs explicitly call out that the helper routes "HTTP requests and/or WebSocket connections" (`refs/cloudflare-docs/src/content/docs/agents/api-reference/calling-agents.mdx:40`).

## Recommended approach

- Use `getAgentByName` for server-to-agent calls (like `ping`) where you don’t want to expose agents directly.
- Add `routeAgentRequest` when you are ready to connect clients directly, and always gate it with `onBeforeConnect` and `onBeforeRequest` for auth.
