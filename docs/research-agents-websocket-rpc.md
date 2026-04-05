# Cloudflare Agents WebSocket RPC

Research on how `callAgentRpc` in `test/TestUtils.ts` works, grounded in the Agents library source.

## Protocol overview

A single WebSocket connection multiplexes many RPC calls. Each call gets a unique `id` so responses can be correlated back to requests regardless of ordering.

## Message types

### Client → Server (RPCRequest)

```ts
// refs/agents/packages/agents/src/index.ts:68-73
type RPCRequest = {
  type: "rpc";
  id: string;        // client-generated UUID
  method: string;    // name of @callable() method
  args: unknown[];   // positional arguments
};
```

### Server → Client (RPCResponse)

```ts
// refs/agents/packages/agents/src/index.ts:86-104
type RPCResponse = {
  type: MessageType.RPC;  // "rpc"
  id: string;
} & (
  | { success: true;  result: unknown; done?: false }  // streaming chunk
  | { success: true;  result: unknown; done: true }    // final result
  | { success: false; error: string }                  // error
);
```

Three shapes:

| Shape | Meaning |
|-------|---------|
| `success: true, done: true` | Final (and possibly only) result |
| `success: true, done: false` | Intermediate streaming chunk — more coming |
| `success: false` | Error, call is over |

## Non-streaming vs streaming methods

Server-side, methods are decorated with `@callable()`:

```ts
// non-streaming — server sends one message with done: true
@callable()
getInvoices() { return [...]; }

// streaming — server sends N chunks (done: false) then one final (done: true)
@callable({ streaming: true })
async streamData(stream: StreamingResponse, ...) {
  stream.send(chunk);   // done: false
  stream.end(final);    // done: true
}
```

`refs/agents/packages/agents/src/index.ts:1213-1282` — handler dispatches to the method, wraps result in `{ done: true, success: true, result }`, and sends via `connection.send()`.

`refs/agents/packages/agents/src/index.ts:5119-5199` — `StreamingResponse` class. `send()` emits `done: false`, `end()` emits `done: true`. If the method throws before closing the stream, the handler auto-closes with an error response.

## Why the WebSocket receives multiple messages per connection

The WebSocket is **shared** — it carries:

1. Initial connection messages (state sync, session, identity — the 3 messages skipped in `skipInitialMessages`)
2. RPC responses for any in-flight call
3. State update broadcasts

So `addEventListener("message", handler)` on a shared socket means the handler fires for **every** message, not just the one you care about.

## Walking through `callAgentRpc`

### Why `Effect.callback`

`addEventListener` is a callback-based API — it doesn't return a Promise. You pass it a function, and it calls that function later when a message arrives. `Effect.callback` bridges this into Effect: you get a `resume` function, and when the callback fires you call `resume(Effect.succeed(value))` to complete the Effect.

Compare to a Promise constructor:
- **Promise**: `new Promise((resolve) => { addEventListener(..., () => resolve(value)) })`
- **Effect.callback**: `Effect.callback((resume) => { addEventListener(..., () => resume(Effect.succeed(value))) })`

The advantage: `Effect.callback` lets you return a finalizer — an Effect that runs when the fiber is interrupted (e.g. by `Effect.timeout`). This removes the event listener automatically on cancellation. `Effect.promise` can't do this because Promises are uninterruptible.

### Line by line

```ts
export const callAgentRpc = Effect.fn("callAgentRpc")(
  function*(ws: WebSocket, method: string, args: unknown[] = [], timeout: number = 10_000) {
    return yield* Effect.callback<RPCResponse>((resume) => {
```

`Effect.callback<RPCResponse>` — creates an `Effect<RPCResponse>` that will complete when `resume` is called. The caller of `callAgentRpc` just `yield*`s it and gets an `RPCResponse` back.

```ts
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
```

**Send request** — matches `RPCRequest` shape. The `id` correlates the response.

```ts
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as RPCResponse;
        if (msg.type === MessageType.RPC && msg.id === id) {
```

**Filter by type + id** — ignore unrelated messages (state broadcasts, other RPC calls). Only react to RPC responses matching our `id`.

```ts
          if (msg.success && !msg.done) return;
```

**Skip streaming chunks** — `done: false` means intermediate chunk; wait for the final `done: true` message.

```ts
          ws.removeEventListener("message", handler);
          resume(Effect.succeed(msg));
```

**Cleanup + complete** — remove the listener (so it doesn't fire on future messages), then call `resume` to complete the Effect with the response.

```ts
      };
      ws.addEventListener("message", handler);
      return Effect.sync(() => { ws.removeEventListener("message", handler); });
```

**Register handler + finalizer** — attach the listener, then return a finalizer Effect. The finalizer runs if the Effect is interrupted before `resume` is called (e.g. by timeout), removing the listener so it doesn't leak.

```ts
    }).pipe(
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.die(new Error(`Agent RPC timeout: ${method}`))),
    );
```

**Timeout** — the Agents library has no built-in timeout (`refs/agents/packages/agents/src/tests/callable.test.ts:84-115`). If the server never responds, the Effect hangs forever. `Effect.timeout` interrupts the `Effect.callback` after the duration, which triggers the finalizer (removing the listener), then the `TimeoutError` is caught and converted to a defect.

## Why `addEventListener` / `removeEventListener` instead of `onmessage`

`ws.onmessage` is a **single** handler — setting it would overwrite any existing handler. `addEventListener` allows **multiple** concurrent handlers on the same WebSocket, which is essential because:

- Multiple `callAgentRpc` calls can be in-flight simultaneously
- The WebSocket also carries non-RPC messages (state sync, etc.)

Each `callAgentRpc` invocation registers its own handler filtered by its unique `id`, so they don't interfere.

## Summary of the flow

```
Client                          Server
  |                               |
  |-- { type:"rpc", id, method } -->
  |                               |  executes @callable() method
  |                               |
  |<-- { id, success, done:false } --  (streaming only, 0..N times)
  |<-- { id, success, done:true }  --  final result
  |                               |
  [removeEventListener]
  [resume(Effect.succeed(msg))]
```

## Effect v4 API reference

**`Effect.callback`** — wraps callback-based async APIs (was `Effect.async` in v3).

```ts
// refs/effect4/packages/effect/src/Effect.ts:1405
export const callback: <A, E = never, R = never>(
  register: (
    this: Scheduler,
    resume: (effect: Effect<A, E, R>) => void,
    signal: AbortSignal
  ) => void | Effect<void, never, R>
)
```

The register function receives `resume` (call with `Effect.succeed(value)` or `Effect.fail(error)` to complete the Effect) and returns an optional finalizer Effect for cleanup on interruption.

**`Effect.timeout`** — interrupts an effect after a duration, failing with `Cause.TimeoutError`.

```ts
// refs/effect4/packages/effect/src/Effect.ts:4400
export const timeout: {
  (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) =>
    Effect<A, E | Cause.TimeoutError, R>
}
```

When `timeout` fires, it interrupts the inner effect, which triggers the finalizer returned by `Effect.callback`.
