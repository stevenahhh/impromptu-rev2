# MODEL ROUTER GUIDE

## OVERVIEW

Server-only TypeScript library for policy-mediated model dispatch, adapter isolation, deadlines,
budgets, streaming, and typed provenance.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Dispatch lifecycle | `src/router.ts` | Unary/streaming policy and reconciliation |
| Adapter isolation | `src/isolation.ts` | Permissioned child process |
| Trusted context | `src/context.ts` | WeakSet-branded authority |
| Policy and egress | `src/policy.ts`, `src/security.ts` | Exact destinations and budgets |
| Ports/contracts | `src/ports.ts`, `src/schemas.ts` | Typed provider boundary |
| Deterministic tests | `src/testing.ts`, `test/` | Fakes and manual scheduling |

## CONVENTIONS

- Require a trusted branded model context before dispatch.
- Evaluate policy, quota, and budget before invoking an adapter.
- Validate adapter inputs and outputs with typed schemas.
- Run production adapters in the permissioned isolate with a scrubbed environment.
- Provide credentials only through mediated, revocable transport; adapters never receive raw keys.
- Restrict egress to exact HTTPS origins and safe relative paths.
- Reconcile actual budget after dispatch and clean cancellation/stream resources on every terminal path.
- Tests use deterministic adapters and manual time rather than wall-clock waits.

## ANTI-PATTERNS

- Never expose this package to browser bundles or import it from Console/Stage.
- Never register a production adapter as an in-process deterministic fake.
- Never pass arbitrary URLs, credential headers, or unrestricted process environment to adapters.
- Never return unvalidated provider payloads or omit provenance/policy metadata.
- Never leak prompts/content into telemetry beyond the required audit metadata.

## CHECKS

```bash
bun test services/model-router
bun run typecheck
bun run check:browser-boundary
```
