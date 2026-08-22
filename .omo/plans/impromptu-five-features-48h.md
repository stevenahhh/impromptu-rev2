# impromptu-five-features-48h - Work Plan

## TL;DR (For humans)
**What you'll get:** PDF와 PPTX 발표 자료, 로컬 한국어 음성인식, 내부·외부 근거 검색, 중립적인 실시간 코칭, 발표 후 리포트를 하나의 발표자 전용 흐름으로 연결합니다. 추가 결정에 따라 스캔 PDF도 로컬 OCR로 실제 검색 가능하게 만들며, 청중 화면에는 끝까지 슬라이드만 보입니다.

**Why this approach:** 음성·문서 계약을 먼저 고정해 생산자와 소비자를 동시에 개발하고, 공유 경계는 정해진 통합 시점에만 합칩니다. OCR은 사용자가 추가한 여섯 번째 subsystem으로 비용과 실패 상태를 별도 표시해 나머지 다섯 기능의 결과를 가리지 않습니다.

**What it will NOT do:** 브라우저 AI, 공개 근거 카드, 보편적인 말하기 속도 판정, transcript 본문 저장, pgvector·VAD·분석 대시보드·새 운영 orchestration은 만들지 않습니다. 장기 동시성·운영 hardening도 48시간 결과로 과장하지 않습니다.

**Effort:** Large - 5인 규모의 최대 병렬 실행과 네 번의 제한된 통합을 전제로 한 48시간 압축
**Risk:** High - 실제 whisper word timing, keyless 검색의 403, 새 OCR의 이미지·발열 비용, 다수 shared seam이 지배합니다.
**Decisions to sanity-check:** 스캔 PDF OCR과 keyless-first 다중 검색은 기존 합의보다 명시적으로 늘어난 범위입니다. 코칭 window와 48시간 완료 정의는 실행 전에 사용자가 결정해야 합니다.

Your next move: 고정밀 계획 리뷰 결과를 확인하고, 별도 실행 세션에서 이 계획을 시작합니다. Full execution detail follows below.

---

> TL;DR (machine): Large/high-risk, 28 implementation todos + 4 final verifiers; core-5와 OCR을 분리한 48시간 contract-first merge-train plan.

## Scope
### Must have
- 기존 장기 계획을 폐기하지 않고, 로컬 한국어 STT·외부 근거 검색·lexical+dense RAG·실시간 코칭·발표 후 리포트를 48시간 merge-train overlay로 압축한다.
- PDF와 PPTX 모두 기존 `DeckManifest` 구조 요소를 통해 포맷 중립적으로 색인한다. text-layer PDF/PPTX가 먼저 독립적으로 성공해야 한다.
- 사용자가 범위를 늘린 여섯 번째 subsystem으로 scanned-PDF OCR을 별도 후행 트랙에 둔다. 엔진은 서버 로컬 Tesseract 5 + pinned `tessdata_fast` `kor+eng`이며 OCR 실패는 나머지 5기능의 `CORE5_GREEN`을 막지 않는다.
- Stage는 슬라이드 전용이다. private approve/coordinator, projection ingress/serializer, Stage client의 세 경계가 모두 source 종류와 무관하게 card를 fail-closed한다. legacy `publicCardRevision`은 읽고 버리는 호환 필드만 남긴다.
- STT는 Chrome이 실제 생성하는 `audio/webm;codecs=opus` 하나만 받고, `sessionGeneration + sequence + PARTIAL|REPLACE|FINAL|ABORT + word-time` 계약을 스트리밍한다. partial은 recommendation을 시작하지 않고 FINAL만 한 번 시작한다.
- hybrid retrieval은 동일 ACL·RLS·source-revision 집합에서 PostgreSQL `simple` FTS와 기존 dense cosine 후보를 고정 RRF로 합친다. 보안 검증 실패는 0건, 검증 후 한 retriever 장애는 다른 retriever로 degrade한다.
- 외부 검색은 senpi의 방식을 재구현한 fixed-priority provider chain을 private-backend에만 둔다: keyless DuckDuckGo HTML 기본, 설정된 경우 Google CSE, Brave 순서. 403/429/0-result/timeout은 진단 후 internal-only 결과를 보존한다.
- 외부 provider에서는 URL만 후보로 보존한다. title/snippet은 버리고, 기존 `SafeExternalEvidenceFetcher`가 DNS와 redirect를 매 hop 재검증해 origin bytes에서 만든 `rights: UNKNOWN` evidence만 Console private card에 표시한다.
- 코칭은 opt-in/mute이며 검증된 FINAL word timestamp로 현재/직전 rolling pace와 변화량만 중립 숫자로 표시한다. word가 없으면 `MEASUREMENT_UNAVAILABLE`이고 silence로 추정하지 않는다.
- 리포트는 ordered `slide_visit`과 per-session CAS 한 행에서 총 시간, dwell/재방문, 파생 speech summary·word count·timing/coaching aggregate, 준비된 근거 목록을 owner-only DTO로 만든다. transcript 본문·partial·raw audio는 저장하지 않는다.
- 마이그레이션은 private `0008`(retrieval)과 `0009`(report)만 새로 추가하며 기존 migration을 수정하지 않는다.
- 2개 core positive fixture, revised negative assertions, STT 필수 2시나리오, scanned-PDF positive OCR, 기존 recommendation 10회 p95 회귀를 agent가 실제 surface에서 검증한다.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 새 normalized deck DTO, 별도 PDF subsystem, PPTX SVG regex extractor 재작성, cloud/browser OCR·VLM, OCR engine bake-off를 만들지 않는다.
- provider registry 범용화, VAD, diarization, 다중 audio codec, STT provider 비교, browser AI runtime/model/credential을 넣지 않는다.
- pgvector를 이번 48시간 범위에 넣거나 영구 금지로 선언하지 않는다. legacy retrieval row backfill도 하지 않는다.
- public evidence mapper, Stage card renderer, public rights 완화, search title/snippet evidence 승격을 만들지 않는다.
- coaching의 보편 임계값, 정상/비정상 판정, warning color, toast, silence 경고, persisted coaching event stream을 만들지 않는다.
- 6종 event ledger, outbox, 범용 analytics, dashboard, HTML export, live-path report generation을 만들지 않는다.
- recommendation의 기존 5초 deadline 밖에 새 deadline orchestrator·queue·retry·circuit breaker·budget scheduler를 만들지 않는다. 외부 branch에는 parent보다 짧은 child abort 하나만 허용한다.
- projection-gateway가 private-backend를 import하거나, Stage가 private contract를 import하거나, 새 vendor key/SDK가 browser denylist에서 빠지게 하지 않는다.
- cold/concurrent production p95, 장기 soak·capacity, September 운영 hardening을 48시간 완료 증거로 가장하지 않는다.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: shared contract·migration·security invariant는 TDD, adapter·UI는 frozen fixture 기반 tests-after. Bun test, Pytest, PostgreSQL integration, Playwright/browser E2E를 사용한다.
- Evidence root: ulw-loop 안에서는 `omo-agent-toolkit ulw-loop status --json`의 `currentAttemptDir`; 밖에서는 `.omo/evidence/impromptu-five-features-48h/`. 각 task는 `task-<N>/` 아래 command log, machine-readable JSON, 필요 시 screenshot을 남긴다.
- 비결정성 금지: fixed sleep/polling delay를 쓰지 않는다. SSE/WS/CAS/MediaRecorder 테스트는 정확한 event promise를 trigger 전에 subscribe하고 bounded timeout으로 await한다. clock/cadence/deadline 테스트는 manual scheduler를 쓴다.
- 각 branch는 관련 validator를 정확히 한 번 green으로 만든 뒤 제출한다. merge train은 `bun test --max-concurrency 1 --timeout 30000` 단일 실행, Python/DB 관련 명령, build/browser boundary를 다시 실행한다.
- Core positive: 기존 text-layer PDF와 PPTX 각각 `upload -> streamed FINAL -> hybrid evidence -> opt-in coaching -> session end -> report`를 실제 Console/HTTP surface로 통과한다.
- OCR positive: generated scanned Korean PDF가 `scanned_page_requires_ocr` hook에서 local OCR되어 text chunk와 searchable evidence를 만든다. binary/model 부재·OCR nonzero/empty는 `OCR_UNAVAILABLE`로 가시적으로 실패하고 암호화 PDF는 기존 거부를 유지한다.
- Negative: mic 거부 시 audio request 0건, external 403/429에도 internal-only `RECOMMEND`, Stage snapshot/SSE/WS card 0건, A→B→A dwell이 finalize/restart 후 동일하다.
- STT 필수: `partial-before-final`, `revoke-stops-and-blocks-late-delivery`; 같은 segment의 post-FINAL/duplicate FINAL과 ABORT 이후 event를 거부한다.
- 성능: confirmed FINAL→Console recommendation 10회와 기존 recommendation 10회를 측정해 성공 10/10 및 p95 <= 5,000ms를 요구한다. representative PDF/PPTX cold/warm은 기록만 하며 장기 결론에 쓰지 않는다.
- 기본 validator:
  - `uv run --project services/ingestion pytest && uv run --project services/ingestion ruff check src tests && uv run --project services/ingestion basedpyright`
  - `bun test services/model-router services/private-backend packages/state apps/console services/projection-gateway`
  - `bun run test:db && bun run test:security && bun run test:e2e`
  - `bun run lint && bun run typecheck && bun run build && bun run check:boundaries && bun run check:browser-boundary && bun run check:browser-runtime`

## Execution strategy
### Parallel execution waves
> 독립 task는 별도 worktree/topic branch에서 fanout한다. 한 worktree를 둘 이상의 agent가 공유하지 않는다.

- **Wave 0 / T+0~4h - 계약·fixture·Stage 경계 freeze (1~5):** Q4/Q5 owner gate는 독립적으로 열어 두고, STT envelope와 deck fixture를 먼저 고정한다. 동시에 Stage card의 private/gateway/client 경계를 닫는다.
- **Merge train 1 / T+4h (6):** 지정 integrator만 shared exports와 Stage vertical을 합치고 snapshot/SSE/WS 0-card gate를 실행한다.
- **Wave 1 / T+4~14h - producer·storage fanout (7~13):** structural ingestion, streaming router, local whisper, capture transport, retrieval DB, external provider, report DB를 최대 병렬로 제출한다.
- **Merge train 2 / T+14h (14):** 지정 integrator만 `router.ts`, `audio-capture.ts`, `main.ts`, shared config/exports를 연결하고 producer vertical gate를 실행한다.
- **Wave 2 / T+14~30h - feature semantics (15~20):** OCR은 core와 분리해 후행 실행하고, hybrid RRF, Console capture, FINAL trigger, coaching reducer, report finalizer를 fixture 기반으로 병렬 개발한다.
- **Merge train 3 / T+30h (21):** core shared seam을 통합한다. OCR red는 기록하되 이 열차와 `CORE5_GREEN`을 막지 않는다.
- **Wave 3 / T+30~44h - UI·vertical acceptance (22~27):** coaching/evidence/report UI, core E2E, OCR E2E, 성능·scope receipt를 병렬 실행한다.
- **Merge train 4 / T+44~48h (28):** 전체 build/security/test를 한 번 실행하고 `CORE5_GREEN`과 `OCR_GREEN`을 별도 상태로 고정한다. expanded request 완료는 둘 다 green일 때만 주장한다.

**Shared-seam ownership:** 지정 integrator 외 agent는 `services/model-router/src/router.ts`, `services/private-backend/src/audio-capture.ts`, `services/private-backend/src/main.ts`, `packages/contracts/src/private.ts`, `packages/state/src/index.ts`, `apps/console/src/App.tsx`를 수정하지 않는다. 각 track은 새 adapter/module/test와 wiring manifest를 제출하고, integrator가 하루 두 번의 train에서만 shared diff를 적용한다.

**Migration ownership:** `0008_deck_retrieval_hybrid.sql`은 retrieval owner, `0009_session_reports.sql`은 report owner에게 고정한다. 다른 branch는 migration을 추가하지 않으며 적용된 `0001~0007`을 수정하지 않는다.

**Owner-input gates:** task 1이 Q4와 Q5를 machine-readable decision으로 기록하기 전 task 22(coaching UI)와 task 27/28(완료 경계/최종 선언)은 시작할 수 없다. 권고는 Q4=30초, Q5=guarded 48시간 acceptance지만 executor가 대신 선택하지 않는다.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 22, 27, 28 | 2-5 |
| 2 | - | 6, 8-10, 17-19 | 1, 3-5 |
| 3 | - | 6, 7, 11, 13, 15 | 1, 2, 4, 5 |
| 4 | - | 6 | 1-3, 5 |
| 5 | - | 6 | 1-4 |
| 6 | 2-5 | 7-14 | - |
| 7 | 3, 6 | 14-16 | 8-13 |
| 8 | 2, 6 | 10, 14, 18 | 7, 9, 11-13 |
| 9 | 2, 6 | 14, 19, 22 | 7, 8, 10-13 |
| 10 | 2, 6, 8 | 14, 17, 18, 20 | 7, 9, 11-13 |
| 11 | 3, 6 | 14, 16 | 7-10, 12, 13 |
| 12 | 6 | 14, 23 | 7-11, 13 |
| 13 | 3, 6 | 14, 20 | 7-12 |
| 14 | 7-13 | 15-21 | - |
| 15 | 7, 14 | 26, 28 | 16-20 |
| 16 | 7, 11, 14 | 18, 21, 23, 25 | 15, 17, 19, 20 |
| 17 | 2, 10, 14 | 21, 22 | 15, 16, 18-20 |
| 18 | 2, 8, 10, 16 | 20, 21, 23, 25 | 15, 17, 19 |
| 19 | 1, 2, 9, 14 | 20-22 | 15-18 |
| 20 | 10, 13, 18, 19 | 21, 24, 25 | 15-17 |
| 21 | 14, 16-20 | 22-25 | 15 |
| 22 | 1, 9, 17, 19, 21 | 25, 28 | 23, 24, 26 |
| 23 | 12, 16, 18, 21 | 25, 28 | 22, 24, 26 |
| 24 | 20, 21 | 25, 28 | 22, 23, 26 |
| 25 | 16, 18, 20-24 | 27, 28 | 26 |
| 26 | 15 | 28 | 22-25, 27 |
| 27 | 1, 25 | 28 | 26 |
| 28 | 1, 15, 21-27 | F1-F4 | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. Q4/Q5 사용자 결정을 실행 게이트로 고정
  What to do / Must NOT do: 제품 코드는 건드리지 않는다. 사용자에게 Q4 `30|45|60초`와 Q5 `guarded-48h|include-hardening`을 각각 명시적으로 받아 `.omo/evidence/decisions/coaching-window.json`과 `.omo/evidence/decisions/completion-boundary.json`에 `{decision, decidedBy:"user", decidedAt}`로 기록한다. 권고값을 제시하되 executor가 대신 선택하거나 무응답을 승인으로 간주하지 않는다.
  Parallelization: Wave 0 | Blocked by: 없음 | Blocks: 22, 27, 28
  References (executor has NO interview context - be exhaustive): `.omo/drafts/impromptu-five-features-48h.md` Open questions/Approval gate; 본 계획 `Execution strategy > Owner-input gates`.
  Acceptance criteria (agent-executable): `node -e`로 두 JSON을 parse하고 coaching 값이 `[30,45,60]`, completion 값이 `guarded-48h|include-hardening`, `decidedBy === "user"`임을 assert한다. 두 파일 중 하나라도 없거나 범위 밖이면 dependent task를 dispatch하지 않는다.
  QA scenarios (exact tool + invocation): happy=`node scripts/verify-plan-decisions.mjs --coaching .omo/evidence/decisions/coaching-window.json --completion .omo/evidence/decisions/completion-boundary.json`; failure=임시 invalid fixture로 validator가 nonzero인지 확인. Evidence `<evidence-root>/task-1/decision-validation.log`.
  Recommended task executor category: `writing` - 사용자 선택을 코드와 분리된 machine-readable gate로 고정하는 작업이다.
  Commit: N | 사용자 결정 evidence는 product commit에 넣지 않는다.

- [ ] 2. STT event envelope와 두 필수 fixture 동결
  What to do / Must NOT do: private STT schema를 `sessionGeneration`(positive safe integer), monotonic `sequence`, `segmentId`, `PARTIAL|REPLACE|FINAL|ABORT`, word timestamps로 고정한다. `REPLACE`는 같은 segment의 이전 sequence를 가리키고 `FINAL`은 유일한 `finalSegmentId`를 요구한다. 같은 segment의 post-FINAL/duplicate FINAL, generation ABORT 이후 event를 거부한다. FINAL words는 비어 있을 수 있으나 그 경우 coaching은 측정 불가다. provider wording이나 UI prose를 fixture로 pin하지 않는다.
  Parallelization: Wave 0 | Blocked by: 없음 | Blocks: 6, 8-10, 17-19
  References: `services/model-router/src/stt.ts:1-55`; `packages/contracts/src/audio.ts:1-103`; `services/model-router/src/router.ts:302-521`; `services/private-backend/src/audio-capture.ts:1-58`; `services/private-backend/test/audio-lifecycle.test.ts:69-143`.
  Acceptance criteria: `packages/contracts` private audio contract와 model-router schema가 같은 machine values를 검증한다. `partial-before-final.json`은 순서대로 통과하고 `revoke-stops-and-blocks-late-delivery.json`의 late event, duplicate FINAL, post-ABORT는 각각 stable code로 실패한다. `bun test tests/contract/audio.test.ts services/model-router/test/router.test.ts services/private-backend/test/audio-lifecycle.test.ts`가 한 번에 green이다.
  QA scenarios: happy=manual scheduler로 PARTIAL→REPLACE→FINAL signal을 trigger 전에 subscribe하여 수집; failure=FINAL 뒤 동일 segment event와 revoke 뒤 event를 주입. Evidence `<evidence-root>/task-2/stt-contract.json`.
  Recommended task executor category: `deep` - producer/consumer 전체를 잠그는 cross-package protocol이다.
  Commit: Y | `test(stt): freeze streaming event envelope`

- [ ] 3. PDF/PPTX/OCR fixture와 migration 번호 동결
  What to do / Must NOT do: 기존 text-layer PDF/PPTX를 재생성 가능한 fixture로 고정하고 둘이 같은 expected Korean sentinel/chunk semantics를 갖게 한다. 별도 scanned Korean PDF fixture와 expected OCR sentinel을 생성하되 새 deck DTO를 만들지 않는다. migration ownership을 private 0008=retrieval, 0009=report로 manifest에 고정한다. binary fixture에는 generator, SHA-256, provenance를 함께 둔다.
  Parallelization: Wave 0 | Blocked by: 없음 | Blocks: 6, 7, 11, 13, 15
  References: `tests/fixtures/custom-deck-upload/generate.py`; `tests/fixtures/custom-deck-upload/custom-runtime-deck.pptx`; `tests/fixtures/custom-deck-upload/custom-static-deck.pdf`; `tests/fixtures/deck-registry.json`; `services/ingestion/src/impromptu_ingestion/contracts.py:122-149`; `services/ingestion/tests/conftest.py`.
  Acceptance criteria: generator를 두 번 실행한 SHA 목록이 동일하고, text PDF/PPTX structural manifest에서 동일 sentinel이 나오며 PPTX chunk에 `<date/time>` sentinel 오염이 없다. scanned fixture는 기존 adapter에서 `scanned_page_requires_ocr`를 재현한다. manifest가 0008/0009 외 신규 migration을 허용하지 않는다.
  QA scenarios: happy=`uv run --project services/ingestion pytest services/ingestion/tests/test_adapters.py -k 'pdf or pptx or scanned'`; failure=fixture hash 하나를 바꿔 registry validator가 실패하는지 확인. Evidence `<evidence-root>/task-3/deck-fixtures.json`.
  Recommended task executor category: `unspecified-high` - Python fixture와 cross-track ownership을 함께 고정한다.
  Commit: Y | `test(ingestion): freeze format-neutral deck fixtures`

- [ ] 4. private publication 경계를 source-agnostic 410/fail-closed로 전환
  What to do / Must NOT do: `POST /v1/publications/approve`와 card transition route를 410 `stage_cards_disabled`로 반환하고, `PreparedEvidenceCoordinator`의 curated/live 모든 publish transition이 mutation/projection 전에 `PUBLICATION_DISABLED`로 거부되게 한다. `ProjectionHttpPort.projectCard`와 private public-card mapper/call site를 제거한다. legacy snapshot의 `publicCardRevision`은 restore 시 읽되 card collection/lifecycle은 버린다. 기존 publication tests를 삭제하지 말고 positive-publication 기대를 negative policy regression으로 바꾼다.
  Parallelization: Wave 0 | Blocked by: 없음 | Blocks: 6
  References: `services/private-backend/src/http.ts:677-704`; `services/private-backend/src/prepared-evidence.ts:1090-1196,1273-1297,1358-1369`; `services/private-backend/src/projection-http-port.ts:111-140`; `services/private-backend/test/prepared-evidence.test.ts`; `tests/security/release-security.test.ts:304-396`.
  Acceptance criteria: curated와 live 각각 approve 요청이 410이고 coordinator state hash, candidate revision, publicCardRevision, projection call count가 전후 동일하다. repository-wide runtime reference graph에 호출 가능한 `projectCard` mapper가 없고 `bun test services/private-backend/test/prepared-evidence.test.ts services/private-backend/test/http.test.ts tests/security/release-security.test.ts`가 green이다.
  QA scenarios: happy=authenticated curated/live approve를 보내 둘 다 410과 zero side effect 확인; failure=forged source kind/legacy snapshot을 넣어도 transition이 열리지 않음을 확인. Evidence `<evidence-root>/task-4/private-stage-card-denial.json`.
  Recommended task executor category: `deep` - 보안 불변식을 유지하며 기존 CAS 상태를 compatibility-only로 축소한다.
  Commit: Y | `fix(publication): disable every stage card transition`

- [ ] 5. projection ingress·snapshot/SSE/WS·Stage serializer에서 card 제거
  What to do / Must NOT do: projection gateway `/internal/cards` ingress와 `projectCard*` surface를 제거하거나 410으로 닫고, restore/snapshot serializer는 legacy cards/tombstones를 폐기해 항상 빈 배열만 내보낸다. `publicCardRevision`은 입력 호환용으로 parse 후 무시한다. realtime union에서 `CARD`를 제거하고 SSE/WS에 card payload가 들어오면 전달하지 않는다. Stage client/App의 card state/render path를 제거하되 private contract를 import하지 않는다.
  Parallelization: Wave 0 | Blocked by: 없음 | Blocks: 6
  References: `services/projection-gateway/src/prepared-evidence.ts:98-123,388-545,617,870-958`; `services/projection-gateway/src/http.ts:248-363,414,598`; `services/projection-gateway/src/realtime.ts:14-36,160-176`; `apps/stage/src/stage-client.ts:37-101,632-706`; `apps/stage/src/App.tsx:280-309,599-781`; `services/projection-gateway/test/prepared-evidence.test.ts`; `apps/stage/src/App.test.tsx`.
  Acceptance criteria: malicious legacy snapshot, `/internal/cards`, SSE CARD, WS CARD 각각 Stage observer/render tree에 card 0건을 남긴다. snapshot schema는 `publicCardRevision`을 받아도 출력 `cards=[]`, `tombstones=[]`이다. `bun test services/projection-gateway apps/stage tests/security/release-security.test.ts && bun run check:boundaries`가 green이다.
  QA scenarios: happy=slide command snapshot/SSE/WS가 정상 적용; failure=각 transport에 valid-looking curated/live card를 주입해 ingress 410 또는 drop, DOM 0건 확인. Evidence `<evidence-root>/task-5/stage-transport-zero-cards.json`.
  Recommended task executor category: `deep` - 서로 다른 세 transport와 legacy restore를 함께 fail-closed해야 한다.
  Commit: Y | `fix(stage): enforce slide-only projection`

- [ ] 6. Merge train 1 - 계약/fixture/Stage vertical 통합
  What to do / Must NOT do: 지정 integrator가 2~5의 verified commits만 dependency 순서로 cherry-pick하고 shared contract exports를 적용한다. conflict는 별도 integration commit으로 해결하고 amend/rebase하지 않는다. Q4/Q5 미결은 이 train을 막지 않는다.
  Parallelization: Merge train 1 | Blocked by: 2-5 | Blocks: 7-14
  References: tasks 2-5 evidence; `packages/contracts/src/private.ts:1-7`; `packages/state/package.json:1-13`; `package.json` scripts; `.omo/plans/impromptu-r2-hyperplan.md` atomic commit rules.
  Acceptance criteria: Stage snapshot/SSE/WS card assertions 모두 0, STT/deck fixtures parse green, `git diff --check`, `bun run typecheck`, targeted tests가 한 번에 green이다. integration branch에는 각 source commit과 필요 시 하나의 `fix(integration)` commit만 추가된다.
  QA scenarios: happy=slide playback E2E 유지; failure=legacy card fixture를 세 transport로 재주입해 모두 차단. Evidence `<evidence-root>/task-6/merge-train-1.log`.
  Recommended task executor category: `git` - shared seam의 유일한 통합 소유자가 검증된 commits를 합치는 작업이다.
  Commit: Y | `fix(integration): freeze contracts and slide-only stage`

- [ ] 7. production upload를 기존 structural manifest에 연결하고 포맷 중립 색인 입력 생성
  What to do / Must NOT do: 기존 upload deadline/atomic promotion 안에서 `impromptu-ingestion render` 뒤 `ingest --output <artifact>/ingestion.json`을 shell 없이 같은 staged source와 abort signal로 실행한다. artifact에는 기존 `render.json`과 원본 `CompletedIngestion.manifest`를 함께 승격한다. retrieval 준비는 `DeckManifest.slides[].elements`의 text/table/chart 값을 포맷 중립적으로 chunk하고 `.svg` gate 및 regex extractor를 호출하지 않는다. 새 normalized DTO를 만들지 않는다.
  Parallelization: Wave 1 | Blocked by: 3, 6 | Blocks: 14-16
  References: `services/ingestion/src/impromptu_ingestion/cli.py:25-66,252-320`; `services/ingestion/src/impromptu_ingestion/contracts.py:122-164`; `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:102-175`; `services/private-backend/src/deck-render-subprocess.ts:380-412`; `services/private-backend/src/deck-upload-worker.ts:1-91,247-300`; `services/private-backend/src/retrieval/postgres-deck-retrieval.ts:158-236,326-359`.
  Acceptance criteria: PDF/PPTX upload artifact에 valid render+ingestion manifest가 모두 있고 source/deck/slide ordering이 일치한다. 둘의 sentinel chunk가 색인되며 PNG PDF가 skip되지 않고 PPTX `<date/time>` 오염이 0이다. render 또는 ingest 한 단계 실패/abort 시 `.part`와 partial artifact가 남지 않는다.
  QA scenarios: happy=`bun test services/private-backend/test/deck-render-subprocess.test.ts services/private-backend/test/deck-upload-worker.test.ts services/private-backend/test/postgres-deck-retrieval.test.ts && uv run --project services/ingestion pytest`; failure=structural subprocess nonzero/invalid JSON/abort를 주입. Evidence `<evidence-root>/task-7/format-neutral-ingestion.json`.
  Recommended task executor category: `deep` - Python/TypeScript atomic boundary와 retrieval source를 한 번에 바꾸는 load-bearing seam이다.
  Commit: Y | `feat(ingestion): index structural manifests for pdf and pptx`

- [ ] 8. model router를 즉시-yield streaming과 terminal invariant로 수정
  What to do / Must NOT do: `transcriptEvents` terminal buffer를 제거하고 schema/state 검증 직후 각 transcript event를 yield한다. consumer cancellation 시 iterator/lease/budget reconciliation은 기존 finally semantics를 유지한다. segment terminal validator로 sequence, REPLACE target, duplicate FINAL, post-FINAL/post-ABORT를 거부한다. 새 global deadline/budget scheduler를 만들지 않는다.
  Parallelization: Wave 1, integrator-owned seam | Blocked by: 2, 6 | Blocks: 10, 14, 18
  References: `services/model-router/src/router.ts:302-521`; `services/model-router/src/stt.ts:1-55`; `services/model-router/src/isolation.ts:95-145`; `services/model-router/test/router.test.ts:606-792`; `services/model-router/AGENTS.md`.
  Acceptance criteria: adapter가 첫 PARTIAL을 emit한 deferred signal이 resolve되면 adapter completion 전 consumer가 그 event를 받는다. malformed ordering은 stable provider error로 terminalize되고 lease/active isolate count가 0으로 돌아온다. `bun test services/model-router` 한 번 green이다.
  QA scenarios: happy=manual deferred PARTIAL→FINAL; failure=duplicate final과 consumer cancel을 trigger하고 exact completion/cleanup signal await. Evidence `<evidence-root>/task-8/router-streaming.json`.
  Recommended task executor category: `deep` - policy/budget cleanup을 깨지 않고 stream timing을 바꾸는 shared critical seam이다.
  Commit: Y | `fix(model-router): yield stt events as received`

- [ ] 9. pinned local whisper.cpp 단일-codec adapter와 word-timing capability gate 구현
  What to do / Must NOT do: `services/private-backend/src/model-adapters/whisper-cpp.ts`에 exact binary/model path와 shell=false argv만 허용하는 `WhisperCppStreamingAdapter`를 만들고, model-router registry에는 이 concrete adapter를 위한 `trusted-local` streaming kind 하나만 추가한다. 기존 isolated adapters의 permission을 넓히거나 arbitrary command/adapter subprocess surface는 만들지 않는다. whisper.cpp tag `b4938` commit `371b5a7561823ab2bb32142d2751e35e7534727b`, `ggml-small-q5_1.bin` 190,085,487 bytes/SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`을 pin한다. 입력은 `webm-opus`만 받고 ffmpeg로 16kHz mono s16le를 decode한다. 고정 15초 segment에서 3초 cadence PARTIAL/REPLACE, segment/end에서 FINAL을 만들며 이전 inference가 진행 중이면 중간 partial을 skip하되 queue/retry하지 않는다. VAD/diarization/multi-codec/provider registry는 금지한다.
  Parallelization: Wave 1 | Blocked by: 2, 6 | Blocks: 14, 19, 22
  References: `services/model-router/src/registry.ts:1-235`; `services/model-router/src/isolation.ts:1-145`; `services/model-router/src/stt.ts:1-55`; `services/private-backend/Dockerfile`; `config/browser-forbidden-dependencies.json`; `https://github.com/ggml-org/whisper.cpp/releases/tag/b4938`; `https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-small-q5_1.bin`.
  Acceptance criteria: pinned Korean WAV→browser WebM fixture에서 PARTIAL before FINAL, normalized Korean sentinel, monotonic word times, exactly-one finalSegmentId를 얻는다. receipt JSON은 binary/model hashes, p50/p95 cadence, `wordTimingCapable` boolean을 기록한다. transcript는 성공하지만 reliable partial word timing이 없으면 boolean=false로 완료하고 task 22는 pace UI 대신 측정 불가만 출시한다. model/binary/key path가 Console/Stage build artifact에 0건이다.
  QA scenarios: happy=`bun test services/model-router/test/router.test.ts services/private-backend/test/audio-lifecycle.test.ts && bun run test:stt-bakeoff`; failure=wrong codec, corrupt WebM, missing model, cancel mid-inference를 각각 stable failure로 확인. Evidence `<evidence-root>/task-9/whisper-capability.json`.
  Recommended task executor category: `ultrabrain` - native runtime, streaming semantics, timing evidence가 하나의 어려운 cohesive problem이다.
  Commit: Y | `feat(stt): add pinned local whisper streaming adapter`

- [ ] 10. private audio grant/frame/SSE transport와 streaming coordinator 연결
  What to do / Must NOT do: 기존 `AudioCaptureCoordinator`의 consent, short-lived single-use grant, revoke/logout/session-end, 30초 buffered-duration cap을 재사용한다. grant issue가 HttpOnly `__Host-capture` cookie를 설정한 뒤 ID/capability를 URL에 넣지 않는 private routes를 고정한다: `POST /v1/audio/grants`, `GET /v1/audio/events`(SSE), `POST /v1/audio/stream/start`, `POST /v1/audio/frames`(`application/octet-stream`, sequence/duration은 bounded headers), `POST /v1/audio/stream/stop`, `DELETE /v1/audio/grant`. SSE는 start 전에 subscribe 가능해야 하며 `RouterBackedAudioSttPort`가 transcript events를 그대로 전달한다. raw bytes는 memory queue 외 저장/log 금지, partial/final text도 이 task에서는 persistence 금지다.
  Parallelization: Wave 1, integrator-owned seam | Blocked by: 2, 6, 8 | Blocks: 14, 17, 18, 20
  References: `services/private-backend/src/audio-capture.ts:1-300`; `services/private-backend/src/http.ts:360-548`; `services/private-backend/test/audio-lifecycle.test.ts`; `tests/security/audio-lifecycle.test.ts`; `services/private-backend/AGENTS.md`.
  Acceptance criteria: valid grant stream이 PARTIAL/FINAL을 순서대로 SSE에 내보내고 frame sequence/30초 cap을 강제한다. grant 없는 frame, replay, expired/revoked grant, late delivery는 body read/model invocation 전에 거부된다. raw audio/transcript 문자열이 DB, log, snapshot에 없음을 sentinel scan으로 확인한다.
  QA scenarios: happy=event promise를 먼저 subscribe한 뒤 grant→start→frames→stop; failure=revoke exact event를 await한 뒤 late frame을 보내 0 provider delivery 확인. Evidence `<evidence-root>/task-10/private-audio-stream.json`.
  Recommended task executor category: `deep` - existing lifecycle 권한과 새 bidirectional stream을 결합하는 shared seam이다.
  Commit: Y | `feat(audio): stream private capture events end to end`

- [ ] 11. private 0008 RLS·actual revision·transactional replace 기반 추가
  What to do / Must NOT do: 새 `0008_deck_retrieval_hybrid.sql`만 추가한다. `deck_retrieval_chunks`에 FORCE RLS를 적용하되 text `tenant_id = nullif(current_setting('app.tenant_id', true),'')`를 사용하고 uuid cast를 복사하지 않는다. `simple` tsvector/generated column과 GIN index를 추가한다. repository wrapper는 transaction마다 `SET LOCAL app.tenant_id`를 설정한다. embedding은 transaction 전에 계산하고 upload 단위 transaction에서 old revision delete+new rows insert를 원자적으로 교체한다. `source_revision=DeckManifest.source_sha256`, `source_hash=chunk SHA-256`으로 교정하며 legacy backfill은 하지 않는다.
  Parallelization: Wave 1 | Blocked by: 3, 6 | Blocks: 14, 16
  References: `infra/migrations/private/0006_deck_retrieval_chunks.sql:1-27`; `infra/migrations/private/0001_private_foundation.sql:81-110`; `infra/database/README.md:37`; `services/private-backend/src/retrieval/postgres-deck-retrieval.ts:158-318`; `services/private-backend/src/main.ts:208-260`; `tests/database/private-seed.sql:1-100`; `tests/database/run.sh`.
  Acceptance criteria: tenant A transaction은 A row만 보고 B는 0; missing tenant context는 0/denied; cross-tenant insert는 denied. 같은 deck revision replace가 중간 failure 때 old rows를 보존하고 성공 때 old row 0/new row 전량이다. migration rerun은 skip되고 0001~0007 SHA가 unchanged다. `bun run test:db`와 retrieval DB test가 green이다.
  QA scenarios: happy=A/B source revision별 lexical row 확인; failure=uuid-like/non-uuid text tenant, missing SET LOCAL, insert failure를 주입. Evidence `<evidence-root>/task-11/retrieval-rls.json`.
  Recommended task executor category: `deep` - schema·RLS·transaction context 오류가 곧 data isolation 또는 0-result가 된다.
  Commit: Y | `feat(retrieval): enforce tenant rls and source revisions`

- [ ] 12. senpi-style keyless-first external search와 normal-degrade 경로 구현
  What to do / Must NOT do: global senpi module을 import/copy하지 말고 fixed semantics만 재구현한다. private-backend native fetch provider chain은 DuckDuckGo HTML, optional Google CSE, optional Brave 순서의 priority fallback이다. entire external branch는 parent 5초보다 짧은 단일 1,800ms AbortController를 공유하고 queue/retry/circuit breaker가 없다. `SearchCandidate`를 `{url, sourceId}`로 좁혀 title/snippet을 즉시 폐기하고 provider 순서의 URL을 request `maxResults`까지 기존 `SafeExternalEvidenceFetcher`의 기존 직렬 loop로 보낸다. 403/429/0-result/parse error/timeout은 structured diagnostic 뒤 internal-only 결과를 유지한다.
  Parallelization: Wave 1 | Blocked by: 6 | Blocks: 14, 23
  References: `/opt/homebrew/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/websearch/websearch/config.js` default/fallback; sibling `providers/duckduckgo-html.js`, `providers/google-cse.js`, `providers/brave.js`, `provider-endpoints.js`, `search.js`; `services/private-backend/src/verifier/recommendation-pipeline.ts:48-89,187-205`; `services/private-backend/src/retrieval/external-fetch.ts:1-260`; `services/private-backend/src/main.ts:292-308`.
  Acceptance criteria: recorded DDG/Google/Brave fixtures가 URL만 동일하게 정규화되고 DDG 403→optional provider 또는 all-failed diagnostic 순서가 deterministic하다. all-failed와 429에서도 internal evidence가 있으면 `RECOMMEND`, 없으면 기존 abstain semantics다. fetched evidence URL/date/hash/`rights:UNKNOWN`은 origin bytes에서만 나오며 snippet sentinel이 response/DB에 0건이다. optional key/origin signatures가 browser forbidden config에 있고 browser scan green이다.
  QA scenarios: happy=recorded DDG 200 URL→public-DNS fake→origin bytes evidence; failure=실제 DDG live smoke 403 또는 fixture 429를 정상 degrade로 기록. Commands=`bun test services/private-backend/test/recommendation-pipeline.test.ts services/private-backend/test/external-fetch.test.ts && bun run check:browser-boundary`. Evidence `<evidence-root>/task-12/external-search.json`.
  Recommended task executor category: `unspecified-high` - bounded provider adaptation이며 safe fetcher는 재사용한다.
  Commit: Y | `feat(retrieval): add keyless-first external search fallback`

- [ ] 13. private 0009 slide visit와 derived-only report CAS repository 추가
  What to do / Must NOT do: 새 `0009_session_reports.sql`에 ordered `slide_visit` append와 per-session `session_report_state` 한 행을 만든다. row는 owner account, revision, bounded speech summary, word count, speaking duration, final coaching aggregate, finalizedAt만 저장하고 transcript/audio/partial 컬럼·JSON key를 금지한다. text tenant RLS와 `SET LOCAL` wrapper를 사용한다. visit occurrence는 A→B→A를 세 row로 보존하고 CAS conflict는 명시 실패한다.
  Parallelization: Wave 1 | Blocked by: 3, 6 | Blocks: 14, 20
  References: `infra/migrations/private/0005_prepared_evidence_state.sql`; `services/private-backend/src/prepared-evidence-store-postgres.ts:1-104`; `services/private-backend/src/prepared-evidence.ts` slide occurrence/CAS; `tests/database/private-app.sql`; Q3 decision in `.omo/drafts/impromptu-five-features-48h.md`.
  Acceptance criteria: schema introspection으로 transcript/raw_audio/partial column 0, JSON sentinel 0을 확인한다. append ordering과 CAS revision이 deterministic하고 finalization 뒤 update가 denied된다. tenant B와 같은 tenant의 non-owner account가 report row를 읽지 못한다. `bun run test:db`와 repository integration test green이다.
  QA scenarios: happy=A→B→A append+finalize+process reopen; failure=stale revision, non-owner, post-finalize update. Evidence `<evidence-root>/task-13/report-storage.json`.
  Recommended task executor category: `deep` - privacy schema, RLS, immutable CAS를 함께 고정한다.
  Commit: Y | `feat(report): add visit ledger and derived-only cas state`

- [ ] 14. Merge train 2 - producer/storage wiring과 수직 gate
  What to do / Must NOT do: integrator가 7~13 commits를 합치고 shared `router.ts`, `audio-capture.ts`, `main.ts`, config/exports/Docker wiring만 이 train에서 적용한다. whisper/search/report adapters는 private-backend server only다. projection-gateway에 private dependency를 추가하지 않는다. track branch의 대안 shared diff는 버리고 하나의 canonical wiring만 적용한다.
  Parallelization: Merge train 2 | Blocked by: 7-13 | Blocks: 15-21
  References: tasks 7-13 evidence; `services/private-backend/src/main.ts:1-360`; `services/private-backend/src/config.ts`; `services/private-backend/Dockerfile`; `compose.production.yaml`; `config/browser-forbidden-dependencies.json`.
  Acceptance criteria: text PDF/PPTX upload artifacts와 DB rows, early PARTIAL delivery, local STT adapter registration, external failure internal-only, 0008/0009 isolation tests가 통합 branch에서 green이다. `bun run check:boundaries && bun run check:browser-boundary && bun run typecheck`를 한 번 실행한다.
  QA scenarios: happy=compose service bootstrap에서 required local binaries/models와 optional provider keys를 정확히 report; failure=모델 누락, malformed provider config, tenant context 누락 각각 readiness fail 또는 safe degrade. Evidence `<evidence-root>/task-14/merge-train-2.log`.
  Recommended task executor category: `git` - main/shared seam을 소유한 integrator의 두 번째 bounded train이다.
  Commit: Y | `feat(integration): wire local stt hybrid retrieval and reports`

- [ ] 15. scanned-page hook에 local Tesseract OCR 후행 subsystem 연결
  What to do / Must NOT do: `scanned_page_requires_ocr`가 발생한 페이지만 PyMuPDF 200 DPI/max edge 4096 RGB로 rasterize하고 `tesseract stdin stdout -l kor+eng --oem 1 --psm 11 tsv`를 shell 없이 concurrency=1로 호출한다. Tesseract binary는 Debian bookworm package, models는 `tessdata_fast` commit `87416418657359cb625c412a48b6e1d6d41c29bd`의 `kor` 1,677,415 bytes/SHA-256 `6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2`, `eng` 4,113,088 bytes/SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`로 pin한다. TSV line bbox를 기존 `TextElement` 좌표로 변환한다. cloud/VLM/다중 engine은 금지한다.
  Parallelization: Wave 2, core-nonblocking OCR track | Blocked by: 7, 14 | Blocks: 26, 28 only
  References: `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:102-175`; `services/ingestion/src/impromptu_ingestion/render/pdf.py:56-64,80-122`; `services/ingestion/AGENTS.md`; `services/private-backend/Dockerfile`; `https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd`.
  Acceptance criteria: scanned fixture에서 Korean sentinel TextElement/chunk가 나오고 warning은 OCR applied diagnostic으로 바뀐다. missing binary/model, nonzero, timeout, empty TSV는 upload 422 `OCR_UNAVAILABLE`와 internal `scanned_page_requires_ocr`를 남기며 partial success로 가장하지 않는다. encrypted PDF는 기존 `encrypted_document`다. model 총 bytes와 Docker pre/post image size가 receipt에 기록된다.
  QA scenarios: happy=`uv run --project services/ingestion pytest -k ocr && docker build -f services/private-backend/Dockerfile .`; failure=injected runner로 missing/nonzero/empty와 encrypted fixture. Evidence `<evidence-root>/task-15/ocr-unit-and-image.json`.
  Recommended task executor category: `deep` - 기존 no-OCR boundary를 명시적으로 넘되 resource/security contract를 유지한다.
  Commit: Y | `feat(ingestion): add bounded local korean ocr`

- [ ] 16. 동일 권한 집합의 PostgreSQL FTS+dense RRF와 one-side degrade 구현
  What to do / Must NOT do: ACL prefilter→RLS tenant transaction→deck/manifest/source revision 확인을 두 retriever보다 먼저 한 번 수행한다. 그 authorized IDs 안에서 lexical rank와 dense cosine rank를 각각 최대 20개 만든다. dedupe key는 `(tenant,deck,sourceRevision,slideKey,chunkIndex)`, `RRF_K=60`, score=`sum(1/(60+rank))`, tie-break=`objectId` ascending으로 고정한다. dense embedding 실패는 lexical-only, FTS 실행 실패는 dense-only diagnostic으로 degrade한다. ACL/RLS/revision 실패는 0건/fail-closed다.
  Parallelization: Wave 2 | Blocked by: 7, 11, 14 | Blocks: 18, 21, 23, 25
  References: `services/private-backend/src/retrieval/internal-retrieval.ts`; `services/private-backend/src/retrieval/postgres-deck-retrieval.ts:238-318`; `services/private-backend/src/verifier/recommendation-pipeline.ts:142-187`; `infra/migrations/private/0008_deck_retrieval_hybrid.sql` from task 11; `services/private-backend/test/postgres-deck-retrieval.test.ts`; `tests/security/private-retrieval-security.test.ts`.
  Acceptance criteria: fixed lexical/dense ranks가 입력 순서와 무관하게 같은 RRF 결과를 내고 duplicate 0이다. lexical fault와 dense fault 각각 surviving result+diagnostic, ACL/RLS/stale revision 각각 result 0이다. A/B tenant DB test와 `bun run test:retrieval && bun run test:security`가 green이다.
  QA scenarios: happy=Korean exact term+semantic paraphrase가 둘 다 top set에 포함; failure=각 retriever throw, stale source, cross-tenant row를 독립 주입. Evidence `<evidence-root>/task-16/hybrid-rag.json`.
  Recommended task executor category: `deep` - ranking determinism과 security/degrade 분리를 함께 보장한다.
  Commit: Y | `feat(retrieval): fuse lexical and dense candidates with rrf`

- [ ] 17. Console의 실제 WebM/Opus CaptureUploader와 consent control 연결
  What to do / Must NOT do: `MediaRecorder.isTypeSupported("audio/webm;codecs=opus")` 하나만 허용하고 1,000ms timeslice frame을 task 10 private endpoints로 전송하는 `CaptureUploader`를 구현한다. SSE를 start mutation 전에 열고 exact ready event 뒤 MediaRecorder를 시작한다. mic denied/unsupported codec이면 grant/frame/start request를 0건으로 유지한다. controller/component는 cockpit side용으로 만들되 shared `App.tsx` mount는 train 3 integrator에게 wiring manifest로 넘긴다.
  Parallelization: Wave 2 | Blocked by: 2, 10, 14 | Blocks: 21, 22
  References: `apps/console/src/audio-capture.tsx:1-176`; `apps/console/src/audio-capture.test.tsx`; `apps/console/src/session-client.ts:430-530`; `apps/console/src/App.tsx:738-789`; `tests/security/audio-lifecycle.test.ts`.
  Acceptance criteria: actual MediaRecorder fake-device session이 ordered binary frames와 stop을 보내고 tracks를 항상 stop한다. deny/revoke/unmount/expired grant 후 network count 0 또는 late count 0이다. browser bundle에 ffmpeg/whisper/model/credential 0건이다.
  QA scenarios: happy=Playwright Chromium fake audio + pre-subscribed SSE ready→capture; failure=`getUserMedia` NotAllowedError와 unsupported MIME. Commands=`bun test apps/console/src/audio-capture.test.tsx apps/console/src/session-client.test.ts && bun run check:browser-boundary`. Evidence `<evidence-root>/task-17/console-capture.json`.
  Recommended task executor category: `visual-engineering` - 실제 browser media lifecycle과 private cockpit UX를 함께 다룬다.
  Commit: Y | `feat(console): upload consented webm opus capture`

- [ ] 18. FINAL exactly-once recommendation과 private stream fanout 연결
  What to do / Must NOT do: backend live transcript coordinator가 task 2 state validator를 통과한 event만 Console SSE로 fanout한다. PARTIAL/REPLACE는 opt-in coaching preview만 갱신하고 recommendation/storage를 호출하지 않는다. FINAL은 `(presentationSessionId,sessionGeneration,finalSegmentId)` in-memory idempotency로 기존 recommendation pipeline을 정확히 한 번 호출하고 current deck/manifest context를 server에서 해석해 private `RECOMMENDATION` event를 보낸다. ABORT/revoke/late event는 모두 drop한다. 범용 CAS나 durable recommendation store는 만들지 않는다.
  Parallelization: Wave 2 | Blocked by: 2, 8, 10, 16 | Blocks: 20, 21, 23, 25
  References: `services/private-backend/src/audio-capture.ts`; `services/private-backend/src/verifier/recommendation-pipeline.ts:94-112,142-205`; `services/private-backend/src/http.ts:537-546`; `apps/console/src/App.tsx:872-966`; `packages/contracts/src/retrieval.ts:7-83`.
  Acceptance criteria: 20 partial/replace events 뒤 recommendation invocation 0, 첫 FINAL 뒤 1, duplicate FINAL/post-revoke 뒤 여전히 1이다. recommendation result는 Console private stream에만 나타나고 projection interfaces 호출 0이다. final text는 invocation 종료 뒤 coordinator snapshot/log/DB에 없다.
  QA scenarios: happy=partial-before-final fixture로 exact recommendation event await; failure=duplicate final, late final, Stage credential로 private stream 접근. Evidence `<evidence-root>/task-18/final-trigger.json`.
  Recommended task executor category: `deep` - exactly-once 비용 경계와 privacy fanout을 연결한다.
  Commit: Y | `feat(audio): trigger private recommendations on final only`

- [ ] 19. private-only coaching contract와 neutral reducer 구현
  What to do / Must NOT do: task 1의 Q4 window를 코드 상수로 고정하고 `packages/contracts/src/coaching.ts`를 `private.ts`에만 export한다. `packages/state/src/coaching.ts`는 root index에만 export하고 `./realtime` subpath에는 내보내지 않는다. reducer는 opt-in/mute, final-word rolling current/previous pace, delta, cue count, measurement unavailable를 pure state로 계산한다. PARTIAL/REPLACE는 transient preview만 바꾸며 metric은 FINAL validated words만 사용한다. `audio-fusion`의 words-empty `SILENCE`를 `MEASUREMENT_UNAVAILABLE`로 교정한다.
  Parallelization: Wave 2 | Blocked by: 1, 2, 9, 14 | Blocks: 20-22
  References: `packages/state/src/audio-fusion.ts:97-235`; `packages/state/src/index.ts:1-8`; `packages/state/package.json:6-9`; `packages/contracts/src/private.ts:1-7`; task 9 word-timing receipt; task 1 coaching decision.
  Acceptance criteria: fixed word fixtures로 current/previous window와 delta가 exact하고 input 순서/REPLACE에도 deterministic하다. words 없음, provider lag, network abort는 모두 `MEASUREMENT_UNAVAILABLE`이며 `SILENCE`, threshold, severity, color, toast field가 schema/state에 없다. Stage import graph에서 coaching 0건이다.
  QA scenarios: happy=`bun test packages/state/src/coaching.test.ts packages/state/src/audio-fusion.test.ts tests/contract/coaching.test.ts`; failure=empty words/out-of-order timestamps/Stage subpath import fixture. Evidence `<evidence-root>/task-19/coaching-reducer.json`.
  Recommended task executor category: `unspecified-high` - pure contract/reducer 작업이지만 privacy export와 잘못된 silence semantics를 함께 고친다.
  Commit: Y | `feat(coaching): compute neutral session-relative pace`

- [ ] 20. owner-only 비동기 report finalizer와 API 구현
  What to do / Must NOT do: accepted slide-set마다 ordered visit를 append하고 in-memory transcript handler는 FINAL에서 즉시 bounded derived summary, word count, speaking/timing/coaching aggregate만 갱신한 뒤 원문 reference를 버린다. session end는 derived aggregate를 CAS 저장하고 202를 반환한 뒤 visits+prepared-evidence snapshot으로 typed report를 idempotently finalize한다. GET report는 private backend에서 presentation owner account를 재검증한다. 같은 tenant의 non-owner를 허용하지 않는다. '사용한 근거' 대신 '준비된 근거'를 쓴다.
  Parallelization: Wave 2 | Blocked by: 10, 13, 18, 19 | Blocks: 21, 24, 25
  References: `services/private-backend/src/http.ts:537-546`; `services/private-backend/src/prepared-evidence.ts` setSlide/session ownership; `services/private-backend/src/prepared-evidence-store-postgres.ts:35-104`; `packages/contracts/src/event-derived-report.ts:10-99` (재사용 금지 근거); `apps/console/src/session-client.ts`; task 13 schema.
  Acceptance criteria: report DTO가 total duration, ordered dwell/revisit, derived summary/word count/timing/coaching aggregate, prepared evidence를 provenance대로 반환한다. transcript/raw audio/partial, silence duration, used-evidence claim이 DTO/DB/log에 0건이다. finalize 후 process restart/GET 결과 byte-equivalent이고 A→B→A dwell 동일하다. non-owner 403, unfinalized 202/pending, post-final CAS immutable다.
  QA scenarios: happy=session end exact completion event를 await한 뒤 restart harness로 report 비교; failure=non-owner, stale CAS, crash after initial CAS/before materialization을 주입하고 retry finalize. Evidence `<evidence-root>/task-20/report-api.json`.
  Recommended task executor category: `deep` - privacy 손실 없이 종료 후 재현성과 owner authorization을 함께 만족해야 한다.
  Commit: Y | `feat(report): finalize owner-only session reports asynchronously`

- [ ] 21. Merge train 3 - core stream/RAG/coaching/report 수직 통합
  What to do / Must NOT do: integrator가 16~20과 task 17을 합치고 shared `main.ts`, `audio-capture.ts`, contracts/state exports, `App.tsx` mount points를 한 번만 적용한다. task 15 OCR은 green이면 별도 cherry-pick하되 red/missing이어도 core train을 진행한다. 모든 track의 wiring manifest를 폐기하지 말고 실제 diff와 대조한다.
  Parallelization: Merge train 3 | Blocked by: 14, 16-20 | Blocks: 22-25
  References: tasks 16-20 evidence; `apps/console/src/App.tsx:738-789,872-966`; `services/private-backend/src/main.ts`; `packages/contracts/src/private.ts`; `packages/state/src/index.ts`.
  Acceptance criteria: one fixture stream에서 PARTIAL visible before FINAL, FINAL→one recommendation, neutral reducer update, report aggregate가 연결된다. Stage card 0 invariant와 browser boundary가 유지된다. targeted Bun/Python/DB tests와 typecheck가 한 번 green이다.
  QA scenarios: happy=text PDF session의 vertical API harness; failure=revoke+late final, dense fault, DB restart를 같은 harness에서 exact event로 trigger. Evidence `<evidence-root>/task-21/merge-train-3.log`.
  Recommended task executor category: `git` - shared UI/runtime seam의 세 번째 bounded integration train이다.
  Commit: Y | `feat(integration): connect live private coaching and reports`

- [ ] 22. word-timing gate를 지키는 opt-in/mute coaching Console UI 구현
  What to do / Must NOT do: cockpit private side column에 명시적 opt-in과 mute, current pace, previous pace, delta, cue count를 neutral 숫자/텍스트로 렌더한다. server capability `wordTimingCapable=false` 또는 words 없음이면 `측정 불가`만 보이고 pace UI를 출시하지 않는다. universal normal range, warning color, severity, toast, silence 문구를 쓰지 않는다. task 1 Q4 decision 전 시작 금지다.
  Parallelization: Wave 3 | Blocked by: 1, 9, 17, 19, 21 | Blocks: 25, 28
  References: `apps/console/src/App.tsx:738-789`; `apps/console/src/audio-capture.tsx`; `apps/console/src/App.test.tsx`; `apps/console/DESIGN.md:40-87`; task 9 capability receipt; task 19 contract.
  Acceptance criteria: opt-in=false와 mute=true에서 metric DOM 0, enabled+timed FINAL에서 selected rolling window 숫자/delta exact, no-words/capability=false에서 `data-coaching-state="unavailable"`만 존재한다. forbidden warning/severity fields와 Stage imports 0이다. keyboard/aria-live가 동작한다.
  QA scenarios: happy=Testing Library로 opt-in→timed FINAL→mute; failure=empty words/capability false/network abort. Commands=`bun test apps/console/src/App.test.tsx apps/console/src/audio-capture.test.tsx`. Evidence `<evidence-root>/task-22/coaching-ui.json` 및 screenshot.
  Recommended task executor category: `visual-engineering` - private cockpit의 조건부 출시와 접근성을 구현한다.
  Commit: Y | `feat(console): show opt-in neutral coaching metrics`

- [ ] 23. 외부 URL/date/UNKNOWN을 표시하는 private evidence card 완성
  What to do / Must NOT do: recommendation evidence를 closed private card DTO로 map하고 Console에 source URL, 기준일, `권리 미확인(UNKNOWN)`을 명시한다. internal evidence는 approved label을 구분한다. URL은 safe fetch result만 사용하고 provider title/snippet을 UI에 전달하지 않는다. Stage/public package에는 mapper, DTO, import, pixel이 없어야 한다.
  Parallelization: Wave 3 | Blocked by: 12, 16, 18, 21 | Blocks: 25, 28
  References: `packages/contracts/src/retrieval.ts:37-83`; `packages/contracts/src/private-evidence.ts`; `apps/console/src/App.tsx:872-966`; `apps/console/src/session-client.ts:474-486`; `config/browser-forbidden-dependencies.json`.
  Acceptance criteria: external fixture card가 fetched origin title/URL/date/UNKNOWN을 표시하고 snippet sentinel 0이다. unsafe/failed fetch는 card 0이며 internal card는 유지된다. Stage build/DOM/network fixture에 external private DTO/URL 0건이다.
  QA scenarios: happy=recorded external origin bytes로 Console card render; failure=provider snippet injection, unsafe redirect, Stage bundle scan. Evidence `<evidence-root>/task-23/private-evidence-ui.json` 및 screenshot.
  Recommended task executor category: `visual-engineering` - provenance를 오해 없이 private UI에 표시하는 작업이다.
  Commit: Y | `feat(console): label private external evidence provenance`

- [ ] 24. 종료 후 owner-only report Console 화면 구현
  What to do / Must NOT do: session end가 202를 반환하면 private stream의 exact `REPORT_READY` signal을 await하고 existing Console 안에서 typed report를 렌더한다. reload 때만 GET으로 이미 finalized된 report를 읽으며 polling loop를 만들지 않는다. total duration, ordered slide dwell/revisit, speech summary/word count, neutral coaching aggregate, '준비된 근거'를 표시한다. transcript 본문, silence 추정, used-evidence 표현, HTML export/dashboard는 만들지 않는다.
  Parallelization: Wave 3 | Blocked by: 20, 21 | Blocks: 25, 28
  References: task 20 report DTO/API; `apps/console/src/session-client.ts`; `apps/console/src/App.tsx`; `apps/console/src/App.test.tsx`; `packages/contracts/src/private.ts`.
  Acceptance criteria: owner finalize→reload 후 동일 report DOM, A→B→A 세 occurrence와 dwell 합계 exact, non-owner response는 403이고 UI data 0이다. report JSON/DOM에서 transcript body, silence, `사용한 근거` sentinel 0이다.
  QA scenarios: happy=Testing Library/Playwright session end→ready event→reload; failure=non-owner, pending, missing speech summary(reason 표시) 상태. Evidence `<evidence-root>/task-24/report-ui.json` 및 screenshot.
  Recommended task executor category: `visual-engineering` - privacy-safe report provenance와 reload UX를 구현한다.
  Commit: Y | `feat(console): render finalized presentation reports`

- [ ] 25. Core-5 실제 surface acceptance suite 완성
  What to do / Must NOT do: text-layer PDF와 PPTX 각각 upload→fake-device WebM capture→whisper FINAL→hybrid RRF/private external branch→opt-in coaching→end/report를 실제 Console/private HTTP/DB surface로 실행한다. revised negative 6개와 STT 2개 필수 시나리오를 별도 assertions로 둔다. fixed sleep/poll을 금지하고 exact SSE/WS/report-ready signals를 trigger 전에 subscribe한다. OCR 결과는 이 suite의 pass/fail에 넣지 않는다.
  Parallelization: Wave 3 | Blocked by: 16, 18, 20-24 | Blocks: 27, 28
  References: `tests/e2e/custom-deck-upload.harness.ts`; `tests/e2e/prepared-evidence.harness.ts`; `tests/e2e/durable-main-restart.test.ts`; `tests/e2e/realtime-soak.harness.ts`; `scripts/verify-wp3-e2e.ts`; tasks 2-24 evidence.
  Acceptance criteria: PDF/PPTX positive 2/2. Negative: mic denial request 0, external 429 internal-only, Stage snapshot/SSE/WS cards 각각 0, A→B→A reload dwell 동일. STT `partial-before-final`과 `revoke-stops-and-blocks-late-delivery` 2/2. full result JSON은 assertion 이름/command/exit code를 포함한다.
  QA scenarios: happy=`bun test tests/e2e/five-features.test.ts --timeout 120000 && node --experimental-strip-types scripts/verify-five-features-e2e.ts`; failure=각 negative fixture를 독립 실행해 implementation을 잠시 우회한 mutation fixture가 validator에 잡히는지 확인. Evidence `<evidence-root>/task-25/core5-e2e.json`.
  Recommended task executor category: `deep` - 다섯 기능과 세 보안 transport를 실제 surface에서 수직 검증한다.
  Commit: Y | `test(e2e): verify five private presentation features`

- [ ] 26. OCR vertical positive·failure·M5 Pro resource receipt 검증
  What to do / Must NOT do: task 15을 core와 독립적으로 scanned PDF upload→OCR TextElement→chunk→hybrid query까지 실행한다. missing OCR binary/model/nonzero/empty는 visible `OCR_UNAVAILABLE`, encrypted PDF는 기존 rejection을 확인한다. Docker image/model byte delta와 macOS M5 Pro에서 10-page sequential OCR의 wall/user/sys/max RSS, `pmset -g therm` 전후를 기록한다. concurrency는 1로 고정하며 `powermetrics`/sudo나 사람이 보는 온도 판정에 의존하지 않는다.
  Parallelization: Wave 3, independent OCR gate | Blocked by: 15 | Blocks: 28 expanded-scope status only
  References: task 15; `services/private-backend/Dockerfile`; `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:168-175`; `services/ingestion/src/impromptu_ingestion/render/pdf.py:56-64`; task 3 scanned fixture.
  Acceptance criteria: OCR sentinel query가 expected slide/chunk를 반환하고 scanned positive가 green이다. failure codes 3종과 encrypted rejection이 visible하다. receipt에 model 5,790,503 bytes, image pre/post size, `/usr/bin/time -l` metrics, `pmset` warning fields가 모두 있다. thermal/performance warning이 기록되면 `OCR_GREEN=false`로 fail-closed하되 `CORE5_GREEN`은 변경하지 않는다.
  QA scenarios: happy=`/usr/bin/time -l uv run --project services/ingestion pytest -k ocr_vertical` 10-page fixture; failure=runner/model 제거와 encrypted fixture. Evidence `<evidence-root>/task-26/ocr-vertical-resource.json`.
  Recommended task executor category: `unspecified-high` - 기능 gate와 하드웨어/resource receipt를 분리해 증명한다.
  Commit: Y | `test(ocr): verify scanned pdf search and resource bounds`

- [ ] 27. 성능 회귀와 48시간/9월 완료 경계 고정
  What to do / Must NOT do: task 1 Q5 결정에 따라 `docs/DEMO-SCOPE.md`에 48시간 observable acceptance와 September hardening을 분리한다. confirmed FINAL→Console recommendation 10회, 기존 recommendation flow 10회, representative PDF/PPTX cold/warm smoke를 실행한다. cold/concurrent capacity나 장기 p95 결론을 만들지 않는다. OCR은 별도 status/cost로 표기한다.
  Parallelization: Wave 3 | Blocked by: 1, 25 | Blocks: 28
  References: task 1 completion decision; task 25 evidence; 기존 실측 p50 3,038.6ms/p95 4,164.3ms/10-of-10; `package.json` `test:private-latency`; `docs/DEMO-SCOPE.md`; `.omo/plans/impromptu-r2-hyperplan.md`.
  Acceptance criteria: 두 10-run cohort 모두 10/10 성공, p95 <=5,000ms이고 raw samples/command/commit SHA가 JSON에 있다. PDF/PPTX cold/warm은 측정값만 기록한다. Q5=`guarded-48h`이면 core acceptance를 48h 완료로, `include-hardening`이면 완료를 보류하고 48h 제약 해제를 명시한다. prose 변경에는 prose-pinning test를 추가하지 않는다.
  QA scenarios: happy=`bun run test:private-latency`와 새 smoke runner; failure=sample 누락/ABSTAIN/5초 초과 fixture로 aggregator nonzero. Evidence `<evidence-root>/task-27/performance-and-scope.json`.
  Recommended task executor category: `unspecified-high` - 측정과 제품 완료 주장을 일치시키는 release evidence 작업이다.
  Commit: Y | `docs(scope): separate 48 hour acceptance from hardening`

- [ ] 28. Merge train 4 - 전체 release gate와 분리 상태 고정
  What to do / Must NOT do: integrator가 22~27과 green OCR commit을 합친다. OCR red이면 core branch 통합/검증은 계속하되 expanded request를 완료로 표시하지 않는다. Docker stack은 `docker compose up --build --wait` 또는 Python `subprocess.Popen(..., start_new_session=True)`로 띄우고 shell background job에 의존하지 않는다. unrelated worktree 변경을 stage하지 않는다.
  Parallelization: Merge train 4 | Blocked by: 1, 15, 21-27 | Blocks: F1-F4
  References: all task evidence; `package.json` validators; `compose.production.yaml`; `services/private-backend/Dockerfile`; `config/browser-forbidden-dependencies.json`; `git status --short` baseline.
  Acceptance criteria: diagnostics/lint/typecheck/build, Bun tests, Python tests, DB/security/E2E를 각각 한 번 green으로 실행한다. machine receipt는 `CORE5_GREEN`, `OCR_GREEN`, `COACHING_WORD_TIMING_GREEN`, `STAGE_ZERO_CARDS`를 독립 boolean으로 기록한다. expanded scope complete는 네 값과 F1-F4가 모두 true일 때만 가능하다. browser bundle secret/model/SDK 0, Stage private import 0, projection→private dependency 0이다.
  QA scenarios: happy=`bun run check && bun run test:db && bun run test:security && bun run test:e2e && uv run --project services/ingestion pytest`; failure=browser forbidden fixture, card ingress fixture, cross-tenant DB fixture를 validator에 주입. Evidence `<evidence-root>/task-28/release-gate.json`과 full logs.
  Recommended task executor category: `git` - 마지막 shared integration과 truthful status matrix를 소유한다.
  Commit: Y | `chore(release): integrate five features and separate ocr status`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. 계획 준수·의존성 감사
  Verify: fresh reviewer가 task 1~28의 evidence와 live diff를 대조해 모든 Hard Constraint, Q1=B/Q2=C/Q3=A, Q4/Q5 gate, migration 0008/0009, OCR core-nonblocking dependency를 체크한다. self-report나 grep hit만으로 승인하지 않는다.
  Acceptance: 누락/모순 0, dependency matrix cycle 0, 모든 command/receipt가 실제 commit SHA와 일치하면 `APPROVE`; 아니면 exact task와 재현 command로 `REJECT`.
  Evidence: `<evidence-root>/final/F1-plan-compliance.json`.
  Recommended task executor category: `unspecified-high` - 독립 plan-to-diff 감사다.

- [ ] F2. 코드 품질·보안 경계 리뷰
  Verify: fresh reviewer가 changed files를 읽고 type/lint 결과와 함께 RLS text policy, fail-closed/degrade 분리, transcript/audio non-persistence, safe fetch, browser/projection boundaries, deterministic stream cleanup을 adversarial review한다.
  Acceptance: concrete security/data-loss/compatibility blocker 0, suppression/skip/swallowed error/secret/model leak 0, `bun run check:boundaries && bun run check:browser-boundary && bun run test:security` 실제 실행 green이면 `APPROVE`.
  Evidence: `<evidence-root>/final/F2-code-security.json`.
  Recommended task executor category: `deep` - cross-service security invariant를 공격적으로 검토한다.

- [ ] F3. 실제 surface 수동 QA
  Verify: fresh agent가 production-like Docker stack을 health wait로 띄워 Console 4173/Stage 4174/private 3001/gateway 3002를 직접 사용한다. text PDF, PPTX, scanned PDF, Korean fake audio, mic deny, provider failure, report reload, Stage snapshot/SSE/WS를 UI/HTTP로 실행한다. exact event를 먼저 subscribe하고 fixed sleep을 쓰지 않는다.
  Acceptance: task 25 core matrix 전부 green, task 26 OCR matrix 별도 truthfully green/red, Console screenshots에 private cards/coaching/report가 있고 Stage screenshots에는 slide 외 card pixel 0이면 `APPROVE`; core 또는 보안 negative가 실패하면 `REJECT`.
  Evidence: `<evidence-root>/final/F3-manual-qa.json` 및 screenshots/network traces.
  Recommended task executor category: `unspecified-high` - 사용자 surface를 독립적으로 재현한다.

- [ ] F4. 범위·완료 주장 충실성 검토
  Verify: fresh reviewer가 diff/commits/docs/status matrix를 원 요청과 Must-NOT-Have에 대조한다. OCR 추가 비용이 숨겨지지 않았는지, 기존 장기 plan을 덮지 않았는지, `CORE5_GREEN`과 `OCR_GREEN`이 분리됐는지, Q5 결정과 최종 wording이 일치하는지 확인한다.
  Acceptance: unrequested subsystem(새 DTO/VAD/pgvector/queue/public cards/dashboard) 0, requested feature 누락 0, September hardening을 48h 완료로 과장한 문장 0이면 `APPROVE`.
  Evidence: `<evidence-root>/final/F4-scope-fidelity.json`.
  Recommended task executor category: `unspecified-high` - 최종 주장과 실제 범위를 독립 대조한다.

## Commit strategy
- 각 task는 자기 worktree에서 관련 test를 먼저 정의하거나 frozen fixture를 사용해 최소 구현 후 validator를 한 번 green으로 만들고 Conventional Commit 하나를 제출한다. unrelated file과 `.omo/evidence`는 stage하지 않는다.
- track agent는 shared-seam 파일을 수정하지 않는다. merge train integrator만 verified commits를 cherry-pick하고 conflict는 별도 `fix(integration): ...` commit으로 남긴다. amend/rebase/force-push는 하지 않는다.
- migration과 repository/test는 같은 atomic commit에 둔다. private 0008/0009 외 migration commit을 거부한다.
- commit 전 `git diff --cached --check`와 해당 task validator를 실행하고, merge train마다 전체 targeted gate를 재실행한다.
- 권장 순서: contracts/fixtures → Stage denial → producer/storage → semantics/UI → E2E/docs → integration. OCR commits는 core chain과 별도로 cherry-pick 가능해야 한다.

## Success criteria
- text-layer PDF와 PPTX positive flow가 각각 실제 upload→FINAL STT→hybrid evidence→coaching→report를 통과한다.
- scanned PDF는 OCR text를 생성해 검색 가능하고, OCR unavailable은 명시 422로 실패한다. 암호화 PDF 거부는 유지된다.
- STT는 WebM/Opus 하나만 받아 early PARTIAL, exactly-once FINAL, monotonic words, revoke late-delivery block을 증명한다. actual adapter가 reliable word timing을 못 내면 coaching pace는 미출시/측정 불가로 표시되고 완료 상태에 그대로 반영된다.
- ACL/RLS/source revision 실패는 result 0이며 lexical/dense 한쪽 기능 장애는 surviving retriever result와 diagnostic을 남긴다. cross-tenant read/write 0이다.
- DDG/Google/Brave routing은 URL만 공급하고 SafeExternalEvidenceFetcher가 만든 origin evidence만 private Console에 표시한다. 403/429/timeout에도 internal-only recommendation이 보존된다.
- Stage snapshot, SSE, WS, DOM 각각 card 0이며 approve/coordinator/gateway ingress가 source-agnostic fail-closed다. `publicCardRevision`은 compatibility read/drop 외 runtime 의미가 없다.
- coaching은 사용자 결정 window의 neutral current/previous/delta만 보이며 threshold, warning color, toast, silence 추정, persistence가 없다.
- report는 owner-only이고 A→B→A dwell/revisit, derived speech/coaching aggregate, '준비된 근거'를 finalize/restart 후 동일하게 반환한다. raw audio, partial, FINAL transcript 본문은 DB/log/report에 0이다.
- 기존 recommendation과 FINAL→Console 10-run cohort가 각각 10/10, p95 <=5,000ms다. PDF/PPTX cold/warm과 OCR resource 값은 raw evidence로 기록된다.
- `bun run check`, Python strict checks, DB/security/E2E와 F1~F4가 모두 승인된다.
- 최종 receipt는 `CORE5_GREEN`, `OCR_GREEN`, `COACHING_WORD_TIMING_GREEN`, `STAGE_ZERO_CARDS`를 별도 표기한다. OCR 실패는 core 5기능 결과를 덮지 않지만, 사용자가 확장한 전체 요청 완료는 네 값이 모두 true일 때만 선언한다.
- Q5=`guarded-48h`일 때만 observable acceptance를 48시간 guarded 완료로 부른다. Q5=`include-hardening`이면 September hardening 전에는 완료를 선언하지 않고 48시간 제약이 해제됐음을 명시한다.
