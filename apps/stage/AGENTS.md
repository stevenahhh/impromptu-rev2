# PUBLIC STAGE GUIDE

## OVERVIEW

Public-only React/Vite projection surface owning display join, topology, realtime reconciliation,
offline verification, and local expiry.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Display lifecycle and rendering | `src/App.tsx` | Topology, SSE/WSS, leases, reconciliation |
| Public transport boundary | `src/stage-client.ts` | Snapshot/event parsing, hashes, signatures |
| Windows display behavior | `src/windows-topology.ts` | Extend/duplicate/recovery |
| PWA boot/update | `src/main.tsx`, `src/registerServiceWorker.ts` | Entry and SW registration |
| Security/build policy | `vite.config.ts` | CSP and offline-shell plugins |

## CONVENTIONS

- Parse every snapshot/event as a closed public schema before use.
- Verify snapshot hashes and signed offline packages before rendering.
- Apply only contiguous revisions under the full session, epoch, deck, and occurrence identity.
- Hide cards on stale events, gaps, epoch changes, policy mismatch, expiry, or uncertainty.
- Keep SSE and WebSocket behavior equivalent; retain HTTP receipt fallback.
- Install event listeners/subscriptions before triggering; clear listeners, subscriptions, and
  lease timers on teardown/reconnect.
- Fullscreen and target-screen placement require local user action and recover safely on loss.

## ANTI-PATTERNS

- Never import private contracts, private backend, storage clients, model routing, or AI providers.
- Never render private notes, transcripts, candidates, credentials, or controller state.
- Never optimistically accept an invalid signature, stale revision, or missing reconciliation pin.
- Never turn a connection partition into retained live-card visibility.
- Never use global cache search, forced service-worker activation, or automatic client claiming.

## CHECKS

```bash
bun test apps/stage/src
bun run --cwd apps/stage typecheck
bun run --cwd apps/stage build
bun run check:browser-boundary
```
