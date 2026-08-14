# Demo and acceptance scope

## Terminology

- **First demo:** curated, pre-approved evidence reveal. This is not the final MVP.
- **Guarded-pilot MVP:** both secure display modes, private live recommendations, and a feature-flagged supervised path from an eligible live candidate to the public Stage.
- **Deferred enhancement:** automatic display placement, public live evidence before its gates, coaching, and generated report summaries.

## Supported environment

- Windows 11
- current stable Chrome and Edge
- wired Extend
- Duplicate with a separate private controller
- single-screen public Stage fallback

Manual Stage placement and a Stage-local fullscreen click are canonical. Browser Window Management is an optional enhancement.

## Secure display baseline

Both Extend and Duplicate use:

1. a clean public Stage browser profile on the presentation machine;
2. an already authenticated private controller on another device;
3. a short-lived, non-authorizing display join locator;
4. server-side display binding and an AudienceDisplaySession.

A co-resident Console in Extend mode is convenience-only and has no no-private-pixel claim.

## Preregistered evaluation

Before unblinding a frozen acceptance corpus, record:

- corpus hash and sampling frame;
- claim class and severity taxonomy;
- semantic acoustic endpoints;
- network and cache profile;
- formulas, thresholds, exclusions, and failure treatment;
- evaluator and rubric versions.

Development, provider bake-off, and acceptance data are disjoint by claim/paraphrase, source version, speaker recording, and deck instance.

Provisional live recommendation gates:

- semantic-audio-end to eligible Console render p95 <= 5 seconds;
- at most 3 results;
- eligible yield >= 60% for supportable, fetchable claims;
- direct top-3 usefulness >= 80% for answerable events;
- abstention >= 95% for intentionally unanswerable events;
- zero critical numeric, date, entity, and security escapes;
- at least 299 representative non-supportable cases with zero false-support escapes.

Live public evidence remains off until the signed evaluation record passes every applicable safety, usefulness, approval-load, lease, and recovery gate.
