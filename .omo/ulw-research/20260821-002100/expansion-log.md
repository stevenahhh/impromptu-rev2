# expansion-log.md

세션: 20260821-002100

## wave 1 (첫 파도)
스폰: 팀 멤버 8 (stt-local-models, stt-streaming-arch, external-search, rag-hybrid,
coaching-metrics, post-report, codebase-integration, skeptic)
반환: stt-streaming-arch **축 완주**(5m37s). 나머지 4명 중간보고. codebase-integration/skeptic 아직.

### 도구 수준 장애 (전원 영향)
web_search 의 duckduckgo-html 제공자가 **전 질의 HTTP 403 / 결과 0**.
external-search 와 stt-streaming-arch 가 독립적으로 동일 보고. 검색어 문제 아님.
→ 우회: 공식 문서 URL 직접 fetch, GitHub REST Search API, 벤더 docs/pricing/terms 경로.
→ 전 멤버에게 즉시 브로드캐스트함.
`gh` CLI 미설치도 확인됨(stt-local-models) → GitHub REST API 로 대체.

### 사용자 스티어링 (원문)
"혹시나 quick이나 explore 서브에이전트 이용하게될때 opencode go의 deepseek v4 flash 모델 사용해."
→ subagent_type 레인(explore/librarian)에 model 오버라이드 적용 필요. category 와는 병용 불가.

### 새 리드 (라우팅 대상)
L1 WhisperKit 한국어 정확도 미확인 → stt-local-models (owner)
L2 비공식 Korean Parakeet/Canary adapter 존재 여부 → stt-local-models
L3 SenseVoiceSmall 한국어 CER + Apple ONNX RTF → stt-local-models
L4 Fun-ASR-Nano-2512 / Qwen3-ASR 최신 한국어 지원 → stt-local-models
L5 canonical STT event 계약 확장 blast radius → codebase-integration (소유자 전환)
L6 streaming format metadata 부재(고정 PCM vs session-open metadata) → codebase-integration
L7 브라우저 uploader/ingest route 0개 → codebase-integration
L8 vendor retention 운영표(no-training/no-logging/region/DPA) → stt-local-models
L9 300~400ms endpoint 가설의 한국어 pause 오류율 → **검증 레인 필요(코퍼스 sweep)**
L10 Brave=후보만 / 자체 fetch vs Tavily·Exa 원문 위임 → external-search (설계 분기)
L11 Perplexity·Kagi 가격/약관 미확정 → external-search

### wave 1 진행 (2차 집계)
축 완주: stt-streaming-arch(5m37s), **post-report(7m05s)**
중간보고 다수: stt-local-models(3회), coaching-metrics(1회, 핵심 수치 확보), rag-hybrid(3회), external-search(2회)
착수: codebase-integration. **미반환: skeptic** → 공격 패킷 투입 필요.

새 리드:
L12 리턴제로 벤치마크의 Whisper 정확한 버전/실행 옵션 → stt-local-models (독립성 결함 확인용)
L13 동일 AI-Hub 샘플로 large-v3-turbo/MLX/WhisperKit 재평가 → **검증 레인 후보 (실제 실행)**
L14 Qwen3-ASR-0.6B 의 MLX/llama.cpp Apple 포트 → stt-local-models
L15 Qwen3 한국어 코드스위칭 실제 샘플 → stt-local-models
L16 section target authoring UI/contract 위치 → codebase-integration
L17 팀원 authorization canonical source → codebase-integration
L18 bge-reranker-v2-m3 실제 한국어 top-k 지연 → **검증 레인 후보 (실제 실행)**

### wave 1 (3차 집계)
축 완주 4/7: stt-streaming-arch, post-report, **rag-hybrid(9m28s)**, **external-search**
진행: stt-local-models(최종 종합 중), coaching-metrics(알림 상태기계 확정), codebase-integration(1차 발견)
**장애: skeptic 멤버 기동 실패 (`Child prompt failed to start`). 공격 패킷이 죽은 멤버로 전달됨.**
→ 대체 공격 레인을 `task`(ultrabrain)로 스폰. 팀 재생성 없이 레인으로 대체.

### codebase-integration 1차 발견 (프로덕션 도달 불가 경로 2건)
- STT: main.ts 에 streaming adapter 등록 / RouterBackedAudioSttPort / AudioCaptureCoordinator / HTTP route 배선 **전무**.
  Console AudioConsentControl 은 테스트 외 **미마운트**, CaptureUploader 구현 0개.
- **외부검색: external fetcher 는 main.ts:280/307 배선됐으나 `ExternalSearchBoundary` 가 주입되지 않아
  `recommendation-pipeline.ts:187-207` 외부 분기가 프로덕션에서 도달 불가.**
- coaching: capability 만 선언, adapter/domain/route/UI 배선 0개.
- 리포트: `PlaybackAuthorityState.acceptedCommands` 는 스냅샷에 영속되나
  event-derived-report 는 outbox dispatch DTO 기반 별도 유틸이고 **런타임 호출 0건**.
  coordinator 는 ProjectionHttpPort 직접 호출, **outbox INSERT 없음.**

### coaching-metrics 알림 설계 확정 (근거 4종)
- NIST EWMA λ 0.2~0.3 통상값 (임의성 있음 → 제품 초기값은 ASSUMED)
- **Quené 2007: 말속도 JND 약 5% → 히스테리시스 폭 최소 5%** (이게 임계 밴드의 근거)
- Prometheus `for` 지속조건 + Alertmanager grouping/dedup/inhibition/cooldown
- Microsoft: 라이브 critique 를 **한 번에 하나만 순차 표시**
- Stothart et al. 2015: **notification 자체만으로도 주의과제 성능 저하**
제안: fast/long EWMA 분리, 3회 연속 동일 상태 후 후보, trigger/clear 5% band,
종류별 60s cooldown + 전역 30s 간격(초값 ASSUMED), 동시 1개.
시간 부채(섹션 종료 시에만 재계산):
`debt = max(0, Σ remaining base - remainingBudget)`; `flex_i = base_i - min_i`; `new_i = base_i - debt*flex_i/Σflex`
debt > Σflex 이면 전부 min 고정 + unrecoverable overrun 표시. 실행 검산(정상/1분 부채/복구불가/조기종료) 통과.

### 새 리드
L19 4,506ms 측정의 정확한 timing seam (final transcript receipt 인가 HTTP request 인가) → **검증 필요, CG-1 의 전제**
L20 4/10 DEADLINE_EXCEEDED 의 단계별 분포 (retrieval/fetch/verifier 별 terminal latency 분해)
L21 partial prefetch 의 안전한 지연 회수량
L22 발표 슬라이드 기반 용어 bias A/B corpus (정확도 레버 ↔ 환각 위험)
L23 Korean accent English 언어 감지 실패 → 구간 언어 라우팅
L24 finalized utterance 의 idempotency key (`utteranceId + revision`)
L25 PDF-origin provenance (OOXML sidecar 가 PDF 미커버)

### wave 1 종료 — 전 축 완주 (7/7)
stt-streaming-arch 5m37s / post-report 7m05s / rag-hybrid 9m28s / stt-local-models 10m52s /
codebase-integration 12m50s / coaching-metrics 13m41s / external-search 15m25s
skeptic 멤버 기동 실패 → 대체 레인 st_01a01fd0 진행 중.

### 수렴 신호 (독립 관측 그룹 4개가 같은 결론)
external-search, stt-streaming-arch, rag-hybrid, post-report 가 **서로 다른 근거로** 동일 결론 도달:
"외부 검색 / rerank / 근거 검증 / 리포트 재계산을 동기 5초 경로에 넣을 수 없다. 비동기 분리가 유일한 경로."
→ CG-1 의 독립 관측 수렴 충족.

### 커밋 완료 (병렬 트랙)
9개 원자적 커밋(eaa9e16~2a3a0ea). `git diff --check` 통과, 관련 테스트 72 pass,
typecheck·build 통과. 워킹트리에 `.omo/ulw-research/` 만 남음(의도적 미커밋).

### 남은 미해결 (wave 2 후보)
**L19 (최우선)**: 4,506ms 측정의 timing seam. CG-1 의 유일한 ASSUMED 전제.
  → 검증 레인 투입.
L20 DEADLINE_EXCEEDED 4/10 의 단계별 분포
L22 슬라이드 용어 bias A/B (정확도 레버 ↔ 무음 환각)
L26 UNCERTAIN 이 verifier terminal 인지 candidate lifecycle 보존 상태인지 — **제품 의미 결정 필요(코드 아님)**
L27 external evidence rights 가 항상 UNKNOWN 인 것이 의도인지 미완성인지 — **제품 의미 결정 필요**
L28 private migration 0008/0009 번호 예약
