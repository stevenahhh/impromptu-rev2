# WP5 realtime soak: commandToStageAppliedP95Ms investigation and fix

Date: 2026-08-21
Task: bring `commandToStageAppliedP95Ms` under the 300 ms SLA with measured evidence.

## Outcome

- Before (same commit e03f941, prior runs): p95 **354.999 ms** standalone, **310.596 ms**
  in-suite; on this machine the soak no longer completed at all (two consecutive
  `bun test tests/e2e/realtime-soak.test.ts` runs hit the 180 s runner timeout).
- After fix: p95 **47.954 ms**, full soak completes in ~14.5 s. Evidence:
  `wp5-realtime-soak-after.json`.

## Root cause (measured, not hypothesized)

The coordinator/gateway state moved to PostgreSQL keyed by
`PRIVATE_PREPARED_EVIDENCE_STATE_KEY` / `PROJECTION_GATEWAY_STATE_KEY`, but the soak harness kept
using fixed keys (`/tmp/impromptu-r2-wp5-private.json`) and "cleaned up" with `rmSync` on paths
that are no longer files. Every soak run therefore restored all previous runs' presentations from
the shared dev database:

- The row for `impromptu-r2-wp5-private.json` had grown to revision 15612 /
  **16,757,819 chars of JSON** containing 18 accumulated presentations.
- Each measured command performs 4 awaited full-snapshot persists (2 in private-backend, 2 in the
  gateway). Serializing + writing a 16 MB jsonb snapshot 4x per command is what produced the
  ~310-355 ms per-command times; growth also eventually exceeded the 180 s runner budget.
- A control probe that spawns the identical service topology with a unique state key ran 150
  commands at mean total 10.8 ms before any service change, proving the services were never slow.

## Segment table (150-command probe, unique state key, load average ~2.4)

Client-side segments (`segment-table.json`):

| segment | mean | p50 | p95 | max |
|---|---|---|---|---|
| POST start -> COMMAND frame on stage socket | 1.19 ms | 1.16 | 1.40 | 7.10 |
| STAGE_APPLIED sent -> RECEIPT received | 8.94 ms | 9.14 | 15.42 | 17.56 |
| POST start -> 202 response | 10.13 ms | 10.28 | 16.60 | 18.66 |
| total (matches soak sample definition) | 10.13 ms | 10.28 | 16.60 | 18.66 |

Server-side handler durations (from `/metrics` histograms and request logs during the same run):

| handler | mean | p95 |
|---|---|---|
| private-backend POST /v1/playback/slide-set | 5.84 ms | 9.00 ms |
| projection-gateway POST /internal/playback (fanout+persist) | 0.56 ms | 1.00 ms |
| private-backend POST /internal/stage-applied | 8.78 ms | 15.00 ms |
| projection-gateway POST /internal/playback-applied | 0.78 ms | 1.00 ms |

During the degraded soak (shared polluted state), the same handlers measured:
gateway `/internal/playback` 1.6 ms mean vs private-backend `/internal/stage-applied`
**581 ms mean** (99.3 s across 171 requests) — the delta is exactly the full-snapshot persist
cost, which scales with accumulated store size.

## Bottleneck

Not an intra-command serial round trip or fsync issue: with isolated state the whole round trip is
~10-18 ms including all four CAS persists. The bottleneck was unbounded cross-run state
accumulation inflating every persist on the critical path.

## Fix

`tests/e2e/realtime-soak.harness.ts` only:

1. Unique per-run state keys (`impromptu-r2-wp5-<nonce>-private` / `-projection`), matching the
   venue-like profile of a fresh deployment. No threshold, fixture, or expectation changed.
2. Replaced the legacy no-op `rmSync` cleanup with best-effort `DELETE` of the run's own two state
   rows, so repeated runs cannot re-pollute the shared test databases.
3. One-time cleanup of 45 + 32 abandoned tmp-path rows already present in the dev databases
   (executed manually via `psql`; recorded here for the audit trail).

Correctness gates untouched: CAS revisions, causal `pbr_` revision checks, idempotency windows,
authorization adjacency, epoch checks, and the fail-closed card refusal are all as before.

## VERIFY exit codes

| gate | exit code |
|---|---|
| `bun test --timeout 300000 tests/e2e/realtime-soak.test.ts` | 0 (pass, 14.37 s) |
| `bun run test:e2e` | 0 |
| `bun run test:security` | 0 |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun run check:boundaries` | 0 |

## Files

- `segment-probe.ts` - reusable per-segment measurement probe (spawns real service mains).
- `capture-evidence.ts` - writes one official soak evidence JSON.
- `wp5-realtime-soak-after.json` - post-fix evidence: `commandToStageAppliedP95Ms = 47.954`.
- `segment-table.json` - raw client/server segment samples backing the table above.
