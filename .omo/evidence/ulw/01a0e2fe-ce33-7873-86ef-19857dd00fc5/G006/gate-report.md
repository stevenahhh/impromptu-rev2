# G006 — Dirty-tree gate capture report

Scope: run `bun run typecheck`, `bun run lint`; verify `audit-map.md` covers all dirty files. Read-only on product code. Raw tails + exit codes are in `gate.txt` (same directory).

## Gate results

| Command | Exit | Result |
|---|---|---|
| `bun run typecheck` | **2** | FAIL — one error: `services/private-backend/test/recommendation-model-slots.test.ts(12,3)`: `error TS2353: Object literal may only specify known properties, and 'now' does not exist in type 'DeadlineScheduler'.` Root `tsc --noEmit` dies here; the per-package typechecks (packages/ui, apps/console, apps/stage) never run, so their status is unknown. |
| `bun run lint` | **0** | PASS — `biome check .` clean, 503 files, no findings. |

Reproduction for the typecheck failure: `bun run typecheck` (or `bunx tsc --noEmit`) in the repo root — fails on the first compile step every run.

## audit-map.md coverage

`audit-map.md` exists and its section (a) individually lists all 25 modified files shown by `git status --porcelain` plus all 12 product-relevant new untracked files (2 product modules + 10 test files), and explicitly covers the remaining untracked paths (`.omo/*`, `docs/paper/`, `.tmp-docx/`) as non-product. Coverage is complete.

## Defects found (in scope of this gate)

| # | Defect | Repro |
|---|---|---|
| G1 | `services/private-backend/test/recommendation-model-slots.test.ts:12` — test constructs `DeadlineScheduler` with a `now` property the type does not declare; blocks the entire `tsc --noEmit` step and masks all downstream per-package typechecks. File is NOT part of the dirty tree (not in `git status`), so this is a pre-existing committed-tree failure, not introduced by the plan's partial implementation — but it means the dirty tree cannot be verified clean on types. | `bun run typecheck` → exit 2 at root tsc. |
| G2 | Coverage gap in `audit-map.md` defects list: N1–N13 catalog the tree's own defects but do not record this committed-tree typecheck blocker, so "tree is commit-ready" judgments in the map were made without a passing typecheck. | Compare gate.txt typecheck tail with audit-map.md §(e). |

Lint produced no findings; nothing to record as lint defects.

## Plan tasks served

This gate itself serves the audit's verification step, not a plan task. Per audit-map.md, the dirty tree partially serves plan tasks 17, 27, 28, 29, 30, 32, 34, 36, 38, 39 (plus task-1 UX-R2 retention and test-harness groundwork for 11/12/16/37).

## Verdict

The gate FAILS: `bun run typecheck` exits 2 on `services/private-backend/test/recommendation-model-slots.test.ts:12` (TS2353, `now` not in `DeadlineScheduler`), a committed-tree file outside the dirty set — so the failure is pre-existing rather than introduced by the partial implementation, but it still blocks any clean-typecheck claim and hides the state of the packages/ui, console, and stage typechecks that never run. `bun run lint` exits 0 with zero findings. `audit-map.md` exists and covers every dirty file (25 modified + 12 product-relevant untracked individually; non-product paths covered as a group), and the audit is complete per its own map — with the caveat that defects N1–N13 do not include this typecheck blocker. For the plan tasks this gate touches (17/30 backend work adjacent to the failing test file), the unimplemented remainders listed in audit-map.md §(c) still stand; nothing in this gate's output changes the map's verdict that the tree is not commit-ready.
