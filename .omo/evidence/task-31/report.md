# Task-31: Core-5 ABSTAIN vs state-key pollution — measured verdict

Date: 2026-08-21 (UTC). Method: psql row measurement + 10-request recommendation
driver (ephemeral ports, same fixture `korean-text-layer.pdf`, same shipped model
slots deepseek-v4-flash x2 + qwen3.6-plus) against a real private-backend +
projection-gateway topology, plus one full acceptance-suite run after the fix.

## Verdict

**State-key pollution is NOT the cause of the Core-5 positive ABSTAINs.**
With a per-run unique key and a clean database the recommendation pipeline still
returns 0/10 RECOMMEND. The binding failure is `DETERMINISTIC_MISMATCH`
(LLM fabricates evidence such as `dates:["2026"]`; the deterministic gate
correctly rejects it), with `DEADLINE_EXCEEDED` only on LLM tail latency.
The fix below is still applied as hygiene: it removes the WP5-class unbounded
snapshot growth from this harness.

## (a) Measured state-key rows (before any cleanup)

| row | bytes (`octet_length(snapshot::text)`) | revision | presentations |
|---|---|---|---|
| `five-features-acceptance-private` (as found) | 67,124 | 38 | 19 accumulated |
| `five-features-acceptance-projection` | **row absent** (no display join ever occurs in this suite; gateway never persists) | – | – |
| clean per-run keys (abstain-repro / bench rows) for contrast | 3,566 | 2 | 1 |

Note: the polluted row was deleted by a concurrent actor mid-investigation
(the first "before" attempt silently ran on a fresh revision-2 row), so the
polluted condition was faithfully reconstructed by re-accumulating 19 uploads
against the fixed key before the official BEFORE run: **69,477 bytes,
revision 22, 20 presentations**.

## (b) Fix applied (mirrors WP5 commit `4a94318`)

- `scripts/verify-five-private-presentation-features.py`: generates a unique
  nonce per run -> `five-features-<nonce>-private` / `-projection`, passes them
  to the services and to the runner.
- `tests/e2e/five-features.runner.ts`: `deleteRunStateRows()` in `finally`
  deletes exactly this run's two state rows via Bun `SQL` (best-effort).
- Verified: after the post-fix acceptance run, zero `five-features-%` rows
  remain in either table.

## (c) One-time abandoned-row cleanup

Deleted **8** rows from `private_app.prepared_evidence_state`
(5x `bench-private-*`, 2x `/var/folders/...deck-upload-main-*/snapshot.json`,
1x reconstructed `five-features-acceptance-private`). Projection debris: 0
(already clean). `development-*` rows left untouched (live dev stack).

## (d) Per-stage latency, 10 recommendations each (median ms)

| stage | BEFORE (polluted, 69KB/20 pres.) | AFTER (unique key, clean) |
|---|---|---|
| embedding | 177 | 173 |
| retrieval gap (derived) | 638 | 549 |
| rerank (completed runs) | 1,433 | 1,024 |
| llm (completed runs) | 1,410 | 1,575 |
| verifier | n/a — gate aborts before verifier in every run | n/a |
| whole pipeline | 2,837.5 | 2,516.5 |

Differences are within provider noise; no stage regresses or improves beyond it.
DEADLINE_EXCEEDED runs are explained by single-stage llm tails of 3.4–3.7s on
top of the ~0.5–1.0s retrieval gap against the 4,500ms abort point.

## (e) Recommendation outcome distribution

| outcome | BEFORE (polluted) | AFTER (unique key) | post-fix acceptance suite (2 positives) |
|---|---|---|---|
| RECOMMEND | 0/10 | 0/10 | 0/2 |
| DETERMINISTIC_MISMATCH | 7/10 | 9/10 | 2/2 |
| DEADLINE_EXCEEDED | 3/10 | 1/10 | 0/2 |

## (f) VERIFY exit codes

| check | exit code |
|---|---|
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| acceptance suite (post-fix) | 1 — identical pre-existing positive failure mode (was 0/2 with DEADLINE_EXCEEDED before; now 0/2 with DETERMINISTIC_MISMATCH); negative 6/6, STT 2/2 unchanged |

## Artifacts

- `before-polluted-driver.json` / `after-unique-key-driver.json` — raw driver runs
- `accidental-clean-run.json` — the invalidated first "before" attempt (fresh row)
- `core5-e2e-post-fix.json` — acceptance suite result after the fix
