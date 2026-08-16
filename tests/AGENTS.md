# CROSS-CUTTING TEST GUIDE

## OVERVIEW

Repository-wide contract, property, security, E2E, database, corpus, and release validation;
owner-local unit tests remain beside application/service/package code.

## STRUCTURE

| Area | Purpose | Command |
|---|---|---|
| `contract/` | Role/export/schema boundaries | `bun test tests/contract` |
| `property/` | Deterministic reducer/protocol laws | `bun test tests/property` |
| `security/` | Cross-private/public safety | `bun run test:security` |
| `e2e/` | Real process/browser/network behavior | `bun run test:e2e` |
| `database/` | Docker migration/role/failure behavior | `bun run test:db` |
| `wp8/`, `wp9/` | Frozen evaluation gates | `bun run test:wp8`, `bun run test:wp9` |
| `corpus/`, `evidence/` | Integrity-bound inputs/results | Dedicated gate scripts |

## CONVENTIONS

- Run test commands from repository root; many fixtures use root-relative paths.
- Root tests are serial by design (`--max-concurrency 1`, 30-second runner budget).
- Subscribe to exact events/process output/state before triggering work; await with bounded timeout.
- E2E cleanup in `finally` must stop processes, browsers, profiles, snapshots, and artifacts.
- Database harnesses use unique Compose project names, traps, and post-run leak checks.
- Property tests use the fixed `fastCheckParameters()` seed and run count.
- Browser tests register/unregister happy-dom explicitly and clean Testing Library after each test.
- Keep SLA measurement thresholds separate from runner deadlock deadlines.

## ANTI-PATTERNS

- Never use fixed sleeps, polling delays, timing luck, or repeated reruns to obtain green tests.
- Never weaken, skip, or delete a failing invariant to pass.
- Never silently modify checksum-pinned corpus/evidence; update its manifest/evidence deliberately.
- Never leave child processes, Docker resources, browser profiles, or generated snapshots behind.
- Never over-mock a boundary so the integration under test cannot fail.
- Never assert prose wording; assert machine-consumed values and observable behavior.

## NOTES

- Database tests require Docker.
- Some E2E harnesses require a compatible Chrome executable.
- WP8/WP9 inputs intentionally assert frozen/preregistered states.
