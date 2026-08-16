# PRESENTER CONSOLE GUIDE

## OVERVIEW

Private React/Vite controller for authentication, session setup, audio consent, and supervised
live-publication approval.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Routes and private UI | `src/App.tsx` | Auth guards, approval, co-resident interlock |
| Private API transport | `src/session-client.ts` | Credentials, CSRF, authoritative snapshots |
| Audio lifecycle | `src/audio-capture.tsx` | Consent, stream setup, teardown |
| PWA boot/update | `src/main.tsx`, `src/registerServiceWorker.ts` | App entry and SW registration |
| Security/build policy | `vite.config.ts` | Shared UI Vite plugins |

## CONVENTIONS

- Mutating requests remain credentialed, exact-origin, and CSRF-protected.
- Live approval uses a fresh authoritative candidate snapshot and all CAS/version fields.
- Clear a loaded snapshot after publication success or rejection; require an explicit reload.
- Subscribe to lifecycle/browser events before triggering actions and remove listeners on cleanup.
- Audio capture is consent-driven; close tracks and remote streams on stop, revoke, and failure.
- Co-resident mode fails closed if any private pixel is observed on the public surface.

## ANTI-PATTERNS

- Never persist authorization codes, CSRF tokens, transcripts, or private evidence in URLs/logs.
- Never auto-publish a live candidate or reuse a stale authoritative snapshot.
- Never let Console force fullscreen or window placement on Stage.
- Never weaken the no-private-pixel interlock for duplicate-display convenience.
- Never import model routing, AI providers, or server implementation modules.

## CHECKS

```bash
bun test apps/console/src
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
bun run check:browser-boundary
```
