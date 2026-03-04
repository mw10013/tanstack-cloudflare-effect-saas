# Agent Workflow Communication

This document outlines the various communication channels between `AgentWorkflow`, its parent `Agent`, and the frontend client via `useAgent()`.

## 1. Workflow to Agent

An `AgentWorkflow` has a direct link back to the Agent instance that started it.

### Agent RPC
Workflows can invoke any method on their parent Agent using `this.agent`. This allows workflows to trigger agent logic, save results to other systems, or query agent-specific state.

```ts
// Inside AgentWorkflow.run()
await this.agent.processResult(result);
```

### Durable State Sync
Workflows can durably update the Agent's SQLite-backed state. These updates are idempotent and integrated into the workflow's step history, ensuring they are not repeated during a replay.

```ts
// Inside AgentWorkflow.run()
await step.updateAgentState({ status: "processing_complete" });
await step.mergeAgentState({ lastStep: 5 });
```

> **From the docs:** "Durable Agent state sync... These methods are idempotent and will not repeat on retry. Use for state changes that must persist."

---

## 2. Workflow to Client

Workflows can push updates directly to connected clients without requiring manual hooks in the Agent.

### Direct Broadcasting
The `broadcastToClients()` method sends a message to every WebSocket currently connected to the parent Agent. This is useful for real-time progress bars or UI notifications.

```ts
// Inside AgentWorkflow.run()
this.broadcastToClients({
  type: "progress",
  percent: 0.75,
  label: "Finalizing..."
});
```

> **From the docs:** "Workflows cannot open WebSocket connections directly. Use `broadcastToClients()` to communicate with connected clients through the Agent."

---

## 3. Agent to Client

The Agent acts as the communication hub, managing WebSocket connections and responding to Workflow events.

### Lifecycle Hooks
The Agent provides several hooks that fire automatically as the workflow progresses. These are the primary places to handle status updates and errors.

```ts
// Inside Agent class
async onWorkflowProgress(name: string, id: string, progress: any) {
  this.broadcast(JSON.stringify({ type: "wf_progress", id, progress }));
}

async onWorkflowComplete(name: string, id: string, result: any) {
  this.broadcast(JSON.stringify({ type: "wf_complete", id, result }));
}
```

### Manual Broadcasts
Agents can use `this.broadcast(data)` to send messages to all connected clients at any time, regardless of whether a workflow is running.

---

## 4. Client to Agent (Frontend)

The `useAgent()` hook in the frontend provides a bidirectional link to the Agent.

### The `onMessage` Callback
This callback captures all messages sent via `this.broadcast()` (from the Agent) and `this.broadcastToClients()` (from the Workflow).

```tsx
const agent = useAgent({
  agent: "my-agent",
  onMessage: (event) => {
    const data = JSON.parse(String(event.data));
    if (data.type === "wf_progress") {
      updateProgressBar(data.progress.percent);
    }
  },
});
```

### The `stub` Object
The `stub` allows the client to call `@callable()` methods on the Agent directly. This is the standard way to initiate workflows from the UI.

```tsx
const startWork = () => {
  agent.stub.requestApproval(title, description);
};
```

### The `onStatus` Callback
Used to monitor the WebSocket connection state.

```tsx
const agent = useAgent({
  onStatus: (status) => {
    console.log("Connection status:", status); // 'connecting', 'open', 'closed', etc.
  },
});
```
