# D1 Read Replicas + Better Auth: Research & Questions

## Current State

### `createD1SessionService` is half-wired

- **Created** every request in `worker.ts:173-179`
- **`setSessionBookmarkCookie()`** called on response (`worker.ts:187`) - but only writes a cookie *if* `getSession()` was called during the request
- **`getSession()` is never called anywhere** - no code consumes the D1 session
- **Net effect**: the service is a no-op. The cookie is never written because no session is ever created

### Better Auth uses raw `D1Database` directly

`Auth.ts:36` extracts `D1` from `CloudflareEnv`, passes it as `database` to `betterAuth()` at line 100. Better Auth's Kysely-based D1 adapter calls `prepare().bind().all()` and `batch()` on this binding directly. No session awareness.

You need to do deeper research. Show me the interface to the d1 and d1 read replica. then analyze better-auth source to figure out if d1 read replica interface can work with cast. If not, show me evidence.

### Effect `D1` service also uses raw `D1Database`

`D1.ts:6` does the same `yield* CloudflareEnv` and wraps `d1.prepare()`, `d1.batch()` in Effect operations. Repository layer sits on top.

This is not showstopper since we could change D1 to take D1 primary or d1 read replica since what it uses is common to both.

---

## D1 Sessions API Summary

```ts
// Synchronous - returns immediately
const session: D1DatabaseSession = env.DB.withSession(constraintOrBookmark)

// Constraints for first query routing:
// "first-primary"       - first query hits primary (freshest data), subsequent may use replica
// "first-unconstrained" - first query hits nearest (primary or replica), default
// bookmarkString        - resumes from a previous session's bookmark

session.prepare(sql)    // same as D1Database.prepare()
session.batch([])       // same as D1Database.batch()
session.getBookmark()   // returns bookmark string after queries execute
```

**Key**: `D1DatabaseSession` shares `prepare()` and `batch()` with `D1Database`. It lacks `exec()` and `withSession()`. It adds `getBookmark()`.

**All writes always go to primary** regardless of constraint. The constraint only affects where the *first read* routes.

---

## Interface Compatibility: D1Database vs D1DatabaseSession

| Method | D1Database | D1DatabaseSession | Better Auth uses? | Effect D1 uses? |
|--------|-----------|-------------------|-------------------|----------------|
| `prepare(sql)` | yes | yes | yes | yes |
| `batch(stmts)` | yes | yes | yes (introspection) | yes |
| `exec(sql)` | yes | **no** | detection only* | no |
| `withSession()` | yes | **no** | no | no |
| `getBookmark()` | **no** | yes | no | no |

*Better Auth's D1 auto-detection checks `"batch" in db && "exec" in db && "prepare" in db`. A `D1DatabaseSession` would **fail this check** because it lacks `exec`.

Oh, so this is the showstopper. Show the code excerpt here as evidence.

---

## The Core Question: Read Replicas for Better Auth

### What we want (maybe?)

- **Auth API routes** (`/api/auth/*`): use `first-primary` constraint so auth reads/writes are always consistent (login, session validation, etc.)
- **Non-auth routes**: use `first-unconstrained` (or bookmark from previous request) so reads hit nearby replicas for lower latency
- **Bookmark continuity**: pass bookmark across requests via cookie so subsequent reads are at least as fresh as the last write

### How this could work

**Option A: Two D1 handles per request**
- Auth gets a `D1DatabaseSession` with `first-primary`
- Effect `D1` service gets a `D1DatabaseSession` with `first-unconstrained` or bookmark
- Problem: better-auth's D1 detection fails on `D1DatabaseSession` (no `exec`)

This option is not an option because of exec

**Option B: Shim `exec` onto the session**
```ts
const session = env.DB.withSession("first-primary");
const shimmed = Object.assign(session, { exec: env.DB.exec.bind(env.DB) });
// Pass shimmed to better-auth
```
- Hacky. `exec` on the raw DB wouldn't participate in the session's consistency
- But `exec` is only used for detection, not actual queries, so maybe fine?

Not a good idea.

> **Q1: Is shimming `exec` acceptable? Or too fragile / likely to break on better-auth upgrades?**

**Option C: Single session for everything**
- Create one `D1DatabaseSession` per request (with appropriate constraint)
- Pass to both better-auth and Effect D1 service
- Simpler but loses the ability to differentiate auth vs non-auth read routing

We use better-auth to get the session and that would be benefical to get from the read replica.

> **Q2: Is differentiating auth vs non-auth routing even worth the complexity? Auth queries are a small % of total queries.**

Well, I think at this point, better-auth would have to go against primary. Maybe we consider using replica with D1 service. Though that may not be appropriate for api routes.

**Option D: Keep better-auth on raw D1, only use sessions for Effect D1**
- Better Auth always hits primary (raw `D1Database` goes to primary for writes, and reads... also go to primary? or nearest?)

> **Q3: What does raw `D1Database` (no session) actually do? Does it always go to primary? Or does it use read replicas automatically? The docs suggest that without sessions, reads *may* hit replicas but without consistency guarantees. Need to verify.**

Do the fucking research. How the hell would D1Database know about a read replica session?

---

## Questions for Discussion

### Architecture

**Q1**: Do we actually need read replicas for better-auth? Auth operations are mostly writes (create session, update session, create user) or critical reads (validate session). These arguably *should* always hit primary.

**Q2**: Should the Effect D1 service (Repository layer) use sessions? Our Repository does reads like `getPlans`, `getMemberByUserAndOrg`, `getOwnerOrganizationByUserId` - these could benefit from replica reads. But do we have enough read volume to justify the complexity?

**Q3**: Is the right approach: **better-auth stays on raw D1Database (always primary), Effect D1 service uses sessions (replicas for reads)**? This avoids the `exec` shim problem entirely.

### Implementation

**Q4**: If we do use sessions, should the session be created in `worker.ts` and threaded through as a service? Or should each service create its own session?

**Q5**: The existing `createD1SessionService` has the cookie/bookmark plumbing. Should we:
- (a) Delete it and build session management into Effect services
- (b) Fix it to actually be consumed (wire `getSession()` into Auth and/or D1 service)
- (c) Convert it to an Effect service

**Q6**: For the bookmark cookie approach: the current `createD1SessionService` reads bookmark from `X-D1-Bookmark` cookie and passes to `withSession()`. Is this the right cookie name / pattern? Should the bookmark be per-session or global?

### Scope

**Q7**: Is read replication even enabled on the D1 database yet? If not, `withSession()` still works (it's a no-op on non-replicated DBs) but there's no benefit. Should we defer this until replication is enabled?

**Q8**: Priority order? Suggested:
1. Decide if better-auth should use sessions at all (likely: no, keep on raw D1)
2. Decide if Effect D1 should use sessions (likely: yes, eventually)
3. Clean up or delete `createD1SessionService`
4. Implement if decided yes

---

## Raw Notes

### Better Auth D1 Adapter Internals

Better Auth's `D1SqliteDialect` (from `@better-auth/kysely-adapter`) wraps D1 in Kysely's dialect interface:

```
betterAuth({ database: env.D1 })
  -> createKyselyAdapter()
    -> detects D1 via duck-typing: "batch" in db && "exec" in db && "prepare" in db
    -> creates D1SqliteDialect({ database: db })
      -> D1SqliteConnection.executeQuery() calls db.prepare(sql).bind(...params).all()
      -> D1SqliteIntrospector.getTables() uses db.batch()
```

D1 adapter does NOT support interactive transactions - throws error. Uses `batch()` for atomic operations instead.

### D1 Read Replication Details

- Replicas created asynchronously across regions (ENAM, WNAM, WEUR, EEUR, APAC, OC)
- No extra cost for replicas
- Sessions provide sequential consistency: monotonic reads, monotonic writes, read-your-own-writes
- `D1Result.meta` includes `served_by_region` and `served_by_primary` for observability
- Sessions API works locally in dev but `served_by_*` fields are `undefined`
