# RPC Systems in Cloudflare: Cap'n Web vs Agents SDK

Cloudflare provides two distinct RPC systems for browser-to-server communication: **Cap'n Web** (a low-level, sophisticated RPC library) and **Agents SDK's `@callable`** (a higher-level abstraction built on PartyKit). This document explains the differences, capabilities, and when to use each.

## Overview

### Cap'n Web
- **Package**: `capnweb` (npm)
- **Author**: Kenton Varda (creator of Cap'n Proto)
- **Philosophy**: Full object-capability RPC with maximum flexibility
- **Transport**: HTTP batch, WebSocket, MessagePort, custom
- **Runtime support**: Cloudflare Workers, Node.js, Deno, Browsers

### Agents SDK `@callable`
- **Package**: `agents` (npm)
- **Built on**: PartyKit Server (which wraps Durable Objects)
- **Philosophy**: Easy RPC for AI agents and real-time apps
- **Transport**: WebSocket only (via PartySocket)
- **Runtime support**: Cloudflare Workers only

## Architecture Comparison

```
┌─────────────────────────────────────────────────────────────┐
│  CAP'N WEB                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Browser    │  │   Worker     │  │   Worker     │     │
│  │              │  │  (RpcTarget) │  │  (RpcTarget) │     │
│  │  HTTP/WS     │  │              │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│       ↑↓                ↑↓                ↑↓                │
│  Promise pipelining, .map(), function passing              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  AGENTS SDK                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Browser    │  │    Agent     │  │   Durable    │     │
│  │              │  │   (Server)   │  │   Object     │     │
│  │  WebSocket   │  │              │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│       ↑↓                ↑↓                                │
│  @callable methods, state sync, React hooks                │
└─────────────────────────────────────────────────────────────┘
```

## Feature Comparison

| Feature | Cap'n Web | Agents `@callable` |
|---------|-----------|-------------------|
| **Transport options** | HTTP batch, WebSocket, MessagePort | WebSocket only |
| **Promise pipelining** | ✅ Yes | ❌ No |
| **`.map()` method** | ✅ Yes | ❌ No |
| **Pass functions** | ✅ Yes | ❌ No |
| **Bidirectional calling** | Full | Limited |
| **React hooks** | ❌ No | ✅ `useAgent`, `useAgentChat` |
| **State syncing** | Manual | Automatic (`this.setState`) |
| **AI integration** | Manual | `AIChatAgent` built-in |
| **Scheduling** | Manual | Built-in (`this.schedule`) |
| **Bundle size** | <10kB | Larger (includes PartyKit) |
| **Runtime support** | Workers, Node, Deno, Browsers | Workers only |

## Cap'n Web: Deep Capabilities

### Promise Pipelining

Chain dependent calls without waiting for round trips:

```typescript
// Server
class Api extends RpcTarget {
  async authenticate(token: string): Promise<AuthedApi> {
    return new AuthedApi(userId);
  }
  
  async getProfile(userId: string): Promise<Profile> {
    return fetchProfile(userId);
  }
}

// Client - ONE round trip for both calls!
const api = newWebSocketRpcSession<Api>("wss://...");
const authed = api.authenticate(token);  // Don't await!
const profile = await api.getProfile(authed.userId);  // Pipelined!
```

### The `.map()` Method

Transform arrays remotely without pulling data locally:

```typescript
// Get user IDs
const ids = api.getUserIds();

// Look up profiles for each ID - single round trip!
const profiles = await ids.map(id => api.getProfile(id));
```

**How it works**: Record-replay serialization captures the callback's behavior without sending code.

### Function Passing

Pass callbacks that become callable stubs:

```typescript
// Server
class Processor extends RpcTarget {
  async process(data: string, onProgress: (pct: number) => void) {
    for (let i = 0; i <= 100; i += 10) {
      onProgress(i);  // Calls back to client!
      await sleep(100);
    }
    return "done";
  }
}

// Client
const result = await processor.process("data", (progress) => {
  console.log(`${progress}% complete`);
});
```

### HTTP Batch Mode

Multiple calls in a single HTTP request:

```typescript
const api = newHttpBatchRpcSession<Api>("https://...");

// All batched into one request
const result1 = api.method1();
const result2 = api.method2(result1);  // Can use promises as params!
await Promise.all([result1, result2]);  // Batch sent here
```

## Agents SDK: Developer Experience

### Simple Method Exposure

```typescript
import { Agent, callable } from "agents";

class MyAgent extends Agent {
  @callable({ description: "Add two numbers" })
  async add(a: number, b: number) {
    return a + b;
  }
  
  @callable({ streaming: true })
  async *streamData() {
    yield "chunk1";
    yield "chunk2";
  }
}
```

### React Integration

```typescript
import { useAgent } from "agents/react";

function MyComponent() {
  const { stub } = useAgent({ name: "my-agent" });
  
  async function handleClick() {
    const result = await stub.add(2, 3);
    console.log(result); // 5
  }
  
  return <button onClick={handleClick}>Add</button>;
}
```

### Automatic State Sync

```typescript
class CounterAgent extends Agent<Env, { count: number }> {
  initialState = { count: 0 };
  
  @callable()
  async increment() {
    this.setState({ count: this.state.count + 1 });
    // Automatically broadcasts to all connected clients!
  }
}
```

## When to Use Each

### Use Cap'n Web when:

- You need **HTTP batch mode** (REST-like + RPC hybrid)
- You want **promise pipelining** for complex call chains
- You need to pass **functions/callbacks** over RPC
- You want **`.map()`** for server-side data transformation
- You're building **complex distributed systems**
- You need to run on **Node.js or Deno** (not just Workers)
- You want **maximum flexibility** over transport and protocol

### Use Agents SDK when:

- You're building **AI agents** or **chat applications**
- You want **React hooks** and automatic state syncing
- You need **built-in scheduling** (`this.schedule`)
- You want **AI streaming** (`AIChatAgent`)
- You prefer **easy setup** over maximum flexibility
- You're all-in on the **Cloudflare ecosystem**
- You need **SQLite integration** with your RPC

## Interoperability

### Cap'n Web with Workers RPC

Cap'n Web interoperates with Cloudflare's built-in Workers RPC:

```typescript
// Cap'n Web server can receive Workers RPC stubs
class Api extends RpcTarget {
  async process(workerStub: WorkerEntrypoint) {
    // Can call WorkerEntrypoint methods
    const result = await workerStub.someMethod();
  }
}
```

Set compatibility flag for full interoperability:
```jsonc
{
  "compatibility_flags": ["rpc_params_dup_stubs"]
}
```

### Agents with Durable Objects

Agents extends PartyKit Server which wraps Durable Objects:

```typescript
// Agent can be addressed via Durable Object bindings
const agent = env.MY_AGENT.get(env.MY_AGENT.idFromName("instance-1"));
```

## Resource Management

Both systems use **explicit resource management** (`using` keyword):

```typescript
// Cap'n Web
using api = newWebSocketRpcSession<Api>("wss://...");
// Connection closes automatically at scope end

// Agents SDK
const client = new AgentClient({ agent: "my-agent", name: "instance-1" });
using stub = client.getStub();
// Stub disposed automatically
```

## Summary

| Aspect | Cap'n Web | Agents SDK |
|--------|-----------|------------|
| **Complexity** | High (powerful primitives) | Low (easy to use) |
| **Learning curve** | Steep | Gentle |
| **Philosophy** | RPC expert tool | Rapid development |
| **Best for** | Distributed systems, complex RPC | AI agents, real-time apps |

**Bottom line**: Cap'n Web is the deeper, more sophisticated RPC system for experts who need maximum control. Agents SDK is the practical, easy-to-use abstraction for common use cases with React integration and built-in features.
