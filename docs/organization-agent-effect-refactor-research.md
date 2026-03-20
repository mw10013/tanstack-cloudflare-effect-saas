# Organization Agent Effect v4 Refactor Research

## Current State

`src/organization-agent.ts` is imperative: raw `this.sql` template literals, manual `Schema.decodeUnknownSync` calls, direct `this.broadcast`/`this.runWorkflow` calls. No Effect pipelines, no services, no layers.

The Agent class itself must stay — Agents SDK requires `extends Agent<Env, State>`. The refactor targets the *internals*.

## Boundary Pattern: How This Codebase Bridges Effect

Two existing patterns for running Effect at imperative boundaries:

### Pattern A: `makeHttpRunEffect` (worker.ts)

Builds layers from env/request, returns `async (effect) => Promise<A>`. Used per-request in fetch handler. Layers include D1, KV, R2, Auth, etc.

```ts
const runEffect = makeHttpRunEffect(env, request);
// later:
const result = await runEffect(someEffect);
```

### Pattern B: `Effect.runPromiseWith` (Auth.ts, invoice-extraction-workflow.ts)

Extracts services inside an Effect.gen, then creates a `runEffect` that can be called from non-Effect callbacks (better-auth hooks, workflow step callbacks):

```ts
// Auth.ts
const services = yield* Effect.services<KV | Stripe | Repository>();
const runEffect = Effect.runPromiseWith(services);
// later in a callback:
runEffect(Effect.gen(function* () { ... }));
```

## Proposed Approach

### Service: Wrap Agent Capabilities

The agent has four capabilities that business logic needs:
1. **SQL** — `this.sql` template tag
2. **Broadcast** — `this.broadcast(message)`
3. **Workflow** — `this.runWorkflow(...)`, `this.getWorkflow(...)`

Wrap these as a single service since they're tightly coupled to the agent instance:

```ts
// Represents the Durable Object agent instance capabilities
export class AgentContext extends ServiceMap.Service<AgentContext>()("AgentContext", {
  make: Effect.die("AgentContext must be provided by the agent instance"),
}) {
  // Alternative: define as a simple tag since it's always provided externally
}
```

Actually — since these capabilities come from the agent instance (not constructed from other services), the simpler pattern is `ServiceMap.Service<Interface>`:

```ts
export interface AgentContextShape {
  readonly sql: OrganizationAgent["sql"];
  readonly broadcast: OrganizationAgent["broadcast"];
  readonly runWorkflow: OrganizationAgent["runWorkflow"];
  readonly getWorkflow: OrganizationAgent["getWorkflow"];
}

export const AgentContext = ServiceMap.Service<AgentContextShape>("AgentContext");
```

Or even simpler — just pass `this` (the agent instance) as a service since all capabilities hang off it. But that's a big interface and couples everything to the Agent class. Explicit shape is better.

### Layer Construction

The agent needs CloudflareEnv for queue handlers (already in worker.ts). Inside the agent, the only external service dependency is CloudflareEnv (for `this.env`). But the agent's own methods mostly use `this.sql` and `this.broadcast` directly — no D1/KV/R2 services needed.

So the agent's internal runtime layer is minimal:

```ts
// In OrganizationAgent constructor or lazy init
const agentContextLayer = Layer.succeedServices(
  ServiceMap.make(AgentContext, {
    sql: this.sql.bind(this),
    broadcast: this.broadcast.bind(this),
    runWorkflow: this.runWorkflow.bind(this),
    getWorkflow: this.getWorkflow.bind(this),
  })
);
```

### Business Logic as Effect.fn Functions

Each operation becomes a named Effect function:

```ts
const onInvoiceUpload = Effect.fn("OrganizationAgent.onInvoiceUpload")(
  function* (upload: InvoiceUploadInput) {
    const { sql, broadcast, runWorkflow, getWorkflow } = yield* AgentContext;
    const r2ActionTime = Date.parse(upload.r2ActionTime);
    if (!Number.isFinite(r2ActionTime)) {
      return yield* Effect.die(new TypeError(`Invalid r2ActionTime: ${upload.r2ActionTime}`));
    }
    const existing = decodeInvoiceRow(
      sql`select * from Invoice where id = ${upload.invoiceId}`[0] ?? null
    );
    if (existing && r2ActionTime < existing.r2ActionTime) return;
    // ...
  }
);
```

### Callable Methods as Thin Boundaries

Each `@callable()` method delegates to the Effect pipeline:

```ts
@callable()
async onInvoiceUpload(upload: InvoiceUploadInput) {
  return this.runEffect(onInvoiceUploadEffect(upload));
}
```

Where `this.runEffect` is set up once (constructor or lazy):

```ts
private runEffect: <A, E>(effect: Effect.Effect<A, E, AgentContext>) => Promise<A>;

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // table creation stays synchronous (this.sql is sync)
  void this.sql`create table if not exists Invoice (...)`;

  const agentContextLayer = Layer.succeedServices(
    ServiceMap.make(AgentContext, {
      sql: this.sql.bind(this),
      broadcast: this.broadcast.bind(this),
      runWorkflow: this.runWorkflow.bind(this),
      getWorkflow: this.getWorkflow.bind(this),
    })
  );
  this.runEffect = <A, E>(effect: Effect.Effect<A, E, AgentContext>) =>
    Effect.runPromise(Effect.provide(effect, agentContextLayer));
}
```

## Key Design Decisions

### 1. Single AgentContext service vs multiple services?

**Recommendation: single service.** The capabilities are all tightly coupled to one agent instance. Splitting into `AgentSql`, `AgentBroadcast`, `AgentWorkflow` adds boilerplate without real benefit — these aren't independently swappable.

### 2. Where to define the Effect functions?

**Option A**: Module-level `const` functions (like `processQueueMessage` in worker.ts).
**Option B**: Inside the class as private methods returning Effects.

**Recommendation: Option A** — module-level functions. This is more functional, testable (can provide mock AgentContext), and consistent with worker.ts patterns. The class becomes a thin shell.

### 3. Error handling strategy?

Current code throws raw TypeErrors. With Effect, we have options:
- `Effect.die` for truly unexpected/programmer errors (like invalid r2ActionTime)
- Tagged errors for expected failures
- `Effect.tryPromise` for async agent SDK calls (runWorkflow)

**Recommendation**: Keep it simple. `Effect.die` for validation failures (these are bugs in callers). `Effect.tryPromise` for `runWorkflow` (which is async and can fail). SQL operations via `this.sql` are synchronous and throw on failure — wrap in `Effect.try` if we want structured errors, or let them propagate as defects.

### 4. Should `broadcastActivity` become an Effect?

It's currently synchronous and infallible (just serializes + broadcasts). Making it an Effect adds ceremony for no real benefit.

**Recommendation**: Keep as a plain helper, or make it a trivial `Effect.sync` if we want it composable inside Effect pipelines. Slight preference for `Effect.sync` so the whole pipeline is pure:

```ts
const broadcastActivity = Effect.fn("broadcastActivity")(
  function* (input: { level: WorkflowProgress["level"]; text: string }) {
    const { broadcast } = yield* AgentContext;
    broadcast(JSON.stringify({
      type: "activity",
      message: { createdAt: new Date().toISOString(), level: input.level, text: input.text },
    } satisfies ActivityEnvelope));
  }
);
```

### 5. `onWorkflowProgress` / `onWorkflowError` — these are callbacks from the Agents SDK

These are called by the SDK, not by our code. They're already `async` and imperative.

**Recommendation**: Same pattern — delegate to `this.runEffect(someEffect)`. These become thin boundary methods like the callables.

### 6. Constructor table creation

`void this.sql\`create table if not exists...\`` is synchronous, idempotent, and runs before any method call. No reason to make this effectful.

**Recommendation**: Keep as-is in the constructor.

### 7. Logger layer?

The workflow and worker both set up logger layers. The agent currently has no structured logging.

**Recommendation**: Add a logger layer to the agent's runtime if we want `Effect.logInfo` etc. to work inside the business logic. Use the same `makeLoggerLayer(env)` pattern from worker.ts. This is optional for v1.

We want logging.

## Proposed File Structure

Keep everything in `src/organization-agent.ts` — no need to split into multiple files. The module would have:

1. Schema definitions (unchanged)
2. `AgentContext` service definition
3. Module-level Effect functions (business logic)
4. `OrganizationAgent` class (thin shell with `@callable()` boundaries)

## Sketch of Refactored Code

```ts
import { Agent, callable } from "agents";
import { Effect, Layer, ServiceMap } from "effect";
import * as Schema from "effect/Schema";

import type { ActivityEnvelope, WorkflowProgress } from "@/lib/Activity";
import { WorkflowProgressSchema } from "@/lib/Activity";
import { InvoiceStatus } from "@/lib/Domain";

// --- Schema (unchanged) ---

const InvoiceRowSchema = Schema.Struct({ /* ... */ });
type InvoiceRow = typeof InvoiceRowSchema.Type;
const decodeInvoiceRow = Schema.decodeUnknownSync(Schema.NullOr(InvoiceRowSchema));
const decodeInvoices = Schema.decodeUnknownSync(Schema.Array(InvoiceRowSchema));

// --- AgentContext service ---

export const AgentContext = ServiceMap.Service<{
  readonly sql: OrganizationAgent["sql"];
  readonly broadcast: (message: string) => void;
  readonly runWorkflow: OrganizationAgent["runWorkflow"];
  readonly getWorkflow: OrganizationAgent["getWorkflow"];
}>("OrganizationAgent/AgentContext");

// --- Business logic as Effect functions ---

const broadcastActivity = Effect.fn("broadcastActivity")(
  function* (input: { level: WorkflowProgress["level"]; text: string }) {
    const { broadcast } = yield* AgentContext;
    broadcast(JSON.stringify({
      type: "activity",
      message: { createdAt: new Date().toISOString(), level: input.level, text: input.text },
    } satisfies ActivityEnvelope));
  }
);

const onInvoiceUploadEffect = Effect.fn("onInvoiceUpload")(
  function* (upload: InvoiceUploadInput) {
    const { sql, runWorkflow, getWorkflow } = yield* AgentContext;
    const r2ActionTime = Date.parse(upload.r2ActionTime);
    if (!Number.isFinite(r2ActionTime)) {
      return yield* Effect.die(new TypeError(`Invalid r2ActionTime`));
    }
    const existing = decodeInvoiceRow(
      sql`select * from Invoice where id = ${upload.invoiceId}`[0] ?? null
    );
    if (existing && r2ActionTime < existing.r2ActionTime) return;
    const trackedWorkflow = getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) return;
    if (
      existing?.idempotencyKey === upload.idempotencyKey &&
      (existing.status === "extracting" || existing.status === "extracted")
    ) return;
    void sql`insert into Invoice (...) values (...) on conflict(id) do update set ...`;
    yield* broadcastActivity({ level: "info", text: `Invoice uploaded: ${upload.fileName}` });
    yield* Effect.tryPromise(() =>
      runWorkflow("INVOICE_EXTRACTION_WORKFLOW", { /* ... */ }, { /* ... */ })
    );
    void sql`update Invoice set status = 'extracting' where ...`;
  }
);

// ... similar for onInvoiceDelete, saveExtractedJson, etc.

// --- Agent class (thin shell) ---

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  initialState: OrganizationAgentState = { message: "Organization agent ready" };
  private declare agentRunEffect: <A, E>(
    effect: Effect.Effect<A, E, typeof AgentContext["Service"]>
  ) => Promise<A>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.sql`create table if not exists Invoice (...)`;
    const layer = Layer.succeedServices(
      ServiceMap.make(AgentContext, {
        sql: this.sql.bind(this),
        broadcast: this.broadcast.bind(this),
        runWorkflow: this.runWorkflow.bind(this),
        getWorkflow: this.getWorkflow.bind(this),
      })
    );
    this.agentRunEffect = (effect) => Effect.runPromise(Effect.provide(effect, layer));
  }

  @callable()
  getTestMessage() { return this.state.message; }

  @callable()
  onInvoiceUpload(upload: InvoiceUploadInput) {
    return this.agentRunEffect(onInvoiceUploadEffect(upload));
  }

  @callable()
  onInvoiceDelete(input: InvoiceDeleteInput) {
    return this.agentRunEffect(onInvoiceDeleteEffect(input));
  }

  saveExtractedJson(input: SaveExtractedJsonInput) {
    return this.agentRunEffect(saveExtractedJsonEffect(input));
  }

  async onWorkflowProgress(workflowName: string, _workflowId: string, progress: unknown) {
    return this.agentRunEffect(onWorkflowProgressEffect(workflowName, progress));
  }

  async onWorkflowError(workflowName: string, workflowId: string, error: string) {
    return this.agentRunEffect(onWorkflowErrorEffect(workflowName, workflowId, error));
  }

  @callable()
  getInvoices() {
    return decodeInvoices(this.sql`select * from Invoice order by createdAt desc`);
  }
}
```

## Circular Reference Issue

There's a potential problem: `AgentContext` references `OrganizationAgent["sql"]` etc. for typing, but `OrganizationAgent` uses `AgentContext`. This creates a circular type dependency.

**Solutions**:
1. Define the AgentContext interface independently (don't reference `OrganizationAgent` types):
   ```ts
   interface AgentContextShape {
     readonly sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
     readonly broadcast: (message: string) => void;
     // ...
   }
   ```
2. Use `typeof` on the Agent base class methods instead of OrganizationAgent.

**Recommendation**: Option 1 — define the interface shape explicitly. Cleaner, no circular deps.

## `getWorkflow` and `runWorkflow` Typing

These methods come from the Agent base class. Their signatures are complex (generic, overloaded). We need to check exact types.

The `sql` method is a tagged template that returns an array. `broadcast` takes a string. `runWorkflow` and `getWorkflow` have specific signatures from the agents SDK.

**Action item**: Check the exact Agent base class type signatures for these methods before finalizing the AgentContext interface. We may need to import types from `agents`.

## What About `getInvoices`?

`getInvoices` is synchronous — `this.sql` + `decodeInvoices`. Making it an Effect adds overhead for no benefit (no async, no error recovery needed).

**Recommendation**: Keep `getInvoices` as a direct call, not routed through `runEffect`. Same for `getTestMessage`. Only methods with async operations or complex logic benefit from Effect.

## Open Questions

1. **Logger layer**: Should we add structured logging inside the agent's Effect pipelines? Currently the agent has no `Effect.log*` calls. Adding a logger layer means the `runEffect` needs to include it. Worth it?

Yes, can we reuse the one in worker.ts?

2. **`this.sql` binding**: `this.sql` is a tagged template literal. When we do `this.sql.bind(this)`, does that work correctly for tagged templates? Need to verify. Alternative: wrap in a function `(strings, ...values) => this.sql(strings, ...values)`.

3. **Sync vs async `runEffect`**: Some methods (onInvoiceDelete, saveExtractedJson) are currently synchronous. Wrapping in `Effect.runPromise` makes them async. Is that acceptable for the Agent SDK's callback contract? `saveExtractedJson` is called from the workflow — need to check if it expects sync.

oh god, I don't know. do more research. Note that we may add logging and what not in the future and so they need to be effectful.

4. **Testing**: With AgentContext as a service, we can test business logic by providing a mock AgentContext layer. Is that a goal for this refactor?

Not a goal. Testing is a hole can of worms we're not really addressing.


I'm not crazy about using Effect.die() unless absolutely necessary since it's a showstopper. Why are we relying on die so much instead of effect errors?

You need to explain AgentContext conceptually. Mermaid diagram may help. You seem to be taking methods from this and binding them to this so they can be used as free standing functions?

this.agentRunEffect should be this.runEffect (rename)

The thin wrappers such as onInvoiceUpload are a little tedious. Why not just inline with Effect.gen?

Let's use effect for everything eg getInvoices. We may need to add logging, retries and whatnot later.