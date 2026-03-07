# Deprecated: request + session combined research

This document is deprecated.

The combined analysis mixed two separate design problems and overstated some Effect memoization implications for lazy `Session`.

Use these replacement docs instead:

- `docs/request-effect-service-research.md`
- `docs/session-effect-service-research.md`

Why split them:

- `Request` has a straightforward request-scoped service path, but must account for the worker `scheduled()` path where no HTTP request exists.
- `Session` has different constraints: fetch timing, memoization per `runEffect` vs per HTTP request, and whether lazy loading preserves current behavior.

Treat the request research as the implementation candidate to evaluate first.
