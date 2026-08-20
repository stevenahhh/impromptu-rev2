# wave-1 / codebase-integration (축 완주, 12m50s) — file:line 접속점 확정

## 1) 스트리밍 STT
- canonical 계약: `descriptor.capability==="stt"`, `{sequence:int>=0, audio:Uint8Array}` 연속 chunk,
  `{kind:"partial"|"final", sequence, transcript:{text,language,durationMs}}` event, `ModelInvocationContext` 의 trusted context/signal/정책 매개 transport.
  production 어댑터는 **`registerIsolatedStreamingStt()` 로 절대경로 `.mjs` module/export/config 등록.**
  근거: stt.ts:4-55, ports.ts:17-28,53-63, registry.ts:203-239,257-279, isolation.ts:10-35,113-148, isolate-runner.mjs:4-10,66-82
  **COUNTER: stream chunk 에 encoding/sampleRate 가 없고 unary input 에만 있음(stt.ts:16-23) → 어댑터 config 고정 또는 계약 확장 필요.**
- router 접속점 `ServerModelRouter.streamStt()` (router.ts:302-368,389-443,454-478,479-521,524-589):
  trusted context / adapter resolve / cancellation / policy·quota·budget·egress·secret / chunk·event schema 강제, final 없으면 실패.
  **COUNTER: 모든 transcript event 를 버퍼링했다가 terminal 성공일 때만 방출 (router.ts:416,465,517-521) → 실시간 partial 즉시 소비 구조가 아님.**
- private 경계 `RouterBackedAudioSttPort` (audio-capture.ts:7-59): Uint8Array 를 0부터 연속 sequence 로 감싸고 **partial 무시, complete 만 반환.**
  `AudioCaptureCoordinator` (audio-capture.ts:94-233,385-392): consent/grant/session identity/single-use/revoke + 30초 buffered-duration 상한 소유.
  **COUNTER: main/http 에서 이 클래스들의 생성·route 사용 0개.**
- Console: `BrowserCaptureController` + 추상 `CaptureUploader` 만 (audio-capture.tsx:23-27,42-89,91-181).
  uploader 구현·HTTP client·App 마운트 없음. `AudioConsentControl` 사용은 테스트 외 0개.
  **부착 위치: presentation cockpit 의 private side column (App.tsx:738-789).**

## 2) 외부 근거 검색
- 포트: **`ExternalSearchBoundary.search(query, signal): Promise<readonly SearchCandidate[]>`**,
  후보 `{url,snippet,sourceId}` 가 recommendation-pipeline.ts:187-206 에서 fetcher 로 진입 (AST 로 :194 search, :199 fetchCandidate 확인).
  **COUNTER: main.ts 는 fetcher 만 전달하고 `externalSearch` 미전달 → 프로덕션 분기 도달 불가.**
- `SafeExternalEvidenceFetcher` 계약 (external-fetch.ts:8-38,98-137,168-278,281-328):
  public DNS resolve + pinned HTTPS(자동 redirect 추적 금지), credential-free HTTPS/기본 포트,
  redirect 마다 DNS 재검증, public IP 만, HTML/XHTML/text 만, 기본 1MB/5 redirects/deadline, **fetched bytes 만 evidence.**
  검색 snippet 은 증거로 복사되지 않음.
  **COUNTER(중요): fetched external evidence rights 가 항상 `UNKNOWN`(:271) 이고 publication gate 는 rights APPROVED 만 허용(pipeline:119-124).
  external item 은 internal reference 가 없어 publicationEvidence 에도 미저장(:297-317).
  → 추천 UI 에는 들어가도 현재 공개는 fail-closed.**
- 배선점: main.ts:280-283(fetcher) 와 :292-307(pipeline) 사이. (git show 391d9bd — 처음부터 fetcher 만 배선)

## 3) 하이브리드 RAG
- seam: `PostgresDeckRetrievalStore.search()`. 한 클래스가 prepare/prefilter/search/readMetadata/readContent 를 모두 구현
  (postgres-deck-retrieval.ts:66-92,93-232,234-263,265-330; internal-retrieval.ts:15-75).
  **hybrid 는 ACL-filtered object IDs 안에서 lexical+vector 를 융합해야 하며 ACL 을 search 뒤로 밀면 안 됨.**
  현재 search 는 authorized rows 를 전부 읽어 애플리케이션 cosine sort (:272-297), lexical/FTS 없음.
- ACL 실제 순서 (internal-retrieval.ts:109-168,170-227,229-258):
  principal resolve → corpus prepare access check → prefilter/current → authorized ID 제한 ANN →
  tenant/deck/manifest/auth-version 검증 → metadata/rights/PII/post-authorize → **materialize 직전 재인가** →
  private bytes read → SHA-256 검증 → **publication 직전 재인가**.
  **COUNTER: 모든 예외가 []/DENIED 로 collapse → 진단이 관측 로그에만 의존.**
- **`deck_retrieval_chunks` 에 RLS 가 없음.** 0006 은 table/index/grant 만 만들고 tenant predicate 는 애플리케이션이 붙임.
  hybrid migration 은 최소 private `0008_*` 로 FTS column/index 와 함께 ENABLE/FORCE RLS 를 다뤄야 하고,
  요청 transaction 에서 **`SET LOCAL app.tenant_id` 를 실제로 설정하는 repository wrapper** 도 필요.
  **COUNTER: 0006 tenant_id 는 text 지만 foundation 정책은 uuid cast 패턴이라 그대로 복사 불가. main.ts:208-260 도 tenant transaction context 미설정.**

## 4) 코칭
- 입력 seam: `TimedTranscriptSchema` → `fuseTranscriptToSlide()` (contracts/audio.ts:37-81, state/audio-fusion.ts:12-68,97-159,161-235).
  transcript 는 word/device timing + authenticated clock 을 가져야 하고 결과는 `ATTRIBUTED` 또는 명시적 `AMBIGUOUS` reason.
  **COUNTER: STT canonical output 에 word timing/clock/transcriptFinalId 가 없어 별도 normalization/enrichment seam 필요.**
- 구조 권고: 새 private contract `packages/contracts/src/coaching.ts` → **private.ts 에만 export**,
  pure reducer `packages/state/src/coaching.ts` → index.ts root 에만 export, **Stage 가 쓰는 realtime subpath 에는 미export.**
  표시 접속점 Console `PresentationWorkspacePage` cockpit side (App.tsx:779-786). **공개 Stage/projection 에 DTO 추가 금지.**
  현재 coaching 은 capability 문자열만 있고 adapter/schema/service/route/UI 0개.

## 5) 발표 후 리포트
- 가장 풍부한 기존 private event source: `PlaybackAuthorityState.acceptedCommands`
  (state/playback.ts:84-111,129-164; prepared-evidence.ts:116-126,204-220,242-365; store-postgres.ts:38-106).
  command / acceptance time·context / receipt·effect / stage applied·superseded 보유, CAS 영속.
  **COUNTER: snapshot 은 current aggregate + accepted records 이지 append-only report ledger 가 아님.**
- **기존 `deriveEventReport()` 는 closed public `PublicationDispatchDto[]` 를 contiguous revision 으로 집계하는 유틸이고 런타임 호출 0개**
  (contracts/event-derived-report.ts:8-35,49-100). outbox dispatcher 도 claim/dispatch/ack 만 구현하고
  **producer INSERT 가 coordinator/main 에 없음**; coordinator 는 ProjectionHttpPort 직접 호출
  (outbox-dispatcher.ts:33-56,66-114; prepared-evidence.ts:62-99,1188-1196,1297-1304; main.ts:113-115,322-330).
  → **현재 production event log 로 리포트를 만들 수 없음.** (git show 6a8e3fb — contract/test/fixture 만 추가됐고 service/route/storage 는 그 커밋에도 없음)
- presenter-only post-report 는 public.ts 확장 금지, private contract/HTTP route 로. append-only 테이블은 hybrid 뒤 `0009_*`. projection migration 불필요.

## 보안 경계
- STT/search/coaching/report provider runtime·키는 전부 private backend/model-router **server-only**.
  Console 은 audio bytes 와 closed private DTO 만 전송. AI SDK/키/모델 artifact bundle 금지
  (config/browser-forbidden-dependencies.json:2-49, scripts/check-browser-dependencies.ts:71-76,109-155,263-273).
  **COUNTER: 새 벤더 SDK/키 signature 가 denylist 에 자동 추가되지 않음 → 반드시 동기화.**
- Stage 는 private contract/transcript/candidate/RAG/coaching/report 를 import/render 불가.
  projection-gateway 는 private-backend dependency 금지. 공개가 필요하면 private authority 가 최소 closed public DTO 로 declassify 후 narrow projection port/outbox 만 통과.
  **coaching/report 는 요구상 Console-only 이므로 declassification 자체가 불필요.**
- 신규 private feature table 은 private DB + private_app RLS. projection DB 에 만들면 안 됨.
  **prepared_evidence_state/accounts 는 service-wide auth/state 라 의도적 no-RLS 예외이지만, 신규 tenant session facts 는 그 예외가 아님.**

## UNCERTAIN blast radius (신청서 8항)
- **코드에 이름 붙은 4-state schema 가 없음.** 직접 seam 은 `VerifierModelOutputSchema.verdict` 의 **3-state enum**
  (contracts/retrieval.ts:73-79) 이고 isolated OpenAI-compatible adapter 가 **같은 enum 을 중복 정의**
  (model-adapters/openai-compatible.ts:66-71,260-264). UNCERTAIN 추가 시 둘 + pipeline terminal mapping(:275-294) + tests(:217-223) 동시 변경.
- **문서와 코드가 다름**: docs 는 SUPPORTED/UNCERTAIN/CONFLICTING/UNSUPPORTED, 코드는 **SUPPORTED/INSUFFICIENT/CONFLICTING**
  (docs/PWA-구현-최적화-연구보고서.md:32-44). 단순 추가하면 4개가 되지만 **docs 의미와 여전히 다름.**
- 최소 blast radius: model-output terminal 로만 추가 + `RetrievalFailureCodeSchema` 에 `UNCERTAIN_EVIDENCE` 추가 + pipeline fail-closed ABSTAIN.
  후보 lifecycle 까지 상태를 보존하려면 `EvidenceCandidateSchema` 의 SUPPORTED literal, CandidateVerdictState/snapshot/transition,
  public-card gate, prepared snapshot/fixtures/property tests 까지 확대
  (private-evidence.ts:49-50; state/candidate-lifecycle.ts:26-37,46-63,138-217,219-240; public-card-stream.ts:291; prepared-evidence.ts:1330-1342).
  **COUNTER: `EvidenceCandidateSchema` 는 의도적으로 publish-eligible SUPPORTED 만 표현할 수도 있으므로 제품 의미 결정 없이 확장하면 권위 store 에 unsafe state 를 넣게 됨.**

## 마이그레이션 / 환경변수
- 현재 최신: **private 0007, projection 0005**.
- 권장: private **0008** hybrid FTS + retrieval RLS / private **0009** session·report·coaching event ledger.
  STT grant/audio 는 ephemeral 유지 시 migration 없음. external search 도 cache/audit 미영속이면 없음. **projection 신규 migration 없음.**
  **병렬 구현이면 번호 충돌 가능 → lead 가 예약 필요.**
- 신규 env 최소 후보: STT `STT_MODEL_API_KEY`/`STT_MODEL_BASE_URL`/`STT_MODEL`,
  search `EXTERNAL_SEARCH_API_KEY`/`EXTERNAL_SEARCH_BASE_URL`,
  coaching·report 가 기존 chat origin/key 공유 시 `COACHING_MODEL`/`REPORT_SUMMARY_MODEL` 만 추가.
  동기화 지점: main 의 required/URL parsing + secretStore + egress binding, `.env.example`,
  `compose.production.yaml` private-backend environment, `scripts/dev-services.ts`, main-spawn/E2E env fixtures,
  **`config/browser-forbidden-dependencies.json` secret/origin denylist**, deploy/prewarm runbook.

## 이력 교차검증
삭제된 production 구현 **없음**. STT coordinator 는 b829a8c 에서 서비스 파일/테스트만,
external fetch 는 ff41f5b 후 391d9bd 에서 fetcher 만, report 는 6a8e3fb 에서 contract/test/fixture 만 추가됨.
`git log --all --diff-filter=D` 대상 파일 결과 0.
DEAD END: ast-grep / typescript-language-server 미설치 → TypeScript compiler AST fallback 으로 검증.
