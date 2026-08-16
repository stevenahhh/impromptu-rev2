# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-16T14:53:14Z
**Commit:** 7143229
**Branch:** main

## OVERVIEW

Presentation-assistance PWA with a private Presenter Console, public Stage, Bun services, and a
Python ingestion worker. Security topology is the primary architectural axis: private authority,
public projection, and browser-safe deterministic behavior remain separate.

## STRUCTURE

```text
apps/                  # Console and Stage browser PWAs
services/              # Private authority, public gateway, model routing, ingestion
packages/              # Role-scoped contracts, reducers, UI, slide runtime, test helpers
infra/                 # Three-way database topology and migrations
tests/                 # Cross-cutting contract, security, property, E2E, DB, release gates
scripts/               # Repository and browser-boundary validators
docs/                  # Product, security, accessibility, operations
config/                # Browser dependency denylist
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Private sessions, approval, retrieval | `services/private-backend` | Private/control authority |
| Public display state and realtime | `services/projection-gateway` | Must remain private-backend independent |
| Model execution and policy | `services/model-router` | Server-only library, not a deployable service |
| PPTX/PDF ingestion and render | `services/ingestion` | Python 3.14 + uv |
| Wire schemas and role surfaces | `packages/contracts` | Highest cross-workspace blast radius |
| Replayable state transitions | `packages/state` | Reducer and reconciliation choke point |
| Browser design/build helpers | `packages/ui` | Shared by both PWAs |
| Cross-boundary verification | `tests` | Unit tests also live beside owners |
| Browser/source policy checks | `scripts`, `config` | Custom TypeScript verifiers |

## CODE MAP

| Symbol | Type | Location | Role |
|---|---|---|---|
| `PreparedEvidenceCoordinator` | class | `services/private-backend/src/prepared-evidence.ts` | Private session and publication authority |
| `PreparedEvidenceProjectionGateway` | class | `services/projection-gateway/src/prepared-evidence.ts` | Public projection state and fan-out |
| `createPrivateBackendHandler` | function | `services/private-backend/src/http.ts` | Authenticated private HTTP boundary |
| `createProjectionGatewayHandler` | function | `services/projection-gateway/src/http.ts` | Public/internal projection HTTP boundary |
| `createProjectionRealtimeProtocol` | function | `services/projection-gateway/src/realtime.ts` | WebSocket commands and receipts |
| `ServerModelRouter` | class | `services/model-router/src/router.ts` | Policy-mediated model dispatch |
| `createConsoleSessionClient` | function | `apps/console/src/session-client.ts` | Private browser transport |
| `createStageSessionClient` | function | `apps/stage/src/stage-client.ts` | Public browser transport and verification |
| `main` | function | `services/ingestion/src/impromptu_ingestion/cli.py` | Ingestion CLI |

LSP was unavailable during generation (`typescript-language-server` not installed); code-map
centrality was established with ast-grep/import tracing and repository tests.

## CONVENTIONS

- Bun workspace, ESM TypeScript, strict options including unchecked indexing and exact optionals.
- Biome: 2 spaces, 100 columns, double quotes, semicolons.
- Boundary data uses closed Zod/Pydantic schemas; exported types derive from schemas.
- Domain transitions return explicit uppercase outcome unions and preserve rejection reasons.
- Validate untrusted input at transport/storage boundaries and fail closed.
- Behavioral changes start with a failing test; async tests subscribe before triggering and use
  bounded event/state deadlines, never timing sleeps.
- Use declared package exports; direct implementation-subpath imports are boundary violations.

## ANTI-PATTERNS

- No AI runtimes, providers, weights, tokenizers, credentials, or inference in browser bundles.
- Stage never imports private contracts/storage or displays private session/evidence data.
- Projection gateway never depends on private backend or escapes its `src` import boundary.
- Do not weaken closed DTO parsing, causal revisions, authorization adjacency, or idempotency.
- Do not edit applied migrations; add ordered migrations and preserve DB/role separation.
- Do not mix unrelated changes, default to `git add .`, or rewrite others' commits.

## COMMANDS

```bash
bun install
bun run dev:console
bun run dev:stage
bun run lint
bun run typecheck
bun run test
bun run build
bun run check              # full repository gate
bun run check:boundaries   # projection architecture
bun run check:browser-boundary
```

Python ingestion commands live in `services/ingestion/AGENTS.md`. Database tests require Docker.

## NOTES

- Root `build` is browser-only; Bun services execute TypeScript source directly.
- Stage deliberately maintains SSE and WebSocket delivery with HTTP receipt fallback.
- `packages/slide-runtime` has no current workspace consumer; render integration remains in progress.
- The source browser-boundary scanner currently reports `missing-csp` for both apps because CSP
  literals are generated in `packages/ui/vite/securityHeaders.ts`, outside configured browser roots.
- Supported demo topology is Windows 11 Chrome/Edge: Extend, Duplicate with separate private
  controller, or single-screen Stage fallback.
