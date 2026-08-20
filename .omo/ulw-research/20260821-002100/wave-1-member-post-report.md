# wave-1 / post-report (축 완주, 7m05s)

## 결론
현재 CAS 스냅샷 **옆에** 작고 append-only 인 분석 이벤트 원장을 두고, 끝난 세션에서 그 원장만
재생해 immutable report version 을 만든다. **현재 상태/실시간 값으로 리포트를 만들면 안 된다.**

## 권고 범위 (과설계 금지 — 리포트 화면 딱 5블록)
(1) 총 발표 시간 (2) 슬라이드 **occurrence 별** 체류 시간 (3) 구간별 목표/실제/차이
(4) 구간별 WPM 변화와 침묵 비율 (5) 카드 표시 시각·종료 상태/사유
+ 결정론적 `next_practice[]` 최대 2개.
**제외**: 종합 점수, LLM 요약, 원본 음성, 전문 transcript, 카드 인용문.

## 최소 영속 이벤트 모델
새 테이블 `private_app.presentation_analysis_events`, envelope:
`event_id UUID, tenant_id, presentation_session_id, presentation_session_epoch,
 seq BIGINT(세션 내 단조·unique), kind, offset_ms(발표시작 기준), occurred_at, recorded_at,
 producer_id(idempotency), versioned closed JSON payload`, `presentation_sessions` FK ON DELETE CASCADE.

필수 사건 6종:
1. SESSION_STARTED / SESSION_ENDED — total duration 의 명시 경계
2. **TIMING_PLAN_FROZEN** `{sectionId, orderedPublicSlideKeys, targetMs}[]`
   → 시작 시점에 얼린 목표 없이는 '목표 대비 실제'가 **정의 불가**. 미설정 구간은 차이 미표시.
3. SLIDE_CHANGED `{commandId, controlRevision, publicSlideKey, occurrenceSeq}`
   → **slide key 만으로는 재방문 시 dwell 계산이 틀림. occurrence 필수.**
4. TRANSCRIPT_FINALIZED `{segmentId, segmentRevision, startOffsetMs, endOffsetMs, wordCount, language}`
   → 본문 저장 없이 WPM 재계산 가능. 지연 수정은 같은 segment 의 더 높은 revision 을 새 이벤트로 append.
5. VOICE_ACTIVITY_FINALIZED `{intervalId, startOffsetMs, endOffsetMs, kind:SPEECH|SILENCE, detectorVersion}`
   → 오디오/파형/녹음 URI 없음.
6. EVIDENCE_CARD_TRANSITION `{candidateId, candidateVersion, publicCardRevision?, publicSlideKey?,
   occurrenceSeq?, fromState?, toState:CREATED|SHOWN|STALE|SUPERSEDED|DISCARDED, reason?}`
   → SHOWN offset 이 사용 시점, terminal state/reason 이 폐기 사유. excerpt/원문/내부 source 는 넣지 않음.

리포트 materialize 키: `(session, event high-water seq, algorithmVersion)` unique
+ `input_digest = hash(ordered canonical events + algorithmVersion)`.
생성은 **순수 replay**. 늦은 final transcript/새 VAD 가 append 되면 새 high-water/report version 을 만들고
이전 것만 supersede. → realtime projection 재사용 없음, 재시도 idempotent.

## 결정론적 개선 항목 (LLM 불필요)
- `TIME_DEVIATION`: target 존재 + `abs(actual-target)/target >= 20%`
- `PACE_SHIFT`: spoken duration >=20s section 에서 session weighted-median WPM 대비 `max(20 WPM, 15%)` 이상
- `LONG_SILENCE`: speech-coverage 내 3초 이상 무음 + long-silence share >=25%
  → **의도적 pause 를 '오류'로 단정하지 않음**
category 당 1개, `severity desc → TIME_DEVIATION → PACE_SHIFT → LONG_SILENCE → earliest offset` 안정 정렬,
최대 2개 노출. coverage 부족 시 후보 미생성. 카드 통계는 투명성 블록이지 코칭 점수에 섞지 않음.

## 보안/보존 (코드 근거 포함)
- 현재 store 는 presentation 전체 **현재 상태만** snapshot/restore (`prepared-evidence.ts:171-177, 204-227`)
  → 전이 이력이 없어 dwell/card history 복원 불가. **이것이 원장이 필요한 직접 근거.**
- Postgres persistence 는 snapshot revision CAS (`prepared-evidence-store-postgres.ts:44-71`)
  → 원장은 이를 **대체하지 말고 sidecar append + seq idempotency**.
- capture seam: reducer 가 SLIDE_SET 을 적용하는 성공 경계 (`prepared-evidence.ts:758-785`), 카드 lifecycle (`:1146-1149`).
- retention: `infra/migrations/private/0003_retention_cascade.sql:10-57`(session delete `:41-51`) 와
  동일 cutoff 로 FK cascade 삭제. **새 테이블에 독립 장기 보존을 만들지 말 것.**
- **RLS 는 tenant 격리만** (`0001_private_foundation.sql:81-86`) → '같은 tenant' 만으로 팀원 공개하면 요구 위반.
  owner subject 또는 명시적 session-report viewer grant 를 private backend 가 확인해야 함.
  Stage/projection API 에 report endpoint/table 절대 미노출.

## 경쟁 제품 (공식 원문 검증)
- MS Speaker Coach(PowerPoint): pace/pitch/filler/informal·euphemistic·inclusive language/wordiness/slide reading.
  Rehearsal Report 는 full-screen 종료 시 열리고 **닫으면 사라짐**.
- MS Teams Speaker Coach: 사후 report 에 total speaking time 등, **개인에게만 표시**.
  live insight 는 녹화 transcript 에 저장되지 않음 명시 → private report + raw separation 의 직접 선례.
- Orai: filler words/pace/clarity/energy + 다음 행동 한 문장. 예시 147 WPM.
  **공개 testimonial 로 실사용 확인되는 항목은 filler-word counter 뿐.**
- Yoodli: homepage 주장만 확인. **granular metric list 나 testimonial 로 확인된 단일 metric 없음
  → Orai/MS 항목을 Yoodli 사실로 확장 금지.**

## claim
- (high) 스냅샷/CAS 를 재생 리포트 입력으로 쓰면 카드·슬라이드 과거 전이와 후발 transcript 수정이 소실 → append-only 원장 필요
- (normal) LLM 없이 target deviation + session-relative pace shift + long-silence anomaly 안정 정렬로 실천 항목 생성 가능
- (normal) raw audio 즉시 폐기 + time/count/state 이벤트만 보존은 요구와 MS 의 private/non-transcript 모델과 양립
- (high) **tenant RLS 만으로 '허용된 팀원' 규칙 미충족 → per-session report authorization 필요**

## EXPAND
- LEAD: section target authoring UI/contract 위치 — frozen target 없이 '목표 대비 실제' 정의 불가
- LEAD: 팀원 authorization 의 canonical source — 현재 DB policy 는 tenant scope 뿐
