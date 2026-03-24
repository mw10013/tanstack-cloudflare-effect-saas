# Agent Connection Identity Research

## Question

For a Cloudflare Agent / Durable Object behind `useAgent()`, the Worker already authenticates the WebSocket handshake. But how does the agent know **which user** is on that socket, so it can do authorization?

## Short Answer

The concrete pattern should be:

1. Worker authenticates the WebSocket in `onBeforeConnect`
2. Worker passes vetted identity data forward on the WebSocket request
3. Agent reads that data in `onConnect(connection, ctx)` from `ctx.request`
4. Agent stores it in `connection.state`
5. `@callable()` methods read `getCurrentAgent().connection.state`
6. Privileged methods check permissions from that connection identity

The important conclusion: **do not use `props` for per-user auth identity**.

## Why `props` Is The Wrong Tool

The refs are pretty explicit.

From `refs/agents/docs/routing.md:254`:

```ts
class MyAgent extends Agent<Env, State> {
  private userId?: string;

  async onStart(props?: { userId: string; config: { maxRetries: number } }) {
    this.userId = props?.userId;
  }
}
```

And from `refs/agents/docs/http-websockets.md:326`:

```ts
`onStart()` is called once when the agent first starts, before any connections are established
```

Also from `refs/cloudflare-docs/src/content/docs/agents/api-reference/agents-api.mdx:58`:

```ts
| `onStart(props?)` | When the instance starts, or wakes from hibernation |
| `onConnect(connection, ctx)` | When a WebSocket connection is established |
```

So `props` are:

- instance-scoped
- delivered to `onStart`
- not connection-scoped

That is the core problem.

Your organization agent instance is keyed by org name. That means:

- one org agent instance
- potentially many user connections to that same instance

So if you passed this through `props`:

```ts
props: {
  userId: session.user.id;
}
```

you would be attaching one user identity to the whole org instance, not to an individual socket.

That is wrong for multi-user org connections.

## Evidence: `props` Are Shared Per Matched Agent

From `refs/agents/docs/routing.md:261`:

```ts
When using `props` with `routeAgentRequest`, the same props are passed to whichever agent matches the URL.
```

And the example right below it is:

```ts
export default {
  async fetch(request, env) {
    const session = await getSession(request);
    return routeAgentRequest(request, env, {
      props: { userId: session.userId, role: session.role },
    });
  },
};
```

This is useful for universal initialization context.

But for this app, it is a trap if interpreted as per-connection auth identity.

Why?

- org agent instance `organization-agent/acme`
- user A connects
- user B connects
- both hit the same agent instance
- `props` are instance init data, not socket identity data

So `props.userId` cannot be the source of truth for who is calling a later `@callable()` method.

## What The Agent Actually Gets Per Connection

From `refs/agents/docs/http-websockets.md:145`:

```ts
onConnect(connection: Connection, ctx: ConnectionContext) {
  // ctx.request contains the original HTTP request (for auth, headers, etc.)
  const url = new URL(ctx.request.url);
}
```

This is the hook that matters for per-socket identity.

The docs also define per-connection state.

From `refs/agents/docs/http-websockets.md:186`:

```ts
interface Connection<TState = unknown> {
  id: string;
  state: TState | null;
  setState(state: TState | ((prev: TState | null) => TState)): void;
}
```

And from `refs/agents/docs/http-websockets.md:283`:

```ts
Store data specific to each connection using `connection.state` and `connection.setState()`
```

With example:

```ts
type ConnectionState = {
  username: string;
  joinedAt: number;
  messageCount: number;
};

export class ChatAgent extends Agent {
  onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);

    connection.setState({
      username: url.searchParams.get("username") || "Anonymous",
      joinedAt: Date.now(),
      messageCount: 0,
    });
  }
}
```

This is the right pattern shape for authenticated identity too.

## What `@callable()` Methods Can See

From `refs/cloudflare-docs/src/content/docs/agents/api-reference/get-current-agent.mdx:232`:

```ts
| Custom method (via RPC) | `agent` Yes | `connection` Yes | `request` No |
```

And from `refs/agents/docs/get-current-agent.md:151`:

```ts
async customMethod() {
  const { agent, connection, request } = getCurrentAgent<MyAgent>();
}
```

The docs show `connection` is available in custom methods, but `request` is not always available there.

So the flow has to be:

- extract identity at `onConnect` time from `ctx.request`
- persist it into `connection.state`
- use `connection.state` later in callables

## Why The Worker Must Pass Identity Forward

Your key concern is right:

- Worker authenticates via Better Auth session/cookie
- agent later needs `userId`, maybe `sessionId`, maybe org/role info
- the agent should not depend on re-running the whole app auth stack in a callable

The refs give us the missing bridge.

From `refs/agents/docs/routing.md:283`:

```ts
const response = await routeAgentRequest(request, env, {
  onBeforeConnect: (req, lobby) => {
    // Called before WebSocket connections
    // Return a Response to reject, Request to modify, or void to continue
  },
});
```

The important part is: **`onBeforeConnect` can return a modified `Request`.**

That gives the Worker a concrete place to:

- verify Better Auth session
- derive trusted claims like `userId`, `sessionId`, `organizationId`, `role`
- attach those claims to the WebSocket request that the agent receives in `ctx.request`

## Concrete Pattern For This Repo

## Worker side

In `src/worker.ts`, after session validation, the Worker can rewrite the request before routing to the agent.

Conceptually:

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: async (req) => {
    const session = await runEffect(/* Better Auth session lookup */);
    if (Option.isNone(session)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const activeOrganizationId = session.value.session.activeOrganizationId;
    if (!activeOrganizationId) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    url.searchParams.set("cfUserId", session.value.user.id);
    url.searchParams.set("cfSessionId", session.value.session.id);
    url.searchParams.set("cfOrganizationId", activeOrganizationId);

    return new Request(url, req);
  },
});
```

That is not copied from docs verbatim, but it is directly enabled by the docs line saying `onBeforeConnect` may return a modified `Request`: `refs/agents/docs/routing.md:285`.

### Why query params?

Because the docs examples consistently read connection bootstrap data from `ctx.request.url` in `onConnect`.

Examples:

- `refs/agents/docs/http-websockets.md:147`
- `refs/agents/docs/http-websockets.md:294`

Could this instead be headers? Probably yes in transport terms, since `ctx.request` is a full request. But the refs examples are URL/query-param oriented, so that is the most documented path.

If you do use query params here, do **not** put raw sensitive bearer tokens there. But vetted internal identity claims added by the Worker on an already-authenticated same-origin request are a different category than user-supplied auth tokens.

Isn't this modified request internal? It never leaves cloudflare's network?

## Agent side

Then in `src/organization-agent.ts`:

```ts
interface OrgConnectionState {
  userId: string;
  sessionId: string;
  organizationId: string;
}

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  onConnect(
    connection: Connection<OrgConnectionState>,
    ctx: ConnectionContext,
  ) {
    const url = new URL(ctx.request.url);
    const userId = url.searchParams.get("cfUserId");
    const sessionId = url.searchParams.get("cfSessionId");
    const organizationId = url.searchParams.get("cfOrganizationId");

    if (!userId || !sessionId || !organizationId) {
      connection.close(4001, "Unauthorized");
      return;
    }

    connection.setState({ userId, sessionId, organizationId });
  }
}
```

This is directly aligned with the refs pattern of reading `ctx.request` during `onConnect` and storing per-connection data in `connection.state`.

## Callable side

Then privileged methods use the current connection state.

```ts
import { getCurrentAgent } from "agents";

@callable()
softDeleteInvoice(invoiceId: string) {
  const { connection } = getCurrentAgent<OrganizationAgent>();
  const auth = connection?.state;
  if (!auth) throw new Error("Unauthorized");

  // auth.userId
  // auth.organizationId
  // auth.sessionId
  // perform permission check, then delete
}
```

That is the critical bridge from Worker auth -> agent auth context.

## What Should Be Stored In `connection.state`

Minimum useful set:

- `userId`
- `sessionId`
- `organizationId`

Maybe also:

- `role`
- `permissionsVersion`
- `connectedAt`

I would avoid storing large or secret-heavy payloads there. Keep it to identity + authorization lookup keys.

## What Should Not Be Trusted

Even with `connection.state`, the agent should not blindly trust stale permission snapshots for destructive actions.

Safer split:

- trust `connection.state.userId` as authenticated caller identity
- for destructive actions, check current org membership/role using that identity

So `connection.state` answers:

- who is this socket?

And a permission helper answers:

- may this user do this action right now?

## Recommendation

For this repo, the concrete design should be:

1. keep Better Auth session lookup in the Worker
2. in `onBeforeConnect`, derive vetted identity claims
3. return a modified `Request` carrying those claims to the agent
4. in `OrganizationAgent.onConnect`, move claims into `connection.state`
5. in every privileged `@callable()`, read `getCurrentAgent().connection.state`
6. do method-level authorization checks there

## Bottom Line

The missing piece is not `props`.

The missing piece is:

- Worker-authenticated identity
- forwarded on the WebSocket request
- stored per connection in `connection.state`

That is the concrete Cloudflare Agents pattern that fits this app.
