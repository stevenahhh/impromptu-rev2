# brief.md — impromptu 미구현 5개 축 연구

세션 시작: 20260821-002100
세션 경로: /Users/gahn/Projects/impromptu-rev2/.omo/ulw-research/20260821-002100

<analysis>
Core question: 신청서(docs/신청서.pdf)가 정의한 5개 미구현 기능(로컬 STT / 외부 근거 검색 / 완전한 RAG /
실시간 코칭 / 발표 후 리포트)을 이 저장소의 기존 아키텍처·보안 경계·로컬 하드웨어 제약 안에서
어떻게 구현해야 하는가. 산출물은 내부 연구 보고서(MD)와 그로부터 도출한 구현 범위 정의.

Axes (7 + 1 skeptic):
 A1 stt-local-models   — 로컬 실행 가능한 한국어 STT 모델 실측 비교 (24GB M5 Pro 제약)
 A2 stt-streaming-arch — 스트리밍 STT 구조: partial/final 분리, VAD, endpointing, 브라우저 오디오 전송
 A3 external-search    — 외부 근거 검색: 검색 API, 1차 자료 우선, 원문 근거 구간 추출
 A4 rag-hybrid         — lexical+dense 하이브리드 검색, 한국어 토크나이징, pgvector, 재순위
 A5 coaching-metrics   — 결정론적 발표 코칭 지표(음절/분, 침묵률, 구간 시간부채) + 알림 정책
 A6 post-report        — 발표 후 리포트: 재계산 모델, 필요한 이벤트 영속화
 A7 codebase-integration — 각 기능이 기존 계약/상태/경계/마이그레이션 어디에 붙는지
 S  skeptic            — 위 전부에 대한 공격(증거 품질, 독립성, 과설계, 실현가능성)

Codebase relevant: yes · External: yes · Browsing: yes · Verification likely: yes (STT 모델은 실제 실행 검증)
Scale: 7축, 소스 영역 다수(모델 카드/벤치마크/논문/구현체/저장소), 목표 문서 길이 장문
Precision demand: 잘못된 모델 선정은 수 주의 재작업. 잘못된 지연 수치는 5초 SLA 설계를 통째로 무너뜨림.
→ lifecycle: 단일 research 팀 + 검증 레인 (구현 범위 정의는 합성 이후 별도 산출)
Debate need: (1) 로컬 STT가 24GB에서 실시간 한국어를 감당한다는 주장 (2) 하이브리드 검색이
pgvector 없이도 충분하다는 주장 (3) 코칭을 LLM 없이 결정론적으로 해도 유용하다는 주장
(4) 5초 SLA 안에 STT→검색→검증이 들어간다는 주장
</analysis>

## 포맷 게이트 (사용자가 사전 응답)
사용자 원문: "이 모든 내용은 ulw-research로 연구하여 내부 보고서를 MD파일로 만들고,
그 보고서를 토대로 구현 범위만 간단하게 잡아놓으셈."
→ 최종 산출물: **Markdown 내부 보고서** (PDF/DOCX 렌더링 없음). 추가 산출물: 간결한 구현 범위 정의.
→ 언어: 한국어. 인용 원문은 원어 유지.

## Phase 0 스코핑에서 이미 확정된 사실 (재조사 불필요)
- STT 라우팅 배관 존재: services/model-router/src/router.ts 가 "stt" capability 를 5곳에서 처리.
  services/model-router/src/stt.ts (56줄) 는 스키마 + UnarySttAdapter/StreamingSttAdapter 인터페이스만.
  구현체 0개. → 아키텍처가 아니라 어댑터가 빠진 상태.
- RAG 현황: services/private-backend/src/retrieval/postgres-deck-retrieval.ts:361 의 cosineSimilarity()
  가 TypeScript 인메모리 계산. infra/migrations/private/0006 의 embedding 은 double precision[],
  인덱스 deck_retrieval_scope_idx 는 벡터 인덱스가 아님. pgvector 미사용. lexical 검색 0건.
- 코칭 토대 존재: packages/state/src/audio-fusion.ts 의 mapDeviceIntervalToSession(),
  fuseTranscriptToSlide() 로 발화-슬라이드 시간축 정합 가능. 지표 계산만 부재.
- 외부 검색: main.ts:280 SafeExternalEvidenceFetcher 배선됨(SSRF 방어 pinned HTTPS). 검색 후보
  생성기(질의 생성 + 검색 API)가 없어서 fetch 할 대상이 만들어지지 않음.
- 검증 상태 4종 중 UNCERTAIN 미구현 (SUPPORTED/CONFLICTING 만 존재).
- 하드웨어: Apple M5 Pro, 24GB RAM, ollama 설치됨(embeddinggemma 만 보유), uv, soffice 사용 가능.
- 기존 모델 배선: chat 3슬롯 deepseek-v4-flash @ OpenCode Go, embedding embeddinggemma 768d 로컬 TLS.
- 제품 SLA: docs/PWA-구현-최적화-연구보고서.md 및 docs/DEMO-SCOPE.md 가 확정발화→표시 p95 5초 규정.

## 기대 진실 (intent-diff.md 시드)
 I1 신청서 4)주요기능: "발표 음성 STT 텍스트화 + 현재 슬라이드 결합" → 현실: STT 구현체 0
 I2 신청서 7): "외부 자료는 원문 페이지를 가져와 근거 구간 확보" → 현실: 검색 후보 생성기 부재
 I3 신청서 7): "lexical + dense hybrid 검색" → 현실: dense 만, 그것도 인메모리 코사인
 I4 신청서 11): "음절/분·조음속도·침묵비율, cooldown, 3~5 논리구간 시간 재분배" → 현실: 미구현
 I5 신청서 12): "저장된 이벤트를 다시 계산해 리포트" → 현실: 미구현
 I6 신청서 8): 검증 상태 4종 → 현실: UNCERTAIN 부재
 I7 신청서 16): "발화 후 5초 이내 최대 3개 추천" → 현실: 발화 입력 자체가 없음
