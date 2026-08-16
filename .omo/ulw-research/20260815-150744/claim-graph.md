# Claim Graph

## Verified-claims digest (Phase 4b gate)
*Not yet run — Phase 4b executes at synthesis time once waves converge. No non-code high-risk claim may enter SYNTHESIS.md before clearing the gate. Placeholder — populated in a later pass.*

## Claims by axis

### ingestion-integration / render-pipeline (the central finding of the run so far)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C21 | Ingestion worker output (structural extraction) cannot by itself become a servable presentation artifact — no rendering exists | high | **supported (2 independent observers: ingestion-integration + lead cross-read this turn)** | O-ING-2, O-ING-3 | S9 (adapters/base.py), S4 (public-deck.ts) | none found |
| C31 | No durable ingestion job / deck-artifact persistence seam exists in current SQL or runtime | high | supported (1 observer, code-verifiable, DB side corroborated by O-DB-1) | O-DB-2, O-DB-1 | S6 | none found |
| C-NEW1 | Runtime coordinator state is in-memory + snapshot-file only (Bun.write to PRIVATE_SNAPSHOT_PATH); DB deck_storage_uri column is not the live persistence path | normal | supported (1 observer) | O-DB-2 | services/private-backend/src/main.ts:40-55,208-228 | none found |

### upload-mechanics

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C1 | No object-storage/S3/bucket service or SDK exists in the repo; /v1/deck-artifacts is a JSON-only stub | normal | supported (2 independent reads) | O-UPLOAD-1 | S1,S2 | none |
| C2 | PostgreSQL revokes large-object mutation functions from PUBLIC in both private and projection DBs | normal | supported (2 independent reads); one residual sub-lead (any later re-grant to private_app?) unresolved | O-UPLOAD-2 | S5 | initial README-vs-SQL tension resolved by direct re-read: revoke targets PUBLIC broadly, affecting all roles absent an explicit re-grant |
| C3 | tus protocol 1.0.0 defines byte-offset resumable upload via POST/PATCH/HEAD, `Upload-Offset`, 409 on mismatch | normal | supported | O-RES-1 | S16 | none |
| C4 | S3 MPU resumes at part granularity (5MiB-5GiB, <=10,000 parts), no expiry until complete/abort | normal | supported | O-RES-1 | S17 | none |
| C5 | GCS resumable uploads resume byte-precisely via session URI + 308/Range; session expires after 1 week | normal | supported | O-RES-1 | S18 | none |
| C6 | tus-node-server v2 Bun compatibility is a **vendor claim**, not CI-proven | high | **verified-partial (lead smoke test this session): `@tus/server@2.4.4`+`@tus/file-store@2.1.1` install and import cleanly on Bun 1.3.14, `Server`/`FileStore` exports present; full E2E upload round-trip not executed; repo-dive lane corroborates srvx `bun` export condition + `handleWeb()` surface | O-RES-1 + lead bash smoke test | S19 | none found by the lane; lead independently testing |
| C7 | Resumable upload is not justified below ~5-10MB on stable networks; plain multipart POST suffices | normal | supported (consistent across tus FAQ + AWS CLI defaults) | O-RES-1 | S16 (tus FAQ) | none |
| C-NEW2 | Original design intent likely was object-store indirection (URI in Postgres, not bytes) — deck_storage_uri + privateObjectPrefix convention both point this way, but no object-store service is actually wired up | normal | supported (2 independent workers raised same lead) | O-DB-1, O-DB-2 | S2, S6 | none — this is a design gap, not yet an implementation |

### file-security

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C-SEC1 | Existing PPTX/PDF validation already rejects symlinks, non-regular/empty/oversize files, unsafe zip paths, encrypted members, >10k entries, >512MiB expansion, wrong content-type, CRC failures | normal | supported | O-SEC-1 | S8 | none |
| C-SEC2 | Gap: declared file_size total and ZipFile.testzip() still eagerly decompress every member; no per-member or compression-ratio cap, no CPU/wall/memory isolation for the PPTX parser | high | supported (1 observer; PENDING skeptic verdict on severity) | O-SEC-1 | S8 | none found yet — L8 investigation ongoing |
| C11 | Adapter asymmetry: PDF path is subprocess-sandboxed with a wall timeout and bounded pages/xrefs/resources; PPTX path runs python-pptx in-process with NO timeout, no isolation, no size/shape/image-pixel limits | **high** | supported (1 observer) — **routed to skeptic for severity verdict this turn** | O-SEC-2 | S9 | none found |
| C22 | cli.py's mkstemp/hardlink atomic-publish protections are local-operator-path-specific and do NOT automatically transfer to a web/API/queue intake path | normal | supported | S10 (direct quote) | S10 | none |

### auth-session

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C20 | A new browser mutation endpoint can reuse the exact existing account-session + CSRF + origin/referer gate (no new auth mechanism needed) | normal | supported | O-AUTH-1 | S1 | need to inspect multipart/body-parsing constraints (flagged by auth-session itself) |
| C-AUTH2 | ownerAccountId propagates end-to-end: deck-artifacts creation -> createPresentation ownership check -> PresentationSessionLifecycle.ownerAccountId | normal | supported | O-AUTH-1 | S1, S15 | none |

### render-pipeline (from lane-conversion-tooling, pending render-pipeline team member's own pass)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C23 | Gotenberg v8 keeps one persistent LibreOffice UNO daemon per container — per-request latency excludes soffice boot | normal | supported | O-CONV-1 | S22 | v7's stateless per-conversion mode (superseded) |
| C24 | Warm LibreOffice conversion of a simple doc ~0.7s; cold boot adds ~2.5s; a real 10-20 slide Korean deck's total time is an **extrapolation, not measured** | **high** | unresolved — flagged as Phase-4 verification candidate (L20) | O-CONV-1 | S24 | environment-dominated outliers exist (20s under blocked IPv6 loopback) |
| C25 | `soffice --convert-to png` rasterizes only the first slide; reliable all-slide output requires PDF -> poppler (pdftoppm/pdftocairo) | normal | supported | O-CONV-1 | S23, S28 | none official found |
| C26 | Gotenberg's image ships fonts-noto-cjk (Hangul renders without extra setup); a 8.33.0 fontconfig regression (fixed later) is a pin-version risk | normal | supported | O-CONV-1 | S22, S29 | none |
| C27 | unoconv is archived, GPL-2.0, last release 2017, officially deprecated in favor of Unoserver — do not adopt | normal | supported | O-CONV-1 | S25 | none (self-declared) |
| C28 | CloudConvert supports direct PPTX->PNG, ~1 credit/min + base cost, 10 free credits/day; custom fonts are Enterprise-only | normal | supported | O-CONV-1 | S26 | exact EUR pricing unverifiable (client-side rendered) |
| C29 | Aspose.Slides Cloud is commercially self-hostable via Docker with a metered license, closest fidelity to real PowerPoint rendering | normal | supported | O-CONV-1 | S27 | credit pricing unverifiable (purchase page redirect-loops) |
| C30 | LibreOffice (MPL-2.0) and Gotenberg (MIT) are both free for commercial server-side use | normal | supported | O-CONV-1 | S30 | GitHub's license-detector mislabels LibreOffice/core as GPL-3.0 (detector artifact on multi-license repo, not authoritative) |

### auth-session FINAL (wave 2)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C32 | Current RLS is tenant-UUID-only (`app.tenant_id`), while runtime uses branded `account_*` text IDs; NO account→tenant adapter exists; a deck persistence row would need `SET LOCAL app.tenant_id` with a separately verified tenant UUID | high | supported (1 observer, source-verified; 7/7 tests passed) | auth-session FINAL | S6, infra/database/README.md | cross-account in-memory test is NOT DB RLS integration (C35) |
| C33 | `/v1/deck-artifacts` is authenticated but NON-durable: returns artifacts without calling `persist`; durability only happens when artifacts are later included in a created presentation snapshot | high | supported | auth-session FINAL + ingestion-integration FINAL | S1, S2 | none |
| C34 | Current flow enforces account-level ownership, not actor provenance: no actorId/sessionId/uploadId recorded; same-account actors indistinguishable; deck reusable across presentations | high | supported (test-proven: realtime-soak harness clones upload output, appends slides client-side, presentation still created) | auth-session FINAL | S1, S15 | none |
| C35 | The "cross-tenant" security test is actually cross-account in-memory isolation (`account_tenant_a/b` labels), not PostgreSQL RLS integration | high | supported | auth-session FINAL | tests/security/release-security.test.ts | DB tests separately use UUID tenants — two systems never bridged |

### pwa-constraints FINAL (wave 2)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C36 | Raw `fetch` has NO native upload-progress events; wrapping a File in a ReadableStream measures bytes pulled into Fetch (buffered), not bytes transmitted | normal | supported (2 observers: pwa-constraints + lane-resumable-upload lead) | pwa-constraints FINAL | developer.mozilla.org (XHR upload), jakearchibald.com/2025/fetch-streams-not-for-progress | none |
| C37 | `XMLHttpRequest.upload.onprogress` is the broadly supported native progress option (Baseline 2015+); for resumable uploads prefer tus-js-client (onProgress, pause/resume, cross-session resume) | normal | supported | pwa-constraints FINAL | MDN XHR upload; tus-js-client docs | none |
| C38 | File Handling API (`file_handlers`+`launchQueue`) is desktop-only Chromium 102+, no Android/Firefox/Safari; Web Share Target works Chrome/Edge desktop 89+/Android 76+; FSA pickers desktop 86+, Android 132+ per Chromestatus/BCD (caniuse disagrees — device-verify before shipping Android) | normal | supported (BCD v8 + Chromestatus, pinned SHAs) | lane-pwa-file-apis | BCD @ ba5f572f; chromestatus features 5721776357113856/6284708426022912 | caniuse `and_chr: n` for FSA on Android — unresolved source conflict, device verification recommended |
| C54 | Service Worker: blanket non-GET bypass is CORRECT for ordinary upload POST/PATCH (SW interception gives uploads no benefit, may distort body streaming/progress) — but Web Share Target file reception is the deliberate EXCEPTION: `share_target` POST must be intercepted (narrowly, only the exact in-scope action like /share-target), formData extracted in SW, handed off via IndexedDB/Cache + postMessage, 303 redirect reply | normal | corrected (pwa-constraints CONTRADICTION) | pwa-constraints | apps/console registerServiceWorker source; MDN share_target; Chrome Web Share Target | blanket bypass insufficient once share-target is added |

### upload-mechanics FINAL / ingestion-integration FINAL (wave 2)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C39 | First-demo architecture decision: single same-origin multipart/form-data POST → stream to account-scoped durable writable-volume staging; Postgres/state keeps metadata ONLY (no bytes in DB — consistent with large-object REVOKE); no tus now | normal | supported (2 axes converge) | upload-mechanics FINAL + ingestion-integration FINAL | S1, S5 | tus justified only if byte-offset/cross-session resume becomes a hard requirement pre-object-storage |
| C40 | Minimal-diff integration: injected async SUBPROCESS adapter in private-backend invoking the existing Python CLI (`uv run --project services/ingestion impromptu-ingestion ingest ...`); queue unsupported (no schema/dep/contract); standalone Python HTTP worker = documented FUTURE scale-out only | normal | supported | ingestion-integration FINAL | .omo/plans/impromptu-r2-hyperplan.md:112-129; pyproject.toml | none |
| C41 | Multipart route must branch BEFORE `http.ts:273` unconditional `request.json()`; auth gate itself (Origin+Referer+__Host-account+CSRF) is reusable unchanged | high | supported (2 axes converge) | auth-session FINAL + ingestion-integration FINAL | S1 | none |
| C42 | "~10 concurrent users" is NOT stated in DEMO-SCOPE.md — planning assumption (previously sourced from this session's memory notes), must be labeled as such | normal | correction accepted | upload-mechanics FINAL | DEMO-SCOPE.md | none — correction recorded in sources-ledger |
| C43 | File cap decision: accept only .pptx/.pdf, hard 100 MiB per deck (warning at 50 MiB); product cap not format limit; write `.part` then atomic-promote after validation; idempotency key on POST; UI states Selected→Uploading→Verifying→Converting→Ready | normal | supported | upload-mechanics FINAL | upload-mechanics FINAL report | none |

### file-security wave 2 (CVEs + policy gap)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C44 | CVE-2026-3308: MuPDF <=1.27.0 crafted-PDF image integer overflow → heap OOB write / possible RCE; fixed in 1.28.0; local get_text('dict') path decodes images so reachability is plausible; CURRENT RESOLVED 1.28.2 is safe BUT declared range `pymupdf>=1.26,<2` permits vulnerable versions and no lock/security floor is committed | high | supported | file-security | mupdf.com/releases/cve; nvd.nist.gov CVE-2026-3308 | none — pin + advisory gate + subprocess sandbox recommended |
| C45 | Renamed `.pptm`→`.pptx` passes current validator: extension gate + main-content-type check exist but `vbaProject.bin`/OLE/ActiveX/external-rel parts are NOT forbidden; python-pptx loads reachable internal blobs eagerly (memory amplification) though it never executes VBA and skips external rels | high | supported | file-security | Microsoft format ref; local pptx/opc/* | no macro execution inside current extractor (counter is narrow — risk is load/redistribution) |
| C46 | `validation.py`'s `ZipFile.testzip()` + 512MiB/10k caps bound amplification to ~5GiB at 10 concurrent worst-case uploads; POI-style per-entry inflation-ratio cap is the missing complementary control | high | supported | file-security | S8, POI ZipSecureFile | Python ZipExtFile honors declared size — bounded amplification, not unbounded bomb |
| C47 | python-pptx's lxml parser uses `resolve_entities=False` (XXE mitigated in current path); PDF XFA XXE (CVE-2025-54988, CVSS 9.8, Tika) is NOT reachable via PyMuPDF get_text today but becomes relevant with any future LibreOffice/Tika renderer | normal | supported | file-security + lane-file-security-lit | codeql.github.com; CVE-2025-54988 | no PyMuPDF-specific XFA advisory found |

### competitor-benchmark wave 2 (Mentimeter)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C48 | Mentimeter's import path is a raster/static-image pipeline (PowerPoint/Keynote/PDF → static images; 60MB/200-slide caps; paid plans), with SEPARATE URL-embed path (PowerPoint Online/published Google Slides) that preserves animations — a multi-path trust-boundary architecture reference | normal | supported | competitor-benchmark | help.mentimeter.com import + embed articles | no public conversion-engine details |
| C49 | Pitch (help.pitch.com): .pptx only (Keynote/Google Slides must export), dual picker/drop UX, editable-element conversion with fidelity caveats (unsupported blocks dropped, fonts need workspace upload, 16:9 only) | normal | supported | competitor-benchmark | help.pitch.com/en/articles/4615453 | client-side vs server-side conversion location unconfirmed |

### render-pipeline FINAL (wave 2)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C50 | Full adapters/ audit confirms ZERO render capability: `base.render_slides` always raises; pdf.py is PyMuPDF structural-only (`RenderBoundary.structural_only()`); pptx.py structural-only; no alternate adapter exists | high | supported (2 independent observers: render-pipeline full audit + lead cross-read of base.py) | render-pipeline FINAL + O-ING-2 | S9 | none |
| C51 | DEMO-SCOPE.md's ≤5s is the `semantic-audio-end to eligible Console render p95` LIVE recommendation gate only; it does NOT bind once-per-deck upload/render conversion latency; upload needs its own async UX/SLO contract | normal | supported (primary doc re-read) | render-pipeline FINAL | S14 | none — upload flow still needs its own progress/timeout UX policy |
| C52 | 100 MiB is already codified as the repo's source-deck limit: `IngestionJob.max_input_bytes` defaults to 104,857,600; `stage_input()` streams 1 MiB chunks, enforces limit, SHA-256, fsync, signature validation, 512 MiB PPTX expansion cap, read-only private temp | normal | supported | upload-mechanics | services/ingestion/src/impromptu_ingestion/contracts.py | none — configurable up to 1 GiB by schema, but default is explicit |

### competitor-benchmark wave 2 (Mentimeter)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C53 | Poll Everywhere is integration-first (native add-ins inserting live activities into PowerPoint/Keynote/Google Slides; placeholder-slide replacement at present time) rather than deck-upload-first; its only web upload is CSV question batches | normal | supported | competitor-benchmark | support.polleverywhere.com integration articles | no PPT/PPTX/PDF deck upload found in official docs |

### skeptic FINAL verdicts (wave 2, debate-log D1-D4)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C55 | PPTX inspection MUST be isolated into a killable worker/container (wall deadline, resource limits, bounded queue/concurrency, typed failure) BEFORE any web path parses PPTX; a storage-only/quarantine endpoint may receive bytes but must NOT invoke OOXML validation/extraction until then | high | verdict rendered (skeptic) — release-blocking for web parsing | file-security C11 + skeptic D1 | S8, S9 | operator-only CLI remains tolerable latent risk today |
| C56 | Design fork resolved → (b): private upload/intake + human-curated render/review/publish for the first demo; no always-on Gotenberg/LibreOffice/Poppler orchestration for ~10 demo users; automation only after measured operator throughput makes the manual gate the bottleneck | normal | verdict rendered (skeptic D2) | skeptic + DEMO-SCOPE.md + C21 | S14, S9 | lane-conversion-tooling's C23-C30 remain valid technical reference for the operator-triggered render step |
| C57 | Tenant/RLS bridge is a real persistence blocker: server-trusted {tenantId: UUID, accountId, actorId} resolution + `SET LOCAL app.tenant_id` (never request input) + cross-tenant/pool-leak tests are prerequisites for ANY DB-backed upload; current snapshot-backed demo behavior is separate and NOT a durable multi-tenant claim | high | verdict rendered (skeptic D3) | auth-session C32-C35 + skeptic | S6, infra/database/README.md | under (b), implement only the private asset/job slice needed now |
| C58 | Active content policy: REJECT outright (no quarantine+scan as acceptance policy): strict allowlist; reject/delete packages containing VBA parts, ppt/embeddings (OLE), ActiveX, external relationships, encrypted members BEFORE any parser/renderer; raw bytes land only in non-public, non-executable quarantine; AV/CDR later as defense-in-depth only | high | verdict rendered (skeptic D4) | file-security C45 + skeptic | Microsoft format refs | no valid demo need for active content |
| C59 | DB retention (`apply_retention()`) deletes presentation rows but has NO hook to delete `deck_storage_uri` targets — storage leak; needs spool-root TTL/orphan sweep (never traverse user-provided paths) | normal | supported | upload-mechanics | private migrations + upload-mechanics FINAL | DB cascade cannot delete external bytes |
| C60 | PDF active actions (/OpenAction, /AA, /JavaScript, /Launch, /URI, /SubmitForm, /EmbeddedFiles) are not screened by the current extractor; PyMuPDF get_text does not execute them, but retained/served originals cross into viewer-dependent active content — original-file lifecycle decision (discard vs quarantine+attachment-only serving) is required | high | supported | file-security | opensource.adobe.com PDFMark actions + Acrobat JS API | current staged original is deleted at context exit |
| C61 | Rasterization may stay INSIDE the existing bounded PyMuPDF worker (`Page.get_pixmap()` → PNG + exact dimensions), avoiding a second CLI/package (pdftoppm); decision deferred to a benchmark on the Korean acceptance corpus | normal | recommended (render-pipeline) | render-pipeline FINAL | services/ingestion pdf_worker.py | pdftoppm remains valid alternative; benchmark before locking |
| C62 | Lifecycle boundary: POST multipart upload → validate/stage/hash + durable job → 202/jobId; worker renders (PPTX via Gotenberg, PDF via PyMuPDF), rasterizes, hashes/stores public images, atomically marks privateDeck/publicDeck READY; client polls GET job; createPresentation forbidden until READY; webhooks rejected (callback auth/SSRF complexity, PDF-only output) | normal | recommended (render-pipeline) | render-pipeline FINAL | gotenberg.dev config (serialized instance, default 30s API timeout) | synchronous upload unsuitable (variable conversion latency) |
| C63 | Presenter preview/approval step is a product SAFETY gate (READY_PREVIEW → explicit approve → publish), not polish: static output contract cannot absorb conversion drift after session starts; Noto CJK glyph coverage ≠ Malgun Gothic layout fidelity | high | recommended | render-pipeline FINAL + skeptic D2 | gotenberg docs (fonts-noto-cjk but no Malgun Gothic) | custom legally-deployable fonts could improve fidelity |
| C64 | skeptic independence framing: every proposal must label PRIVATE_INTAKE (upload → owner-only storage/context; no public artifact until operator review/render/declassification) vs SELF_SERVE_PUBLIC (upload auto-triggers rendering/public artifact — a first-demo scope EXPANSION); option (b) = PRIVATE_INTAKE; '~10 users' is NOT citable to DEMO-SCOPE.md (re-confirms C42) | normal | framing adopted (skeptic) | skeptic final framing | README.md, DEMO-SCOPE.md, AI-BOUNDARY.md | none |
| C65 | Storage decision FINAL: filesystem staging for the first demo — stream multipart to `$DECK_SPOOL_ROOT/.incoming/<server-id>.part`, hash+fsync, atomic no-replace rename to `private-decks/{account}/{sha256}/source.<ext>`; store `file:` URI in `deck_storage_uri` (storage-agnostic contract, S3/R2 URI later); NEVER user filenames; NO MinIO (SNSD = overbuilt, no HA gain) and NO R2 in the demo critical path; switch triggers: multi-node, replicas, node-loss survival, direct-upload bandwidth, >10MiB decks with restart pain; spool quota ~4-5 GiB (~2 GiB worst-case source+copy) | normal | decision rendered (upload-mechanics FINAL, aligns with skeptic simplicity) | upload-mechanics FINAL | S1, S6, contracts.py | R2 preferred over MinIO once real object storage is justified (free tier covers demo scale; presigned PUT only, no HTML-form POST) |
| C66 | Atomicity semantics differ by storage backend: CLI hard-link no-replace protects only local JSON output and does NOT transfer through web ingest()/DB/object store — web path needs its own conditional publication (filesystem: exclusive temp+fsync+no-replace+parent-dir fsync; DB: transaction/CAS; object store: If-None-Match); spool input must be exclusive-temp fd, byte-counted, fsync'd, atomically immutable before enqueue; server-detected kind, never user suffix/path | high | supported | file-security FINAL (transfer matrix) | cli.py, worker.py, validation.py | stage_input does independently secure parser input once a stable local spool exists |
| C67 | Artifact semantics: persist original/PPTX + intermediate PDF ONLY in private staging; encode final PNG first, hash exact bytes, read dims from decoded output; upload immutable content-addressed images; atomically commit ONE canonical manifest emitting BOTH privateDeck+publicDeck with identical deckVersion/manifestHash; READY is all-or-nothing (createPresentation rejects non-READY); public URLs must be real stable Stage-fetchable URLs (never public.example.test/data URLs/raw PDF/client canvas); unreferenced images GC-safe; accessibilityLabel = visible/public-safe title+ordinal, NEVER speaker notes; 400/unsupported/encrypted/resource-limit = terminal, 500/503/timeouts = bounded retry | high | recommended (render-pipeline ARTIFACT SEMANTICS FINAL) | render-pipeline FINAL | prepared-evidence.ts, public-deck.ts | none |
| C68 | Android FSA contradiction confirmed: Chromium prose claims Android support but compat data shows `showOpenFilePicker` unsupported on Chrome Android — keep `<input type=file>` fallback, never promise Android pickers without feature detection | normal | supported | pwa-constraints LEAD/CONTRADICTION | MDN BCD, Chromestatus | OPFS/handle primitives exist on Android; picker methods don't |
| C69 | PWA backgrounding/mobile suspension does NOT make large uploads continue reliably: Background Sync is for deferred retries (browser may terminate SW mid-transfer), Background Fetch is limited/experimental (download-oriented); rely on protocol-level resumability (tus/GCS session + persisted upload URL/offset) + 'keep app foreground' guidance; never queue whole PPTX/PDF POST bodies in Workbox Background Sync | normal | supported | pwa-constraints | MDN Background Sync/Background Fetch, Workbox docs | none |
| C70 | Persisted tus upload URL/offset is NOT persisted file access: a File chosen via input/drop is held only by the current page; after relaunch the user must re-select the SAME file for fingerprint matching ('Choose the same file to resume'); do not copy large decks into IndexedDB just to retain bytes (quota risk); File Handling/FSA handles can reduce reselection friction but may need permission re-grant + getFile() refresh | normal | supported (raised twice by pwa-constraints) | pwa-constraints FINAL | tus-js-client docs, MDN File API | none |
| C71 | No surveyed vendor (Pitch, Prezi, Beautiful.ai, Google Slides, Mentimeter, Sendsteps, Poll Everywhere, Slido) publicly documents OOXML/PPT conversion or slide-rendering internals; Canva's engineering post covers generic media upload architecture only; observable output semantics (editable elements vs raster vs holding slides) are the strongest available architecture evidence | normal | supported | competitor-benchmark FINAL | canva.dev blog + all vendor help/eng hubs | none |
| C72 | No surveyed vendor publishes an office-upload-specific malware-scanning/active-content-stripping contract (adjacent-only material: general platform security, add-in data-scope, signed binaries, Drive download warnings); absence of docs ≠ absence of operational scanning, but this is a public enterprise due-diligence gap OUR product can differentiate on with a precise upload trust-boundary statement | high | supported | competitor-benchmark FINAL | pitch.com security-policy, beautiful.ai, polleverywhere.com, google.com, mentimeter.com | counter noted: undocumented does not mean absent |
| C73 | Market architectures cluster into four modes: editable object conversion (Pitch/Canva/Beautiful.ai/Google), static raster import (Mentimeter/Prezi classic/Sendsteps), URL embedding (Mentimeter), metadata holding slides (Poll Everywhere/Slido); Prezi/Sendsteps add separate AI regeneration paths | normal | supported | competitor-benchmark FINAL (9-product primary-source matrix, 50+ queries) | official docs per product | none |

### frontend / UI (lane-frontend-sweep, lane-db-sweep)

| id | statement | risk | status | supporting obs | primary source | counter |
|---|---|---|---|---|---|---|
| C12 | Current browser code cannot upload a PPTX/PDF at all — no production caller of /v1/deck-artifacts exists in console source | high | **supported (2 independent workers converge: ingestion-integration + lane-frontend-sweep)** | O-ING-1 | S11 | none — exhaustive AST/string search both ways |
| C13 | No upload/file-picker/drag-drop UI exists anywhere in apps/console, apps/stage, or packages/ui | normal | supported (same convergence as C12) | O-ING-1, O-FE-1 | S11 | none |
| C14 | `pdfjs-dist` is not explicitly forbidden by the browser dependency policy | normal | supported | O-FE-1 | S12 | none |
| C15 | A parser emitting `.wasm` beneath a browser app root will violate the current boundary checker | normal | supported | O-FE-1 | S12 | node_modules excluded, but generated app output is scanned |
| C16 | Same-origin PDF workers/resources are CSP-compatible; CDN-hosted ones are blocked | normal | supported | O-FE-1 | S13 | none |
| C17 | No upload/staging/object-store schema exists in any of the 12 SQL migrations | normal | supported | O-DB-1 | S6, S7 | none — exhaustive keyword sweep |
| C18 | Database tests cover deck/source URI rows only indirectly (seeding, RLS, retention) — no upload-state/multipart/presigned/staging assertions | normal | supported | O-DB-1 | tests/database/* | none |
| C19 | The current "deck upload" endpoint generates deterministic artifacts from JSON text rather than uploading bytes to any store | normal | supported | O-DB-1, O-UPLOAD-1 | S2 | none |
