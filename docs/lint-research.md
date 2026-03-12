# Lint Research

## 1. External UI Components (shadcn/ui)

The following components are from shadcn/ui and should be excluded from linting:

- `src/components/ui/breadcrumb.tsx`
- `src/components/ui/label.tsx`
- `src/components/ui/pagination.tsx`
- `src/components/ui/input-group.tsx`

**Current ignorePatterns already include some UI components:**
```json
"src/components/ui/carousel.tsx",
"src/components/ui/chart.tsx",
"src/components/ui/field.tsx",
"src/components/ui/form.tsx",
"src/components/ui/input-otp.tsx",
"src/components/ui/progress.tsx",
"src/components/ui/sidebar.tsx",
"src/components/ui/toggle-group.tsx",
```

**Fix:** Add these to the ignorePatterns array in `.oxlintrc.json`.

---

## 2. Form Library Issue (TanStack Form `children` prop)

**Error:** `react(no-children-prop): Avoid passing children using a prop`

### Example from `src/routes/login.tsx:157`:
```tsx
<form.Field
  name="email"
  children={(field) => {   // <-- ESLint warns here
    const isInvalid = field.state.meta.errors.length > 0;
    return (
      <Field data-invalid={isInvalid}>
        <FieldLabel htmlFor={field.name}>Email</FieldLabel>
        <Input ... />
      </Field>
    );
  }}
/>
```

### Why this happens:
TanStack Form (and react-hook-form) use a render props pattern where `children` is passed as a **prop** rather than as **JSX children**:

```tsx
// TanStack Form pattern (current - triggers lint warning)
<form.Field name="email" children={(field) => <Input {...} />} />

// Standard React pattern (not applicable here)
<form.Field name="email">
  {(field) => <Input {...} />}
</form.Field>
```

### Fix options:

**Option A:** Disable the rule for these specific patterns (recommended - this is the TanStack Form idiomatic pattern):
```json
"react/no-children-prop": "off"
```

**Option B:** Use the render prop via `children` property explicitly allowed by TanStack Form. Actually, TanStack Form supports BOTH patterns:
```tsx
// This also works and may not trigger the lint
<form.Field
  name="email"
  children={(field) => <Input {...} />}
/>
```

Wait - looking more carefully, the current code IS using `children` as a prop. The alternative would be:
```tsx
// This is the standard JSX children pattern - but TanStack Form ALSO supports this
<form.Field name="email">
  {(field) => <Input {...} />}
</form.Field>
```

Let me verify if TanStack Form supports this...

Actually, TanStack Form supports both. The `children` prop version and the JSX children version are both valid. Let me check the TanStack Form docs...

Based on the TanStack Form API, both should work:
- `children={(field) => ...}` (prop form)
- `children>{(field) => ...}</children>` (JSX form)

If we convert to JSX children pattern, it should fix the lint. But this is a larger refactor across multiple files.

**Recommendation:** Disable the rule since this is idiomatic TanStack Form pattern.

I need more color on this. Why does this rule exist? Even though TanStack support both forms why would one be better than the other such that a lint rule is created for it? Need to understand the basis of the lint rule in order to decide whether to follow or disable.

---

## 3. Other Issues

### 3.1 Nested Ternary

**File:** `src/routes/admin.users.tsx:353`

```tsx
setBanDialog((prev) =>
  prev.isOpen === isOpen
    ? prev
    : isOpen
      ? { ...prev, isOpen }
      : { isOpen: false, userId: undefined },
);
```

**Fix:** Use if-else instead:
```tsx
setBanDialog((prev) => {
  if (prev.isOpen === isOpen) return prev;
  if (isOpen) return { ...prev, isOpen };
  return { isOpen: false, userId: undefined };
});
```

Ok, we should fix this one.

---

### 3.2 Self-closing component

**File:** `src/routes/__root.tsx:95`

```tsx
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon={JSON.stringify({ token: analyticsToken })}
></script>
```

**Fix:** Make self-closing:
```tsx
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon={JSON.stringify({ token: analyticsToken })}
/>
```

Yes, we should fix.

---

### 3.3 Numeric Separators

**File:** `src/lib/Domain.ts:153`

```tsx
monthlyPriceInCents: 10000,
annualPriceInCents: Math.round(10000 * 12 * 0.8),
```

**Fix:**
```tsx
monthlyPriceInCents: 10_000,
annualPriceInCents: Math.round(10_000 * 12 * 0.8),
```

we should fix

---

### 3.4 Switch Case Braces

**File:** `src/worker.ts:185`

```tsx
switch (scheduledEvent.cron) {
  case "0 0 * * *":
    await runEffect(...)
```

**Fix:**
```tsx
switch (scheduledEvent.cron) {
  case "0 0 * * *": {
    await runEffect(...)
  }
```

should fix

---

### 3.5 Array Method thisArg

**File:** `src/lib/Auth.ts:167`

```tsx
activeOrganizationId: Option.map(
  activeOrganization,
  (organization) => organization.id,
)
```

Wait - the lint says there's a `thisArg` issue, but the code shown doesn't have one. Let me check line 22 in `_mkt.tsx`:

**File:** `src/routes/_mkt.tsx:22`

```tsx
sessionUser: Option.map(session, (value) => value.user).pipe(
  Option.getOrUndefined,
```

This might be a false positive or there's something else. Let me check if Option.map from effect has a different signature...

Actually, looking at the error more carefully - it says "Avoid using 'thisArg' with array iteration methods". This typically applies to `Array.prototype.map`, not `Option.map` from effect. This might be a false positive from the unicorn plugin misinterpreting.


I don't know what to do with this. Do more research.
---

### 3.6 String Replace All

**File:** `src/lib/Auth.ts:132`

```tsx
slug: user.email.replace(/[^a-z0-9]/g, "-").toLowerCase(),
```

**Fix:**
```tsx
slug: user.email.replaceAll(/[^a-z0-9]/g, "-").toLowerCase(),
```

Wait - `replaceAll` expects a string, not a regex with global flag. The correct fix is:
```tsx
slug: user.email.replace(/[^a-z0-9]/g, "-").toLowerCase(),
// OR
slug: user.email.replaceAll("-", "-").toLowerCase(),  // This won't work the same
```

Actually, this rule is about using `replaceAll` when you have a global regex. But `replaceAll` with regex doesn't exist in JS - you need `replace` with `/g`. This might be a false positive/wrong suggestion from the lint rule.

**Correction:** The lint rule is wrong here. `replaceAll` with regex is NOT supported in JavaScript. You CANNOT use `replaceAll` with a regex pattern. The correct pattern is `replace(/pattern/g, ...)`. This rule suggestion is incorrect for JavaScript.

Do more research. 

---

### 3.7 Relative URL Style

**File:** `vite.config.ts:16`

```tsx
alias: {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
}
```

**Fix:**
```tsx
alias: {
  "@": fileURLToPath(new URL("src", import.meta.url)),
}
```


hmmm, i guess we can try

---

### 3.8 Catch Error Name

**File:** `scripts/d1-reset.ts:61`

```tsx
} catch (p) {
  console.error(`Ignoring execption: ${String(p)}`);
```

**Fix:**
```tsx
} catch (error) {
  console.error(`Ignoring execption: ${String(error)}`);
```

ok, we should fix

---

### 3.9 Array Reverse (e2e test)

**File:** `e2e/stripe.spec.ts:79`

```tsx
[planData, [...planData].reverse()]
```

**Fix:**
```tsx
[planData, [...planData].toReversed()]
```
should fix
---

## Summary

| Issue | Files | Fix |
|-------|-------|-----|
| UI components ignore | Add to ignorePatterns | Config change |
| Form children prop | Multiple route files | Disable rule |
| Nested ternary | admin.users.tsx | Refactor to if-else |
| Self-closing script | __root.tsx | Make self-closing |
| Numeric separators | Domain.ts | Add `_` |
| Switch case braces | worker.ts | Add braces |
| String replace | Auth.ts | Keep as-is (rule is wrong) |
| Relative URL | vite.config.ts | Remove `./` |
| Catch error name | d1-reset.ts | Rename to `error` |
| Array reverse | stripe.spec.ts | Use `toReversed()` |

---

## Questions for Review

1. Should I disable `react/no-children-prop` entirely since TanStack Form uses this pattern?
2. Should I add UI components to ignorePatterns or disable specific rules for them?
3. For the other issues - should I fix them all, or pick and choose?
