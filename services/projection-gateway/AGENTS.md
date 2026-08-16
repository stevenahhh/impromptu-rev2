# PROJECTION GATEWAY GUIDE

## OVERVIEW

Public-only Bun gateway for display joins, bindings, playback/cards, snapshots, realtime fan-out,
and Stage-applied receipts.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Public projection state | `src/prepared-evidence.ts` | Epochs, revisions, cards, snapshots |
| HTTP boundary | `src/http.ts` | Exact origins, cookies, closed DTOs |
| Realtime protocol | `src/realtime.ts` | WebSocket commands and receipts |
| Public storage port | `src/ports/public-projection.ts` | Narrow public persistence |
| Architecture enforcement | `test/support/architecture-scanner.ts` | Import/package checks |
| Runnable boundary check | `test/check-architecture.ts` | Root `check:boundaries` target |

## CONVENTIONS

- Keep the service independent of private backend implementation and data.
- Accept only closed public DTOs under exact-origin/cookie/internal-auth boundaries.
- Validate display binding, session/deck epochs, revisions, policy, occurrence, and live lease.
- Apply contiguous causal revisions; reconcile gaps and hide stale/uncertain cards.
- Treat tombstones as terminal and snapshots as validated public state.
- Maintain SSE/WebSocket parity and authenticated Stage receipt handling.
- Package entrypoints remain executable `./` paths inside `src`.

## ANTI-PATTERNS

- Never import or depend on `@impromptu/private-backend`.
- Never use relative/path-alias imports that escape `src`, symlinks, `require`, import-equals, or
  nonliteral dynamic/import-type expressions.
- Never add private contracts, storage paths, secrets, transcripts, candidates, or RAG access.
- Never weaken epoch/revision/live-card freshness checks.
- Never accept malformed manifests or permissive partial request objects.

## CHECKS

```bash
bun run check:boundaries
bun test services/projection-gateway
bun run --cwd services/projection-gateway typecheck
```
