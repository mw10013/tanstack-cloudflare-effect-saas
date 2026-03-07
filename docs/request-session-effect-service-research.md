# Research: Moving `request` and `session` from TanStack Context into Effect Services

## Current State

`worker.ts` stuffs `request` and `session` into TanStack Start's `ServerContext`:

```ts
// worker.ts L165-172
const response = await serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
    request,          // ← raw Request
    session: session ?? undefined,  // ← pre-fetched session
  },
});
```

Server functions destructure both from `context` alongside `runEffect`, then pass them _into_ `runEffect(Effect.gen(...))` via closure capture.

---

## Usage Analysis

### `session` from context (used _outside_ runEffect but passed _in_)

Every usage reads `session` from context and immediately passes it into `runEffect`. No route uses `session` outside of `runEffect`.

| File | Handler | How `session` is used inside runEffect |
|---|---|---|
| `_mkt.tsx:12` | beforeLoad | `session?.user` — check logged-in state |
| `app.tsx:6` | beforeLoad | `session?.user` — role guard, redirect |
| `admin.tsx:38` | beforeLoad | `session.user.role` — admin guard |
| `magic-link.tsx:6` | beforeLoad | `session?.user.role` — post-login redirect |
| `app.index.tsx:6` | beforeLoad | `session` — redirect to active org |
| `app.$organizationId.tsx:57` | beforeLoad | `session.session.activeOrganizationId` — validate org |
| `app.$organizationId.index.tsx:45` | loader | `session.session.activeOrganizationId`, `session.user.email` |
| `_mkt.pricing.tsx:47` | mutation | `session` — auth guard + `session.session.activeOrganizationId` |

### `request` from context (used _outside_ runEffect but passed _in_)

All usages pass `request.headers` to `auth.api.*` calls inside `runEffect`. Two also use `request.url` for origin construction.

| File | Handler | How `request` is used inside runEffect |
|---|---|---|
| `login.tsx:50` | login POST | `request.headers` → `auth.api.signInMagicLink` |
| `app.$organizationId.tsx:41` | switchOrg | `request.headers` → `auth.api.setActiveOrganization` |
| `app.$organizationId.tsx:57` | beforeLoad | `request.headers` → `auth.api.listOrganizations` |
| `app.$organizationId.index.tsx:66` | acceptInvitation | `request.headers` → `auth.api.acceptInvitation`, `setActiveOrganization` |
| `app.$organizationId.index.tsx:91` | rejectInvitation | `request.headers` → `auth.api.rejectInvitation` |
| `app.$organizationId.members.tsx:51` | loader | `request.headers` → `auth.api.getSession`, `hasPermission`, `listMembers` |
| `app.$organizationId.members.tsx:95` | removeMember | `request.headers` → `auth.api.removeMember` |
| `app.$organizationId.members.tsx:114` | leaveOrg | `request.headers` → `auth.api.leaveOrganization` |
| `app.$organizationId.members.tsx:133` | updateRole | `request.headers` → `auth.api.updateMemberRole` |
| `app.$organizationId.billing.tsx:38` | loader | `request.headers` → `auth.api.listActiveSubscriptions` |
| `app.$organizationId.billing.tsx:261` | manageBilling | `request.headers` + `request.url` → `auth.api.createBillingPortal` |
| `app.$organizationId.billing.tsx:284` | cancelSub | `request.headers` + `request.url` → `auth.api.cancelSubscription` |
| `app.$organizationId.billing.tsx:308` | restoreSub | `request.headers` → `auth.api.restoreSubscription` |
| `app.$organizationId.invitations.tsx:62` | loader | `request.headers` → `auth.api.hasPermission`, `listInvitations` |
| `app.$organizationId.invitations.tsx:156` | inviteMembers | `request.headers` → `auth.api.inviteMember` |
| `app.$organizationId.invitations.tsx:324` | cancelInvitation | `request.headers` → `auth.api.cancelInvitation` |
| `admin.users.tsx:118` | unbanUser | `request.headers` → `auth.api.unbanUser` |
| `admin.users.tsx:135` | impersonateUser | `request.headers` → `auth.api.impersonateUser` |
| `admin.users.tsx:367` | banUser | `request.headers` → `auth.api.banUser` |
| `Auth.ts:362` | signOut | `request.headers` → `auth.api.signOut` |
| `api/auth/$.tsx:22,29` | GET/POST handlers | full `request` → `auth.handler(request)` |

### Key Observation

Neither `request` nor `session` is ever used _outside_ of `runEffect`. They are always destructured from TanStack context, then captured by the closure passed to `runEffect`. This means they could be provided as Effect services instead, eliminating them from `ServerContext` entirely.

---

## Effect v4 Idiomatic Patterns for Request-Scoped Services

### Pattern 1: `ServiceMap.Service` + `Layer.succeedServices` (simplest, already used)

This is how `CloudflareEnv` is already provided. Define a service tag, add it to the `ServiceMap` at request time.

```ts
// Define
const CurrentRequest = ServiceMap.Service<Request>("CurrentRequest");

// Provide (in makeRunEffect or worker.ts fetch)
const envLayer = Layer.succeedServices(
  ServiceMap.make(CloudflareEnv, env)
    .pipe(ServiceMap.add(CurrentRequest, request))
);
```

**Precedent in effect4:** `HttpServerRequest` is defined exactly this way:
```ts
// refs/effect4/packages/effect/src/unstable/http/HttpServerRequest.ts L74
export const HttpServerRequest: ServiceMap.Service<HttpServerRequest, HttpServerRequest> =
  ServiceMap.Service("effect/http/HttpServerRequest")
```

And injected per-request in `NodeHttpServer.makeHandler`:
```ts
// refs/effect4/packages/platform-node/src/NodeHttpServer.ts L161-162
const map = new Map(services.mapUnsafe)
map.set(HttpServerRequest.key, new ServerRequestImpl(nodeRequest, nodeResponse))
const fiber = Fiber.runIn(Effect.runForkWith(ServiceMap.makeUnsafe<any>(map))(handled), options.scope)
```

### Pattern 2: `ServiceMap.add` into existing `ServiceMap` in `makeRunEffect`

Currently `makeRunEffect` captures `env` but not `request`/`session`. It could accept them and inject into the layer:

```ts
const makeRunEffect = (env: Env, request: Request, session: Session | undefined) => {
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env)
      .pipe(
        ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        ServiceMap.add(CurrentRequest, request),
        ServiceMap.add(CurrentSession, session),
      ),
  );
  // ... rest unchanged, but appLayer type now includes CurrentRequest | CurrentSession
};
```

### Pattern 3: `Effect.provideService` at the call site

Rather than baking into the layer, provide at each `runEffect` call:

```ts
runEffect(
  myEffect.pipe(
    Effect.provideService(CurrentRequest, request),
    Effect.provideService(CurrentSession, session),
  )
)
```

Less clean — still requires destructuring from TanStack context in every handler.

### Pattern 4: `ServiceMap.Reference` with default value (for session)

`session` is nullable — a `Reference` provides a built-in default:

```ts
const CurrentSession = ServiceMap.Reference<Session | undefined>("CurrentSession", {
  defaultValue: () => undefined,
});
```

This avoids runtime errors if the service isn't provided; effects can `yield*` it and get `undefined`.

---

## Recommended Approach

**Pattern 2** — inject `request` and `session` into the service map in `makeRunEffect`, keeping them out of TanStack context.

### Service Definitions (new file `src/lib/RequestContext.ts`)

```ts
import type { AuthInstance } from "@/lib/Auth";
import { ServiceMap } from "effect";

export const CurrentRequest = ServiceMap.Service<Request>("CurrentRequest");

export const CurrentSession =
  ServiceMap.Service<AuthInstance["$Infer"]["Session"] | undefined>("CurrentSession");
```

### Changes to `worker.ts`

1. `makeRunEffect` accepts `request` and `session` params.
2. Adds `CurrentRequest` and `CurrentSession` to the `envLayer` via `ServiceMap.add`.
3. `appLayer` type now includes both services.
4. Remove `request` and `session` from `ServerContext`.

```ts
const makeRunEffect = (
  env: Env,
  request: Request,
  session: AuthInstance["$Infer"]["Session"] | undefined,
) => {
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env)
      .pipe(
        ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        ServiceMap.add(CurrentRequest, request),
        ServiceMap.add(CurrentSession, session),
      ),
  );
  // ... layer composition unchanged ...
};
```

```ts
export interface ServerContext {
  env: Env;
  runEffect: ReturnType<typeof makeRunEffect>;
  // request and session removed
}
```

### Changes to Route Handlers

Before:
```ts
.handler(({ data, context: { runEffect, request } }) =>
  runEffect(
    Effect.gen(function* () {
      const auth = yield* Auth;
      yield* Effect.tryPromise(() =>
        auth.api.unbanUser({
          headers: request.headers,
          body: { userId: data.userId },
        }),
      );
    }),
  ),
);
```

After:
```ts
.handler(({ data, context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const request = yield* CurrentRequest;
      const auth = yield* Auth;
      yield* Effect.tryPromise(() =>
        auth.api.unbanUser({
          headers: request.headers,
          body: { userId: data.userId },
        }),
      );
    }),
  ),
);
```

### Problem: `makeRunEffect` is called once per request, but `session` is fetched _after_ via `runEffect`

Currently in `worker.ts`:
```ts
const runEffect = makeRunEffect(env);  // ← runEffect created first
const session = await runEffect(       // ← session fetched using it
  Effect.gen(function* () { ... }),
);
```

If `makeRunEffect` requires `session`, we have a chicken-and-egg problem.

**Solutions:**

#### Option A: Two-phase approach
Create `runEffect` without session, fetch session, create a second `runEffect` with session.

```ts
const baseRunEffect = makeRunEffect(env, request, undefined);
const session = await baseRunEffect(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* auth.getSession(request.headers);
  }),
);
const runEffect = makeRunEffect(env, request, session ?? undefined);
```

Downside: builds the layer twice.

#### Option B: Keep session fetch in worker, pass into `makeRunEffect`
Restructure so `makeRunEffect` takes a pre-fetched session. The initial session fetch uses a simpler runner.

```ts
// Lightweight runner just for session fetch
const sessionRunner = makeBaseRunner(env);
const session = await sessionRunner(...);
const runEffect = makeRunEffect(env, request, session);
```

#### Option C: Provide `request` in `makeRunEffect`, provide `session` via `Effect.provideService` inline
`CurrentRequest` goes into the layer. `CurrentSession` is provided at the `runEffect` call site in the worker `fetch`, after session is known:

```ts
const runEffect = makeRunEffect(env, request);
const session = await runEffect(
  Effect.gen(function* () { ... }),
);
const response = await serverEntry.fetch(request, {
  context: {
    env,
    runEffect: (effect) => runEffect(
      Effect.provideService(effect, CurrentSession, session ?? undefined),
    ),
  },
});
```

This is the cleanest — `request` goes into the layer (used by many handlers), `session` is wrapped once in the worker fetch handler.

#### Option D: Fetch session lazily inside the Effect layer
Make `CurrentSession` a service whose layer calls `Auth.getSession`. The session fetch happens when the service is first accessed.

```ts
const sessionLayer = Layer.effect(
  CurrentSession,
  Effect.gen(function* () {
    const request = yield* CurrentRequest;
    const auth = yield* Auth;
    return yield* auth.getSession(request.headers);
  }),
);
```

Downside: session would be fetched on every `runEffect` call that touches it, not once per request. Though Effect's `Layer.memoize` could help, the layer is rebuilt per request anyway.

---

## Impact on `api/auth/$.tsx`

The auth catch-all route uses the full `request` object (not just headers):
```ts
const auth = yield* Auth;
return yield* auth.handler(request);
```

With `CurrentRequest` as a service, this becomes:
```ts
const request = yield* CurrentRequest;
const auth = yield* Auth;
return yield* auth.handler(request);
```

---

## Summary

| Aspect | Current | Proposed |
|---|---|---|
| `request` location | TanStack `ServerContext` | Effect service `CurrentRequest` |
| `session` location | TanStack `ServerContext` | Effect service `CurrentSession` |
| Handler access | closure capture from context destructure | `yield* CurrentRequest` / `yield* CurrentSession` |
| `ServerContext` shape | `{ env, runEffect, request, session }` | `{ env, runEffect }` |
| Idiom alignment | mixed (Effect services + TanStack context) | all request-scoped data in Effect services |
| Recommended wiring | Option C: `request` in layer, `session` wrapped via `Effect.provideService` after fetch |


---

## Annotation Responses

### Naming: `Request` / `Session` instead of `CurrentRequest` / `CurrentSession`

Yes. No naming conflicts exist in `src/`. The global `Request` type is always available as a type but never imported as a value. `Session` isn't imported anywhere either. Service definitions:

```ts
export const Request = ServiceMap.Service<globalThis.Request>("Request");
export const Session = ServiceMap.Service<AuthInstance["$Infer"]["Session"] | undefined>("Session");
```

### Lazy `Session` service

Yes — `Session` can be a lazily-constructed Effect service via `Layer.effect`. At layer construction time, no actual session is needed. The session is fetched on first `yield* Session` access:

```ts
const sessionLayer = Layer.effect(
  Session,
  Effect.gen(function* () {
    const request = yield* Request;
    const auth = yield* Auth;
    return (yield* auth.getSession(request.headers)) ?? undefined;
  }),
);
```

This eliminates the chicken-and-egg problem entirely. No two-phase runner, no wrapping `runEffect`. The layer is built once per request and `Layer.effect` memoizes within a single `Effect.provide` call — meaning if multiple services or generators `yield* Session`, the `getSession` call happens only once per `runEffect` invocation.

**Key concern addressed:** The current worker fetch handler fetches the session _before_ `serverEntry.fetch` to also pass it into `ServerContext`. With a lazy service, the session is fetched inside the first `runEffect` call that needs it. If nothing needs the session (e.g., the `/api/auth/$` handler), no fetch occurs.

**Worker-level session fetch for `d1SessionService`:** The worker currently uses the session result to _not_ need it anymore — it only uses `session` for `ServerContext`. The `d1SessionService.setSessionBookmarkCookie(response)` call doesn't depend on the session object. So the worker-level pre-fetch can be removed entirely.

### `beforeLoad` and server execution

All `beforeLoad` guards that check `session` are wrapped in `createServerFn`, so they always execute on the server where the `Session` Effect service is available. This is safe:

| Route | Pattern |
|---|---|
| `app.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |
| `admin.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |
| `_mkt.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |
| `magic-link.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |
| `app.index.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |
| `app.$organizationId.tsx` | `createServerFn().handler(...)` → `runEffect(... yield* Session ...)` |

No route accesses `session` on the client side. The `Session` service would never appear in the R channel of any client-executed effect.

---

## Revised Recommendation

Use **lazy `Session` service** via `Layer.effect` + **`Request` service** via `ServiceMap.add`.

### Service Definitions (`src/lib/RequestContext.ts`)

```ts
import type { AuthInstance } from "@/lib/Auth";
import { ServiceMap } from "effect";

export const Request = ServiceMap.Service<globalThis.Request>("Request");
export const Session =
  ServiceMap.Service<AuthInstance["$Infer"]["Session"] | undefined>("Session");
```

### Worker Changes

```ts
const makeRunEffect = (env: Env, request: Request) => {
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ServiceMap.add(Request, request),
    ),
  );
  // ... existing layer composition ...
  const sessionLayer = Layer.effect(
    Session,
    Effect.gen(function* () {
      const req = yield* Request;
      const auth = yield* Auth;
      return (yield* auth.getSession(req.headers)) ?? undefined;
    }),
  );
  const appLayer = Layer.provideMerge(Auth.layer, stripeLayer);
  const appWithSessionLayer = Layer.merge(appLayer, sessionLayer);
  // ... loggerLayer, runtimeLayer as before ...
};
```

```ts
export interface ServerContext {
  env: Env;
  runEffect: ReturnType<typeof makeRunEffect>;
}
```

Worker fetch handler simplifies — no pre-fetch:
```ts
async fetch(request, env, _ctx) {
  // ... rate limiting, d1SessionService ...
  const runEffect = makeRunEffect(env, request);
  const response = await serverEntry.fetch(request, {
    context: { env, runEffect },
  });
  d1SessionService.setSessionBookmarkCookie(response);
  return response;
},
```

### Revised Summary

| Aspect | Current | Proposed |
|---|---|---|
| `request` location | TanStack `ServerContext` | Effect service `Request` |
| `session` location | TanStack `ServerContext` (pre-fetched) | Effect service `Session` (lazy, fetched on first access) |
| Handler access | closure capture from context destructure | `yield* Request` / `yield* Session` |
| `ServerContext` shape | `{ env, runEffect, request, session }` | `{ env, runEffect }` |
| Worker pre-fetch | `getSession` called before `serverEntry.fetch` | removed — lazy in Effect layer |
| Idiom alignment | mixed (Effect services + TanStack context) | all request-scoped data in Effect services |