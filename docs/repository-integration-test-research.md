# Repository Integration Test Research

## Goal

Create `test/integration/repository.test.ts` to exercise every Repository method's SQL against the real D1 schema via Miniflare.

---

## Test Isolation Model

Per `@cloudflare/vitest-pool-workers` isolation docs:

- **Storage is isolated per test file** — `repository.test.ts` gets its own D1 instance, completely separate from `login.test.ts`
- **Within a test file**, all tests share the same D1 state — data inserted in one `it.effect` is visible in subsequent tests
- `test/apply-migrations.ts` runs as a `setupFile` before each test file, so the schema (tables, indexes, code tables) is always present
- The admin seed (`id='admin', email='a@a.com', role='admin'`) from `0001_init.sql` is always present

Implication: tests within the file must either be order-independent (each test sets up its own data) or explicitly ordered. Prefer each test inserting what it needs and cleaning up or tolerating prior state.

---

## Dependency Chain

Repository requires D1, which requires CloudflareEnv. In production (`src/worker.ts:76–79`):

```ts
const envLayer = makeEnvLayer(env); // CloudflareEnv + ConfigProvider
const d1Layer = Layer.provideMerge(D1.layer, envLayer); // D1 ← CloudflareEnv
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer); // Repository ← D1
```

For tests, we need to construct the same chain using `env` from `cloudflare:workers`:

```ts
import { env } from "cloudflare:workers";
import { Layer, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import { Repository } from "@/lib/Repository";

const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
```

Note: we skip `ConfigProvider` since Repository doesn't use it.

### Using `layer()` from `@effect/vitest`

`layer()` constructs the layer once in `beforeAll`, tears it down in `afterAll`, and provides it to all `it.effect` tests:

```ts
import { layer } from "@effect/vitest";

layer(repositoryLayer)("Repository", (it) => {
  it.effect("getUser", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      // ...
    }),
  );
});
```

This is the idiomatic Effect v4 pattern for shared service setup in tests.

---

## Seeded Data

The migration seeds:

| Table   | id      | email     | role         |
| ------- | ------- | --------- | ------------ |
| User    | `admin` | `a@a.com` | `admin`      |
| Account | `admin` | —         | `credential` |

No Organization, Member, Session, Invitation, or Subscription rows are seeded.

---

## Test Data Setup Strategy

### Option A: Direct D1 inserts (preferred for Repository tests)

Since we're testing the Repository layer in isolation (not through the Worker fetch handler), we can insert test data directly via `env.D1`:

```ts
const insertUser = Effect.fn("insertUser")(function* (user: {
  id: string;
  name: string;
  email: string;
  role: string;
}) {
  yield* Effect.promise(() =>
    env.D1.prepare(
      "insert into User (id, name, email, role) values (?1, ?2, ?3, ?4)",
    )
      .bind(user.id, user.name, user.email, user.role)
      .run(),
  );
});
```

This is simpler and faster than going through the login server fn. It also avoids pulling in TanStack Start dependencies.

### Option B: Login server fn (like login.test.ts)

Using `runServerFn(login, { email: "u@u.com" })` creates a user + account + session + organization + member through Better Auth's full flow. This is convenient when you need a realistic user with all related rows, but it's heavyweight and couples Repository tests to the auth system.

### Recommendation

Use **Option A** (direct inserts) for most tests. This gives precise control over test data and makes tests independent of auth internals. Use Option B only if a test specifically needs the full auth-created graph (organization, member, session).

### Helper shape

```ts
const seed = {
  user: Effect.fn("seed.user")(function* (
    overrides?: Partial<{
      id: string;
      name: string;
      email: string;
      role: string;
      emailVerified: number;
      stripeCustomerId: string;
    }>,
  ) {
    const id = overrides?.id ?? crypto.randomUUID();
    const email = overrides?.email ?? `${id}@test.com`;
    yield* Effect.promise(() =>
      env.D1.prepare(
        "insert into User (id, name, email, role, emailVerified) values (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(
          id,
          overrides?.name ?? "Test User",
          email,
          overrides?.role ?? "user",
          overrides?.emailVerified ?? 0,
        )
        .run(),
    );
    return { id, email };
  }),

  organization: Effect.fn("seed.organization")(function* (
    overrides?: Partial<{
      id: string;
      name: string;
      slug: string;
    }>,
  ) {
    const id = overrides?.id ?? crypto.randomUUID();
    yield* Effect.promise(() =>
      env.D1.prepare(
        "insert into Organization (id, name, slug) values (?1, ?2, ?3)",
      )
        .bind(
          id,
          overrides?.name ?? "Test Org",
          overrides?.slug ?? `org-${id.slice(0, 8)}`,
        )
        .run(),
    );
    return { id };
  }),

  member: Effect.fn("seed.member")(function* ({
    userId,
    organizationId,
    role,
  }: {
    userId: string;
    organizationId: string;
    role: string;
  }) {
    const id = crypto.randomUUID();
    yield* Effect.promise(() =>
      env.D1.prepare(
        "insert into Member (id, userId, organizationId, role) values (?1, ?2, ?3, ?4)",
      )
        .bind(id, userId, organizationId, role)
        .run(),
    );
    return { id };
  }),

  // similar for session, invitation, subscription
};
```

---

## Repository Methods and Test Plan

### 1. `getUser(email)`

**SQL:** `select * from User where email = ?1`
**Returns:** `Option<User>` (via `Effect.catchNoSuchElement`)
**Tests:**

- existing user (`a@a.com`) → returns decoded User
- nonexistent email → returns `NoSuchElement` (left side of Either)

### 2. `getMemberByUserAndOrg({ userId, organizationId })`

**SQL:** `select * from Member where userId = ?1 and organizationId = ?2`
**Returns:** `Option<Member>`
**Setup:** insert user + org + member
**Tests:**

- matching userId+orgId → returns Member with correct role
- wrong orgId → NoSuchElement
- wrong userId → NoSuchElement

### 3. `getOwnerOrganizationByUserId(userId)`

**SQL:** `select o.* from Organization o where o.id in (select organizationId from Member where userId = ?1 and role = 'owner')`
**Returns:** `Option<Organization>`
**Setup:** insert user + org + member(role='owner')
**Tests:**

- user is owner of org → returns Organization
- user is member (not owner) → NoSuchElement
- user has no memberships → NoSuchElement

### 4. `initializeActiveOrganizationForUserSessions({ organizationId, userId })`

**SQL:** `update Session set activeOrganizationId = ?1 where userId = ?2 and activeOrganizationId is null`
**Returns:** D1 run result
**Setup:** insert user + org + session(activeOrganizationId=null)
**Tests:**

- session with null activeOrganizationId → gets updated
- session with existing activeOrganizationId → not overwritten (verify idempotency)

### 5. `getUsers({ limit, offset, searchValue? })`

**SQL:** JSON aggregate query with `like` filter, pagination, count
**Returns:** `{ users: User[], count, limit, offset }`
**Setup:** insert multiple users
**Tests:**

- no search → returns all users (including seeded admin), correct count
- search by email pattern → filters correctly
- pagination: limit=1, offset=0 → 1 user; offset=1 → next user
- empty result → `{ users: [], count: 0, ... }`

### 6. `getAppDashboardData({ userEmail, organizationId })`

**SQL:** JSON aggregate with subqueries for userInvitations (with org+inviter joins), memberCount, pendingInvitationCount
**Returns:** `{ userInvitations: InvitationWithOrganizationAndInviter[], memberCount, pendingInvitationCount }`
**Setup:** insert user + org + members + invitations (pending status)
**Tests:**

- org with members and pending invitations → correct counts and invitation details
- no invitations for user → empty array, counts still correct
- invitation with non-pending status → not included in userInvitations

### 7. `getAdminDashboardData()`

**SQL:** JSON aggregate counting customers (role='user'), active subscriptions, trialing subscriptions
**Returns:** `{ customerCount, activeSubscriptionCount, trialingSubscriptionCount }`
**Setup:** insert users (role='user') + subscriptions with various statuses
**Tests:**

- mix of active/trialing/canceled subscriptions → correct counts
- no subscriptions → all zeros (except admin user has role='admin', not counted)
- admin users not counted in customerCount

### 8. `getCustomers({ limit, offset, searchValue? })`

**SQL:** JSON aggregate of users (role='user') with left-joined subscription, pagination
**Returns:** `{ customers: UserWithSubscription[], count, limit, offset }`
**Setup:** insert users with role='user', some with subscriptions
**Tests:**

- user with subscription → subscription field populated
- user without subscription → subscription is null
- search filters by email
- pagination works
- admin users excluded (where role = 'user')

### 9. `getSubscriptions({ limit, offset, searchValue? })`

**SQL:** JSON aggregate joining Subscription + User on stripeCustomerId, pagination
**Returns:** `{ subscriptions: SubscriptionWithUser[], count, limit, offset }`
**Setup:** insert users with stripeCustomerId + matching subscriptions
**Tests:**

- subscription joined with user → correct user data nested
- search by user email
- pagination
- ordering by email asc, subscriptionId asc

### 10. `getSessions({ limit, offset, searchValue? })`

**SQL:** JSON aggregate joining Session + User, pagination
**Returns:** `{ sessions: SessionWithUser[], count, limit, offset }`
**Setup:** insert user + sessions
**Tests:**

- session with user data joined
- search by user email
- pagination
- ordering by email asc, createdAt asc

### 11. `updateInvitationRole({ invitationId, role })`

**SQL:** `update Invitation set role = ?1 where id = ?2`
**Returns:** D1 run result
**Setup:** insert user + org + invitation
**Tests:**

- updates role from 'member' to 'admin'
- verify by re-querying the invitation

### 12. `deleteExpiredSessions()`

**SQL:** `delete from Session where expiresAt < ?1` (where ?1 is `new Date().toISOString()`)
**Returns:** number of deleted rows (via `result.meta.changes`)
**Setup:** insert sessions with past and future expiresAt
**Tests:**

- expired sessions deleted, non-expired sessions kept
- returns correct count of deleted rows
- no expired sessions → returns 0

---

## Error Handling in Tests

Repository methods return `Effect.Effect<A, NoSuchElement | D1Error | ParseError>`. In `it.effect`, unhandled errors automatically fail the test with a pretty-printed cause.

For testing the "not found" path, use `Effect.either` or `Effect.option`:

```ts
it.effect("nonexistent user returns NoSuchElement", () =>
  Effect.gen(function* () {
    const repo = yield* Repository;
    const result = yield* repo
      .getUser("nonexistent@test.com")
      .pipe(Effect.either);
    expect(Either.isLeft(result)).toBe(true);
  }),
);
```

Or match on the specific error tag:

```ts
const result =
  yield *
  repo.getUser("nonexistent@test.com").pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.fail("should not succeed"),
      onFailure: (e) => Effect.succeed(e),
    }),
  );
expect(result._tag).toBe("NoSuchElementException");
```

---

## Structural Considerations

### Test file structure

```ts
import { env } from "cloudflare:workers";
import { Effect, Either, Layer, ServiceMap } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vitest";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import { Repository } from "@/lib/Repository";

const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);

// seed helpers here

layer(repositoryLayer)("Repository", (it) => {
  // all tests go here, Repository is available via `yield* Repository`
});
```

### Cleanup between tests

Since tests share D1 state within a file, two strategies:

1. **Insert unique data per test** — use `crypto.randomUUID()` for IDs and unique emails so tests don't collide. This is the simplest approach and allows tests to run in any order.

2. **Reset before each test** — a `beforeEach` that deletes non-seed data. The existing `resetDb` from TestUtils does this but uses Effect.fn which can't run in a plain `beforeEach`. Could wrap in `Effect.runPromise` or use raw D1 calls.

**Recommendation:** Strategy 1 (unique data per test). It's simpler, avoids cleanup coordination, and matches the per-test isolation philosophy.

### `deleteExpiredSessions` and time

This method calls `new Date().toISOString()` inside the Effect. With `it.effect`, `TestClock` is available but `new Date()` still uses the real system clock (TestClock controls Effect's `Clock` service, not the JS global). This is fine — just insert sessions with expiresAt far in the past and far in the future to avoid flakiness.

---

## Resolved Questions

1. **`layer()` from `@effect/vitest` in cloudflare pool** — Should work. `@effect/vitest` imports standard `vitest`; the cloudflare pool should resolve it. Fall back to manual `Effect.provide` if it doesn't.

2. **D1 foreign key enforcement** — Foreign keys ARE enforced in Miniflare. Seed helpers must insert parent rows first (User before Session, Organization before Member, etc.).

3. **Schema.decodeUnknownEffect error messages** — Out of scope. Parse errors from mismatched SQL/schema are a feature, not a bug to handle.
