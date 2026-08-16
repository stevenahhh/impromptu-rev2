# Expansion Log (Wave 1 -> Wave 2 leads, deduped)

| lead_id | description | raised by | priority | status | routed to (this turn) |
|---|---|---|---|---|---|
| L1 | Check deployment target for durable writable volume (avoid new object-storage svc) | upload-mechanics | med | open | folded into L18 routing to upload-mechanics |
| L2 | Bun/runtime compat of tus-node-server + @aws-sdk/lib-storage is vendor-claimed, not CI-proven | lane-resumable-upload | HIGH | verifying now (bash_5, this turn) | lead (self) |
| L3 | S3 MPU no-expiry vs GCS 1-week vs tus Upload-Expires — cleanup/cost implications | lane-resumable-upload | low | open | routed to upload-mechanics (context only) |
| L4 | Cloudflare R2 (S3-compatible, cheaper) as object-store option | lane-resumable-upload | med | open | routed to upload-mechanics |
| L5 | Browser fetch streaming/upload-progress constraints shape chunk-size UX | lane-resumable-upload | low | open | routed to pwa-constraints |
| L6 | DuckDuckGo is bot-gated for technical search | lane-resumable-upload | info | DEAD END (noted, not routed — informational for other lanes) | n/a |
| L7 | uppy/uppy repo moved to transloadit/uppy | lane-resumable-upload | info | DEAD END | n/a |
| L8 | Crafted ZIP metadata / decompression-bomb behavior vs Python zipfile limits | file-security | HIGH | open, owner continuing | file-security (self-owned, no redirect needed) |
| L9 | Move PPTX parsing into bounded child sandbox + OS/cgroup/job-object quotas | file-security | HIGH | open | relayed to skeptic for design-fork verdict |
| L10 | Per-page PDF materialization before aggregate limit check (peak-memory risk) | file-security | med | open | file-security (self-owned) |
| L11 | Rendering/OCR attack surface intentionally absent today | file-security | info | DEAD END | n/a |
| L12 | Add/trace console upload UI + client API as a separate missing seam | ingestion-integration | HIGH | open, confirmed independently by lane-frontend-sweep (O-ING-1) | noted in intent-diff IT5 |
| L13 | Web spool ownership/permissions + object-store publication semantics (mkstemp guarantees don't transfer) | file-security | HIGH | open | routed to upload-mechanics |
| L14 | Rendering/object-storage seam independently missing — private->public pipeline cannot complete | ingestion-integration | CRITICAL | open | routed to render-pipeline (primary), skeptic (design-fork context) |
| L15 | Define manifest-to-PrivateDeckContext projection (Python SlideManifest -> TS extractedText/speakerNotes/sourceAssetIds) | ingestion-integration | med | open | ingestion-integration (self-owned) |
| L16 | Existing /v1/deck-artifacts may make a separate /v1/deck-uploads route redundant — inspect prepared-deck-upload.ts callers/tests | auth-session | med | open | auth-session (self-owned) |
| L17 | Parser-specific production artifact behavior (WASM emission / CDN worker default) is library/version dependent | lane-frontend-sweep | med | open | relevant to render-pipeline if client PDF.js preview pursued; noted, not yet routed |
| L18 | deck_storage_uri / privateObjectPrefix suggests object-store indirection was the original design intent — raised independently TWICE (ingestion-integration + lane-db-sweep) | ingestion-integration, lane-db-sweep | HIGH (duplicate-confirmed) | open | routed to upload-mechanics as the storage-location decision owner |
| L19 | prepared-deck-upload.ts's privateObjectPrefix key convention may constrain future object/upload schemas | lane-db-sweep | low | open | folded into L18 routing |
| L20 | Measured latency for 10-20 slide Korean PPTX->PNG conversion (warm vs cold) — currently anecdotal/extrapolated only | lane-conversion-tooling | HIGH | open — strong Phase 4 (execute-to-verify) candidate | routed to render-pipeline as a suggested verification task |
| L21 | Malgun Gothic / Korean font substitution layout-shift fidelity in LibreOffice headless | lane-conversion-tooling | med | open | routed to render-pipeline |
| L22 | CloudConvert/Aspose Korean-text rendering QA reports | lane-conversion-tooling | low | open, deprioritized (self-host is the lead recommendation) | not routed this turn |
| L23 | Runtime snapshot persistence excludes standalone uploads — decide ephemeral-by-design vs need a deck catalog before presentation creation | ingestion-integration | HIGH | open | folded into render-pipeline/upload-mechanics routing (architecture-level question) |

**Duplicate check performed:** L18/L19 (object-store indirection) confirmed raised independently by 2 workers — elevated priority, single routing decision. No other duplicates found this wave.
