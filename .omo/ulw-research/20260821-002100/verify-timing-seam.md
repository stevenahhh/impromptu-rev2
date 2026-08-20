# Phase 4 검증: 4,506ms 타이밍 seam — 판정 PARTIAL

## 측정 seam (코드 확정)
서버가 응답하는 `latencyMs` = **`recommend()` 진입 → 모델·검색·검증·최종 재인가 완료**
- 시작: `recommendation-pipeline.ts:94-96` (`startedAtMs`)
- 성공 종료: `:307` (`completedAtMs`), `latencyMs = completedAtMs - startedAtMs` (`:318-324`)
- abstain 도 동일 시작점 (`:372-382`)

**제외되는 것**: STT / slide fusion·trigger·query 생성 / 도착 전 네트워크 /
origin 검사(`http.ts:288-293`) / account-session 조회(`:405-413`) / CSRF(`:414-419`) /
JSON 파싱(`:535-536`) / 응답 직렬화·송신 / **Console persist·push·render**
(추천 경로에는 rate limiter 없음 — limiter 는 로그인 경로 `http.ts:365-375` 에만)

## 결정적 발견 — 4,506ms 의 정체
deadline race 구조:
- 명목 deadline = 시작 + 5,000ms (`:94-96`)
- **실제 guard 는 deadline - 500ms 에 실행** (`:102-106`) → **약 4,500ms 에 abort**
- 응답에는 실제 시각이 아니라 `deadlineAtMs`(시작+5,000ms) 를 기록 (`:106`)

→ **기존 "실측 p95 4,506ms" 는 서버 latencyMs 가 아니라 클라이언트 wall-clock 이고,
그 회차들은 RECOMMEND 완료가 아니라 4.5초 가드에 걸린 DEADLINE_EXCEEDED 였다.**
즉 "작업이 4.5초 걸렸다"가 아니라 "4.5초에 잘렸다".

deadline 은 **단계별 budget 없이 전체 파이프라인이 하나를 공유**
(`:155-163` trusted context, `:223-246` rerank·LLM 병렬도 동일 deadline, `:275-285` verifier,
timer 는 `model-router/src/deadline.ts:17-19`, 각 호출 감시 `:42-46`). `AbortSignal.timeout` 이 아니라 AbortController + scheduler.

## 재측정 (동일 인증 경로, loopback, 순차 10회, nearest-rank)
| | p50 | p95 |
|---|---:|---:|
| 클라이언트 wall-clock | 3,038.636ms | **4,164.304ms** |
| 서버 `latencyMs` | 3,037ms | 4,162ms |
| **seam 밖 오버헤드** | **2.304ms** | **3.395ms** |

**10/10 RECOMMEND 성공, deadline 실패 0회.** 공급자 tail 변동이 큼.
(seam 밖 오버헤드가 3ms 대라는 것은 인증·CSRF·파싱이 무시 가능하다는 뜻 — 이건 좋은 소식)

## 기존 4회 DEADLINE_EXCEEDED 분해
| 회차 | 걸린 단계 | 로그 |
|---:|---|---|
| 5 | **rerank** | LLM 1,487ms 성공, rerank 4,284ms 에서 cancelled |
| 6 | **rerank** | LLM 3,673ms 성공, rerank 4,272ms 에서 cancelled |
| 7 | **verifier** | rerank 3,775ms·LLM 1,210ms 성공 후 verifier 506ms 에서 cancelled |
| 9 | **LLM** | rerank 798ms 성공, LLM 4,324ms 에서 cancelled |

분포 rerank 2 / LLM 1 / verifier 1.
→ **특정 단계의 문제가 아니라 chat provider tail 이 어느 슬롯에 떨어지느냐의 문제.
STT 를 줄여도 이 수율 문제는 해결되지 않는다.**

## 제품 문서 예산 원문 (`docs/PWA-구현-최적화-연구보고서.md:243-251`)
| 단계 | p95 |
|---|---:|
| STT endpoint/final | 700ms |
| slide fusion·trigger·query | 350ms |
| 내부/외부 **병렬 검색** | 800ms |
| **원문 fetch·parse** | 1,200ms |
| deterministic checks·verifier | 1,100ms |
| rank·persist·push·render | 250ms |
| 합계 | 4,400ms |
→ **STT 제외 할당 = 3,700ms**

## 판정: PARTIAL
**맞는 부분**
- 4,506ms 표본에 STT 는 포함되지 않았다.
- 그 표본 기준 5초까지 headroom 은 494ms 뿐이다.
- 문서상 STT p95 700ms 를 예산 방식으로 더하면 5,206ms → 206ms 초과.

**틀리거나 불완전한 부분**
- 4,506ms 는 "STT 이후 → Console render" 전체가 아니라 **추천 HTTP 호출 일부**다.
  slide fusion·trigger·query 와 Console persist·push·render 가 빠져 있다.
- 4,506ms p95 는 RECOMMEND 완료가 아니라 **4.5초 가드에 걸린 DEADLINE_EXCEEDED 응답**이다.
- **독립 측정된 p95 끼리 더한 5,206ms 는 예산 합이지 실제 end-to-end p95 측정값이 아니다.**

## 정정된 headroom
| 기준 | wall-clock p95 | 5초까지 여유 | STT 700ms 차감 후 |
|---|---:|---:|---:|
| 기존 4,506ms 표본(가드 발동분 포함) | 4,506ms | 494ms | **-206ms** |
| **신규 4,164ms 표본(10/10 성공)** | 4,164.3ms | **835.7ms** | **+135.7ms** |
둘 다 slide fusion·query 와 Console render 를 제외한 값이므로 **실제 end-to-end 여유는 이보다 작다.**

## 리드 분석 — 정정이 결론을 약화시키지 않고 오히려 강화하는 이유
문서의 STT 제외 예산 3,700ms 안에는 **아직 구현되지 않은 단계 2,000ms 가 이미 배정**돼 있다:
내부/외부 병렬 검색 800ms + 원문 fetch·parse 1,200ms.
현재 파이프라인은 **외부 검색도 원문 fetch 도 하지 않으면서** wall-clock p95 4,164ms 를 쓴다.
즉 실제로 수행 중인 작업(내부 검색 + rerank + LLM + verifier)에 배정된 예산은
많게 잡아도 검색 800 + 검증 1,100 = **1,900ms 인데 4,164ms 를 쓰고 있다 — 약 2.2배 초과.**
→ 외부 검색을 동기 경로에 넣는 결론은 유지된다. 근거만 "206ms 초과" 에서
**"이미 배정 예산의 2.2배를 쓰면서 배정된 2,000ms 어치 단계를 아직 시작도 안 했다"** 로 교체한다.
