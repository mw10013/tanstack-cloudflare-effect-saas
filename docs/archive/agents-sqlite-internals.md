# Agents SQLite Internals

## Overview

Agents extend Durable Objects and inherit all SQLite capabilities. The Agents library (`cf:agents`) provides automatic state persistence, task queuing, and scheduling using internal SQLite tables.

## Internal Tables

Agents automatically create and manage these tables:

### cf_agents_state

Stores agent state for automatic persistence:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_state (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT
);
```

**Usage in code** (`refs/agents/packages/agents/src/index.ts:423-452`):
```typescript
// Check if state was changed
const changed = this.sql`
  SELECT state FROM cf_agents_state WHERE id = 'STATE_WAS_CHANGED'
`;

// Save state
this.sql`
  INSERT OR REPLACE INTO cf_agents_state (id, state)
  VALUES ('STATE', ${JSON.stringify(this.state)})
`;

// Clear state
this.sql`
  DELETE FROM cf_agents_state WHERE id = 'STATE_ROW_ID'
`;
```

### cf_agents_queues

Stores queued tasks for sequential execution:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_queues (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT,
  callback TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
```

**Usage in code** (`refs/agents/packages/agents/src/index.ts:1230-1333`):
```typescript
// Enqueue task
this.sql`
  INSERT OR REPLACE INTO cf_agents_queues (id, payload, callback)
  VALUES (${id}, ${JSON.stringify(payload)}, ${callback})
`;

// Dequeue all tasks
const tasks = [...this.sql`SELECT * FROM cf_agents_queues`];

// Delete completed task
this.sql`DELETE FROM cf_agents_queues WHERE id = ${id}`;

// Clear all tasks
this.sql`DELETE FROM cf_agents_queues`;
```

### cf_agents_schedules

Stores scheduled and cron tasks:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_schedules (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
  callback TEXT,
  payload TEXT,
  type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
  time INTEGER,
  delayInSeconds INTEGER,
  cron TEXT,
  intervalSeconds INTEGER,
  running INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);
```

**Usage in code** (`refs/agents/packages/agents/src/index.ts:1379-1770`):
```typescript
// Schedule one-time task
this.sql`
  INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, time)
  VALUES (${id}, ${callback}, ${payload}, 'scheduled', ${timestamp})
`;

// Schedule cron task
this.sql`
  INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time)
  VALUES (${id}, ${callback}, ${payload}, 'cron', ${cronExpression}, ${nextRunTime})
`;

// Get due schedules
const due = this.sql`
  SELECT * FROM cf_agents_schedules WHERE time <= ${now}
`;

// Mark as running
this.sql`
  UPDATE cf_agents_schedules 
  SET running = 1, execution_started_at = ${now} 
  WHERE id = ${id}
`;

// Reschedule or delete after execution
this.sql`
  UPDATE cf_agents_schedules 
  SET running = 0, time = ${nextTimestamp} 
  WHERE id = ${id}
`;
// OR
this.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;
```

### cf_agents_workflows

Tracks workflow instances (Agent-Workflow integration):

```sql
CREATE TABLE IF NOT EXISTS cf_agents_workflows (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL UNIQUE,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'running', 'paused', 'errored',
    'terminated', 'complete', 'waiting',
    'waitingForPause', 'unknown'
  )),
  metadata TEXT,
  error_name TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON cf_agents_workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_name ON cf_agents_workflows(workflow_name);
```

## Table Initialization

All tables are created in the Agent constructor (`refs/agents/packages/agents/src/index.ts:529-631`):

```typescript
constructor(ctx: AgentContext, env: Env) {
  super(ctx, env);
  
  // Tables created with IF NOT EXISTS (idempotent)
  this.sql`CREATE TABLE IF NOT EXISTS cf_agents_state (...)`;
  this.sql`CREATE TABLE IF NOT EXISTS cf_agents_queues (...)`;
  this.sql`CREATE TABLE IF NOT EXISTS cf_agents_schedules (...)`;
  this.sql`CREATE TABLE IF NOT EXISTS cf_agents_workflows (...)`;
  
  // Migrations for existing agents
  this.runMigrations();
}
```

## Migration Strategy

Agents use a try-catch approach for additive migrations:

```typescript
// From refs/agents/packages/agents/src/index.ts:581-603
const addColumnIfNotExists = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Ignore "duplicate column" errors (idempotent)
    if (!message.toLowerCase().includes("duplicate column")) {
      throw e;
    }
  }
};

// Add columns for interval scheduling feature
addColumnIfNotExists(
  "ALTER TABLE cf_agents_schedules ADD COLUMN intervalSeconds INTEGER"
);
addColumnIfNotExists(
  "ALTER TABLE cf_agents_schedules ADD COLUMN running INTEGER DEFAULT 0"
);
addColumnIfNotExists(
  "ALTER TABLE cf_agents_schedules ADD COLUMN execution_started_at INTEGER"
);
```

**Key differences from Durable Objects:**
- No `blockConcurrencyWhile()` for table creation (uses `IF NOT EXISTS`)
- Try-catch for column additions (catches duplicate column errors)
- Raw `exec()` bypasses `onError` handler to avoid logging expected failures

## SQL Template Tag

Agents provide a convenient SQL template tag:

```typescript
// Parameterized query (safe)
const results = this.sql`
  SELECT * FROM cf_agents_schedules 
  WHERE type = ${type} AND time <= ${now}
`;

// Insert with parameters
this.sql`
  INSERT INTO cf_agents_state (id, state) 
  VALUES (${id}, ${JSON.stringify(state)})
`;
```

The template tag automatically:
- Constructs queries with `?` placeholders
- Executes via `ctx.storage.sql.exec()`
- Returns array of results
- Throws via `onError` handler on failure

## Storage Limits

Agents inherit Durable Object limits:
- **10 GB** per Agent instance
- Unlimited Agents per account (Paid)
- 5 GB total storage (Free plan)

## References

- [Agents State Documentation](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)
- [Agents Queue Documentation](https://developers.cloudflare.com/agents/api-reference/queue-tasks/)
- [Agents Scheduling Documentation](https://developers.cloudflare.com/agents/api-reference/schedule-tasks/)
- [Agents Source Code](refs/agents/packages/agents/src/index.ts)
