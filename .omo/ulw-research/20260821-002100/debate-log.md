# debate-log.md

세션: 20260821-002100

## 라운드 1 — skeptic-judgment (6m34s)

### 명제 1: "한국어 코칭 임계값을 문헌 근거로 정할 수 있다" → **무너짐**
공격 논거:
1. **경계가 성과 기준이 아니라 표본 분포의 재명명이다.**
   제안 경계 폭 `417-302 = 115 SPM`. 조음속도 실제 SD 57.6 → ±1SD 폭 **115.2** — 사실상 동일.
   평균 359 에서 각 경계까지는 57.5 SPM 뿐이고 ±50 은 그 거리의 87%.
2. **±50/±58 은 개인 내부 변동이 아니라 표본 분산이다.** 개인 실시간 경계로 쓰는 것은 추가 비약.
3. **Kim 2018 개인 평균 범위 `492-312 = 180 SPM`.** 고정 경계 적용 시
   **40명 중 아무도 '느림' 으로 분류되지 않고, 상단 화자는 평소 평균 자체가 '빠름'** 이 된다.
   → 고정 경계가 정상적 화자 차이를 교정 대상으로 오인.
4. 낭독은 내용 생성 부담이 없다. 발표에는 생각·강조·청중 반응·슬라이드 전환 휴지가 섞인다.
   조음속도는 이식 가능성이 상대적으로 높지만 **휴지비율과 전체 말속도의 직접 이식은 정당화되지 않는다.**
5. Lee & Ko 2004 는 6명이 스스로 느림·보통·빠름을 **연기한 낭독**이고 논문도 절대 기준 불가를 인정.
6. **유용성 증거 없음**: Orai testimonial / 불명확한 Yoodli 1차 자료 / 영어 rehearsal 용 Speaker Coach 는
   한국어 발표 성과의 **인과적 개선 증거가 아니다.** 청중 이해도·발표 품질 개선 검증이 없다.
7. **JND 5% 오독 지적**: 359 SPM 기준 약 18 SPM 을 '지각할 수 있다' 는 뜻이지
   **그 폭의 히스테리시스가 유익하다는 뜻이 아니다.**
   Stothart 는 발표 연구가 아니지만 알림의 주의 비용을 보여주므로,
   현재 근거로 **실시간 알림의 순편익을 주장할 수 없다.**

리드 판정: **공격 인용.** 특히 (1)의 산술과 (3)의 반례는 반박 불가.
→ 보고서 §7.3, §7.7 수정. 실시간 알림을 기본 활성화에서 **opt-in 실험 기능**으로 강등.

### 명제 2: "발표 후 리포트를 append-only 이벤트 원장으로" → **약화됨 (부분 방어)**
**방어된 부분**: `occurrenceSeq` 반론은 살아남았다. `A` 와 `A→B→A` 는 최종 snapshot 이 같지만 dwell 이 다르다.
공격자가 이 지점에서 실패했음을 인정.
**무너진 부분**: 그것이 입증하는 건 **최소한의 순서 있는 방문 기록**이지 6종 원장·materializer·재계산 체계가 아니다.
- `reportVersion`/`inputDigest` 는 리포트 행에 저장 가능 — 원장의 전유물이 아님
- 대안 표현: 단조 증가 서버 sequence / 순서 보장 change ID / `{slideId, enteredAt, leftAt, visitNo}` 방문 구간
- 최소안: **1종 `SLIDE_VISIT_RECORDED` 또는 `SLIDE_CHANGED`**
- 나머지 5종을 버릴 때의 정확한 손실:
  | 버리는 이벤트 | 대체 | 포기하는 것 |
  |---|---|---|
  | SESSION_STARTED/ENDED | 세션 행 timestamps/status | 라이프사이클 재생 |
  | TIMING_PLAN_FROZEN | 최종 plan/hash 저장 | 이전 계획 + 정확한 freeze 순간 |
  | TRANSCRIPT_FINALIZED | 최종 transcript 행 | revision provenance |
  | VOICE_ACTIVITY_FINALIZED | 최종 VAD segments | VAD revision provenance |
  | EVIDENCE_CARD_TRANSITION | count/firstSeen/lastSeen 집계 | 카드 상태 경로 + 사건 간 시간 상관 |
리드 판정: **공격 인용.** → 보고서 §8.4 를 1종 최소안으로 교체.

### 명제 3: "5개 기능을 남은 기간에 5인 학부생 팀이 구현할 수 있다" → **무너짐**
- **8/21 → 9월말 6주 미만.** 두 개의 긴 의존 경로가 병렬화를 막는다:
  ① STT 계약 → 오디오 ingest → 모델 → VAD/코칭/리포트
  ② 검색 → 추출 → 인덱싱 → 랭킹 → 근거 카드
- 예산 대부분이 ChatGPT Pro 에 묶여 검색·STT API 실패를 돈으로 우회할 여지가 작다.
- **제품 절반이 빈 채로 ACL/RLS/SSRF/CSP/CAS/Docker/CI/483 테스트가 있다는 사실은
  기술력 부족이 아니라 범위 배분 실패를 지지한다.**
- 보안은 질의응답에서 점수가 될 수 있으므로 무가치하지 않다. 그러나
  **작동하는 제품 흐름이 없으면 심사자가 볼 사용자 가치가 아니고, 483 테스트가 기능 5개로 환산되지 않는다.**
리드 판정: **공격 인용.**

### skeptic 권장 우선순위 (그대로 채택)
**남길 것**: ① 슬라이드·발화 맥락 기반 **원문 근거 카드 하나** (사전 수집·검증한 소형 corpus 를 실제 검색,
인용 구간 + 출처 URL 표시) ② 최소 plumbing — 지원 형식 하나, 검증된 STT 경로 하나,
현재 슬라이드 + 최종 transcript text/timestamp 만 ③ 기존 ACL/RLS/CI 는 **동결**하고 회귀 방지에만 사용

**자를 순서**:
1. 로컬 STT 4-way bakeoff·다중 모델 운영 → 검증 엔진 하나로 고정
2. 범용 분석 이벤트 원장·replay·materializer → 종료 리포트 1건 + slide visit 만
3. OOXML sidecar 전면 재작성 → 기존 추출 경로 + 지원 데모 deck 형식 고정
4. 실시간 코칭 알림·시간부채 재분배 → 효과 검증 전까지 제거, 필요하면 발표 후 지표만
5. 실시간 웹 검색 조달·도메인 registry·Trafilatura/DOM/table/NLI 전체 → 검증된 고정 corpus 로 축소
6. Kiwi+tsvector+GIN+계층청킹+RRF 동시 도입 → 작은 corpus 에 단일 검색 방식만
7. 커스텀 binary WSS + AudioWorklet DSP → 기존 라이브러리 또는 단일 표준 capture 경로
8. STT revision·word timing 전체 계약 → 최종 text + 단조 증가 utterance ID + 시작·종료 시간만
9. retained path 에 불필요한 migration 0008/0009 와 환경변수 7곳 확장 중단

**하나만 고른다면: 원문 근거 카드.**
근거: STT 자체는 commodity, 고정 임계값 코칭은 근거가 약함, 단순 리포트는 사용자 우선순위 낮음.
반면 출처가 보이는 맥락형 근거 카드는 **심사자가 즉시 이해하고, 차별점을 한 장면으로 보여주며,
고정 corpus 로 범위를 통제할 수 있다.**

규모 판단: **Medium, 총 3~4주.** 2주 vertical slice + 1~2주 통합·fallback·리허설.
리스크: STT/네트워크 실패 → 엔진 하나 + 녹음 replay fallback /
고정 corpus 가 scripted 로 보일 위험 → 결과 hard-code 금지, 실제 query 와 no-result 동작 시연 /
기존 보안 회귀 → 아키텍처 동결, 기존 CI 통과만

## 라운드 2 — skeptic-empirical (7m56s)

### 명제 1: "현재 파이프라인은 배정 예산의 2.2배를 쓴다" → **무너짐**
공격 논거:
1. **이중 계상.** 800ms 는 '내부·외부 **병렬** 검색' 단계 전체의 wall-clock 상한이다.
   이를 현재 내부 검색에 전부 주는 것은 보수적이지만, **동시에 '미구현 외부 검색 예산' 으로도 세면 중복**이다.
   `현재작업 1,900 + 미구현 2,000 = 3,900ms > 3,700ms` — 애초에 3,700 의 분할이 아니다.
   게다가 fusion/query 350 + rank/render 250 = **600ms 가 빠져 있다.**
2. **분모가 정의되지 않는다.** 문서 단계표에 **embedding·rerank·생성 LLM 항목이 없다.**
   따라서 이들의 예산이 0 이거나 verifier(1,100)에 포함됐다고 **추론할 수 없다.**
3. **lineage 오류.** 4,164.3ms 만 10회 nearest-rank MEASURED 이고,
   "2.2배" 는 임의로 고른 계획표 분모에서 나온 **DERIVED** 값이다.
4. 공유 deadline 에서 발생한 rerank 2 / LLM 1 / verifier 1 실패는 **단계별 예산을 증명하지 않는다.**
   어느 inference 단계에서든 남은 deadline 이 소진됨을 보여줄 뿐이다.

리드 판정: **공격 전면 인용.** 제가 낸 수치를 철회한다.
**단 결론은 약화된 형태로 생존**: 현 코드의 외부 분기는 내부 materialization **뒤에서** 검색·fetch 하므로
그대로 활성화하면 critical path 가 늘어난다. → 외부 근거는 **초기 Console 표시의 blocking dependency 가 되면 안 된다.**
**그러나 "동기 경로에 절대 불가능" 은 과장이다** — partial transcript prefetch 나 cutoff 있는 bounded 병렬 race 는 배제되지 않았다.

### 명제 2: "한국어 발표 도메인 STT 정확도를 우리는 모른다" → **방어됨**
- 리턴제로가 경쟁사라는 사실만으로 결과가 거짓이 되지는 않는다.
  그러나 **자사 제품이 1위인 평가에서 Whisper checkpoint·decoding·정규화가 미명시**돼
  독립 재현과 현재 후보로의 전이가 불가능하다.
- Zeroth 2.06% 도 self-report, 동일 read-speech domain, 별도 평가 harness →
  발표·잡음·streaming 정확도나 XLS-R 대비 우위를 입증하지 못한다.
- **추가 지적(내 서술 오류)**: 서로 다른 평가의 2.06% 와 6~17% 를 나눠 **"2~8배 악화"** 라고 한 것은
  **통제된 비교가 아니다.** → 보고서에서 이 표현을 제거해야 한다.
- **다만 "전혀 모른다" 로 확대하면 안 된다**: 정확한 CER/순위는 모르지만
  한국어 outlier·도메인 이동·VAD·code-switch 가 위험 축이라는 **방향성까지 모르는 것은 아니다.**
- GitHub 이슈는 발생률·일반 성능으로 일반화 불가. 그러나
  **acceptance-test 사례로는 중요**하다(segment 누락 / 무음 환각 / 언어 오감지).

리드 판정: 방어 인용 + 서술 정정 2건 반영.

### 명제 3: "하이브리드 lexical+dense 가 필요하다" → **약화됨**
- **규모 공격이 실패했다.** 내부 RAG 대상이 슬라이드가 아니라
  **선택된 README·API 명세·회의록·기획서**라면 "수십 chunk" 전제가 무효다.
  이질적 팀 문서의 **API 경로·식별자·버전·고유명사는 lexical 신호의 타당한 근거**다.
- **그러나 "필요" 가 측정된 사실은 아니다.** 실제 corpus 크기와 relevance lift 가 없다.
  "lexical 신호가 유용할 수 있다" 와 "지금부터 형태소 분석기·인덱스를 운영해야 한다" 는 별개 주장이다.
- **내 서술 오류 지적**: 외부 Kiwi 가 만든 lexeme 를 표준 `tsvector`+GIN 에 저장하는 권고안 자체는
  **custom PostgreSQL 이미지를 요구하지 않는다.** §6.4 의 "확장을 넣는 순간 DB 이미지 책임" 문장은
  pg_bigm/PGroonga 에는 맞지만 **Kiwi 안에는 적용되지 않는다.**
- cosine 실측은 **ANN 만 반박**할 뿐 lexical recall 을 반박하지 않는다.
- 결론: ANN 없는 **단계적 hybrid 는 합리적 제품 가설**이지만 **Kiwi 고정이나 학습형 가중합은 아직 이르다.**

리드 판정: 공격 인용 + §6 을 '덱' 에서 '팀 문서 corpus' 로 재정의.
