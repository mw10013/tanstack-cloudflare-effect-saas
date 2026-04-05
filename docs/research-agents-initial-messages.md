# Cloudflare Agents: Initial WebSocket Messages

Research on what the 3 initial messages are and whether `skipInitialMessages` is needed.

## What are the 3 initial messages?

When a client connects to a Cloudflare Agent over WebSocket, the server sends 3 protocol messages **before** any RPC traffic. Sent in `webSocketOpen`:

```ts
// refs/agents/packages/agents/src/index.ts:1307-1354
if (this.shouldSendProtocolMessages(connection, ctx)) {
  // 1. Identity — who you're connected to
  if (this._resolvedOptions.sendIdentityOnConnect) {
    connection.send(JSON.stringify({
      name: this.name,
      agent: camelCaseToKebabCase(this._ParentClass.name),
      type: MessageType.CF_AGENT_IDENTITY    // "cf_agent_identity"
    }));
  }

  // 2. State — current agent state snapshot
  if (this.state) {
    connection.send(JSON.stringify({
      state: this.state,
      type: MessageType.CF_AGENT_STATE       // "cf_agent_state"
    }));
  }

  // 3. MCP servers — list of available MCP servers
  connection.send(JSON.stringify({
    mcp: this.getMcpServers(),
    type: MessageType.CF_AGENT_MCP_SERVERS   // "cf_agent_mcp_servers"
  }));
}
```

### Message types (from `refs/agents/packages/agents/src/types.ts:4-13`)

```ts
enum MessageType {
  CF_AGENT_IDENTITY = "cf_agent_identity",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  // ...
  RPC = "rpc"
}
```

### Message shapes

| # | Type | Payload | Conditional on |
|---|------|---------|----------------|
| 1 | `cf_agent_identity` | `{ name, agent, type }` | `sendIdentityOnConnect` option (default `true`) |
| 2 | `cf_agent_state` | `{ state, type }` | `this.state` being truthy |
| 3 | `cf_agent_mcp_servers` | `{ mcp, type }` | Always sent (within protocol messages) |

Our `OrganizationAgent` has `initialState` set (`src/organization-agent.ts:93`) and uses default options, so all 3 are sent.

## The count could vary

The 3-message assumption is fragile:
- Identity skipped when `sendIdentityOnConnect: false` (`refs/agents/.../index.ts:1310`)
- State skipped when `this.state` is falsy (`refs/agents/.../index.ts:1340`)
- All skipped when `shouldSendProtocolMessages()` returns `false` (`refs/agents/.../index.ts:1307`)

For our agent (default options + `initialState` set), it's always 3.

## How the client SDK handles them

The official `AgentClient` handles them inline in its `onmessage` handler — it checks the type and dispatches:

```ts
// refs/agents/packages/agents/src/client.ts:328-386
if (parsedMessage.type === MessageType.CF_AGENT_IDENTITY) {
  // update client identity, resolve ready promise
  return;
}
if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
  // sync client state from server
  return;
}
```

No separate "skip" step — the message handler just knows about all message types and routes accordingly.

## Do we actually need `skipInitialMessages`?

**No.** Our `callAgentRpc` already filters by `msg.type === MessageType.RPC && msg.id === id` (`test/TestUtils.ts:136`). Protocol messages don't match that filter, so they're silently ignored. `skipInitialMessages` is redundant.

The Agents library's test suite has `skipInitialMessages` (`refs/agents/.../tests/callable.test.ts:67-81`) because their `callRPC` helper uses `waitForMessage` which consumes the **next** message regardless of type — so they must drain protocol messages first. Our `callAgentRpc` is smarter: it filters by type + id, making the drain unnecessary.

### Where it belongs if we keep it

`skipInitialMessages` is a **connection setup** concern, not an RPC concern. It belongs in `agentWebSocket` (where it currently lives), not in `callAgentRpc`. But since `callAgentRpc`'s filtering makes it unnecessary, the simplest option is to remove it entirely.

## Summary

| Approach | Used by | How it works |
|----------|---------|--------------|
| Drain N messages on connect | Agents test suite (`callable.test.ts`) | `waitForMessage` consumes next message blindly → must drain protocol messages first |
| Filter by type in message handler | Agents client SDK (`client.ts`) | `onmessage` checks type, routes protocol messages, ignores unknown |
| Filter by type + id in RPC handler | Our `callAgentRpc` | Handler only reacts to `type === "rpc" && id === ourId` → protocol messages ignored automatically |

Our `callAgentRpc` follows the same pattern as the client SDK (filter in the handler) rather than the test suite (drain first). `skipInitialMessages` is a leftover from copying the test suite pattern and can be removed.
