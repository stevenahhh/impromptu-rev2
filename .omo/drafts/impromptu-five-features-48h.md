---
slug: impromptu-five-features-48h
status: plan-written-review-pending
intent: clear
review_required: true
plan_path: .omo/plans/impromptu-five-features-48h.md
plan_sha256: 66d739ec5e95a23dba72aa27b5acf0971d759f352db9ecee330f621c1fe198f5
review_round_id: null
review_round_limit: 5
pending-action: write and review .omo/plans/impromptu-five-features-48h.md
review:
  momus:
    status: pending
    workspace_root: null
    runtime_home: null
    target: .omo/plans/impromptu-five-features-48h.md
    round_id: null
    plan_sha256: null
    launch_id: null
    session: null
    result: null
approach: 오전 계약·fixture freeze 뒤 6개 독립 트랙을 최대 병렬 실행하고, 공유 seam은 지정 integrator의 하루 2회 merge train에서만 통합한다. 각 열차 끝 수직 E2E gate를 통과해야 다음 의존 작업을 연다. 48시간 종료는 fixture 기반 observable acceptance로 증명하고 운영 hardening은 9월 항목으로 분리한다.
---

# Draft: impromptu-five-features-48h

## Components (topology ledger)
| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | PDF/PPTX 공통 structural manifest를 production 업로드와 hybrid index에 연결하고 scanned PDF OCR을 독립 후행 트랙으로 제공 | active, Q1 resolved B | `adapters/pdf.py:102-121,145-175`; `ingestion/contracts.py:122-149`; `deck-render-subprocess.ts:380-412`; `postgres-deck-retrieval.ts:158-186` |
| C2 | whisper.cpp 기반 한국어 STT를 단일 codec·단일 event stream 계약으로 Console까지 전달 | active | `model-router/src/stt.ts:4-31`; `router.ts:416-465,517-521`; `audio-capture.ts:47-58,94-233`; `audio-capture.tsx:23-89` |
| C3 | 동일 ACL/RLS/revision 후보 집합에서 PostgreSQL FTS+dense를 RRF로 융합 | active | `postgres-deck-retrieval.ts:271-282`; `main.ts:208-260`; private migration `0006` |
| C4 | DDG HTML 기본 + 선택적 Google CSE/Brave priority fallback이 공급한 URL만 기존 safe fetcher로 검증해 private recommendation에 추가 | active, Q2 resolved C | `recommendation-pipeline.ts:187-205`; `main.ts:292-308` |
| C5 | final word timestamp 기반 중립 rolling pace를 opt-in/mute Console UI로 제공 | active, owner gate Q4 and STT timing gate | `packages/state/src/audio-fusion.ts:97-235`; `audio-fusion.ts:161-183`; `App.tsx:738-789` |
| C6 | ordered slide visits + 파생 집계-only session CAS로 owner-only 비동기 report를 재현하고 Stage card 경로를 삼중 차단 | active, Q3 resolved A; owner gate Q5 | `http.ts:537-546,677-704`; `prepared-evidence.ts:1157-1196`; `event-derived-report.ts:10-99` |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| budget/spend | 외부 검색 provider 외 신규 유료 서비스 없음; 로컬 whisper.cpp/embeddinggemma와 기존 DB 사용 | 48시간 압축 및 확정 stack 준수 | yes |
| stack | Bun/TypeScript strict/PostgreSQL 17/기존 Python ingestion 유지 | 사용자 확정 환경 | no within this plan |
| scale | 현재 대표 deck·단일 발표 session acceptance까지만 48시간 gate; cold/concurrent p95는 9월 hardening | 실측 없는 장기 결론 방지 | yes |
| audience/compliance | Console은 발표자 private, Stage는 청중 slide-only; raw audio와 partial transcript 영속화 금지 | 사용자 제품 결정과 privacy boundary | no |
| browser boundary | AI runtime/credential/SDK를 browser bundle에 넣지 않고 새 key signature는 denylist에 수동 추가 | 기존 보안 경계 | no |
| legacy data | 기존 retrieval row backfill 없이 deck 재업로드로 재색인 | 48시간 범위 축소와 migration 안전성 | yes |

## Findings (cited - path:lines)
- PDF adapter와 공통 `DeckManifest`에는 이미 구조 텍스트가 있으나 production은 text 없는 render manifest만 읽고 non-SVG index를 skip한다: `adapters/pdf.py:102-121,145-175`, `ingestion/contracts.py:122-149`, `deck-render-subprocess.ts:380-412`, `postgres-deck-retrieval.ts:158-186`.
- STT router는 terminal까지 버퍼링하고 backend port는 complete-only라 streaming consumer가 막혀 있다: `router.ts:416-465,517-521`, `audio-capture.ts:47-58`.
- 외부 검색 branch는 `externalSearch`와 `externalFetch`가 모두 필요하지만 bootstrap은 fetcher만 주입한다: `recommendation-pipeline.ts:187-205`, `main.ts:292-308`.
- live-public gate는 `LIVE_VERIFIED`만 막아 curated candidate가 Stage projection에 도달하며 approve API도 public-card revision을 승인한다: `prepared-evidence.ts:1157-1196`, `http.ts:677-704`.
- 현 dense retrieval은 승인 row를 읽어 JS cosine sort하며 retrieval transaction에 tenant context가 없다: `postgres-deck-retrieval.ts:271-282`, `main.ts:208-260`.
- recommendation 응답은 저장하지 않고 기존 event report는 publication card 통계이며 runtime caller가 없다: `http.ts:537-546`, `event-derived-report.ts:10-99`.
- 기존 장기 plan `.omo/plans/impromptu-r2-hyperplan.md`은 실행 중이므로 이 계획은 그것을 폐기하거나 재작성하지 않고, 요청된 5기능과 필수 경계를 48시간 merge-train overlay로 압축한다.

## Decisions (with rationale)
- Stage는 slide-only fail-closed: approve endpoint 정책 거부, coordinator의 모든 source public-card transition 거부, gateway ingress와 Stage serializer에서 card payload 거부/제거. snapshot의 `publicCardRevision`은 읽고 버리는 compatibility field로만 보존한다.
- ACL/RLS/revision 실패만 전면 fail-closed; 검증 후 lexical/dense 한쪽 장애는 생존 retriever로 degrade하고 진단한다.
- 외부 evidence는 `rights: UNKNOWN`을 유지한 private recommendation 전용이며 provider snippet/title을 evidence로 복사하지 않는다. URL은 기존 `SafeExternalEvidenceFetcher`를 통과한다.
- STT는 browser가 실제 전송하는 codec 하나만 지원하고 `sessionGeneration + sequence + PARTIAL|REPLACE|FINAL|ABORT + word-time`을 동결한다. partial/replacement는 opt-in coaching만 갱신하고 FINAL만 recommendation을 trigger하며 `finalSegmentId`로 dedupe한다.
- RAG는 pgvector 없이 PostgreSQL FTS+dense+고정 RRF/tie-break/dedupe를 사용한다. private migration은 0008부터 추가하고 `SET LOCAL app.tenant_id` wrapper와 tenant-isolation DB test를 포함한다.
- coaching은 보편 threshold, 색상 경고, toast, VAD 기반 silence 판정을 만들지 않는다. final word timestamp가 실측 gate를 통과하지 못하면 timestamp-dependent coaching은 미출시한다.
- report는 ordered `slide_visit` append와 per-session `session_report_state` CAS 1행에서 owner-authorized typed DTO를 비동기 파생한다. prepared evidence는 '사용한 근거'가 아니라 '준비된 근거'로 표기한다.
- 새 deadline orchestration/queue/retry/circuit-breaker/budget scheduler를 만들지 않는다. external branch에 parent보다 짧은 child timeout 하나만 둔다.
- contract/fixture freeze 후 adapter branch를 병렬화하고 integrator가 `router.ts`, `audio-capture.ts`, shared contracts, `main.ts`, `App.tsx`를 하루 2회 merge train에서만 통합한다.
- Q1=B: text-layer 연결과 분리된 후행 OCR subsystem을 추가한다. `scanned_page_requires_ocr` hook에 local Tesseract 5 `kor+eng` TSV extraction을 붙이고 암호화 PDF 거부는 유지한다. Docker/model/image delta와 M5 Pro wall/CPU/max-RSS/`pmset -g therm` 전후를 측정하며 concurrency=1로 제한한다.
- Q2=C: 기존 single-provider 결정은 사용자가 뒤집었다. senpi 방식의 priority fallback을 차용해 keyless DuckDuckGo HTML을 기본, credential이 있을 때 Google CSE와 Brave를 선택적으로 활성화한다. 403/0-result는 정상 degrade 진단이며 internal-only recommendation을 보존한다.
- Q3=A: partial뿐 아니라 FINAL transcript 본문도 영속화하지 않는다. `session_report_state`에는 summary, word count, timing/coaching aggregate만 CAS 저장하고 report에도 transcript 본문을 표시하지 않는다.
- Q6은 권고 A로 확정: shared contract·migration·security invariant TDD, adapter/UI fixture tests-after, 모든 track에 agent-executed happy/failure QA와 merge-train E2E gate를 둔다.

## Scope IN
- 로컬 한국어 STT, 단일 외부 검색 provider, ACL/RLS/revision-safe hybrid RAG, opt-in 중립 coaching, owner-only post-session report.
- PDF/PPTX structural ingestion 연결, text-layer fixture, scanned-PDF 명시 정책.
- Stage snapshot/SSE/WS card 0건을 보장하는 서버 삼중 불변식.
- private migration 0008+, typed private contracts, Console UI, fixture/DB/integration/E2E/security regression tests.
- positive 2개와 negative 7개, STT 2개 필수 시나리오, representative cold/warm smoke와 기존 recommendation 10회 p95 회귀.

## Scope OUT (Must NOT have)
- 별도 PDF subsystem/새 normalized DTO/PPTX SVG regex 재작성. OCR 자체는 사용자 범위 확장으로 IN이지만 browser OCR/VLM, cloud OCR, 다중 OCR engine 비교는 OUT.
- provider registry, VAD, diarization, multi-codec, multi-provider bake-off.
- pgvector 도입/영구 금지 선언, legacy backfill.
- public evidence mapper/Stage card UI/rights 완화.
- universal coaching threshold·warning color·toast·persisted coaching event stream.
- 6종 event ledger/outbox/dashboard/HTML export, live-path report generation.
- 새 orchestration/queue/retry/circuit-breaker/budget scheduler.
- 4종 performance cohort, 범용 late-result CAS, cold/concurrent production hardening.

## Open questions
- RESOLVED Q1=B: local OCR subsystem 추가; 나머지 5기능을 block하지 않는 후행 트랙.
- RESOLVED Q2=C: senpi-style multi-provider priority fallback; DDG HTML 기본, Google CSE/Brave 선택.
- RESOLVED Q3=A: transcript 본문 미저장; 파생 집계만 CAS.
- EXECUTION GATE Q4: coaching UI 시작 전 사용자에게 A) 30초 current/previous(권고), B) 45초, C) 60초 중 하나를 받아 `.omo/evidence/decisions/coaching-window.json`에 기록.
- EXECUTION GATE Q5: 최종 완료 선언 전 사용자에게 A) observable 48시간 acceptance 통과를 guarded 완료로 인정하고 9월 hardening 분리(권고), B) hardening까지 포함하고 48시간 제약 해제 중 하나를 받아 `.omo/evidence/decisions/completion-boundary.json`에 기록.
- DEFAULTED Q6=A: contract/migration/security TDD + adapter/UI tests-after.

## Approval gate
status: approved-for-plan
approved_action: write `.omo/plans/impromptu-five-features-48h.md` only; execution remains separate
approval_evidence: latest user reply explicitly requested the executable plan file after resolving Q1-Q3 and required Q4-Q5 as execution gates
plan_written: true
structural_self_check: passed (28 sequential implementation rows, 4 final-verifier rows, 32 executor-category annotations, canonical header order, no placeholders)
review_note: native MOMUS tool is not exposed in this child harness; review remains pending for the lead/parent session
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
