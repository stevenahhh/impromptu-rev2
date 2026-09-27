# F3 fix: audio SSE disconnects mid-capture with IncompleteRead (~8-9s idle during whisper inference)

Scope honored: `services/private-backend/src/audio-ingest.ts` +
`services/private-backend/test/audio-ingest-http.test.ts` only. No git staging/commits.
`compose.production.yaml` untouched — root cause is not a compose-level knob (there is no
reverse proxy in front of private-backend's SSE path; the embedding Caddy terminator is
unrelated).

## Root cause (proven, not inferred)

`Bun.serve` applies `idleTimeout` (default **10 s**) to the whole request lifecycle,
including streaming `Response` bodies. The check runs on a ~4 s connection sweep and fires
when the socket body has written nothing for >= the configured timeout — so an SSE stream
that goes silent is reaped 4-12 s after its last write, landing on a tick boundary:

| `idleTimeout` | body writes | observed kill |
|---|---|---|
| 1 / 2 / 3 s | none, or heartbeat every 150-500 ms | ~4 s (first sweep already exceeds timeout) |
| 4 s | none; hb 200 ms / 3 s | ~4 s |
| 5 s | none | ~8 s |
| 5 s | hb 200 ms | survives 20 s+ |
| 10 s (default) | none | ~12 s |
| 10 s (default) | hb 4 s | survives 28 s+ |

(reproduced on host Bun 1.4.2 and **in-container Bun 1.3.14** — identical behavior;
probe scripts: `/tmp/f3-probe/sse-idle.ts`, `sse-idle-param.ts`, `sse-matrix.ts`)

The whisper.cpp adapter emits **nothing** between consecutive transcript events — a
segment's PARTIAL/FINAL lands only after ffmpeg decode + whisper inference complete. On a
contended box that gap exceeded the kill horizon: baseline pass A severed 8,359 ms after
the last event, pass C 8,306 ms — both inside the 4-12 s sweep window after a write.

**Live proof, unfixed deployment** (`live-idle.py`, GET /v1/audio/events on the running
`impromptu-ulw-g003-demo` stack, grant issued but zero frames — the stream is silent in
exactly the same way it is during inference):

    t=     1 SSE HTTP 200
    t=     1 read 37 bytes 'event: READY\ndata: {"kind":"READY"}\n\n'
    t=  8692 ERROR IncompleteRead: IncompleteRead(0 bytes read)

8,692 ms — byte-for-byte the F3 signature. After the connection dies, the service's
`ReadableStream.cancel` path marks the grant CONSUMED and cancels the stream, which is why
the baseline later observed `GRANT_EXPIRED`/`GRANT_REPLAYED` on cleanup.

## Fix

`audio-ingest.ts`: when `openEvents` starts the capture SSE stream, a `setInterval`
(default 4,000 ms — inside the 10 s Bun window with sweep margin, and inside typical
proxy idle windows) enqueues an SSE **comment frame** `": keep-alive\n\n"` from the grant
binding. Cleared on stream `cancel` (client death — the existing cancel semantics for
grant state, recommendations, and capture are unchanged), on TERMINAL close, and on
enqueue failure. Comment frames carry no `data:` line, so `EventSource` and SSE parsers
(including the console client and the existing test reader) ignore them; the event
contract is unchanged. New option `eventStreamHeartbeatIntervalMs` exists only so the
socket-level regression can compress the timeline; production uses the 4 s default.

No `idleTimeout`/`server.timeout` change: heartbeat writes fix the symptom for every
socket in the path (Bun, a future proxy, browser intermediaries) instead of exempting one
server, and grant/lifecycle/stream authenticity logic is untouched.

## Regression tests (failing before fix)

`test/audio-ingest-http.test.ts`:

1. "emits keep-alive comment frames while inference holds the transcript stream silent" —
   in-process, sub-second. `GatedSilentInferenceRouter` yields one PARTIAL, then blocks on
   a deferred gate (deterministic stand-in for whisper inference; no sleeps), then FINAL +
   complete. Pre-fix: times out with "no keep-alive frame" (the first frame read is the
   PARTIAL, then silence). Post-fix: a `:` comment frame arrives while the gate is held.
2. "keeps the SSE socket connected across an inference longer than the server idle
   timeout" — real `Bun.serve` (`idleTimeout: 5`, so the deterministic kill lands 4-8 s
   after the last write — same mechanism as production's 10 s default), real fetch client,
   real grant/auth/CSRF path. Inference is gated open until the client has consumed 45
   heartbeat frames (~9 s of silence, past the worst-case kill). Pre-fix: socket dies at
   ~4,003 ms with `ECONNRESET` (verified red, matching the live `IncompleteRead`).
   Post-fix: FINAL then `TERMINAL COMPLETED` arrive; 9.07 s test runtime.

Also made `readSseEvent` skip data-less comment frames so existing tests are robust to
heartbeats.

## Verification

- `bun run typecheck` (services/private-backend): clean.
- Focused suite: `bun test services/private-backend/test/audio-ingest-http.test.ts
  services/private-backend/test/audio-lifecycle.test.ts tests/security/audio-lifecycle.test.ts`
  → **17 pass / 0 fail** (9.3 s). Full `services/private-backend/test/` run: 314 pass,
  7 fail — all 7 reproduce with the change stashed (qa-postgres needs a local Postgres
  host; deck-upload-main subprocess tests need env/network this shell lacks). Pre-existing
  environmental failures, unrelated.
- `bunx biome check` on both touched files: clean.
- **In-container real whisper.cpp** (`/app` tree, real `createModelRouter` → pinned
  whisper-cli + ggml-small-q5_1.bin + ffmpeg, real socket serving `openEvents`):
  pushed the baseline's 15-frame two-final.webm (and a 32-frame concatenation).
  Pre-fix build: completed here only because this idle box infers ~5.6 s/segment — under
  the kill horizon (baseline box was saturated → >8 s gaps → F3). Post-fix: 4 heartbeat
  frames bridged every inference gap, `TERMINAL COMPLETED`, clean EOF, verdict
  SSE_COMPLETE.
- **Live stack, fixed module**: copied the fixed `audio-ingest.ts` over the identical-path
  file in `impromptu-ulw-g003-demo-private-backend-1` (sha256 f2390cf8…, verified) and
  `docker restart`ed the container so the running process loads it.
  - Idle-subscription probe: heartbeats at t=4006/8011/12018/…, **alive past 32 s**
    (pre-fix: dead at 8,692 ms). Grant cleanup still 409 GRANT_REVOKED — lifecycle
    unchanged.
  - Real capture through the real HTTP surface (`live-capture.py`: login → grant → SSE →
    start → 15 webm frames → real whisper → stop): all three segments transcribed
    ('형식중립 근거 자료 2026' ×2, '-끝.'), heartbeats interleaved at 4 s, then
    `TERMINAL COMPLETED` + EOF at t=17,455 — the exact flow that produced F3's
    IncompleteRead in passes A/C.

**Container state note**: `/app/services/private-backend/src/audio-ingest.ts` inside the
demo container currently differs from its image (contains this fix). To restore stock:
`docker cp` the HEAD file back and restart; the next image build picks the fix up from
source anyway.

## Adjacent exposure (out of scope, reported not fixed)

`src/http/controller-events.ts` `controllerEventStream` writes `": ready\n\n"` once and
then only control events — a playback-controller SSE that goes silent is exposed to the
same idle kill. Same fix pattern applies if desired.
