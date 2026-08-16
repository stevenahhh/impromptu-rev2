# Sources Ledger

Format: `[S<N>] <type> | <path/URL> | <contents> | <reliability> | <observed date>`

## Local repository (code, primary by definition — verifiable by re-read)

[S1] code | services/private-backend/src/http.ts | HTTP route handler; auth/CSRF/mutation gate; all mutation endpoints incl. /v1/deck-artifacts | primary | 2026-08-15
[S2] code | services/private-backend/src/prepared-deck-upload.ts | createPreparedDeckArtifacts — JSON-title/content-to-fake-artifact stub | primary | 2026-08-15
[S3] code | packages/contracts/src/private-deck.ts | PrivateDeckContextSchema | primary | 2026-08-15
[S4] code | packages/contracts/src/public-deck.ts | PublishedDeckArtifactSchema (public slides = image url+hash+width+height only) | primary | 2026-08-15
[S5] code | infra/migrations/cluster/0001_cluster.sql | role/DB bootstrap; large-object function REVOKE FROM PUBLIC in both DBs | primary | 2026-08-15
[S6] code | infra/migrations/private/0001_private_foundation.sql | private schema: tenants, presentation_sessions(deck_storage_uri), evidence_candidates, publication_outbox | primary | 2026-08-15
[S7] code | infra/migrations/projection/0001_projection_foundation.sql | projection schema: projection_sessions, audience_cards(approved_asset_hash), display_receipts, publication_inbox, applied_publications | primary | 2026-08-15
[S8] code | services/ingestion/src/impromptu_ingestion/validation.py | PPTX/PDF input validation: symlink/size/signature/zip-entry-count/expansion-ratio checks | primary | 2026-08-15
[S9] code | services/ingestion/src/impromptu_ingestion/adapters/{base.py,pptx.py} | render_slides raises RenderingUnsupportedError; structural-only extraction | primary | 2026-08-15 (cross-verified by lead, see observation O-ING-2)
[S10] code | services/ingestion/src/impromptu_ingestion/cli.py | mkstemp + hardlink atomic publish, local-filesystem-path only | primary | 2026-08-15
[S11] code | apps/console/src/{App.tsx,session-client.ts,audio-capture.tsx} | no upload UI; only mic-stream "CaptureUploader" | primary | 2026-08-15
[S12] code | config/browser-forbidden-dependencies.json; scripts/{check-browser-dependencies.ts,verify-browser-boundaries.ts} | browser dependency + CSP boundary scanner rules | primary | 2026-08-15
[S13] code | apps/console/index.html; apps/stage/index.html | CSP: worker-src/script-src/connect-src 'self' only | primary | 2026-08-15
[S14] doc | docs/DEMO-SCOPE.md; README.md | curated-first product scope; ~10 concurrent users; Windows 11 + Chrome/Edge only | primary | 2026-08-15 (read in earlier session turn)
[S15] code | services/private-backend/src/prepared-evidence.ts | createPresentation requires matching private+public decks present together | primary | 2026-08-15

## External (lane-resumable-upload — all fetched in full, SHA-pinned where applicable)

[S16] web-primary | github.com/tus/tus-resumable-upload-protocol (SHA c6a11fa) | tus 1.0.x protocol spec | official | 2026-08-15
[S17] web-primary | docs.aws.amazon.com (mpuoverview, qfacts, cli s3-config) | S3 multipart upload mechanics/limits | official | 2026-08-15
[S18] web-primary | cloud.google.com/storage/docs (resumable-uploads, performing-resumable-uploads) | GCS resumable upload mechanics | official | 2026-08-15
[S19] web-primary | github.com/tus/tus-node-server (SHA cdd6e79) | tus Node/Bun server lib; Bun support is a README claim, no CI job found | official, unverified sub-claim | 2026-08-15
[S20] web-primary | github.com/tus/tus-js-client (SHA c128e39) | tus browser/Node client; cross-session resume via URL storage | official | 2026-08-15
[S21] web-primary | github.com/aws/aws-sdk-js-v3 lib-storage/src/Upload.ts (SHA c41e9a9) | @aws-sdk/lib-storage MPU implementation (read directly) | official source | 2026-08-15

## External (lane-conversion-tooling — all fetched in full)

[S22] web-primary | github.com/gotenberg/gotenberg (SHA c0f487e); gotenberg.dev/docs | Gotenberg conversion API; persistent LibreOffice UNO daemon internals | official | 2026-08-15
[S23] web-primary | manpages.debian.org — soffice(1), pdftoppm(1) | LibreOffice headless CLI; poppler PDF rasterization (per-page PNG) | official | 2026-08-15
[S24] web-secondary | github.com/gotenberg/gotenberg issues #373, #1452, #1502, #1570 | field-reported latency/ops/font-regression data | operator reports, not benchmarks | 2026-08-15
[S25] web-primary | github.com/unoconv/unoconv | archived, GPL-2.0, self-declared deprecated in favor of Unoserver | official (self-declared) | 2026-08-15
[S26] web-primary | cloudconvert.com (pricing, pptx-to-png product page) | SaaS conversion pricing/limits; custom fonts Enterprise-only | vendor official | 2026-08-15
[S27] web-primary | docs.aspose.cloud (slides quickstart, docker guide, pricing-plan) | Aspose Slides Cloud; self-hosted Docker option via metered license | vendor official | 2026-08-15
[S28] web-secondary | github.com/wilke/claude-code-101 office-render SKILL.md | third-party PPTX->PDF->PNG pipeline pattern, corroborates PNG-first-slide-only trap | community, secondary | 2026-08-15
[S29] web-primary | packages.debian.org/trixie/fonts-noto-cjk | Noto CJK KR font package (ships in Gotenberg image) | official | 2026-08-15
[S30] web-primary | libreoffice.org/licenses | LibreOffice MPL-2.0 licensing (commercial-use safe) | official | 2026-08-15

**Running total: 30 sources. Unique external domains so far: tus.io/github.com(tus org), docs.aws.amazon.com, cloud.google.com, github.com(aws-sdk-js-v3), github.com(gotenberg), manpages.debian.org, github.com(unoconv), cloudconvert.com, docs.aspose.cloud, github.com(wilke), packages.debian.org, libreoffice.org — 11 external domains + repo-internal. Final exact count for closing briefing to be computed via grep at delivery time.**

## Corrections

- [2026-08-15] C42: "~10 concurrent users" is NOT stated in docs/DEMO-SCOPE.md (upload-mechanics CONTRADICTION, accepted). The figure originally came from this session's memory notes (2026-08-13 entry, project notes) and must be labeled a planning assumption, not an acceptance criterion. Capacity sizing in the synthesis will not cite DEMO-SCOPE.md for it.
