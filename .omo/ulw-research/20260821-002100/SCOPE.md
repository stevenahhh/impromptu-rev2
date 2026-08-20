---
근거: 같은 디렉터리의 REPORT.md (적대적 검토 반영본)
---
# 구현 범위 정의

보고서의 적대적 검토 결론에 따라 **9월 심사 목표를 하나의 end-to-end 흐름으로 축소**한다.
나머지는 2027년 3월까지의 단계적 로드맵으로 넘긴다.

## 왜 축소하는가
- 8/21 → 9월말은 **6주 미만**이고, 작업이 두 개의 긴 직렬 의존 경로로 묶여 있어 5명이 병렬화할 수 없다.
- 예산 대부분이 ChatGPT Pro 에 묶여 있어 API·모델 운영 실패를 돈으로 우회할 여지가 작다.
- 이 팀의 실패 모드는 기능 부족이 아니라 **검증 전 기능마다 운영급 아키텍처를 먼저 붙이는 과잉 엔지니어링**이다.

---

## A. 9월 심사 목표 — 이것만 한다

### A1. 원문 근거 카드 하나 (단일 핵심 흐름)
슬라이드·발화 맥락으로 **사전 수집·검증한 소형 corpus** 를 실제로 검색해
**인용 구간 + 출처 URL** 을 표시한다.

왜 이것인가: STT 자체는 commodity 이고, 고정 임계값 코칭은 근거가 약하며, 단순 리포트는 사용자 우선순위가 낮다.
반면 **출처가 보이는 맥락형 근거 카드는 심사자가 즉시 이해하고, 차별점을 한 장면으로 보여주며,
고정 corpus 로 범위를 통제할 수 있다.**

- 지원 입력 형식 **하나**로 고정 (PPTX 권장 — PDF 는 텍스트 추출 경로가 없어 §6.8 참조)
- 검증된 STT 경로 **하나**. 현재 슬라이드 + 최종 transcript text/timestamp 만 유지
- 검색은 **고정 corpus**. 실시간 웹 검색 조달 없음
- **결과를 hard-code 하지 않는다.** 실제 query 를 돌리고 no-result 동작도 시연한다

### A2. 최소 plumbing
| 항목 | 범위 |
|---|---|
| STT 계약 | 최종 text + 단조 증가 utterance ID + 시작·종료 시간만. **revision·word timing 전체 계약은 보류** |
| 오디오 캡처 | 기존 라이브러리 또는 단일 표준 경로. **커스텀 binary WSS + AudioWorklet DSP 보류** |
| STT 엔진 | **검증된 하나로 고정.** 4-way bakeoff 보류 |
| 검색 | 고정 corpus 에 **단일 검색 방식**. hybrid·Kiwi·GIN·계층청킹·RRF 동시 도입 보류 |
| 리포트 | 시간이 남을 때만. 총 발표시간 + 슬라이드별 시간 수준 |

### A3. 기존 자산은 동결
ACL / RLS / SSRF 방어 / nonce CSP / CAS 영속성 / Docker / CI / 483 테스트를
**삭제하지 말고 동결**한다. 회귀 방지 용도로만 쓰고 **추가 아키텍처 작업을 중단**한다.

### A4. 일정
| 기간 | 내용 |
|---|---|
| 2주 | 근거 카드 vertical slice 완성 (실제로 검색되는 것) |
| 1~2주 | 통합 · 실패 fallback · 데모 리허설 |
**총 3~4주 (Medium).**

### A5. 리스크
| 리스크 | 대응 |
|---|---|
| STT·네트워크 실패 | 엔진 하나 + **공개 녹음 replay fallback** 준비 |
| 고정 corpus 가 scripted 로 보임 | 결과 hard-code 금지. 실제 query + no-result 동작 시연 |
| 기존 보안 회귀 | 아키텍처 동결, 기존 CI 통과만 확인 |

---

## B. 자를 것 — 이 순서로

1. **로컬 STT 4-way bakeoff 및 다중 모델 운영** → 검증 엔진 하나로 고정
2. **범용 분석 이벤트 원장 · replay · report materializer** → 종료 리포트 1건 + slide visit 만
3. **OOXML sidecar 전면 재작성** → 기존 추출 경로 + 지원 데모 deck 형식 고정
4. **실시간 코칭 알림 · 시간부채 재분배** → 효과 검증 전까지 제거. 필요하면 발표 후 지표만
5. **실시간 웹 검색 조달 · 도메인 registry · Trafilatura/DOM/table/NLI 전체** → 고정 corpus 로 축소
6. **Kiwi + tsvector + GIN + 계층청킹 + RRF 동시 도입** → 단일 검색 방식만
7. **커스텀 binary WSS + AudioWorklet DSP** → 기존 라이브러리 / 단일 표준 capture
8. **STT revision · word timing 전체 계약** → 최종 text + utterance ID + 시각만
9. **migration 0008/0009 및 환경변수 7곳 확장** → retained path 에 불필요하면 중단

---

## C. 2027년 3월까지의 로드맵 (사용자 검증 후)

| 우선순위 | 항목 | 선행 조건 |
|---|---|---|
| 1 | 실시간 웹 검색 (비동기 prepared-evidence) | A1 이 실사용 검증됨 |
| 2 | 팀 문서 hybrid 검색 (dense/lexical/hybrid A-B 후 Kiwi 결정) | 실제 질문 40~100개 라벨 확보 |
| 3 | STT blind bake-off 및 엔진 교체 | 실제 발표 녹음 corpus 확보 |
| 4 | 발표 후 리포트 확장 | slide visit 1종이 운영에서 검증됨 |
| 5 | 코칭 (발표 후 지표 → opt-in 실시간) | 장르별 검증 + 개인 기준선 보정 설계 |
| 6 | PDF 텍스트 provenance (PyMuPDF sidecar) | PDF 사용자 요구가 실제로 확인됨 |

---

## D. 착수 전에 사람이 결정해야 하는 것 (코드로 못 정함)

1. **`UNCERTAIN` 이 verifier terminal 인가, candidate lifecycle 보존 상태인가.**
   전자는 변경 4곳, 후자는 authority store·public card gate·property test 까지 확대된다.
   문서는 4-state(SUPPORTED/UNCERTAIN/CONFLICTING/UNSUPPORTED)인데 **코드는
   SUPPORTED/INSUFFICIENT/CONFLICTING** 으로 의미가 다르다.
2. **외부 근거의 rights 가 항상 `UNKNOWN` 인 것이 의도인가 미완성인가.**
   현재 external evidence 는 공개가 fail-closed 다.
3. **'허용된 팀원' 의 권한 원천.** 현재 RLS 는 tenant 격리만 하므로
   같은 tenant 만으로 리포트를 공개하면 신청서 요구 위반이다.
4. **데모 입력 형식 고정** — PPTX 인가 PDF 인가. PDF 면 텍스트 추출 경로를 먼저 만들어야 한다.
5. **private migration 번호 owner 지정** (0008/0009 병렬 충돌 방지).
