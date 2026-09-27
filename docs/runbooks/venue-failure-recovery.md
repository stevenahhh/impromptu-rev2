# Venue failure recovery runbook

Use this runbook with the approved emergency public PDF or URL already open on a public-only backup
device. Never project Console, logs, terminals, provider dashboards, private deck files, or private
browser notifications. Stage is the only projectable application.

## Recovery is complete only when

1. the projector shows Stage with a public slide, or the approved emergency public artifact;
2. Stage has `[data-audience-readiness="READY"]` and a visible
   `[data-stage-slide-surface="uploaded"]`, or it remains on the emergency artifact;
3. the observed Windows display mode is the rehearsed mode;
4. no private pixels, card, question, transcript, source detail, or expired display state is visible;
5. Console receives the next Stage-applied receipt, or the operator explicitly stays in public
   fallback.

A receipt alone is not visual recovery. If the slide is not visible, stay on the emergency artifact.

## 1. Projector loss or monitor unplug

1. Stop sending slide commands and keep Console on the private controller.
2. Switch the projectable output to the approved emergency PDF or URL. Do not drag Console onto the
   remaining output.
3. Restore projector power, input, cable, and adapter. Select the rehearsed Windows display mode.
4. Reopen Stage through the approved Console flow. Use a fresh one-use invitation for an independent
   device. Never reuse an expired invitation or a bare Stage URL.
5. Read the pending display ID and fingerprint in Console. Approve the exact display and current
   deck before Stage claims a display session.
6. Wait for a public snapshot, the `READY` readiness value, the visible slide surface, and the next
   matching Stage-applied receipt. Keep the emergency artifact visible until all four are present.

No physical projector timing is asserted by this runbook. A macOS browser run cannot measure power,
cable, EDID, Windows, or operator recovery time.

## 2. Windows topology or target-screen fault

1. Leave the last known public frame in place and do not open private controls on Stage.
2. Use the rehearsed Windows mode. In Extend, keep Console on the private controller and put only
   Stage on the projectable output. In Duplicate, keep only Stage on the duplicated computer and
   use a separate Console device. In single-screen fallback, keep only Stage on the shared output.
3. Stage has no local placement or presentation-mode button. Placement runs automatically through
   the Window Management API when the browser supports it; otherwise the browser and Windows
   operator must position the window.
4. If the target screen disappears, keep the public fallback visible, restore the target, and
   reopen the Stage session with a fresh invitation if its display identity changed.
5. Recheck the exact display fingerprint and binding epoch. Do not approve a neighboring display
   or continue after a stale binding response.
6. Confirm the observed mode, public pixels, readiness value, and applied receipt before resuming.

Automatic placement outcomes and headless browser results do not certify a physical multi-screen
setup. The target Windows venue must be tested separately.

## 3. Venue network partition

1. Stop slide commands and keep the emergency public artifact ready. Do not loop or replay requests.
2. Keep microphone, provider, and private question traffic stopped while the network path is
   untrusted. Do not use a personal hotspot for participant data unless it is approved.
3. Restore the approved network path and complete any captive portal on a private, non-projector
   device.
4. Let Stage reconnect and adopt its authoritative snapshot. It may remain in a public recovery
   state while the snapshot is unavailable.
5. Confirm that the returned snapshot contains public slides only, then issue one absolute slide
   selection from Console and wait for the matching applied receipt.
6. If the snapshot, visible slide, identity, or receipt is uncertain, remain on the emergency
   artifact.

## 4. Projection or private service restart

1. Stop operator mutations and leave Stage open so it can observe the channel close.
2. Restart projection-gateway and private-backend with the approved Compose supervisor. Confirm
   `GET /health` and `GET /readyz` from a private operations context.
3. Do not clear PostgreSQL, deck artifacts, invitation state, or projection state.
4. Let Stage reconnect. Confirm the display session, authoritative snapshot, and public slide
   before sending a command.
5. If the invitation expired during the restart, issue a fresh one and repeat the fingerprint
   approval. Do not reuse a token from a prior attempt.
6. Send one absolute slide selection and wait for the matching Stage-applied receipt.
7. If health, snapshot, asset verification, display approval, or receipt fails, stay on the
   emergency artifact and escalate. Do not rebuild state from a copied join or private payload.

## 5. Invitation or fingerprint failure

- `INVITATION_EXPIRED`, `INVITATION_CONSUMED`, wrong deck, malformed token, or replay means the
  invitation is unusable. Issue a fresh invitation.
- A forged display ID or fingerprint, wrong owner, wrong deck, or stale display binding epoch must
  be rejected. Do not retry by changing the displayed identity.
- A Stage claim before owner approval must be rejected. No display cookie is valid proof of owner
  approval unless the binding was just checked against the exact fingerprint and epoch.
- Do not copy an invitation token into a query string, ticket, log, screenshot, or chat message.

The backend invitation contract is live at the production aliases and this working tree carries the
matching Console and Stage UI, but the deployed Vercel build predates that UI wiring. If the served
build does not expose the one-use flow, stop the independent-device demo and report the release
blocker. Do not substitute the retired manual join guidance.

## 6. AI provider failure, timeout, or quota exhaustion

1. Keep provider calls server-side. Never enter provider credentials in Console or Stage.
2. Stop capture and cancel the provider request. Treat missing, malformed, late, or conflicting
   output as abstention.
3. Continue the prepared slide deck. If the public slide path is unavailable, use the emergency
   PDF or URL.
4. Check provider status and quota from a private operations device. Do not switch to an
   unapproved vendor, region, model, or account.
5. Resume only after the approved adapter passes the checks in
   `docs/runbooks/vendor-prewarm.md`. Provider recovery does not authorize public evidence.
6. Record the incident, affected capability, release or model version, and deletion receipt. Do
   not record transcript, prompt, or participant content.

## 7. Vercel or tunnel loss

Follow `docs/runbooks/vercel-demo.md` for Cloudflare tunnel rotation and Vercel redeploy checks.
Until both Vercel aliases and both tunnel health endpoints pass, keep the emergency public artifact
on the projector. A quick-tunnel hostname is temporary and is never a customer URL.

## Escalation and evidence

- If recovery is visually ambiguous, exceeds the local incident threshold, or reveals a private
  pixel, stay in public fallback and open a P0 incident.
- Save UTC start and end times, release and service versions, selected topology, sanitized health
  results, and the public screenshot checksum.
- Save only redacted receipts. Never save private captures, transcripts, prompts, secrets, cookies,
  invitation tokens, or provider payloads.
- Rerun the affected API or browser check after remediation. A verbal confirmation is not release
  evidence.
