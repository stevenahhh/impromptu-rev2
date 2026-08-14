# Vendor account and prewarm runbook

- Status: `BLOCKED`
- Owner: `UNASSIGNED`
- Vendor accounts: `NOT_PROVISIONED`
- Prewarm evidence: `NOT_COLLECTED`

This is the operating contract for future provisioning and rehearsal. It is not evidence that a vendor was selected, an account exists, privacy review passed, or prewarm succeeded.

## Inputs required before provisioning

1. Assign the operations owner and privacy reviewer in `docs/wp0/staffing-owners.json`; record their acceptance.
2. Record the selected capability and vendor, tenant/account identifier, processing region, data-retention setting, deletion API or procedure, subprocessors, and approved data classes.
3. Obtain privacy approval for purpose, participant notice, region, retention, and deletion. A product-plan approval is not a substitute for this review.
4. Create separate development and pilot credentials in the server-side secret manager. Never place credentials in this repository, browser storage, client bundles, URLs, logs, screenshots, or deck fixtures.
5. Record quota, budget, rate limits, timeout, cancellation behavior, status-page URL, and support escalation contact.

## Prewarm procedure

1. Confirm the target venue date, region, model/version, Korean language configuration, network path, and server release ID.
2. Exercise only approved development fixtures; never use the frozen acceptance holdout for prewarm or provider selection.
3. Open the minimum required server-side connection or issue the documented non-billable warmup request. Record exact UTC timestamps, request class, model/version, region, latency, and sanitized result.
4. Run one bounded development-corpus probe for STT and each enabled model capability. Verify timeout and cancellation, quota visibility, and that no raw audio, transcript, secret, or private claim text entered logs.
5. Stop warm resources after the documented lifetime. Record cost and teardown evidence.
6. Re-run after any model/version, region, credential, network, or release change; previous evidence is stale.

## Outage and cold-start response

- If provisioning, privacy review, prewarm, quota, or health evidence is absent, keep live AI and live-public evidence disabled.
- Continue only with the curated pre-approved evidence path when its rights and publication checks are available.
- For a vendor outage or venue-network failure, use the published emergency PDF/URL and manual public slide flow; do not route data to an unapproved vendor.
- Record the incident and deletion receipts. Do not claim a successful rehearsal when fallback was required.

## Evidence record contract

A completed run must record `owner`, `reviewer`, `vendor`, `account_alias`, `region`, `model_version`, `release_id`, `started_at_utc`, `ended_at_utc`, `sanitized_probe_hash`, `latency_ms`, `quota_result`, `logging_review`, `teardown_result`, and links to privacy and deletion evidence. Secrets and participant data are forbidden fields.

## Blocking gate

The gate remains `BLOCKED` until all of the following are recorded and approved:

- named operations owner and privacy reviewer;
- selected vendor/account with region, retention, deletion, quota, and escalation contracts;
- server-secret and outbound-allowlist verification;
- successful target-region prewarm evidence for the pinned model and release;
- successful timeout, cancellation, no-sensitive-log, teardown, and outage-fallback checks.
