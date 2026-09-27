# WP10 final manual QA

## Release posture and evidence

Use a release build with `LIVE_PUBLICATION_GATE_STATE` unset or `BLOCKED`. Public evidence and
public cards are disabled. The public Stage is slide-only. Do not turn an automated receipt into a
claim about venue hardware.

The task-53 receipt at commit `283369767974194c7fa29cac8a604ad3e56e40a7` is historical evidence:

- 13/13 recorded gates exited successfully.
- 577 tests passed in the recorded run.
- The two recommendation cohorts were 10/10 with p95 values of 4,606.0 ms and 4,627.2 ms.
- `STAGE_ZERO_CARDS` was true.

This record does not certify the current working tree, the current Vercel aliases, a redeploy, or a
physical venue. Run the current release checks again. Physical acceptance stays open until the
Windows venue run is signed.

The release security checks must continue to cover private-scope rejection, anonymous Stage
reachability, cross-account reads, forged display state, direct public writes, and zero private
bytes in public responses. `POST /internal/cards` must remain a negative check with
`410 stage_cards_disabled`, not a presentation step.

## Venue record header

Complete this header for each physical rehearsal. Do not include participant data, transcripts,
private deck content, credentials, provider secrets, invitation tokens, or private screenshots.

- Date and time UTC:
- Venue and room:
- Release ID and build hash:
- Operator and privacy observer:
- Console device, OS, and browser version:
- Stage device, OS, and browser version:
- Projector or display model and connection path:
- Windows mode: Extend, Duplicate, or single-screen fallback
- Network path and captive portal status:
- Emergency public PDF or URL prepared:
- Result: PASS or FAIL
- P0 failures:
- Privacy-critical mistakes:
- Evidence links using public-only screenshots and redacted receipts:

## Target venue flow

A physical rehearsal passes only when every row passes in one uninterrupted flow. Stop projection
on a privacy-critical failure and record the rehearsal as failed.

| Step | Operator action | Explicit pass criteria | Automated or HTTP check | Physical execution |
| --- | --- | --- | --- | --- |
| 1. Setup | Start the approved Compose services. Open only the authenticated Console on the private controller and a clean Stage profile on the projectable device. Prepare the emergency public artifact. | Console is not visible on the public output. The Stage origin and release ID are the intended values. No private pixel, notification, terminal, log, speaker note, or private filename is visible. | Compose health and readiness checks. Console `/sign-in`, Console `/`, and Stage `/` respond. | Yes. Confirm the actual display mode, cable, adapter, projector, and audience view. |
| 2. Account and deck | Sign in at Console `/sign-in`. In Console `/` or `/session`, upload the approved PDF or PPTX and wait for public slide rendering to finish. | The owner account is correct, the deck belongs to that owner, and the public slide manifest is ready. Private preparation remains on Console. | Upload response is successful. A task-owned deck is used. No production account or participant data is used. | Yes. Check the operator handoff and the emergency artifact. |
| 3. Invitation and exchange | Create a short-lived, one-use invitation for the active deck. Open its Stage path on the independent public device. | The token is only in the URL fragment. The Stage exchange creates a pending join only. No display cookie, binding, account session, or private data is granted by the invitation. Replay, expiry, wrong deck, and malformed token fail closed. | `POST /v1/display-invitations`, `POST /v1/display-joins`, and the replay and expiry negatives. | Yes. Check readability, room distance, captive portal behavior, and the human handoff. |
| 4. Fingerprint approval | Read the pending display ID and fingerprint in the owner Console. Approve only the exact display, deck version, and current binding epoch. | A Stage claim before approval is rejected. A forged fingerprint, wrong display, wrong owner, or stale epoch is rejected. The approved Stage receives its public display cookie only after the owner action. | `GET /v1/display-invitations/:invitationId/pending`, `POST /v1/display-bindings`, and `POST /v1/display-session`. | Yes. Confirm the fingerprint on both devices and verify that a neighboring display is not approved. |
| 5. Slide control | Send absolute slide selections from Console. Wait for the matching Stage-applied receipt and the visible slide. | Stage reports a ready public snapshot and shows the selected slide. The public DOM and network responses contain slides only. A command receipt without a visible slide is a failure. | `GET /v1/snapshot`, `GET /v1/events`, `POST /v1/stage-applied`, and the existing topology and receipt checks. | Yes. Judge projected readability, response, focus, and operator timing. |
| 6. Public boundary negative | Do not attempt to publish public evidence. Probe the retired card ingress from a private operations context and inspect the public response shape with no display cookie. | `POST /internal/cards` returns `410 stage_cards_disabled`. Snapshot and event requests without an approved display cookie return typed denial and no private bytes. The Stage never shows a card, candidate, question, transcript, or source detail. | Release security suite, public payload matrix, `GET /v1/snapshot` without a display cookie, and `GET /v1/events` without a display cookie. | Yes. A privacy observer checks the actual projected pixels and audience sightlines. |
| 7. Recovery and fallback | Drop the approved network or restart the projection service under the approved supervisor. Keep the emergency public artifact ready. | Stage stays public-only while unavailable, returns to an authoritative slide snapshot after recovery, and receives the next applied receipt. If any identity, snapshot, receipt, or visible slide is uncertain, remain on the emergency artifact. | Health, reconnect, revision, asset, stale epoch, and service restart checks. | Yes. Measure projector reacquisition, network recovery, and the human fallback time. |

The backend invitation routes and a live HTTP receipt at the production aliases support steps 3-4,
and this working tree carries the matching Console and Stage UI. The deployed Vercel build predates
that UI: the served Stage bundle never reads the `#invite` fragment and the served Console chunks
never call `/v1/display-invitations`. Do not sign the separate-device row until the deployed build
exposes the one-use flow and it has been exercised in a real browser. Do not replace that row with
a copied join object.

## Physical-only checks

These checks are mandatory before claiming the target venue and hardware release gate:

1. Run the complete flow above 10 consecutive times on the target Windows venue and hardware.
   Record P0 failures and privacy-critical mistakes. The task-53 record is an automated historical
   stand-in only.
2. Inspect real projector and confidence-monitor pixels in Extend, Duplicate, and the supported
   single-screen fallback during startup, reconnect, monitor unplug, and topology switching.
3. Verify the cable, adapter, dock, GPU, EDID, resolution, refresh rate, overscan, contrast,
   forced colors, 200% zoom, 320 px layout, keyboard, screen reader, remote, and physical focus
   path.
4. Verify venue Wi-Fi or Ethernet, captive portal, DNS, firewall, service-worker cold start, and
   production supervisor and database recovery timing.
5. Verify invitation readability, fingerprint matching, operator handoffs, audience sightlines,
   notification suppression, and that no adjacent display receives the binding.
6. Exercise the approved emergency PDF or URL on a public-only backup device and time the human
   switchover.
7. Run the vendor prewarm, quota, region, retention, deletion receipt, and escalation procedure
   in `docs/runbooks/vendor-prewarm.md`.

The present host is macOS arm64 with headless Chromium. Its browser and API results do not verify
Windows display modes, projectors, physical pixels, clickers, screen readers, captive portals, or
human response time.

## Final sign-off

- [ ] Every target-flow row passed in one uninterrupted physical run.
- [ ] Ten consecutive physical target-venue runs passed.
- [ ] P0 failures are 0/10.
- [ ] Privacy-critical mistakes are 0.
- [ ] Invitation expiry, replay, wrong fingerprint, stale epoch, and pre-approval negatives are
      green.
- [ ] Public card ingress is disabled and public snapshots contain no cards or private data.
- [ ] Recovery restored the authoritative slide state without private exposure.
- [ ] Release security, E2E, topology, soak, and boundary checks are green for the current tree.
- [ ] The live-publication gate remains unset or `BLOCKED`.
- [ ] Operator and privacy observer signed the venue record.
