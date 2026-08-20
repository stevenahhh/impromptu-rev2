# claim-graph.md

세션: 20260821-002100

## 고위험 노드 (Phase 4b 게이트 대상)

### CG-1 SLA 산술 붕괴 (risk: high)
statement: 현재 downstream 추천 p95 4,506ms 에 STT endpoint/final p95 700ms 를 더하면 5초 SLA 를 만족할 수 없다.
- MEASURED: 추천 파이프라인 10회 p95 4,506ms, RECOMMEND 수율 6/10 [LOCAL-M2]
- MEASURED: 제품 문서 예산 — 전체 p95 5s, 구현 할당 4.4s, STT 0.70s [docs/PWA…:239-252, DEMO-SCOPE.md:45]
- DERIVED: 4,506 + 700 = **5,206ms → 206ms 초과**. downstream headroom 은 494ms 뿐.
- DERIVED: 문서상 downstream 할당은 4.40 - 0.70 = **3.70s → 4,506ms 는 자체 할당도 806ms 초과**.
- ASSUMED(**미확인**): 4,506ms 측정이 STT final 이후 시작되고 STT 시간을 포함하지 않는다. **측정 seam 확인 필요.**
- 독립 관측 그룹: stt-streaming-arch(구조), external-search(외부검색 추가 불가 결론), rag-hybrid(rerank 배제 결론) 3개 축이 수렴.
- status: **supported (단, ASSUMED seam 확인 시 재평가)**
- 구조적 대응(멤버 제시): STT endpoint 를 200ms 이하로 억지로 줄여 false split 을 늘리지 말고,
  먼저 downstream deadline/parallelism 과 DEADLINE_EXCEEDED 원인을 줄여 p95 를 최소 4.3s, 문서 예산 준수 시 3.7s 이하로 회수.

### CG-2 한국어 STT 정확도 불확정 (risk: high)
statement: 한국어 로컬 STT 의 발표 도메인 정확도에 대해 신뢰할 수 있는 독립 근거가 없다.
- SELF-REPORTED: ghost613 turbo-korean Zeroth WER 4.89/CER 2.06 (동일 도메인 분할)
- SELF-REPORTED: kresnik XLS-R Zeroth WER 4.74/CER 1.78 → 특화 Whisper 가 우월하지 않음
- 3rd-PARTY(독립성 결함): 리턴제로 AI-Hub 7세트 Whisper 평균 CER 11.39% — **평가자가 상용 경쟁사, Whisper 체크포인트 미명시**
- PRIMARY: Whisper 원 논문이 한국어를 FLEURS 추세 대비 최대 outlier 중 하나로 자인
- 공백: large-v3/turbo 공식 카드에 한국어 수치 없음. WhisperKit 한국어 미확인. Qwen3-ASR 한국어 미확인.
- counter-search: 수행됨 — 한국어 특화 Parakeet/Canary adapter 미발견, Kiwi+Whisper 공개 구현 0건
- status: **unresolved (정직한 결론: 재벤치마크 없이는 순위를 매길 수 없다)**

### CG-3 한국어 발화 속도 기준 (risk: high)
statement: 한국어 코칭 임계값을 문헌 근거로 설정할 수 있다.
- PRIMARY MEASURED: Lee et al. 2017 DOI 10.13064/KSSS.2017.9.1.027, 412명/4,528발화
  말속도 4.82±0.84 syll/s(289±50 SPM), 조음속도 5.99±0.96(359±58 SPM), pause 19.5±5.9%, pause>=100ms
- DERIVED(경계값 아님): 314 / 412 SPM — 6명·9음절 속도조작 연구 중심값의 중간값
- 이식 정당성 근거: 영어 3.40 sps, 네덜란드어 4.63 sps vs 한국어 5.99 sps, 음절구조 차이(자음군 허용 여부)
- **미해결 반론: 표본이 낭독 발화(read speech). 발표는 즉흥·준비된 구어.**
- **미해결 반론: 개인차 ±50 SPM 가 제안 경계 간격보다 큰가.**
- status: **partial (skeptic 공격 대기)**

### CG-4 RAG 규모 논증 (risk: normal)
statement: 현 규모에서 pgvector ANN 도입은 과설계다.
- MEASURED(로컬 실행): 768d 코사인 p50 0.57ms(50) / 4.78ms(500) / 47.6ms(5000)
- PRIMARY: pgvector README — ANN 의 WHERE post-filter 가 recall 저하, multi-tenant 공유 ANN 간섭
- **미해결 반론: 신청서의 내부 RAG 대상은 슬라이드가 아니라 팀 문서(README/API명세/기획서/회의록) → 규모 논증이 뒤집힐 수 있음**
- status: **partial (skeptic 공격 대기)**

### CG-5 외부 검색 약관 리스크 (risk: high)
statement: Exa 는 근거 원문 영구저장에 계약 리스크가 크고 Perplexity API 는 상대적으로 명확하다.
- PRIMARY: Exa ToS §4.2(a), §1.2(c) / Tavily ToS §6.5, §9.2 / Perplexity API ToS §2.3.1~2.3.3
- 독립 관측: 각사 공식 ToS 원문 직접 fetch
- COUNTER: enterprise MSA 로 해소 가능 → 일반 약관만으로 최종 법률판단 금지
- status: supported (단서 포함)

### CG-6 검색 단위 메타데이터 미충족 (risk: high)
statement: 현재 retrieval chunk 는 신청서 7항이 요구한 결합 메타데이터를 충족하지 못한다.
- PRIMARY(코드): `postgres-deck-retrieval.ts`, `infra/migrations/private/0006`
  — source_revision 이 실제 revision 이 아니라 chunk content SHA-256, title="Slide N", anchor 만,
    사용자/그룹 ACL·heading/page/line/JSON Pointer·authored/modified/indexed 시각·원문 경로 부재
- status: supported (코드로 증명)

### CG-7 리포트 원장 필요성 (risk: high)
statement: 스냅샷/CAS 를 재생 리포트 입력으로 쓰면 과거 전이와 후발 transcript 수정이 소실된다.
- PRIMARY(코드): `prepared-evidence.ts:171-177,204-227`, `prepared-evidence-store-postgres.ts:44-71`
- **미해결 반론(사용자 요구): "간단하게 나오면 좋긴 해" 대비 6종 이벤트+새 테이블+버전된 리포트+digest 는 과설계인가**
- status: **partial (skeptic 공격 대기)**


---
## CG-1 정정 (Phase 4 검증 후) — 상태 변경
**이전 진술**: "4,506 + 700 = 5,206ms → SLA 206ms 초과"
**판정**: PARTIAL. 아래로 대체한다.

### CG-1a (supported, 코드+실측)
현재 추천 파이프라인의 실제 성공 지연은 wall-clock p95 **4,164.3ms** (신규 10/10 성공 표본)이며,
서버 `latencyMs` 와의 차이는 3.4ms 로 인증·CSRF·파싱 오버헤드는 무시 가능하다.
- MEASURED: 신규 10회 표본, nearest-rank p95
- 코드 근거: `recommendation-pipeline.ts:94-96, 307, 318-324`; `http.ts:288-293, 405-419, 535-541`

### CG-1b (supported, 코드) — 기존 수치의 정체
기존 "p95 4,506ms" 는 **RECOMMEND 완료가 아니라 deadline guard(deadline-500ms≈4,500ms) 발동 응답**이었다.
따라서 그 수치를 작업 소요시간으로 해석한 모든 산술은 무효다.
- 코드 근거: `recommendation-pipeline.ts:102-106`

### CG-1c (supported, 문서+실측) — **정정 후에도 결론이 유지되는 이유**
문서의 STT 제외 예산 3,700ms 에는 미구현 단계 **2,000ms**(내부/외부 병렬 검색 800 + 원문 fetch·parse 1,200)가 이미 배정돼 있다.
현재 파이프라인은 외부 검색·원문 fetch 를 **수행하지 않으면서** p95 4,164ms 를 소비한다.
실제 수행 작업에 배정된 예산은 최대 1,900ms 이므로 **약 2.2배 초과**.
→ 외부 검색·원문 fetch·검증을 동기 5초 경로에 넣는 것은 불가능하다는 결론은 **유지**.
- 문서 근거: `docs/PWA-구현-최적화-연구보고서.md:243-251`
- 독립 관측 그룹 4개(external-search / stt-streaming-arch / rag-hybrid / post-report) 수렴

### CG-1d (supported, 로그) — STT 단축으로 수율이 회복되지 않는 이유
DEADLINE_EXCEEDED 4회의 단계 분포는 rerank 2 / LLM 1 / verifier 1 로,
**특정 단계가 아니라 chat provider tail 이 임의 슬롯에 떨어지는 현상**이다.
파이프라인은 단계별 budget 없이 **하나의 deadline 을 공유**한다(`deadline.ts:17-19, 42-46`).
→ STT 예산을 줄이는 방향의 대응은 수율 문제를 해결하지 못한다. 대응은 슬롯별 budget 분할 또는 공급자 교체다.

### CG-1e (unresolved) — 측정되지 않은 구간
`slide fusion·trigger·query`(문서 배정 350ms)와 `Console persist·push·render`(250ms)는 **한 번도 측정된 적 없다.**
따라서 실제 end-to-end p95 는 4,164ms 보다 크며 그 차이는 미지수다.
- status: unresolved — 보고서에 공백으로 명시할 것
