# UI PACKAGE GUIDE

## OVERVIEW

Shared React primitives, styles, controlled update coordinator, and Vite plugins for secure,
app-scoped offline shells.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Components | `src/` | Shared accessible primitives |
| Public exports | `src/index.ts` | Components and update coordinator |
| Shared styling | `src/styles.css` | Console/Stage visual system |
| Update activation | `src/UpdateCoordinator.ts` | Explicit handshake |
| Offline shell | `vite/offlineShell.ts` | Hashed app-scoped precache |
| Security headers | `vite/securityHeaders.ts` | CSP and browser headers |

## CONVENTIONS

- Keep components semantic, labeled, keyboard reachable, and forced-colors compatible.
- Preserve one-main/one-h1 route structure in consuming apps.
- Respect reduced motion and avoid motion-dependent meaning.
- Offline caches are app-scoped and content-versioned.
- Navigation remains network-first with app-scoped fallback.
- Service-worker activation occurs only after the explicit coordinator handshake.
- CSP/security headers remain shared so Console and Stage cannot drift.

## ANTI-PATTERNS

- Never search global caches, call `skipWaiting` automatically, or claim clients automatically.
- Never add model/provider dependencies or browser-visible credentials.
- Never weaken `frame-ancestors 'none'` or provider-origin restrictions.
- Never expose app-specific private/public data through generic components.
- Never change shipped offline copy without validating both app builds/runtime behavior.

## CHECKS

```bash
bun test packages/ui
bun run --cwd packages/ui typecheck
bun run --cwd packages/ui build
bun run check:browser
```
