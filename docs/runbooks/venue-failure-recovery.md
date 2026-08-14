# Venue failure recovery runbook

Use this runbook at the venue with the approved emergency public PDF/URL already open on a public-only backup device. Never project Console, logs, terminals, provider dashboards, or private deck files. The Stage is the only projectable application.

## Recovery is complete only when

1. the projector shows Stage or the approved emergency public artifact;
2. the Stage says the audience surface is ready and is fullscreen;
3. the requested Windows topology matches the observed topology;
4. no private pixels, stale cards, or expired leases are visible; and
5. Console receives the next Stage-applied receipt, or the operator explicitly remains in manual public fallback.

## 1. Projector loss or monitor unplug

1. Stop advancing and retract any live evidence whose audience state cannot be confirmed.
2. Keep Console on the private operator device. Do not drag it onto the remaining display.
3. Put the approved emergency PDF/URL on the public-only backup output.
4. Restore projector power/input/cable, then press **Win+P** and select **Extend**. If only one output is available, select **PC screen only** and use Stage single-screen mode; never select a topology that exposes Console.
5. Open the public Stage URL in its clean browser profile, complete display approval from Console, and click **Enter fullscreen** on Stage.
6. Confirm the recovery criteria above before leaving the emergency artifact.

**Verified timing:** the WP4 exact-event browser harness simulated monitor unplug and restoration nine times with a maximum UI recovery of **11.298 ms**. This is measured from injected topology loss through audience-ready observation; it does **not** include physical projector power-up, cable replacement, or operator reaction time. Those physical times must be measured during venue rehearsal.

## 2. Windows topology or fullscreen fault

1. Leave the current public frame in place; do not open private controls on Stage.
2. Press **Win+P**, choose the rehearsed mode, and verify the physical projector preview before moving a window.
3. If fullscreen exited or was blocked, focus Stage and click **Enter fullscreen**. Use the browser fullscreen command if the button reports that fullscreen was blocked.
4. If the mode changed unexpectedly, return to the Stage setup route, follow its displayed mode instructions, then reopen the approved display route.
5. If Duplicate would expose Console, move Console to a separate device. The co-resident interlock must remain disabled after any private-pixel observation.
6. Confirm the requested and observed modes match and check all recovery criteria.

**Verified timing:** on 2026-08-14, 9 rehearsals total (3 each in Extend, Duplicate, and Single) completed 63/63 fault recoveries (21 per mode) with zero private pixels. Exact maximums were **11.062 ms** for topology switch, **39.377 ms** for fullscreen exit, **227.521 ms** for blocked fullscreen recovery, and **109.503 ms** for browser refresh. The maximum across every WP4 fault, including server restart, was **290.714 ms**. Command: `node --experimental-strip-types scripts/verify-wp4-topology-e2e.ts`; manifest checksum: `f933d0df1f1d9a3f7c75455092e1069bdd21ba7194a8f31b5d49349963a425c1`.

## 3. Venue network partition

1. Do not repeatedly publish or replay controls. Stage intentionally rejects relative replay after a partition.
2. Wait for the live-card lease to hide unconfirmed evidence, then switch the projector to the approved emergency PDF/URL if the base deck is unavailable.
3. Keep capture/provider traffic stopped while venue connectivity is untrusted; do not use a personal hotspot for participant data unless it is an approved network path.
4. Restore the approved network path and captive-portal session without displaying the portal.
5. Let Stage reconnect and apply its authoritative snapshot. Do not manually re-create cards that disappeared.
6. Verify that retracted/expired cards remain absent, then issue one absolute slide-set command from Console and wait for its Stage-applied receipt.

**Verified timing:** committed WP5 evidence (`tests/evidence/wp5-realtime-soak.json`, SHA-256 `de21c65fe9bfe78c50d1e62398aa0b2b84b196e2698439f901faf816a7046c97`) records **255.503 ms** maximum silent-partition exposure against a 250 ms live lease and **2.691 ms p95** reconnect-to-snapshot over 50 reconnects. These are application recovery measurements on the harness network, not ISP restoration times.

## 4. Projection or private server restart

1. Stop operator mutations; leave Stage open so it can observe channel close and reconnect.
2. Restart the Projection Gateway with the approved deployment supervisor. Confirm `GET /health` on its private operations endpoint succeeds.
3. Restart the private backend with the same supervisor. Confirm `GET /health` succeeds.
4. Do not clear either durable state store. Let Stage reconnect and restore the authoritative snapshot and tombstones.
5. Confirm no retracted or expired card reappeared.
6. Send one absolute slide-set command and wait for the matching Stage-applied receipt before resuming normal control.
7. If either health check, snapshot, tombstone check, or receipt fails, stay on the emergency public artifact and escalate; do not rebuild state by republishing old cards.

**Verified timing:** the WP4 real process-restart plus SSE-reconnect fault ran nine times with a maximum projection-drop recovery of **290.714 ms**. A separate WP3 run on 2026-08-14 restarted both service mains, restored all 20 tombstones, applied the exact post-restart command prefix, and reported zero active-card resurrection. The harness does not include production supervisor startup or database failover time; measure those at the venue.

## 5. AI provider failure, timeout, or quota exhaustion

1. Keep all inference server-side. Never enter provider credentials or call a provider from Console or Stage.
2. Stop live audio capture and cancel the provider request. Treat missing, malformed, late, or conflicting output as abstention; never publish it.
3. Continue the prepared deck and manually curated, already-approved public evidence only. If that path is unavailable, use the emergency PDF/URL.
4. Check the approved provider status page and quota from a non-projected operations device. Do not fail over to an unapproved vendor, region, model, or account.
5. Resume AI only after the approved adapter passes its target-region prewarm and privacy checks in `docs/runbooks/vendor-prewarm.md`. Existing publication still requires normal human approval.
6. Record the incident, cancellation result, affected capability, release/model version, and deletion receipt. Do not record transcript or prompt content.

**Verified timing:** `services/model-router/test/router.test.ts` deterministically verifies a non-cooperating adapter returns `deadline_exceeded` with **250 ms** latency metadata, without sleeps. This is an injected server deadline, not measured vendor recovery. Provider restoration has no verified venue time while provisioning/prewarm remains `BLOCKED`; the operational recovery is immediate abstention and manual public fallback, not waiting for the vendor.

## Escalation and evidence

- If any recovery exceeds **30 seconds** at the application layer, remains visually ambiguous, or reveals a private pixel, stay in emergency public fallback and open a P0 incident.
- Save UTC start/end times, release and service versions, selected topology, sanitized health results, and the public screenshot checksum. Never save private screen captures, transcripts, prompts, secrets, or provider payloads.
- Re-run the affected harness after remediation. A verbal confirmation is not release evidence.
