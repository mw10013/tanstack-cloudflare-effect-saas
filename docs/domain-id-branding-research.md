# Domain ID Branding Research

Research for branding ID fields in `src/lib/Domain.ts` with Effect v4 schemas.

## Recommendation

- Brand the app-level IDs in `src/lib/Domain.ts`.
- Use one schema per semantic ID, then reuse it for foreign keys.
- Keep TanStack Router params, search params, and Better Auth payloads as string boundaries.
- Decode to branded IDs at server-function, repository, and domain boundaries instead of trying to make every React prop branded.

## Effect v4 Grounding

Effect's brand model is nominal typing layered on top of an existing schema.

From `refs/effect4/ai-docs/src/51_http-server/fixtures/domain/User.ts`:

```ts
export const UserId = Schema.Int.pipe(
  Schema.brand("UserId")
)

export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String
}) {}
```

From `refs/effect4/packages/effect/dtslint/schema/Schema.tst.ts`:

```ts
const schema = Schema.String.pipe(Schema.brand("a"))
expect(Schema.revealCodec(schema)).type.toBe<
  Schema.Codec<string & Brand.Brand<"a">, string, never, never>
>()
```

Takeaway:

- `Schema.brand("UserId")` changes the decoded `Type` to a branded string.
- The encoded/input side stays `string`.
- For `Schema.NonEmptyString.pipe(Schema.brand("UserId"))`, runtime validation is still the `NonEmptyString` validation you already have; the brand adds semantic separation at the type level.

Effect also exposes lower-level brand constructors in `refs/effect4/packages/effect/src/Brand.ts`:

```ts
export type Branded<A, Key extends string> = A & Brand<Key>

export function nominal<A extends Brand<any>>(): Constructor<A>
export function check<A extends Brand<any>>(...checks: ...): Constructor<A>
```

And schema-level integration for checked brands in `refs/effect4/packages/effect/dtslint/schema/Schema.tst.ts`:

```ts
type Int = number & Brand.Brand<"Int">
const Int = Brand.check<Int>(Schema.isInt())
const schema = Schema.Number.pipe(Schema.fromBrand("Int", Int))
```

Takeaway:

- `Schema.brand(...)` is the simplest fit for the current `Domain.ts` IDs.
- `Brand.check` + `Schema.fromBrand(...)` is for cases where the brand itself adds extra runtime rules.
- The current IDs already have their runtime rule: non-empty string.

## What In `Domain.ts` Benefits Most

Today these fields are plain `Schema.NonEmptyString` in `src/lib/Domain.ts`:

```ts
export const Invitation = Schema.Struct({
  id: Schema.NonEmptyString,
  inviterId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
})

export const User = Schema.Struct({
  id: Schema.NonEmptyString,
})

export const Session = Schema.Struct({
  id: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  impersonatedBy: Schema.NullOr(Schema.NonEmptyString),
  activeOrganizationId: Schema.NullOr(Schema.NonEmptyString),
})

export const Member = Schema.Struct({
  id: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
})

export const Organization = Schema.Struct({
  id: Schema.NonEmptyString,
})

export const Subscription = Schema.Struct({
  id: Schema.NonEmptyString,
  referenceId: Schema.NonEmptyString,
})
```

High-confidence candidates:

- `User.id` -> `UserId`
- `Organization.id` -> `OrganizationId`
- `Invitation.id` -> `InvitationId`
- `Member.id` -> `MemberId`
- `Session.id` -> `SessionId`
- `Subscription.id` -> `SubscriptionId`
- Foreign keys should reuse those same schemas: `inviterId`, `organizationId`, `userId`, `impersonatedBy`, `activeOrganizationId`

Lower-confidence candidates:

- `Subscription.referenceId` looks like an external/plugin-level reference, not obviously a dedicated domain ID.
- `Plan.productId`, `monthlyPriceId`, `annualPriceId`, `stripeCustomerId`, `stripeSubscriptionId` are Stripe IDs, so they should not be conflated with app entity IDs.

These should not be branded.

## Proposed Shape

Smallest useful pattern:

```ts
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const OrganizationId = Schema.NonEmptyString.pipe(Schema.brand("OrganizationId"))
export type OrganizationId = typeof OrganizationId.Type

export const User = Schema.Struct({
  id: UserId,
  // ...
})

export const Member = Schema.Struct({
  id: MemberId,
  userId: UserId,
  organizationId: OrganizationId,
  // ...
})
```

Why this is enough:

- It prevents accidental swaps like `UserId` passed where `OrganizationId` is expected.
- It composes naturally with existing `Schema.Struct` definitions.
- It keeps encoded values as plain strings, which matters for UI and transport boundaries.

## Summary

- Low impact if branding stops at domain/service boundaries.
- Medium impact if branding is pushed through route params and React props.
- Highest friction is not rendering; it is ingress from router params and Better Auth APIs.

Important nuance:

- once a value has been decoded into `string & Brand.Brand<...>`, it is still usable anywhere a plain `string` is accepted
- the costly direction is raw `string` -> branded ID, not branded ID -> string consumer

## Where The UI Is String-Shaped Today

### TanStack Router params and local UI props

`src/routes/app.$organizationId.tsx` uses raw string validators and string props:

```ts
const switchOrganizationServerFn = createServerFn({ method: "POST" })
  .inputValidator((organizationId: string) => organizationId)

const beforeLoadServerFn = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)

function AppSidebar({ organizationId }: { organizationId: string })

function ActivityFeed({ organizationId }: { organizationId: string })
```

`src/lib/Activity.ts` also treats the ID as a string cache key:

```ts
export const activityQueryKey = (organizationId: string) =>
  ["organization", organizationId, "activity"] as const
```

Impact:

- TanStack route params are path strings.
- If `OrganizationId` becomes branded in the domain, `Route.useParams().organizationId` still starts life as `string`.
- Recommendation: keep route-param land stringly typed, decode once when handing data to server/domain code.

### Search params are also string-shaped

`src/routes/app.$organizationId.invoices.index.tsx` keeps selection in URL/search state:

```ts
const invoiceSearchSchema = Schema.Struct({
  selectedInvoiceId: Schema.optional(Schema.String),
})

const [pendingSelectedInvoiceId, setPendingSelectedInvoiceId] =
  React.useState<string | null>(null)

const setSelectedInvoiceId = React.useCallback(
  (invoiceId: string | undefined) => {
```

Impact:

- URL search params are a poor place to force branded values.
- Branding here adds conversions with limited benefit.
- Recommendation: keep search params encoded as strings; decode only when crossing into domain operations.

### Better Auth payloads are external string payloads

`src/routes/app.$organizationId.tsx` uses Better Auth inferred types directly:

```ts
function AppSidebar({
  organization,
  organizations,
}: {
  organization: AuthInstance["$Infer"]["Organization"]
  organizations: AuthInstance["$Infer"]["Organization"][]
})
```

Other UI routes also consume Better Auth API results directly:

- `auth.api.listOrganizations(...)`
- `auth.api.listMembers(...)`
- `auth.api.listInvitations(...)`
- `auth.api.listActiveSubscriptions(...)`

Impact:

- Branding `Domain.ts` alone will not automatically brand those returned IDs.
- If you want branded IDs after those calls, you need an explicit decode/adapter layer.
- Without that adapter, the UI will remain partly branded, partly raw-string.

This is the main reason to avoid an all-the-way-through-React branding migration as a first step.

## Why The UI Cost Is Lower Than It Looks

For branded string schemas, encoded values stay plain strings.

That matters because current form/server-function patterns already lean on encoded input types. Example from `src/routes/app.$organizationId.invitations.tsx`:

```ts
const inviteSchema = Schema.Struct({
  organizationId: Domain.Organization.fields.id,
  // ...
})

const defaultValues = {
  organizationId,
  emails: "",
  role: "member",
} satisfies typeof inviteSchema.Encoded
```

Combined with Effect's branded codec shape:

```ts
Schema.Codec<string & Brand.Brand<"a">, string, never, never>
```

Takeaway:

- UI callers usually send encoded/input values.
- For branded string IDs, encoded/input stays `string`.
- The handler/domain side gets the branded `Type` after decode.

So server functions that already validate with domain schemas are good boundaries for adopting branding with minimal UI churn.

## Best Boundary To Introduce Brands

Best first boundary:

- `Schema.toStandardSchemaV1(...)` server-function validators
- repository method parameters
- internal helpers like `getOrganizationAgentStub(organizationId: Organization["id"])`

Examples already aligned with this approach:

```ts
const organizationIdSchema = Schema.Struct({ organizationId: Domain.Organization.fields.id })

const removeMemberSchema = Schema.Struct({
  organizationId: Domain.Organization.fields.id,
  memberId: Domain.Member.fields.id,
})
```

Those appear in:

- `src/routes/app.$organizationId.members.tsx`
- `src/routes/app.$organizationId.index.tsx`
- `src/routes/app.$organizationId.billing.tsx`
- `src/routes/admin.users.tsx`

These routes are already close to the ideal shape: raw input in, decoded domain types inside the handler.

## Places That Would Need Follow-Up

If ID branding is added in `Domain.ts`, these areas likely deserve follow-up review:

- `src/routes/app.$organizationId.tsx` because it still uses ad-hoc `(organizationId: string) => organizationId` validators
- `src/routes/app.$organizationId.invitations.tsx` loader input, which still uses `(data: { organizationId: string }) => data`
- any UI helper intentionally typed as `string` for cache keys, URL state, or router params
- Better Auth result handling when you want app-domain semantics instead of external payload semantics

## Practical Recommendation

If you do this later, the lowest-friction rollout is:

1. Introduce branded ID schema constants in `src/lib/Domain.ts`.
2. Replace `id` and foreign-key fields in domain structs with those constants.
3. Keep router/search/auth edges string-based.
4. Let server-function validators and repository/domain APIs perform the decode into branded types.
5. Only add UI-level branded props where the value is already domain-decoded and the distinction buys real safety.

That gets most of the value:

- fewer accidental ID mixups in server/domain code
- almost no rendering changes
- limited churn in TanStack Router and Better Auth integration points

## Adjacent Note

`src/lib/OrganizationDomain.ts` has the same plain-string pattern for `Invoice.id` and `InvoiceItem.invoiceId`. Same idea applies there, but it is separate from the `Domain.ts` scope.
