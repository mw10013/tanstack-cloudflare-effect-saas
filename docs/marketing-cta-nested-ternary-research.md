# Marketing CTA Nested Ternary Research

> Context: `src/routes/_mkt.index.tsx`
> Date: 2026-03-12

## Problem

After replacing the hero CTA from `Button render={<a />}` with semantic `Link` elements, the conditional render shape became a nested ternary.

Example shape:

```tsx
{sessionUser ? (
  sessionUser.role === "admin" ? <Link to="/admin">...</Link> : <Link to="/app">...</Link>
) : (
  <Link to="/login">...</Link>
)}
```

Oxlint then reported:

- `eslint(no-nested-ternary)`
- `unicorn/no-nested-ternary`

## Why the lint fired

The branch structure had two decisions inside one expression:

```text
sessionUser?
├─ no  -> login CTA
└─ yes -> role?
         ├─ admin -> admin CTA
         └─ user  -> app CTA
```

That is a nested ternary even though the JSX is small.

## Options considered

### 1. Keep nested JSX ternary

Rejected.

- shortest inline form
- fails `no-nested-ternary`

### 2. Store JSX in a variable

Works, but looks indirect.

```tsx
let cta = <Link to="/login">Get Started</Link>;
if (sessionUser) {
  cta = <Link to={sessionUser.role === "admin" ? "/admin" : "/app"}>Go to Dashboard</Link>;
}
```

Tradeoff:

- lint-clean
- pushes JSX assignment into local state-like flow
- name invites questions like whether there is also a secondary CTA

### 3. Extract helper function returning JSX

Works, but also feels heavier than needed for one small branch.

```tsx
function renderCta() { ... }
```

Tradeoff:

- lint-clean
- moves the branch out of the component body
- adds another local abstraction for one use

### 4. Compute data, render once

Recommended.

Compute only the changing values, then render a single `Link`.

```text
defaults
├─ to = "/login"
└─ label = "Get Started"

if sessionUser
├─ to = role === "admin" ? "/admin" : "/app"
└─ label = "Go to Dashboard"

render one <Link />
```

Implementation shape:

```tsx
let cta: { to: "/login" | "/admin" | "/app"; label: string } = {
  to: "/login",
  label: "Get Started",
};

if (sessionUser) {
  cta = {
    to: sessionUser.role === "admin" ? "/admin" : "/app",
    label: "Go to Dashboard",
  };
}

<Link to={cta.to} className={buttonVariants({ ... })}>
  {cta.label}
</Link>
```

Why this is the best fit here:

- keeps JSX to one `Link`
- avoids duplicated `buttonVariants(...)`
- avoids nested ternary lint
- keeps the changing parts explicit: destination + label

## Naming note

Use `cta`, not `primaryCta`.

Reason:

- there is no separate `secondaryCta` variable
- `cta` is enough for the single computed hero action

## Decision

For this route, prefer:

- compute CTA data in local variables/object
- render one semantic `Link`
- avoid nested ternaries in JSX

Do not introduce a helper function or JSX-valued local unless the branch grows materially.
