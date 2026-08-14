# WP10 final manual QA

## Release posture and evidence

Use the release build with `LIVE_PUBLICATION_GATE_STATE` unset. Live-public publication remains default-off. Do not convert an automated result below into a claim that physical venue hardware was rehearsed.

Automated venue-equivalent record:

- Command: `bun run test:aggregate:10`
- Evidence: `tests/evidence/wp10-aggregate-runs.json`
- Consecutive aggregate runs: **10/10 passed**
- P0 failures: **0/10**
- Setup/publish/retract/recovery completion: **40/40 tasks, 100%**
- Privacy-critical mistakes: **0**
- Each run executed, in order: full `bun run check`, prepared-evidence/topology E2E, the dedicated topology suite, and the realtime soak suite.
- Physical venue hardware exercised by this record: **no**

Release-security matrix record:

- Public routes rejecting private-scope bodies: **7/7**
- Private routes rejecting anonymous/Public Stage reachability: **16/16**
- Cross-tenant private reads denied: **1/1**
- Stage-compromise attempts contained: **4/4** (stale live ingress, forged durable snapshot, forged public role snapshot shape, direct write)
- Privacy-critical exposures across the 28 reachability/compromise attempts: **0**
- Deletion/restore checks: active content removed, backup tombstone restored, revoked projection resurrection denied

## Venue record header

Complete this header for each physical rehearsal. Do not include participant data, transcripts, private deck content, credentials, or provider secrets.

- Date/time (UTC):
- Venue/room:
- Release ID and build hash:
- Operator / privacy observer:
- Console device, OS, browser version:
- Stage device, OS, browser version:
- Projector/display model and connection path:
- Windows mode tested: Extend / Duplicate / single-display fallback
- Network path and captive-portal status:
- Emergency public PDF/URL prepared:
- Result: PASS / FAIL
- P0 failures:
- Privacy-critical mistakes:
- Evidence links (public-only screenshots and receipts):

## Target venue flow

A physical rehearsal passes only when every row passes in one uninterrupted flow. Stop projection immediately on a privacy-critical failure and record the rehearsal as failed.

| Step | Operator action | Explicit pass criteria | Automated gate mapping | Physical execution required |
|---|---|---|---|---|
| 1. Setup | Connect the approved controller and public Stage devices. Select the intended Windows display mode. Open only Console on the private display and Stage on the projectable display. Keep the emergency public artifact ready. | Stage shows its public landing surface; Console is not visible on the projector; no private pixel, notification, browser chrome leak, terminal, log, speaker note, or private filename is visible. The release/build IDs match and the live-public gate remains unset. | Full check; browser runtime; topology E2E; public/private matrix. | **Yes.** Validate the actual GPU, cable/adapter, projector, EDID, Windows topology, overscan, and line of sight. |
| 2. Join | From Stage, create the display join and transfer the locator through the approved room procedure. | Locator expires as configured, grants no authority by itself, contains no account/private data, and replay is rejected. Stage receives only the `__Host-display` public cookie. | Release-security public payload matrix; Stage display-session tests; prepared-evidence E2E `display-join`. | **Yes.** Validate QR/readability, room distance, operator handoff, and captive-portal behavior. |
| 3. Bind | In Console, verify the displayed identity/fingerprint and approve the exact display/deck pair. | The intended Stage binds once; wrong deck, wrong fingerprint, stale CAS, and old binding are rejected. Rebinding closes the old channel with no private exposure. | Prepared-evidence gateway tests; topology and Stage-compromise gates. | **Yes.** Confirm the fingerprint on the actual two devices and that no neighboring display is approved. |
| 4. Slide control | Send an absolute slide selection from Console, then exercise the Stage-only emergency keyboard fallback. | The exact command is accepted and receives `STAGE_APPLIED`; Stage shows one visible effect; no relative/offline replay occurs; emergency keys select only cached public slides. | Prepared-evidence E2E accepted/applied prefixes; realtime soak (>=500 commands, duplicate effects 0, stale epoch acceptance 0); topology E2E. | **Yes.** Judge projector response, remote/keyboard mapping, focus, readability, and operator timing on venue hardware. |
| 5. Approve | Approve a curated recommendation from the authoritative Console state. Do not enable live-public. | Publication requires authenticated authority and current CAS identity; only the declassified public card appears; no candidate ID, private URI, source hash, transcript, note, or tenant identifier appears on Stage. | Release-security matrix; prepared-evidence E2E `candidate-approved`/`published-card-visible`; privacy scanners; live-public default-off config tests. | **Yes.** A privacy observer must inspect the physical projector and audience sightlines for private pixels or notifications. |
| 6. Retract | Retract the visible card once, then attempt stale/replayed publication from the old state. | Tombstone is ordered and visible within the gate; card disappears; replay and resurrection are rejected; reconnect snapshot contains zero active revoked cards. | Prepared-evidence E2E retract/expiry and 20-sample Chrome retract gate; deletion/backup tombstone test; Stage `STALE_LIVE_BINDING` gate. | **Yes.** Confirm disappearance on the real projector and any confidence monitor, including during display switching. |
| 7. Recovery | With the card revoked, restart/drop the projection service and exercise the approved emergency PDF/URL path. Restore connectivity and signal recovery. | Stage fails public-only, never shows Console or stale private content, restores an authoritative snapshot and tombstones, resurrects zero revoked cards, and resumes absolute slide control. If recovery fails, remain on the emergency public artifact. | Durable-main restart; prepared-evidence restart/tombstone E2E; event-driven topology recovery; realtime reconnect soak; `docs/runbooks/venue-failure-recovery.md`. | **Yes.** Measure production supervisor/database/network recovery, projector reacquisition, captive portal, and emergency artifact handoff. |

## Physical-only checks that automation cannot satisfy

These checks remain mandatory before claiming the target venue/hardware release gate:

1. Run the complete flow above **10 consecutive times on the target venue and hardware** with P0 failures 0, task completion 100%, and privacy-critical mistakes 0. The checked-in 10-run record is an automated stand-in only.
2. Inspect real projector/confidence-monitor pixels in Extend, Duplicate, and supported single-display fallback, including boot, reconnect, fullscreen exit, monitor unplug, and topology switching.
3. Verify the actual cable, adapter, dock, GPU, EDID, resolution, refresh rate, overscan, color/contrast, forced-colors behavior, 200% zoom, 320 px layout, keyboard, screen reader, remote/clicker, and physical focus path.
4. Verify venue Wi-Fi/Ethernet, captive portal, DNS, firewall/proxy, service-worker cold start, and production supervisor/database failover timing.
5. Verify room-distance join readability, device fingerprint matching, operator handoffs, audience sightlines, notification suppression, and that no adjacent display receives the binding.
6. Exercise the approved emergency PDF/URL on the public-only backup device and time the human switchover.
7. Perform the vendor prewarm, quota, region, retention, deletion-receipt, and escalation procedure against the approved production account under `docs/runbooks/vendor-prewarm.md`.

## Final sign-off

- [ ] Every target-flow row passed in one uninterrupted physical run.
- [ ] Ten consecutive physical target-venue/hardware runs passed.
- [ ] P0 failures are 0/10.
- [ ] Setup/publish/retract/recovery completion is 100%.
- [ ] Privacy-critical mistakes are 0.
- [ ] Public/private negative matrix and Stage-compromise suite are green.
- [ ] Deletion cascade, backup tombstone restore, and resurrection denial are green.
- [ ] Full check, strict TypeScript, both boundary scanners, E2E, topology, and soak are green.
- [ ] Live-public remains default-off with gate state unset.
- [ ] Operator and privacy observer signed the venue record.
