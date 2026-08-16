# STATE PACKAGE GUIDE

## OVERVIEW

Deterministic, replayable domain reducers for playback, projection, candidates, audio, snapshots,
and realtime reconciliation.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Playback authority | `src/playback.ts` | Command replay, leases, receipts |
| Public projection | `src/public-projection.ts` | Public state transitions |
| Candidate lifecycle | `src/candidate-lifecycle.ts` | Approval and terminal states |
| Realtime Stage state | `src/realtime-reconcile.ts` | Gaps, epochs, visibility |
| Persistence | `src/snapshot-restore.ts` | Validated restoration |
| Audio fusion | `src/audio-fusion.ts` | Deterministic event fusion |

## CONVENTIONS

- Reducers are pure: input state is immutable and output is explicit.
- Return uppercase discriminated outcomes with stable rejection reasons.
- Validate transition inputs before mutation.
- Preserve monotonic revisions, epochs, leases, tombstones, and command idempotency.
- Snapshot restoration must reproduce canonical state and reject invalid histories.
- Playback validation includes canonical replay of every command, not shape checks alone.
- Property tests use the fixed repository seed/config and model invariants, not examples only.

## ANTI-PATTERNS

- Never mutate caller-owned state or hide a rejected transition as a no-op.
- Never accept revision gaps, stale epochs, expired leases, or reopened terminal states.
- Never bypass canonical replay during snapshot validation.
- Never use wall-clock waiting in reducer tests; inject events/time.
- Never broaden private contract use into browser-facing state surfaces.

## CHECKS

```bash
bun test packages/state
bun test tests/property
bun run typecheck
```
