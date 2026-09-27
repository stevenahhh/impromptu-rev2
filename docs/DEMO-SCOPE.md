# Demo and acceptance scope

## What this demo is

The current demo is a signed-in presenter using Console to prepare a deck and drive a separate,
public Stage. Stage renders public slides only. It does not render evidence cards, candidate data,
transcripts, questions, private notes, account data, or provider details.

## Terminology

- **First demo:** Upload the sample deck, connect one public Stage, approve the exact display
  identity, and advance slides from Console. This is a slide demo, not a public evidence reveal.
- **Guarded-pilot MVP:** Private preparation, recommendations, coaching, and question review stay
  in Console. A bound Stage receives only the public slide snapshot for the active deck.
- **Deferred enhancement:** Public live evidence, public cards, generated report summaries, and
  venue automation beyond the documented fallback are not part of this demo.

## Supported environment

- The venue target is Windows 11 with current stable Chrome or Edge.
- Supported venue arrangements are wired Extend, Duplicate with a separate private controller,
  and a single-screen public Stage fallback.
- Keep Console on the private controller. Keep the clean Stage browser profile on the projectable
  device. Never rely on a co-resident Console when Duplicate could expose private pixels.
- Stage has no local presentation, placement, or fullscreen controls. Display placement runs
  automatically through the Window Management API when the browser supports it; otherwise the
  browser window and Windows display mode are operator responsibilities, not Stage actions.
- macOS is suitable for source review, API checks, and browser checks. This host cannot verify a
  Windows projector, Extend or Duplicate behavior, GPU or EDID handling, captive portals, clickers,
  screen-reader hardware, or physical audience pixels. Those remain open venue gates.

## Current demo topology

The review demo uses this topology, not the single-VM Caddy production topology:

- Console is served by Vercel at `https://impromptu-rev2-console.vercel.app`.
- Stage is served by Vercel at `https://impromptu-rev2-stage.vercel.app`.
- PostgreSQL, migrations, private-backend on port 3001, and projection-gateway on port 3002 run
  in the local `compose.production.yaml` stack.
- One Cloudflare HTTPS quick tunnel exposes private-backend to the Vercel Console server proxy.
  A separate Cloudflare HTTPS quick tunnel exposes projection-gateway to Stage and to the Console
  deck-asset proxy.
- Stage keeps `/v1` on the Stage origin through its Vercel rewrite. This preserves the display
  session cookie and the SSE event and HTTP receipt paths. Tunnel hostnames are temporary and must
  not be treated as stable product URLs.

The rotation procedure, Vercel environment names, and smoke checks are in
`docs/runbooks/vercel-demo.md`.

## Secure display flow

1. The owner signs in to Console and selects the active deck. A deck is not ready until the upload
   and public slide render complete.
2. For a separate Stage device, the owner creates a short-lived, one-use invitation for that
   deck (the contract caps it at 90 seconds). The invitation is non-authorizing. Its secret
   travels only in the Stage URL fragment, with a shape such as
   `/?deck=<deckVersion>#invite=<token>`.
3. Stage exchanges the invitation at `POST /v1/display-joins`. The exchange creates a pending
   join locator only. It does not create a display cookie, a binding, or account authority.
4. Console reads the pending display identity through
   `GET /v1/display-invitations/:invitationId/pending`. The owner checks the exact display ID,
   fingerprint, deck version, and current binding epoch before approving
   `POST /v1/display-bindings`.
5. Only the owner approval can advance the binding. Stage then claims
   `POST /v1/display-session` and reads the public snapshot, event stream, and applied receipts.
6. During the talk, Console sends absolute slide selections. Stage is ready only when the
   validated snapshot paints the requested public slide. A successful HTTP command without a
   visible slide is not a presentation success.

A bare Stage URL is not a pairing credential. An invitation does not authorize a display by
itself. Do not put account cookies, CSRF values, invitation secrets, or private deck data in a
query string, browser storage, logs, screenshots, or support tickets.

The backend contract and a live HTTP receipt at the production aliases support this flow, and
this working tree carries the matching UI: the Console invitation panel plus the pending
fingerprint approval, and Stage `#invite` fragment consumption. The deployed Vercel build still
predates that UI wiring — the served Stage bundle has no `location.hash` invitation handling and
the served Console chunks contain no `display-invitations` call — so on production today only
the same-device opener path pairs a display. Until both aliases are redeployed and the one-use
invitation is exercised in a real browser, the separate-device invitation path is a release
gate, not a customer promise. Do not replace it with a bare URL or a copied join object.

## Private and public data boundary

- Console and the private backend own the account session, CSRF token, deck preparation, questions,
  recommendations, transcripts, and reports.
- Stage receives only the closed public slide DTO and its display session state.
- The public gateway rejects `POST /internal/cards` with `410 stage_cards_disabled`. There is no
  public card approval or retraction flow in this demo.
- A Stage snapshot, event stream, receipt, or asset response must not contain candidate IDs,
  private source URLs, source hashes, transcripts, questions, prompts, account IDs, tenant IDs,
  cookies, or authorization tokens.
- A separately authenticated teammate, when that feature is enabled, may submit a question only.
  The owner reviews and submits it through the private question flow. The teammate cannot read
  the deck or report, control slides, invoke recommendations, or publish anything to Stage.

## Required negative checks

Run the checks from a private operations context and save redacted status lines only:

- An invitation expires and a second exchange of the same invitation is rejected.
- A wrong deck, forged fingerprint, wrong owner, or stale display binding epoch is rejected.
- A Stage claim before owner approval is rejected.
- `GET /v1/snapshot` and `GET /v1/events` without an approved display cookie return a typed denial
  and no private bytes.
- `POST /internal/cards` remains disabled with `stage_cards_disabled`.
- A Stage-origin request for private account, presentation, or invitation data does not return
  private data. `/internal/*` is not a public Vercel route.
- Reconnect and service restart restore the authoritative slide state without resurrecting cards
  or private content.

## Preregistered evaluation

Before unblinding a frozen acceptance corpus, record:

- corpus hash and sampling frame;
- claim class and severity taxonomy;
- semantic acoustic endpoints;
- network and cache profile;
- formulas, thresholds, exclusions, and failure treatment;
- evaluator and rubric versions.

Development, provider bake-off, and acceptance data are disjoint by claim/paraphrase, source
version, speaker recording, and deck instance.

## Recommendation and evidence gates

These thresholds remain product gates for private assistance. They are not permission to expose
live evidence on Stage:

- semantic audio end to eligible Console render p95 <= 5 seconds;
- no more than 3 results;
- eligible yield >= 60% for supportable, fetchable claims;
- direct top 3 usefulness >= 80% for answerable events;
- abstention >= 95% for intentionally unanswerable events;
- zero critical numeric, date, entity, and security escapes;
- at least 299 representative non-supportable cases with zero false-support escapes.

Keep public evidence disabled until the signed safety, usefulness, approval-load, lease, and
recovery record passes every applicable gate. A 200 response or an automated receipt is not a
visible Stage result.

## Current evidence status

The task-53 receipt at commit `283369767974194c7fa29cac8a604ad3e56e40a7` records 13/13 gates,
577 passing tests, two 10-run cohorts at p95 4,606.0 ms and 4,627.2 ms, and `STAGE_ZERO_CARDS`.
It is historical evidence at that commit. It does not certify this working tree, a Vercel
redeploy, or physical venue hardware. The current tree and the physical 10-run venue gate must be
checked again before release.

## Physical venue acceptance

Before calling the venue release gate complete:

1. Run the complete flow 10 consecutive times on the target Windows venue and hardware. Record
   P0 failures and privacy mistakes. The task-53 automated record is not a substitute.
2. Inspect real projector and confidence-monitor pixels in Extend, Duplicate, and the supported
   single-screen fallback during startup, reconnect, monitor unplug, and topology changes.
3. Check the actual cable, adapter, dock, GPU, EDID, resolution, refresh rate, overscan,
   contrast, forced colors, 200% zoom, 320 px layout, keyboard, screen reader, remote, and focus
   path.
4. Check venue Wi-Fi or Ethernet, captive portal, DNS, firewall, service-worker cold start, and
   production supervisor and database recovery.
5. Check invitation handoff, fingerprint matching, operator changes, audience sightlines, and
   notification suppression. A neighboring display must not receive the binding.
6. Exercise the approved emergency PDF or URL on a public-only backup device and time the human
   switchover.
7. Run the approved provider prewarm, quota, region, retention, deletion, and escalation checks
   in `docs/runbooks/vendor-prewarm.md`.

No macOS browser run, headless result, fixture, or historical receipt can close these physical
checks.
