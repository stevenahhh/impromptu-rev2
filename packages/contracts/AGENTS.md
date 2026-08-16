# CONTRACTS PACKAGE GUIDE

## OVERVIEW

Highest-blast-radius shared API package: role-scoped Zod wire contracts consumed across services,
state, browsers, tests, and harnesses.

## WHERE TO LOOK

| Surface | Entry | Typical consumers |
|---|---|---|
| Public projection | `src/public.ts` | Stage, gateway, state |
| Private authority | `src/private.ts` | Private backend |
| Controller protocol | `src/control.ts` | Console, authority |
| Retrieval | `src/retrieval.ts` | Private retrieval/recommendation |
| Cross-role primitives | `src/shared.ts` | Explicitly safe shared values |
| Export enforcement | `tests/contract/import-boundaries.test.ts` | Resolution and leak checks |

## CONVENTIONS

- Define boundary values as strict Zod schemas and derive types with `z.infer`.
- Keep objects closed and discriminated unions exhaustive.
- Use branded/validated identifiers for role- and session-sensitive values.
- Preserve explicit revisions, epochs, policy versions, hashes, and typed failure variants.
- Export through declared package subpaths; the package root intentionally maps to public only.
- Treat changes to `public` and `private` as cross-cutting API migrations.

## ANTI-PATTERNS

- Never export private/control symbols from the root or public surface.
- Never import implementation files through undeclared package subpaths.
- Never make boundary objects permissive to ease one caller.
- Never replace machine-consumed enums/discriminants with prose.
- Never add a field without updating owning consumers and contract/property tests.

## CHECKS

```bash
bun test tests/contract
bun test tests/property
bun run typecheck
```
