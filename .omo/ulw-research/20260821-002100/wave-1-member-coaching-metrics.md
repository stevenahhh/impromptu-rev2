# wave-1 / coaching-metrics (축 완주, 13m41s)

## 결론
생성형 모델 불필요. `audio-fusion.ts` 의 세션 시간 매핑·슬라이드 귀속 위에
(a) VAD 발성/침묵 이벤트 (b) final STT 음절 수 를 결합하면 핵심 지표 전부 결정적 계산 가능.
**단 현재 코드에 VAD 계약이 없어 `voiced/silence intervals` 계약 추가 필요.**
STT p95 700ms 는 음절 속도 보정에만, VAD 는 오디오 프레임에서 즉시 산출.
**추천/생성모델 경로와 결합 금지.**

## MEASURED — 한국어 기준값
**Lee, Shin, Yoo & Kim 2017**, 한국인 표준 음성 DB, **412명 · 4,528 발화**, 지역/성별/세대 균형
- 말 속도(pause 포함): **4.82±0.84 syll/s = 289±50 SPM**
- 조음 속도(pause 제외): **5.99±0.96 syll/s = 359±58 SPM**
- 휴지 비율: **19.5±5.9%**, pause 기준 **>=100ms**
- 청년/장년 말속도 5.45/4.24 sps, 조음속도 6.72/5.29 sps
- **지역차 유의하지 않음, 세대 효과 최대**, 성별 말속도 유의차 없음
- https://koreascience.kr/article/JAKO201713647763102.page / DOI 10.13064/ksss.2017.9.1.027

**Lee & Ko 2004**, 대학생 6명(남3/여3), 각 375문장을 느림/보통/빠름 낭독 (총 6,750문장)
- 느림 **4.21–4.80 sps = 253–288 SPM**
- 보통 **5.60–6.29 sps = 336–377 SPM**
- 빠름 **7.04–8.14 sps = 422–488 SPM**
- **논문 자체가 "절대 기준 제시는 불가능해 화자 판단으로 읽게 했다"고 명시 → 중심/범위이지 보편 경계 아님**

## DERIVED — 제품 초기 경계 (국가/임상 표준 아님)
대규모 코퍼스 평균±1SD 를 onboarding prior 로:
- **말 속도**: 느림 <239 / 보통 239–340 / 빠름 >340 SPM
- **조음 속도**: 느림 <302 / 보통 302–417 / 빠름 >417 SPM
속도조작 연구 중심(270/358/465) 의 중간점 경계 **314/411 SPM** 과 조음속도 경계가 거의 일치.
**그러나 발표·자유발화의 보편 규범이 아니므로 UI 는 숫자 + 조정 가능 구간으로 보이고 '점수'로 만들지 말 것.**

## COUNTER / 변이 (중요)
**Kim 2018 서울 자연발화 40명의 개인별 평균 조음속도 5.19–8.20 sps (312–492 SPM)** — 폭이 매우 큼.
화자·문구 길이·세대 효과가 있어 **고정 경계만으로 사람을 평가하면 오판.**

## 영어 WPM 이식이 틀리는 이유
한국어 조음속도 5.99 sps vs 미국 영어 3.40 / 네덜란드어 4.63.
원인: 영/네는 음절핵 전후 복수 자음군 허용, 한국어는 최대 한 자음.
WPM 은 언어별 tokenization/어절 길이까지 섞음 → **한국어는 Hangul 음절수/분이 더 안정적.**
혼합 영·숫자 발화는 별도 발음 음절화 없이 SPM 에 단순 합산 금지.

## 정의와 계산
- `speechRateSpm = hangulSyllables / wallClockMinutes` (pause 포함)
- `articulationRateSpm = hangulSyllables / voicedMinutes` (pause 제외)
- `pauseRatio = meaningfulPauseDuration / activePresentationDuration`
- 동일 슬라이드/논리구간 귀속 **final STT 만** 음절 수에 반영. partial 은 숫자를 흔들므로 미표시 또는 provisional 분리.

## VAD 이중 임계 (근거 있음)
1. **physical silence ratio**: >=100ms 비발성 run → 2017 한국어 기준(19.5±5.9%) 과 직접 비교 가능
2. **meaningful pause count**: >=250ms 내부 pause
   **De Jong & Bosker 2013** (L2 Dutch 51명·8과제·9h43m, 내부 pause 10,668개, 30명 90개 20초 표본/20평정자)
   20–1000ms cutoff 비교에서 **proficiency 와 pause 빈도 관계가 250–300ms 에서 최고** → 전통 250ms 권고.
   **단 perceived fluency 에는 단일 최적 cutoff 없음 (개인 최적 138–384ms 변이).**
구현: VAD 10–30ms frame → gap <100ms merge → 100–249ms 는 silence ratio 에는 포함하되 경고 pause count 에서 제외 → >=250ms meaningful pause.
**무성 폐쇄음과 STT 단어 경계 때문에 VAD 단독 이벤트를 곧바로 '망설임'으로 명명 금지.**
발표 중 video/Q&A/manual pause 는 coaching-active time 에서 제외하는 **명시 이벤트 필요.**

## 알림 정책
근거: NIST EWMA(λ 0.2–0.3, 선택은 임의적) / **Quené 2007 speech tempo JND 약 5%** /
Google SRE·Prometheus(최소 2 evaluation cycle 지속, `for` pending, grouping·dedup·inhibition, flapping 억제) /
**Stothart et al. 2015: 알림에 직접 반응하지 않아도 attention task 성능 유의하게 방해** / MS 는 live critique 한 번에 하나만.

ASSUMED 초기 정책(로그로 튜닝 필요):
5초마다 평가 / fast lane = 최근 10–15초 voiced-time EWMA(α≈0.3) / trend lane = 45–60초 또는 현재 구간 EWMA(α≈0.1) /
fast 상태 **3회 연속(≈15초)** 동일 시 candidate, fast+trend 동방향이면 우선 승인 /
**trigger-clear 간 5% hysteresis** (예: trigger >417 SPM → clear <396 SPM) /
per-type cooldown 60초, global gap 30초, **한 번에 하나만** /
우선순위: 복구 가능한 구간 시간 초과 > 지속된 빠름/느림 > 침묵비율 변화 (상위가 하위 억제) /
**silence 중 알림 금지**, 발화 재개 후 추세만 반영 /
라이브는 짧은 비모달 한 줄("조금 빠름 · 15초 지속"), 사후는 `02:10–02:42 빠른 구간 446 SPM` 같은 조절 가능한 사실. **총점/등급 금지.**

## 시간 부채 (구간 전환에서만 재계산)
`remainingBudget = totalBudget - elapsed`
`debt = max(0, Σbase_i - remainingBudget)`
`flex_i = max(0, base_i - min_i)`
debt <= Σflex → `new_i = base_i - debt*(flex_i/Σflex)`
debt > Σflex → 전부 `new_i = min_i`, 초과분은 `UNRECOVERABLE_OVERRUN`. **음수 목표 생성 금지.**
일찍 끝나면 목표를 부풀리지 않고 reserve 유지.
실행 검산: base [4,3,1], min [2,1.5,0.5], 1분 debt → [3.5,2.625,0.875] 합 7 ✓ / 큰 debt → minima + 복구불가 1분 ✓
**매초가 아니라 구간 종료/수동 점프에서만 재계산** (목표 흔들림 방지).

## 경쟁 서비스 — DURING vs POST 실증
- **MS Speaker Coach — DURING 확인**: rehearsal 하단 on-screen, 최근 몇 초 pace/filler/monotone·pitch/inclusive language/slide reading, 종료 후 pace variance. **pace 100–165 WPM 은 영어 기준. 영어 전용, 실제 청중 발표가 아니라 rehearsal.**
- **Yoodli — DURING 미확인**: 현재 AI Feedback 페이지는 'after every roleplay'. 홈페이지의 'real-time coaching' 표현과 달리 **during-speech cue 를 1차 문서로 입증 못함.**
- **Orai — POST 우세**: 현재 홈페이지는 "the moment you finish speaking" 채점.
- **Poised — DURING 확인**: private live in-meeting feedback (words most spoken/filler/confidence/energy/empathy), 앱에 live toggle. **단 slide/section time awareness 없음.**

## 제품 차별점
경쟁사는 WPM·filler·AI rubric/정서 라벨에 집중. impromptu 의 방어 가능한 차별점은
**한국어 SPM + articulation rate + silence ratio 를 분리하고, 슬라이드 시간축에 귀속하며, 3–5 논리구간 time-debt 를 재분배하는 것.**

## DEAD END
'한국어 빠름/보통/느림' 의 국가·방송 공인 단일 경계는 **찾지 못함.** 임의 숫자로 꾸미지 말고 MEASURED/DERIVED 구분 유지.
