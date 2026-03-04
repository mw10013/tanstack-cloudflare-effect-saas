# SQLite in Durable Objects and Agents

## Overview

SQLite-backed Durable Objects provide a 10GB SQLite database per Durable Object instance with zero-latency access since compute runs in the same process as the data.

## Storage Limits

| Resource | Limit |
|----------|-------|
| Storage per Durable Object | **10 GB** |
| Storage per account (Paid) | Unlimited |
| Storage per account (Free) | 5 GB |
| Maximum Durable Object classes | 500 (Paid) / 100 (Free) |
| Key + Value size | 2 MB combined |
| WebSocket message size | 32 MiB |

**Note:** The 10GB limit was increased from 1GB when SQLite in Durable Objects went GA in April 2025.

## SQL API Access

Access SQLite via `ctx.storage.sql`:

```typescript
import { DurableObject } from "cloudflare:workers";

export class MyDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    // Execute SQL directly
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE
      )
    `);
  }
  
  async addUser(name: string, email: string) {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (name, email) VALUES (?, ?)`,
      name,
      email
    );
  }
}
```

## Supported SQLite Extensions

- **FTS5** - Full-text search
- **JSON** - JSON functions and operators
- **Math functions** - Mathematical operations

## SQL Limits

| Feature | Limit |
|---------|-------|
| Maximum columns per table | 100 |
| Maximum rows per table | Unlimited (within storage limits) |
| Maximum string/BLOB/row size | 2 MB |
| Maximum SQL statement length | 100 KB |
| Maximum bound parameters | 100 |
| Maximum function arguments | 32 |
| Maximum LIKE/GLOB pattern | 50 bytes |

## Wrangler Configuration

Enable SQLite storage via migrations:

```jsonc
// wrangler.jsonc
{
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyDurableObject", "MyAgent"]
    }
  ]
}
```

**Important:** You cannot convert existing KV-backed Durable Objects to SQLite. SQLite must be enabled from the start.

## KV API (Also Available)

SQLite-backed DOs also support synchronous KV operations:

```typescript
// Synchronous KV API
ctx.storage.kv.get(key: string): any
ctx.storage.kv.put(key: string, value: any): void
ctx.storage.kv.delete(key: string): void
ctx.storage.kv.list(options?: { prefix?: string, limit?: number }): IterableIterator<[string, any]>
```

## Point-in-Time Recovery (PITR)

SQLite-backed Durable Objects support restoring to any point in the past 30 days using bookmarks:

```typescript
// Create a bookmark
const bookmark = await ctx.storage.createBookmark();

// Later, restore from bookmark
const restored = await ctx.storage.restoreBookmark(bookmark);
```

## References

- [Cloudflare SQLite Storage API Docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Access Durable Objects Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
