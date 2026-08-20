---
STATUS: final — 전 섹션 완료, 적대적 검토 반영됨
생성: ulw-research 세션 20260821-002100
---

# impromptu 미구현 5개 기능 — 내부 연구 보고서

## 0. 요약

신청서가 정의한 7대 기능 중 **5개가 미구현**이고, 이 보고서는 그 5개를 이 저장소의 기존
아키텍처·보안 경계·로컬 하드웨어 제약 안에서 어떻게 구현할지 조사한 결과다. 7개 조사 축이
독립적으로 작업했고 하나의 명제를 코드 실행으로 검증했다.

가장 중요한 결과 세 가지:

1. **신청서의 5초 SLA 는 현재 구조로 지킬 수 없다.** 외부 검색·원문 fetch·근거 검증을
   동기 경로에 넣는 설계는 폐기해야 하고, 비동기 사전 준비로 분리해야 한다.
   근거는 §2. 네 개 축이 서로 다른 경로로 같은 결론에 도달했다.
2. **한국어 STT 의 발표 도메인 정확도에 대해 우리는 아는 것이 없다.** 공개된 수치는 전부
   자체 보고이거나 상용 경쟁사 평가이며, 도메인이 바뀌면 CER 이 2~8배 악화된다는 근거가 있다.
   모델 선정은 문헌으로 끝낼 수 없고 자체 벤치마크가 필요하다. 근거는 §3.
3. **코칭은 근거 있는 한국어 기준값을 확보했다.** 412명·4,528발화 코퍼스에서 말속도
   289±50 SPM, 조음속도 359±58 SPM, 침묵비율 19.5±5.9% 를 얻었고, 영어 WPM 을 쓰면
   안 되는 이유도 음절구조로 설명된다. 5개 축 중 근거가 가장 단단하다. 근거는 §7.

작업량 관점의 결론은 §10 에서 다룬다.

---

## 1. 이 보고서가 답하는 것과 답하지 못하는 것

### 답한 것
- 각 기능이 기존 코드의 **어느 file:line 에 붙는지** (§9)
- 각 기능의 **설계 결정과 그 근거** (§3~§8)
- 신청서 요구 중 **현재 코드가 충족하지 못하는 지점** (§6, §9)
- **지연 예산의 실제 상태** — 실행 측정으로 검증 (§2)

### 답하지 못한 것 (공백을 공백으로 남긴다)
- **한국어 발표 도메인의 STT 정확도 순위.** 공개 자료로는 불가능하다. §3 참조.
- **M5 Pro 에서의 한국어 E2E RTF 와 지속 발열.** 문헌에 하나도 없다.
- **한국어 검색 API 품질 순위.** Brave/Tavily/Exa/SerpAPI/Perplexity/Kagi 어디에도
  동일 query set 기반 공개·재현 가능한 한국어 벤치마크가 없다.
- **한국어 lexical 검색 4방식의 품질 순위.** 동일 corpus head-to-head 비교가 공개돼 있지 않다.
- **`slide fusion·trigger·query` 와 `Console persist·push·render` 의 실제 지연.**
  한 번도 측정된 적이 없다(문서 배정으로는 각 350ms, 250ms).

이 공백들은 전부 **자체 측정으로만 메울 수 있다.** 임의 숫자로 채우지 않았다.

---

## 2. 공통 제약: 지연 예산의 실제 상태

이 절이 나머지 모든 설계 결정을 지배한다. 5개 기능 중 4개의 결론이 여기서 나왔다.

### 2.1 제품이 약속한 예산
`docs/PWA-구현-최적화-연구보고서.md:243-251`, `docs/DEMO-SCOPE.md:45`:
확정발화(semantic-audio-end) → Console eligible render **p95 5초**.

| 단계 | 배정 p95 |
|---|---:|
| STT endpoint/final | 700ms |
| slide fusion·trigger·query | 350ms |
| 내부/외부 병렬 검색 | 800ms |
| 원문 fetch·parse | 1,200ms |
| deterministic checks·verifier | 1,100ms |
| rank·persist·push·render | 250ms |
| **합계** | **4,400ms** |

STT 를 뺀 할당은 **3,700ms**.

### 2.2 실제 측정 (MEASURED)
동일 인증 경로·loopback·순차 10회, nearest-rank percentile:

| | p50 | p95 |
|---|---:|---:|
| 클라이언트 wall-clock | 3,038.6ms | **4,164.3ms** |
| 서버 `latencyMs` | 3,037ms | 4,162ms |
| seam 밖 오버헤드 | 2.3ms | **3.4ms** |

10/10 RECOMMEND 성공. 인증·CSRF·JSON 파싱 오버헤드는 3ms 대로 **무시 가능**하다.

### 2.3 이전에 통용되던 수치의 정정
초기 측정에서 나온 "p95 4,506ms, 수율 6/10" 은 **RECOMMEND 완료 시간이 아니었다.**
파이프라인은 명목 deadline(시작+5,000ms)보다 500ms 이른 **약 4,500ms 에 guard 가 abort**
한다(`services/private-backend/src/verifier/recommendation-pipeline.ts:102-106`).
즉 그 수치는 "4.5초 걸렸다" 가 아니라 "4.5초에 잘렸다" 이다.
`4,506 + 700 = 5,206ms` 형태의 산술은 **무효**이므로 이 보고서에서 사용하지 않는다.

### 2.4 예산 대비 초과율은 계산할 수 없다 [적대적 검토에서 철회된 주장]

> **철회**: 이 보고서의 초안은 "현재 파이프라인이 배정 예산의 약 2.2배를 쓴다" 고 주장했다.
> 적대적 검토에서 무너졌으므로 철회한다.
>
> **철회 사유 1 — 이중 계상.** 800ms 는 '내부·외부 **병렬** 검색' 단계 전체의 wall-clock 상한이다.
> 이를 현재 내부 검색 예산으로 쓰면서 **동시에 '미구현 외부 검색 예산' 으로도 세면 중복**이다.
> `1,900 + 2,000 = 3,900ms > 3,700ms` 이고, fusion/query 350 + rank/render 250 = **600ms 가 빠져 있어**
> 애초에 3,700ms 의 분할이 아니다.
>
> **철회 사유 2 — 분모가 정의되지 않는다.** 문서 단계표에 **embedding·rerank·생성 LLM 항목이 없다.**
> 이들의 예산이 0 이라고도, verifier 1,100ms 에 포함된다고도 추론할 근거가 없다.
>
> **철회 사유 3 — lineage.** 4,164.3ms 만 MEASURED 이고 "2.2배" 는 임의로 고른 분모에서 나온 DERIVED 값이다.

#### 대신 말할 수 있는 것
1. `recommend()` 진입 → 최종 재인가까지의 10회 표본 p95 는 **4,164.3ms** 다. [MEASURED]
2. 이 측정에는 **STT, fusion/query, Console persist·push·render, 외부 search·fetch 가 전부 빠져 있다.**
3. 단계표에 rerank·생성 LLM 의 귀속이 정의되지 않아 **"배정 예산의 N배" 를 산출할 수 없다.**
4. 현 코드의 외부 분기는 **내부 materialization 뒤에서** 검색·fetch 한다
   (`recommendation-pipeline.ts:187-207`). 그대로 활성화하면 **critical path 가 늘어난다.**
5. 기존 inference 단계들은 **단계별 budget 없이 shared deadline 을 소진**한다.

#### 따라서 (약화된 결론)
**외부 근거는 초기 Console 표시의 blocking dependency 가 되어서는 안 된다.**
cutoff 가 있는 prefetch·병렬·progressive 경로로 분리한 뒤 **전체 E2E p95 로 재검증**한다.

> 단 초안이 주장한 **"동기 경로에 절대 불가능" 은 과장**이다.
> partial transcript prefetch 나 cutoff 있는 bounded 병렬 race 는 근거상 배제되지 않았다.

이것이 §5(외부 검색), §6(rerank 배제), §8(리포트 비동기)의 공통 근거다.

### 2.5 수율 문제는 STT 와 무관하다
초기 표본의 DEADLINE_EXCEEDED 4회를 구조화 로그로 분해한 결과:

| 회차 | 걸린 단계 | 상세 |
|---:|---|---|
| 5 | rerank | LLM 1,487ms 성공, rerank 4,284ms 에서 cancelled |
| 6 | rerank | LLM 3,673ms 성공, rerank 4,272ms 에서 cancelled |
| 7 | verifier | rerank 3,775ms·LLM 1,210ms 성공 후 verifier 506ms 에서 cancelled |
| 9 | LLM | rerank 798ms 성공, LLM 4,324ms 에서 cancelled |

분포 rerank 2 / LLM 1 / verifier 1. **특정 단계의 결함이 아니라 chat provider 의 tail latency
가 임의 슬롯에 떨어지는 현상**이다. 파이프라인은 단계별 budget 없이 **하나의 deadline 을 공유**
한다(`services/model-router/src/deadline.ts:17-19,42-46`).

→ 대응은 STT 예산 축소가 아니라 **슬롯별 budget 분할** 또는 **공급자 교체**다.

### 2.6 측정되지 않은 구간 (공백)
`slide fusion·trigger·query`(배정 350ms)와 `Console persist·push·render`(배정 250ms)는
**한 번도 측정된 적이 없다.** 실제 end-to-end p95 는 4,164ms 보다 크며 그 차이는 미지수다.

---

## 3. 축 A — 로컬 한국어 STT

### 3.1 핵심 결론 [적대적 검토에서 **방어됨**]
**공개 근거만으로는 한국어 실시간 발표 환경의 후보별 CER/WER, 구간 누락률,
숫자·고유명사 정확도, 한영 code-switch 오류율, 그리고 정확도 순위를 결정할 수 없다.**

정확도 순위를 **보류**하고, 대신 **latency·streaming 지원·license 같은 운영 적합성만으로 후보를 좁힌 뒤**
실제 발표 녹음을 **동일한 VAD·streaming·정규화 조건에서 blind bake-off** 하여 선택한다.

> 단 "전혀 모른다" 로 확대하면 안 된다. 정확한 수치와 순위는 모르지만
> **한국어 outlier·도메인 이동·VAD 누락·code-switch 가 위험 축이라는 방향성은 안다.**
> 기존 benchmark 와 사용자 이슈는 **기대 정확도나 발생률이 아니라 위험 신호·acceptance test 사례로만** 쓴다.

### 3.2 배제 확정
| 모델 | 배제 사유 |
|---|---|
| NVIDIA Parakeet TDT v3 | 'multilingual' 표기와 달리 **25개 유럽 언어 전용**, 한국어 미지원 |
| NVIDIA Canary Flash/V2 | 4개 / 25개 유럽 언어. 한국어 미지원. NeMo 가 CUDA 중심이라 Apple 부적합 |
| distil-whisper large-v3 | 공식 카드가 **'English series'** 명시 |
| MMS-1B-all / SeamlessM4T-v2 | **CC-BY-NC-4.0 (비상업)**. 크기·발열도 과함 |
| SNU / ETRI | 공개 weight 없음. ETRI 는 API 평가만 존재 |

Parakeet 은 macOS 커뮤니티 평판이 매우 좋지만 **그 평판은 유럽어 것이다.**
r/LocalLLaMA 의 장기 사용 후기도 중/일/한에는 맞지 않는다고 명시한다.
벤치마크 halo 를 한국어로 전이하면 안 된다.

### 3.3 정확도 근거의 실제 상태
| 출처 | 수치 | lineage |
|---|---|---|
| ghost613/whisper-large-v3-turbo-korean | Zeroth WER 4.89% / CER 2.06% | **SELF-REPORTED**, 동일 도메인 분할 |
| kresnik/wav2vec2-large-xlsr-korean | Zeroth WER 4.74% / CER 1.78% | **SELF-REPORTED** |
| 리턴제로 AI-Hub 7세트 × 3,000문장 | Whisper 평균 CER **11.39%** (저음질 전화 17.27%) | **3rd-party, 단 평가자가 상용 경쟁사이고 Whisper 체크포인트 미명시** |
| 같은 평가 | 리턴제로 상용 5.91 / Naver 7.52 / ETRI 10.19 | 동상 |
| Whisper 원 논문 | 한국어를 FLEURS 추세 대비 **최대 outlier 중 하나로 자인** | **PRIMARY** |
| large-v3 / v3-turbo 공식 카드 | **한국어별 수치 없음** | — |

**한국어 특화 fine-tune 이 기존 XLS-R 보다 우월하지도 않다**(CER 2.06 vs 1.78, 동일 Zeroth).

> **[서술 정정]** 초안은 "도메인 이동 시 2~8배 악화" 라고 썼다. **철회한다.**
> Zeroth 2.06% 와 AI-Hub 6~17% 는 **서로 다른 평가 harness·정규화·체크포인트**의 값이므로
> 나눠서 배수를 내는 것은 **통제된 비교가 아니다.**
> 말할 수 있는 것은 **"read-speech in-domain self-report 를 발표 환경 기대값으로 쓸 근거가 없다"** 까지다.

### 3.4 벤치마크가 보여주지 않는 실사용 결함
faster-whisper GitHub 이슈 (한국어 한정):
- **#934** VAD v5 가 v4 보다 발화 대량 누락 — 자막 320줄 → 218줄, 재현 보고
- **#254** large-v2 한국어 뉴스에서 인터뷰 게스트 구간 **40초 이상 통째 누락**
- **#1356** 한국어 hotwords 투입 시 **무음에서도 해당 단어 반복 환각**
- **#918** 언어 자동감지가 영/중/한/이 섞여 나옴
- openai/whisper **#2004** 한국인 억양 영어를 **한국어로 오감지**

> **[사용법 제한]** 위 이슈들은 **개별 사용자 보고**이므로 발생률이나 일반 성능으로 일반화할 수 없다.
> **acceptance test 사례로만** 사용한다 — 즉 "이 현상이 우리 코퍼스에서 재현되는가" 를 묻는 체크리스트다.

발표 시나리오 함의: `auto` 는 언어 혼입, `language=ko` 는 영어 전문용어 손실.
슬라이드 용어를 hotword 로 넣는 것은 정확도 레버이자 환각 위험이므로
**VAD 이후에만 bias 하고 silence fixture 를 release gate 로 둔다.**

### 3.5 한국어 평가 방법론 (선행 결정 사항)
- 교착어·조사·모호한 띄어쓰기 때문에 **WER 이 아니라 CER 을 쓴다.**
  예: '학교에'→'학교' 는 WER 25% 지만 CER 6.7%.
- 숫자·영문 이중 전사 정규화가 점수를 크게 바꾼다:
  `(7시)/(일곱시)`, `(16%)/(십육프로)`, `(ARS)/(에이 알 에스)`.
  → **정규화 정책 없이 WER/CER 을 비교하면 무의미하다. UI 출력 규약(ITN)을 먼저 고정한다.**

### 3.6 권장 bakeoff (M5 Pro, 발열 민감)
| | 후보 | 역할 |
|---|---|---|
| A | whisper.cpp large-v3-turbo Q5 + CoreML encoder + Metal decoder | **통합 기준선.** Apple first-class, M1 Pro encoder CoreML >3x CPU (MEASURED) |
| B | WhisperKit compressed turbo (0.6GB) | **700ms 예산·지속 발열 우승 가능성 최고.** M3 Max ANE encoder 602→218ms, mean interim latency 0.46s (MEASURED). 진짜 partial/confirmation streaming |
| C | SenseVoiceSmall ONNX int8 (234M) | 저전력 challenger. **weights 가 FunASR custom license → 상용 배포 확인 필수** |
| D | Qwen3-ASR-0.6B | 정확도 challenger. **공식 streaming 이 vLLM+FA2 라 macOS 부적합 → 기본값 후보 아님** |

측정 항목: ko CER / en-token recall / 고유명사 recall / 숫자 exact-match /
**분당 silence hallucination** / partial→final p95 / RTF / peak RSS /
**30분 지속 package power·thermal pressure**

> **[MEASURED 공백]** 문헌에 M5 Pro 한국어 E2E RTF 가 하나도 없다. 자체 측정 없이 발열 결론 불가.

---

## 4. 축 B — 스트리밍 STT 구조

### 4.1 좋은 소식: 배관은 이미 있다
`services/model-router/src/registry.ts:203-239,257-279` 에 isolated streaming 등록 경로가
이미 분리돼 있다. **router 재설계는 불필요하고 production module 등록만 하면 된다.**

### 4.2 나쁜 소식: 계약이 다중 발화를 표현하지 못한다
현재 canonical event 는 `{kind:"partial"|"final", sequence, transcript:{text,language,durationMs}}`
가 전부다(`services/model-router/src/stt.ts:25-56`). **없는 것:**
- `utteranceId` — 어느 발화인지
- `replacesRevision` — 무엇을 교체하는지 (`sequence` 는 단순 번호이며 replacement 범위 의미가 없다)
- `audioStartDeviceMs` / `audioEndDeviceMs` — 시간축 귀속에 필요
- word timing — 코칭의 음절 계수에 필요

대조: AWS Transcribe 는 `ResultId`/`StartTime`/`EndTime`/`IsPartial`,
OpenAI realtime 은 `item_id` + `delta`/`completed` 로 발화 identity 를 제공한다.

추가 구조 문제:
- router 는 여러 final 을 yield 할 수 있어도 **마지막 final 하나만** terminal output 으로 삼고,
  **모든 transcript event 를 버퍼링했다가 terminal 성공일 때만 방출**한다
  (`router.ts:416,465,517-521`). 실시간 partial 즉시 소비 구조가 아니다.
- `RouterBackedAudioSttPort` 는 **모든 partial 을 버리고 complete 만 반환**한다
  (`services/private-backend/src/audio-capture.ts:7-59`).
- streaming chunk 에 **encoding/sampleRate/channel 이 없다**(unary input 에만 있음, `stt.ts:16-23`).

### 4.3 최소 계약 확장
stream-local `utteranceId` + `revision` + `replacesRevision?` + `audioStart/EndDeviceMs` 를 추가하고,
**각 final 마다 immutable `transcriptFinalId` 를 발급**해 downstream 으로 즉시 전달한다.
terminal `complete` 는 세션 성공/실패 receipt 이지 "유일한 발화" 가 아니어야 한다.

### 4.4 partial/final 의 물리적 분리 (신청서 5항 요구)
- `partial` → private caption + **TTL 검색 prefetch namespace** 로만
- `final` → `transcriptFinalId` → audio-fusion → retrieval/verifier → candidate

partial revision 은 append 가 아니라 **current hypothesis 의 replace/upsert** 다.
LocalAgreement-n 도 연속 업데이트의 공통 prefix 만 commit 한다.
**partial cache/key 는 publication pipeline 타입이 수용하지 않도록 한다.**
OpenAI 가 turn completion ordering 비보장을 명시하므로 out-of-order final 도
item/utterance id 로 reconcile 한다.

### 4.5 브라우저 → 서버 오디오 경로
권장: **AudioWorklet 채널 downmix + resample + PCM s16le 고정 → 50ms 패킷 → private WSS
→ bounded queue → server endpointing → revision reconciler**

- 16kHz mono s16le = 32KB/s, 50ms = 1.6KB. AWS 권고 uniform PCM 50-200ms.
- Worklet render quantum 128 Float32 는 향후 변경 가능(MDN 경고) →
  **array length 를 읽고 별도 accumulator 에서 packetize.**
- 브라우저 WebSocket 에 자동 backpressure 가 없다 → `bufferedAmount` high-water mark +
  서버 30초 queue 보다 훨씬 작은 **1~2초 hard cap 에서 fail-closed**.
  **audio replay/retry 금지**, sequence gap 이면 stream 재시작 또는 abstain.
- SSE 는 downstream 전용이라 audio upstream 에 부적합. HTTP receipt fallback 은
  stop/cancel terminal receipt 에만 쓰고 raw audio 재전송에는 쓰지 않는다.
- **MediaRecorder 는 fallback.** `timeslice` 가 부정확하고 "significantly larger chunks" 가
  발생할 수 있으며(MDN), 현재 chunk schema 에 encoding 정보가 없어 blob 을 그대로 넣으면
  adapter 가 해석할 수 없다.

### 4.6 endpointing 예산
제품 배정은 endpoint/final **p95 700ms**.
- Deepgram endpointing default **10ms**(문서 예시 300/500ms), **UtteranceEnd min/default 1000ms**
  → **1000ms 는 구조적으로 예산 밖**
- Silero V5 ONNX 는 31.25ms chunk 를 189µs 처리 → VAD 자체는 병목이 아님
- Whisper-Streaming 논문은 long-form latency 3.3s → 이 예산에 부적합

권장 시작점 **50ms 패킷 + 300~400ms endpoint silence**, 남은 250~350ms 에 provider final/network.
> **[ASSUMED]** 이것은 벤더 보장이 아니라 **한국어 발표 코퍼스로 p95 를 통과시켜야 할 tuning hypothesis** 다.
> Silero 기본값(threshold .5, min_silence 100ms, speech pad 30ms)을 제품 endpoint 로 복사하지 말 것.
> client VAD 는 bandwidth 최적화일 뿐 final authority 는 server/provider event 다.

### 4.7 원본 음성 무보존 (신청서 약속)
"DB 에 안 씀" 으로 불충분하다. **vendor retention 설정까지 배포 게이트**다.
- Azure: realtime audio 를 메모리에서만 처리, at-rest 저장 안 함 명시
- Google STT: 기본 audio/transcript logging off
- **AWS: service improvement 목적 content 저장 가능 → Organizations opt-out 정책 필수**

이미 잘 되어 있는 것: 명시 동의/단기 grant, frame 소유권 복사, bounded in-memory queue,
stop/revoke/logout/session end/cancel 에서 clear+AbortSignal, track stop 테스트
(`audio-capture.ts:193-233,286-305,323-381`).

필요한 것: raw audio 를 파일/object store/DB/queue/DLQ/APM body/log/crash dump 에 절대 쓰지 않음,
reverse proxy access log 에서 body·query token 제외, memory-only ring buffer,
provider socket write 후 reference 해제, partial TTL,
모든 terminal path 에서 browser track/worklet/socket/server queue/provider stream 을 **순서 무관 idempotent close**.

deletion receipt 에는 raw audio 가 아니라 captureGrantId/session epoch, local buffer cleared,
provider stream closed, vendor retention policy/version, timestamp 를 남긴다.
**secure zeroization 을 주장하지 말고** "no durable persistence + references released +
vendor no-retention configuration" 으로 정확히 표현한다.

---

## 5. 축 C — 외부 근거 검색

### 5.1 핵심 결론
**동기 5초 경로에 넣을 수 없다.** §2.4 참조. 비동기 prepared-evidence 잡으로 분리한다.

### 5.2 후보 비교 (공식 원문 기준, 2026-08-20)
| 후보 | 가격 | 원문 반환 | 한국어 제어 | 판단 |
|---|---|---|---|---|
| **Perplexity** | $5/1k, 50 q/s | ✓ page content, 토큰 제어 | ISO country + `search_language_filter` | **PoC 1순위** — API ToS §2.3.1~2.3.3 이 **고객 Output 소유·비훈련 명시** |
| Brave | $5/1k, 50 rps | ✗ snippet/LLM context | 한국 로컬 검색 있음(API 파라미터 미확보) | 후보 discovery 최저비용. **단 ToS §3.2 가 Search Results 영구저장 금지** |
| SerpAPI | $25/1k~ | ✗ SERP only | **가장 명시적**: `gl=kr`, `hl=ko`, `lr=lang_ko`, domain/location | 한국어 recall **비교 baseline** |
| Tavily | basic $8/1k, advanced $16/1k | ✓ `include_raw_content` | country boost(필터 아님) | ToS §6.5/§9.2 가 Input/Output retain·train 허용 |
| Exa | search $7/1k + pages $1/1k | ✓ full text/highlights | country 만 | **ToS §4.2(a) download/copy 금지 + §1.2(c) 영구 라이선스 → 계약 리스크 최대** |
| Kagi | search $12/1k + extract $4/1k | ✓ full markdown | ISO region/language | timeout 0.5~4s **+** page extraction 0.5~4s **additive** |
| Google CSE | — | — | — | **신규 가입 불가, 2027-01-01 종료** |
| Bing Search API | — | — | — | **2025-08-11 완전 종료** |
| DuckDuckGo | — | — | — | Instant Answer 는 일반 SERP API 아님 |

### 5.3 약관이 설계를 결정한다
**검색 응답 자체를 저장하면 안 된다.** Brave ToS §3.2 는 Search Results 의 store/cache/DB화를
Customer Application 운영에 필요한 transient storage 외에 금지하고 종료 시 영구 삭제를 요구한다.
Exa §4.2(a) 는 더 넓다.

→ **유일하게 안전한 구조**: 검색 응답은 **transient discovery 로만** 사용하고,
후보 URL 을 즉시 내부 `SafeExternalEvidenceFetcher` 로 넘겨 **origin 에서 다시 가져온 bytes 만**
근거로 저장한다. 이것은 이미 코드가 하는 방식이며(`external-fetch.ts` 는 fetched bytes 만 evidence 로 씀),
보안 불변식(pinned HTTPS, redirect 마다 DNS 재검증, public IP 만)도 자체 fetcher 가 더 강하다.
> 단 **후보 URL 자체를 영구 저장할 권리**는 공개약관에서 불명확하므로 계약 carve-out 이 필요하다.

### 5.4 LLM 의 역할 제한 (신청서 7항 요구의 구현)
closed schema 로 **`claimText`, `claimType`, `query`, `asOf`, `entities`,
`numericTokens[{text, utteranceStart, utteranceEnd}]` 만** 출력하게 한다.
**`slideId`/URL/`userId`/permission/`sourceTier` 필드는 스키마에 아예 두지 않는다.**
숫자는 확정발화 substring + offset 검증에 실패하면 **output 전체를 reject** 한다.
URL 은 검색 provider 가 만들고 권한은 서버 컨텍스트가 결합한다.

### 5.5 1차 자료 우선 랭킹 (결정론적)
LLM 점수가 아니라 **기관 registry + claim type + as-of 날짜의 lexicographic 정렬**로 구현한다.
- 도메인 registry 를 코드/데이터로 버전관리: exact host/eTLD+1, 기관 ID, authority topics,
  tier, license defaults, validFrom/To. **`.go.kr` 은 정부 tier 가능하나 `.re.kr`/`.ac.kr`/`.or.kr` 은
  suffix 만으로 1차자료 판정 금지** — 명시 allowlist. redirect 최종 host 기준 재판정.
- claim-type 적합성: 통계 → KOSIS/data.go.kr 원 데이터 > 정부 통계표 > 보도자료 /
  법·정책 → 법령·고시 원문 > 보도자료 / 기술 → 표준·vendor docs > 블로그 /
  연구 → 논문 원문·DOI > 기관 요약 > 2차 기사
- 랭킹 전 hard filter: https/SSRF 통과, license 허용, `effectiveAt <= asOf`,
  claim slot coverage, entailment pass
- 정렬 tuple: `(sourceTier, claimTypeMatch, effectiveDateDistance, publicationDateConfidence,
  quantizedRetrievalScore, orgDiversityPenalty, canonicalUrl)` — 가중합보다 tie-break 가 명시적·재현 가능
- **날짜 4종 분리 저장**: `dataEffectiveAt`(KOSIS PRD_DE) / `publishedAt`(schema.org datePublished) /
  `modifiedAt`(dateModified·HTTP Last-Modified) / `retrievedAt`.
  **Last-Modified 는 HTTP validator 이므로 발표·데이터 기준일로 승격 금지.**
- 다양성: 동일 기관 최대 2개, high-risk claim 은 독립 2기관.
  단 공식 single-source-of-truth(특정 KOSIS 표)는 canonical table 1개 우선 + single-source exception 기록.

### 5.6 한국 1차 자료 경로 (실제 확인됨)
- **KOSIS**: `statisticsList.do` → `Param/statisticsParameterData.do` 또는 `statisticsData.do`, JSON/SDMX.
  응답의 **ORG_ID/TBL_ID/TBL_NM, 분류 C1~C8, ITM_ID/NM, UNIT_ID/NM, PRD_SE, PRD_DE(수록시점),
  DT(값), LST_CHN_DE(최종수정일)** tuple 을 그대로 evidence 위치로 저장한다.
  **HTML table 추출 금지** — API 가 provenance 를 직접 준다.
- **data.go.kr**: 카탈로그 검색 → dataset 별 OpenAPI 활용신청 → 제공기관 endpoint.
- **KISTI ScienceON**: portal 에 16개 OpenAPI 등록. 과거 gateway URL 은 redirect drift →
  **portal 등록을 canonical discovery 로.**
- **RISS**: portal 에 학술논문/학위논문 OpenAPI 1건. riss.kr 직접 URL 은 404.
  **서지 API 는 원문 재배포권이 아니다.**

**라이선스를 근거 단위로 저장해야 한다.** '정부 사이트라 자유 저장' 이 아니다.
공공누리 0~4 유형(0=출처조건 없음·상업·변형 가능 … 4=비상업+변경금지)과 제3자 권리를
`licenseType`/`attribution`/`commercialAllowed`/`derivativesAllowed` 로 레코드화한다.
→ **unknown 이면 private-only, 공개 projection 금지.**

### 5.7 원문 근거 구간 추출
1. fetch 직후 provider title/snippet 폐기. 원문 전체는 **ephemeral** 처리,
   `finalUrl`·fetch headers·`retrievedAt`·content hash·**채택된 짧은 quote 만** 저장.
2. DOM→본문: **Trafilatura** `favor_precision=True, include_tables=True, with_metadata=True` 1차
   (2023 empirical comparison 에서 단일 도구 ROUGE-LSum mean F1 최고),
   **Mozilla Readability** 를 article fallback(DOM clone 필요 — 파서가 DOM 을 변경).
3. **안정 위치**: DOM preorder 각 block 에 `blockId = hash(section heading + normalized text)` 부여,
   문장 경계 분할. quote 는 `blockId`, block 내 start/end char, DOM path, section heading,
   exact text, normalized text hash 저장.
   **페이지 전체 offset 만 저장하면 광고/헤더 변경에 취약하다.**
4. 주장 정렬: (a) 숫자·날짜·고유명사 hard constraint → (b) BM25+embedding block recall →
   (c) cross-encoder/NLI entailment 검증 → (d) claim 의 모든 slot 을 덮는 **최소 연속 1~3문장** 선택.
   neutral/contradiction 또는 숫자·단위 불일치는 reject. (ALCE 는 citation correctness/completeness 를
   분리 평가, RARR 는 attribution 검색 후 unsupported text 수정)
5. **표**: WHATWG table processing 처럼 rowspan/colspan 을 논리 grid 로 펼친 뒤 값 셀마다
   row headers, column headers, caption, unit, footnotes, `rowIndex/columnIndex`, cell DOM path 저장.
   **단일 숫자 quote 가 아니라 `(caption, headers, value, unit, period, footnote)` tuple 이 evidence 다.**

### 5.8 지금 코드에서 막혀 있는 것
`ExternalSearchBoundary` 가 `main.ts` 에서 주입되지 않아
**`recommendation-pipeline.ts:187-207` 의 외부 분기가 프로덕션에서 도달 불가**하다.
또한 fetched external evidence 의 rights 가 항상 `UNKNOWN`(`external-fetch.ts:271`)이고
publication gate 는 `APPROVED` 만 허용(`recommendation-pipeline.ts:119-124`)하므로
**외부 근거는 현재 공개가 fail-closed 다.** 이것이 의도인지 미완성인지는 제품 결정 사항이다.

---

## 6. 축 D — 하이브리드 RAG

### 6.1 핵심 결론 [적대적 검토에서 **약화됨** — 대상 재정의]

> **규모 논증이 실패했다.** 초안은 "슬라이드 덱 하나가 청크 수십 개" 규모를 근거로
> lexical 인덱스가 과설계일 수 있다고 봤다. 그러나 **신청서가 말한 내부 RAG 대상은 슬라이드가 아니라
> 선택된 팀 문서(README·API 명세·회의록·기획서)** 다. 이 전제가 무효화된다.
> 이질적 팀 문서의 **API 경로·식별자·버전·고유명사는 lexical 신호의 타당한 근거**다.
>
> **그러나 "필요" 가 측정된 사실은 아니다.** 실제 corpus 크기와 relevance lift 가 없다.
> "lexical 신호가 유용할 수 있다" 와 "지금부터 형태소 분석기를 운영해야 한다" 는 **별개 주장**이다.

**채택**: 내부 RAG 의 검색 단위는 덱이 아니라 **ACL 과 current revision 이 확인된 팀 문서 corpus** 다.
동일 authorized candidate 집합에서 exact dense 와 **코드·API 식별자를 보존하는 versioned lexical branch** 를
실행하고, 우선 **표준 `tsvector` + GIN + RRF** 로 결합한다.
실제 질문 40~100개로 **dense-only / lexical-only / hybrid 를 비교해 Kiwi 채택과 가중치를 결정**한다.
**ANN 은 candidate 수와 p95 가 임계치를 넘을 때만** 도입한다.
→ **단계적 hybrid, 구현 노력 Medium.**

### 6.2 신청서 7항 미충족 지점 (코드로 확인)
현재 chunk 에 **없는 것**: 사용자/그룹 ACL, 원문 heading/page/line/JSON Pointer,
authored/modified/indexed 시각, 원문 경로.
**`source_revision` 에 실제 문서 revision 이 아니라 chunk content SHA-256 이 들어간다.**
`title` 은 `Slide N`, `anchor` 는 `slide=N&chunk=M` 뿐이다.

좋은 기반: ACL-first 순서는 이미 올바르다 —
principal resolve → prepare access check → prefilter/current → authorized ID 제한 검색 →
tenant/deck/manifest/auth-version 검증 → metadata/rights/PII → **materialize 직전 재인가** →
bytes read → SHA-256 검증 → **publication 직전 재인가**.

### 6.3 pgvector 는 지금 과설계 (MEASURED)
동형 벤치(768d): **50행 p50 0.57ms / 500행 4.78ms / 5,000행 47.6ms**
(payload 각 0.293 / 2.93 / 29.3 MiB). 수십 chunk/덱 규모에서는 embedding·LLM·network 보다 훨씬 작다.

**도입 조건**: authorized candidate 수 / DB bytes / search p95 를 계측하고
**수천 candidate/query 또는 payload·코사인이 실제 예산을 침범할 때.**

도입 경로: `CREATE EXTENSION vector`; `double precision[]`→`vector(768)` cast 는 pgvector 공식 지원.
운영 데이터는 새 컬럼 → batch backfill → 차원·finite 검증 → dual-read 비교 → swap.
**첫 단계는 ANN 이 아니라 exact `ORDER BY embedding <=> q LIMIT k`.**

> **중요 반증**: pgvector 공식 문서가 ANN 에서 `WHERE` filter 가 index scan **뒤** 적용되어
> 결과 부족/recall 저하가 생기고, multi-tenant 공유 ANN 에서 타 tenant 벡터가 recall/speed 에
> 영향을 준다고 명시한다. **"권한을 검색 전에 적용" 을 엄격히 지키려면 임의 사용자·그룹 ACL 에서
> global HNSW 를 성급히 쓰면 안 된다.**

### 6.4 한국어 lexical 선택 (2026-08-20 유지보수 상태 확인)
| 선택지 | 유지보수 | 라이선스 | 판단 |
|---|---|---|---|
| **Kiwi/kiwipiepy 외부 토크나이징 + tsvector** | **2026-08 활발** | LGPL 2.1-or-later | **추천** — DB 에는 표준 tsvector+GIN 만 |
| pg_bigm | 2026-08-04 커밋, PG19 지원 | PostgreSQL | DB-only 최간단 대안. 조사·어미 구분 없음, index bloat |
| PGroonga | 2026-08-20 커밋 | PGroonga PG / Groonga LGPL2.1 | 기능 최강이나 **Alpine 이 가장 복잡 → 운영 과중** |
| textsearch_ko + mecab-ko | **핵심 코드 커밋 2016** | BSD-2 + MeCab tri-license | **신규 채택 비추천** |
| pg_trgm / 앱 ngram | core | PostgreSQL | baseline / A-B 비교용 |

현 DB 는 `postgres:17-alpine` 그대로이고 custom Dockerfile 이 없다.
**pg_bigm / PGroonga / textsearch_ko 를 넣는 순간 DB 이미지 소유·빌드·패치 책임이 새로 생긴다.**

> **[서술 정정]** 초안은 이 부담이 Kiwi 안에도 적용되는 것처럼 읽혔다.
> **Kiwi 안은 앱 레벨 토크나이징이고 DB 에는 표준 `tsvector`+GIN 만 쓰므로
> custom PostgreSQL 이미지를 요구하지 않는다.** 이것이 Kiwi 안의 핵심 장점이다.

권장 구조: ingestion 이 visible OOXML text 에서 Kiwi 표제어/주요품사 lexeme + 2-gram 보조 lexeme 생성,
tokenizer/model/dict version 저장 → PG17 공식 `array_to_tsvector(text[])` + GIN → query 도 동일 Kiwi 버전.
**원문 canonical text 는 보존하고 정규화 텍스트·lexeme 는 별도 필드에 둔다**
(Kiwi 띄어쓰기 보정이 원문을 덮으면 인용 무결성이 깨진다).

### 6.5 융합
- **라벨 0인 현재: RRF `Σ 1/(k+rank)`, k=60 시작점.** scale 보정 불필요, 감사 쉬움.
- 라벨 40~100 확보 후: `ts_rank_cd` 와 cosine 을 query 별 정규화한 convex weighted sum 튜닝.
  Bruch et al. 2023(TOIS, arXiv:2210.11934)은 CC 가 in/out-of-domain 에서 RRF 를 능가하고
  RRF 도 parameter-sensitive 라고 보고. Elastic 재현은 약 40 annotated query 로 RRF 를 이겼다고 보고.
- learned fusion 은 그 이후. 수십 chunk + 라벨 0 에서는 누수·과적합이 이득보다 크다.
- **두 branch 는 동일 materialized `authorized_current_chunks` 에서 시작하고,
  fusion/rerank 뒤가 아니라 branch 실행 전에 ACL·revision·hash 확인 불가 행을 제외한다.**

### 6.6 reranking
`BAAI/bge-reranker-v2-m3`: Apache-2.0, XLM-R 24층, FP32 **2.27GB**.
model card 의 "lightweight" 문구와 달리 실시간 경로에서 공짜가 아니다.
적용 시 RRF top 10~20, 최대 512 tokens, batch, **private/local process 로만**,
한국어 덱 eval + cold/warm p50·p95 통과 후 **opt-in**.
**원격 LLM rerank 는 배제** — §2.5 의 tail 실측 + authorized private chunk 를 외부 모델로 보내는 정책 문제.

### 6.7 청킹 (현재 2,000자 무조건 절단 → 계층형)
- **parent = slide**: 제목·page·deck heading·source·revision·hash·path 보존. 슬라이드 경계 넘어 합치지 않음.
- **child = shape/불릿 그룹/표 행 묶음**: 희소 슬라이드는 1 child, 밀집은 제목을 각 child 에 prefix,
  의미 경계 기준 **80~250 tokens**. oversized 요소만 문장 경계 + 작은 overlap 절단.
- child 로 retrieval → **parent slide(+필요시 앞뒤 1 slide)로 generation context 확장.**
- title/shape/page boundary 우선, 일반 sliding window 는 최후 수단.
- Azure 의 512-token/25% overlap 은 generic 시작점이지 짧은 slide 에 그대로 쓸 값이 아니다.

### 6.8 SVG 텍스트 품질 — 근본 해결은 OOXML sidecar
현재 `extractSvgText()` 는 **XML 파서가 아니라 regex** 다. 태그 제거 후 `&lt;...&gt;` 를 디코드하므로
**escaped `<date/time>` 같은 sentinel 이 태그 제거 단계를 우회**한다.
(최근 문자열 제거 수정은 증상 대응이었고 근본 원인은 남아 있다)

**root fix**: ingestion 은 이미 PPTX slide XML 과 SVG 를 동시에 읽고 shape id/center 를 `map_slide()` 에서
대응시킨다. 검색 시 SVG 를 다시 긁지 말고 **ingestion 에서 visible OOXML text 를 shape id·좌표·
placeholder type 과 함께 private `retrieval.json` sidecar 로 생성**한다.
그러면 package path(`ppt/slides/slideN.xml`), shape id 기반 JSON Pointer, page, heading,
text run/line, source hash 를 직접 보존하고 **DateTime/Footer/PageNumber 를 OOXML placeholder type 으로
제거**할 수 있다.

단기 SVG extractor 를 유지한다면: bounded XML parser(DOCTYPE/ENTITY 거부) →
`Page` 아래 `<text>/<tspan>` 만 수집하고 DateTime/Footer/PageNumber/Header class 제외
(프로젝트 `render/source.py` 에 동일 ignore set 이 이미 있음) →
inherited transform + x/y/dx/dy + font size + writing mode 계산,
mapped shape 내부 DOM 순서 우선, shape 간에는 title first → column segmentation → y-baseline cluster → x
(**단순 전역 y/x 정렬은 2단 layout 을 섞는다**) → Unicode NFC, NBSP/zero-width 정리 →
**Hangul 사이 모든 공백을 지우지 말고** 같은 glyph run 에서 whitespace node 없이 geometry 가 연속인
fragment 만 결합 → escaped sentinel 은 **decode 후** exact token allowlist 로 제거.

> PDF 입력에는 OOXML 이 없다. PyMuPDF blocks/spans 좌표·page/line anchor 로 별도 sidecar 가 필요하다.
> **이것이 현재 PDF 업로드 사용자가 근거 검색을 전혀 못 쓰는 근본 원인이다.**

---

## 7. 축 E — 실시간 코칭

### 7.1 핵심 결론
**생성형 모델 불필요.** `audio-fusion.ts` 의 세션 시간 매핑·슬라이드 귀속 위에
(a) VAD 발성/침묵 이벤트 (b) final STT 음절 수를 결합하면 모든 핵심 지표를 결정적으로 계산할 수 있다.
**추천/생성모델 경로와 절대 결합하지 않는다.**

### 7.2 한국어 기준값 [MEASURED]
**Lee, Shin, Yoo & Kim 2017** — 한국인 표준 음성 DB, **412명 · 4,528 발화**, 지역/성별/세대 균형
| 지표 | 값 |
|---|---|
| 말 속도 (pause 포함) | **4.82 ± 0.84 syll/s = 289 ± 50 SPM** |
| 조음 속도 (pause 제외) | **5.99 ± 0.96 syll/s = 359 ± 58 SPM** |
| 휴지 비율 | **19.5 ± 5.9%** |
| pause 기준 | **>= 100ms** |
| 청년/장년 말속도 | 5.45 / 4.24 sps |
지역차는 유의하지 않았고 **세대 효과가 가장 컸다.**

**Lee & Ko 2004** — 대학생 6명, 각 375문장을 느림/보통/빠름 낭독(총 6,750문장)
느림 **4.21–4.80 sps (253–288 SPM)** / 보통 **5.60–6.29 (336–377)** / 빠름 **7.04–8.14 (422–488)**
> 논문 자체가 "절대 기준 제시는 불가능해 화자 판단으로 읽게 했다" 고 명시. **중심·범위이지 보편 경계가 아니다.**

### 7.3 참고 대역 [DERIVED — 임계값이 아님. 적대적 검토에서 하향 조정됨]
대규모 코퍼스 평균±1SD 로 얻은 값:
- **말 속도**: <239 / 239–340 / >340 SPM
- **조음 속도**: <302 / 302–417 / >417 SPM

> ### 적대적 검토 결과 — 이것을 '코칭 임계값'이라고 부를 수 없다
> **1. 경계가 성과 기준이 아니라 표본 분포의 재명명이다.**
> 제안 경계 폭은 `417 - 302 = 115 SPM` 이고, 조음속도의 실제 SD 57.6 에 대한 ±1SD 폭은 **115.2** 로
> 사실상 동일하다. 평균 359 에서 각 경계까지는 57.5 SPM 뿐이다.
> **좋은 발표와 나쁜 발표를 구별하는 값이 아니라, 표본이 어떻게 퍼져 있는지에 이름을 붙인 것이다.**
>
> **2. 반례가 결정적이다.** Kim 2018 서울 자연발화 40명의 개인별 평균 조음속도는
> **5.19–8.20 sps (312–492 SPM)**, 범위 180 SPM. 위 고정 경계를 적용하면
> **40명 중 아무도 '느림' 으로 분류되지 않고, 상단 화자는 평소 발화 자체가 '빠름'** 이 된다.
> 고정 경계가 정상적인 화자 차이를 교정 대상으로 오인한다.
>
> **3. ±50/±58 은 개인 내부 변동이 아니라 표본 분산이다.** 개인의 실시간 경계로 쓰는 것은 추가 비약이다.
>
> **4. 낭독 → 발표 이식의 한계.** 낭독은 내용 생성 부담이 없다. 발표에는 생각·강조·청중 반응·
> 슬라이드 전환에 따른 휴지가 섞인다. **조음속도는 이식 가능성이 상대적으로 높지만
> 휴지비율과 전체 말속도의 직접 이식은 정당화되지 않는다.**
>
> **5. 유용성 증거가 없다.** Orai 는 testimonial 로 filler-word counter 만 확인되고,
> Yoodli 는 granular metric 이 1차 문서로 확인되지 않으며, MS Speaker Coach 는
> **실제 발표가 아니라 rehearsal 이고 영어 전용**이다.
> **한국어 발표 성과를 인과적으로 개선했다는 검증은 어디에도 없다.**

**→ 채택 문구**: "302–417 SPM 은 한국어 **낭독** 자료에서 유도한 **초기 참고 대역**이며
절대적인 발표 품질 기준이 아니다. 발표 장르별 검증과 개인 기준선 보정을 거쳐야 한다."
UI 는 숫자와 조정 가능한 구간만 보이고 **'점수'로 만들지 않는다.**

### 7.4 영어 WPM 을 쓰면 안 되는 이유
한국어 조음속도 5.99 sps vs 미국 영어 3.40 / 네덜란드어 4.63.
원인은 음절 구조 — 영어·네덜란드어는 음절핵 전후 복수 자음군을 허용하지만 한국어는 최대 한 자음이다.
WPM 은 언어별 tokenization·어절 길이까지 섞는다. → **한국어는 Hangul 음절수/분이 안정적이다.**
혼합 영·숫자 발화는 별도 발음 음절화 없이 SPM 에 단순 합산하지 않는다.
(신청서 11항의 "영어식 WPM 을 그대로 사용하지 않고" 요구가 근거로 뒷받침된다)

### 7.5 정의
- `speechRateSpm = hangulSyllables / wallClockMinutes` (pause 포함)
- `articulationRateSpm = hangulSyllables / voicedMinutes` (pause 제외)
- `pauseRatio = meaningfulPauseDuration / activePresentationDuration`
- 동일 슬라이드/논리구간에 귀속된 **final STT 만** 음절 수에 반영. partial 은 숫자를 흔들므로 미표시.

### 7.6 VAD 이중 임계
1. **physical silence ratio**: >=100ms 비발성 run → 2017 한국어 기준(19.5±5.9%)과 직접 비교 가능
2. **meaningful pause count**: >=250ms 내부 pause
   De Jong & Bosker 2013(L2 Dutch 51명·9h43m, 내부 pause 10,668개)이 20–1000ms cutoff 비교에서
   **proficiency 와 pause 빈도 관계가 250–300ms 에서 최고**라고 보고 → 전통 250ms 권고.
   > 단 **perceived fluency 에는 단일 최적 cutoff 가 없고** 개인 최적이 138–384ms 로 변이한다.

구현: VAD 10–30ms frame → gap <100ms merge → 100–249ms 는 silence ratio 에는 포함하되
경고 pause count 에서 제외 → >=250ms meaningful pause.
**무성 폐쇄음과 STT 단어 경계 때문에 VAD 단독 이벤트를 곧바로 '망설임' 으로 명명하지 않는다.**
발표 중 video/Q&A/manual pause 는 coaching-active time 에서 제외하는 **명시 이벤트가 필요**하다.

### 7.7 알림 정책
근거: NIST EWMA(λ 0.2–0.3, 선택은 임의적) / **Quené 2007 speech tempo JND 약 5%** /
Google SRE·Prometheus(최소 2 evaluation cycle 지속, `for` pending, grouping·dedup·inhibition) /
**Stothart et al. 2015 — 알림에 직접 반응하지 않아도 주의과제 성능이 유의하게 저하** /
Microsoft 는 live critique 를 한 번에 하나만 순차 표시.

> ### 적대적 검토 결과 — 실시간 알림은 기본 활성화하지 않는다
> **JND 5% 를 오독하면 안 된다.** Quené 2007 의 5% 는 359 SPM 기준 약 18 SPM 을
> **'지각할 수 있다'** 는 뜻이지, **그 폭의 히스테리시스가 유익하다는 뜻이 아니다.**
> Stothart et al. 2015 는 발표 연구가 아니지만 알림 자체의 주의 비용을 보여준다.
> → **현재 근거로는 실시간 알림의 순편익을 주장할 수 없다.**
> 순해라고 단정할 수도 없지만, **순편익 근거 없이 알려진 주의 비용을 부담시키므로
> 기본 활성화가 정당화되지 않는다.**
>
> **→ 채택 문구**: 실시간 알림은 효과 검증 전까지 **opt-in 실험 기능**으로 두고,
> 기본 피드백은 **리허설·발표 후**에 제공한다.

아래는 opt-in 실험을 켤 경우의 초기값이다.

**[ASSUMED 초기값 — 사용 로그로 튜닝 필요]**
- 5초마다 평가
- fast lane = 최근 10–15초 voiced-time EWMA (α≈0.3)
- trend lane = 45–60초 또는 현재 논리구간 EWMA (α≈0.1)
- fast 상태 **3회 연속(≈15초)** 동일 시에만 candidate. fast+trend 동방향이면 우선 승인
- **trigger/clear 간 5% hysteresis** (JND 근거). 예: trigger >417 SPM → clear <396 SPM
- per-type cooldown 60초, global gap 30초, **동시 1개만 표시**
- 우선순위: 복구 가능한 구간 시간 초과 > 지속된 빠름/느림 > 침묵비율 변화 (상위가 하위 억제)
- **silence 중에는 알림 금지.** 발화 재개 후 추세만 반영
- 라이브는 짧은 비모달 한 줄("조금 빠름 · 15초 지속"), 사후는 `02:10–02:42 빠른 구간 446 SPM` 같은
  **조절 가능한 사실**. **총점·등급 금지.**

### 7.8 논리구간 시간 부채 (구간 전환에서만 재계산)
```
remainingBudget = totalBudget - elapsed
debt  = max(0, Σ base_i - remainingBudget)
flex_i = max(0, base_i - min_i)
debt <= Σflex  →  new_i = base_i - debt * (flex_i / Σflex)
debt >  Σflex  →  모든 new_i = min_i, 초과분은 UNRECOVERABLE_OVERRUN
```
**음수 목표를 만들지 않는다.** 일찍 끝나면 목표를 부풀리지 않고 reserve 로 유지한다.
실행 검산: base [4,3,1], min [2,1.5,0.5], 1분 debt → [3.5, 2.625, 0.875] 합 7 ✓
**매초가 아니라 구간 종료·수동 점프에서만 재계산**한다(목표 흔들림 방지).

### 7.9 경쟁 서비스 — DURING vs POST 실증
| 서비스 | 발표 중 실시간 | 확인된 사실 |
|---|---|---|
| MS Speaker Coach | **확인** | rehearsal 하단 on-screen, pace/filler/monotone/inclusive language/slide reading. **pace 100–165 WPM 은 영어 기준. 영어 전용, 실제 청중 발표가 아니라 rehearsal** |
| Poised | **확인** | private live in-meeting feedback. **단 slide/section time awareness 없음** |
| Yoodli | **미확인** | 현재 AI Feedback 페이지는 'after every roleplay'. 홈페이지의 'real-time' 표현과 달리 during-speech cue 를 1차 문서로 입증 못함 |
| Orai | POST 우세 | "the moment you finish speaking" 채점. **testimonial 로 실사용 확인되는 건 filler-word counter 뿐** |

**방어 가능한 차별점**: 경쟁사는 WPM·filler·AI rubric 에 집중한다.
impromptu 는 **한국어 SPM + 조음속도 + 침묵비율을 분리하고, 슬라이드 시간축에 귀속하며,
3–5 논리구간 time-debt 를 재분배**한다. 이 조합을 하는 곳이 없다.

---

## 8. 축 F — 발표 후 리포트

### 8.1 핵심 결론
현재 CAS 스냅샷 **옆에** 작고 append-only 인 분석 이벤트 원장을 두고,
끝난 세션에서 그 원장만 재생해 immutable report version 을 만든다.
**현재 상태·실시간 표시값으로 리포트를 만들면 안 된다**(신청서 12항 요구).

### 8.2 왜 원장이 필요한가 (코드 근거)
현재 store 는 presentation **전체 현재 상태만** snapshot/restore 한다
(`prepared-evidence.ts:171-177, 204-227`). **전이 이력이 없어 dwell·card history 복원이 불가능**하다.
Postgres persistence 는 snapshot revision CAS 이므로(`prepared-evidence-store-postgres.ts:44-71`)
원장은 이를 **대체하지 말고 sidecar append + `seq` idempotency** 로 둔다.

또한 기존 `deriveEventReport()` 는 public dispatch DTO 집계 유틸이고 **런타임 호출이 0개**이며,
outbox 는 producer INSERT 가 없고 coordinator 가 ProjectionHttpPort 를 직접 호출한다.
→ **현재 production event log 로는 리포트를 만들 수 없다.**

### 8.3 리포트 범위 (사용자 요구: "간단하게")
화면 5블록 + 결정론적 `next_practice[]` 최대 2개:
(1) 총 발표 시간 (2) 슬라이드 **occurrence 별** 체류 시간 (3) 구간별 목표/실제/차이
(4) 구간별 WPM 변화와 침묵 비율 (5) 카드 표시 시각·종료 상태/사유
**제외**: 종합 점수, LLM 요약, 원본 음성, 전문 transcript, 카드 인용문.

### 8.4 이벤트 모델 [적대적 검토에서 6종 → 1종으로 축소]

> ### 검토 결과: 원장 필요성은 **부분 방어**되었다
> **살아남은 논거**: `occurrenceSeq` 반론은 정확하다. `A` 와 `A→B→A` 는 최종 snapshot 이 같지만
> dwell 이 다르므로 현재 상태만으로는 재방문 시간을 복원할 수 없다. 공격이 여기서 실패했다.
>
> **무너진 논거**: 그것이 입증하는 것은 **최소한의 순서 있는 방문 기록**이지
> 6종 원장 + materializer + 재계산 체계가 아니다.
> `reportVersion`/`inputDigest` 도 리포트 행에 저장할 수 있으므로 원장의 전유물이 아니다.
> 사용자 요구는 **"간단하게 나오면 좋긴 해"** 였고, 전 이벤트 감사·재생·수정 이력은
> 그 요구에 핵심 가치로 제시되지 않았다.
>
> **→ 채택안**: 종료 시 최종 입력과 슬라이드 방문 기록으로 리포트를 **한 번 materialize** 하고
> 버전·digest 를 함께 저장한다. append-only 기록은 **슬라이드 방문 1종으로 제한**하고,
> 감사·재생 요구가 검증될 때만 범용 원장으로 확장한다.

#### 채택: 1종 최소안
`SLIDE_VISIT_RECORDED` (또는 `SLIDE_CHANGED`) 하나만 append-only 로 남긴다.
대안 표현도 동일 정보를 보존한다: 단조 증가 서버 sequence / 순서 보장 change ID /
`{slideId, enteredAt, leftAt, visitNo}` 방문 구간.
나머지는 **최종 행 저장**으로 대체하고, 각각이 포기하는 것을 명시한다:

| 버리는 이벤트 | 대체 | 포기하는 것 |
|---|---|---|
| `SESSION_STARTED/ENDED` | 세션 행의 timestamps/status | 라이프사이클 재생 |
| `TIMING_PLAN_FROZEN` | 최종 plan + hash 저장 | 이전 계획, 정확한 freeze 순간 |
| `TRANSCRIPT_FINALIZED` | 최종 transcript 행 | revision provenance |
| `VOICE_ACTIVITY_FINALIZED` | 최종 VAD segments | VAD revision provenance |
| `EVIDENCE_CARD_TRANSITION` | count / firstSeen / lastSeen 집계 | 카드 상태 경로, 사건 간 시간 상관 |

> 카드의 시간축이 **승인된 리포트 요구**라면 그때만 두 번째 이벤트를 추가한다.
> 프로세스 장애 복구까지 포기한다면 일반 이벤트 0종도 가능하다(런타임 누적 합계만).

#### 참고: 원래 제안된 6종 전체 모델 (감사·재생 요구가 생길 때 확장안)
새 테이블 `private_app.presentation_analysis_events`, envelope:
`event_id, tenant_id, presentation_session_id, presentation_session_epoch,
seq BIGINT(세션 내 단조·unique), kind, offset_ms, occurred_at, recorded_at,
producer_id(idempotency), versioned closed JSON payload`, `presentation_sessions` FK ON DELETE CASCADE.

| 이벤트 | 왜 필요한가 |
|---|---|
| `SESSION_STARTED` / `SESSION_ENDED` | total duration 의 명시 경계 |
| **`TIMING_PLAN_FROZEN`** | 시작 시점에 얼린 목표 없이는 '목표 대비 실제' 가 **정의 불가**. 미설정 구간은 차이 미표시 |
| **`SLIDE_CHANGED`** (`occurrenceSeq` 포함) | **slide key 만으로는 재방문 시 dwell 계산이 틀린다** |
| `TRANSCRIPT_FINALIZED` | 본문 저장 없이 `wordCount`+timing 만으로 WPM 재계산. 지연 수정은 더 높은 revision 을 새 이벤트로 append |
| `VOICE_ACTIVITY_FINALIZED` | 오디오·파형·녹음 URI 없이 speech/silence interval 만 |
| `EVIDENCE_CARD_TRANSITION` | `SHOWN` offset 이 사용 시점, terminal state/reason 이 폐기 사유. excerpt·원문·내부 source 미포함 |

리포트는 `(session, event high-water seq, algorithmVersion)` unique 로 materialize 하고
`input_digest = hash(ordered canonical events + algorithmVersion)` 을 남긴다.
생성은 **순수 replay**. 늦은 final transcript·새 VAD 가 append 되면 새 high-water/report version 을
만들고 이전 것만 supersede 한다. → realtime projection 재사용 없음, 재시도 idempotent.

**리포트 재계산은 세션 종료 후 비동기 batch** 로 두어 live 경로 지연에 추가하지 않는다.

### 8.5 결정론적 개선 항목 (LLM 불필요)
- `TIME_DEVIATION`: target 존재 + `|actual-target|/target >= 20%`
- `PACE_SHIFT`: spoken duration >=20s section 에서 session weighted-median WPM 대비 `max(20 WPM, 15%)` 이상
- `LONG_SILENCE`: speech-coverage 내 3초 이상 무음 + long-silence share >=25%
  → **의도적 pause 를 '오류' 로 단정하지 않는다**

category 당 1개, `severity desc → TIME_DEVIATION → PACE_SHIFT → LONG_SILENCE → earliest offset`
안정 정렬, 최대 2개. coverage 부족 시 후보를 만들지 않는다.
카드 통계는 투명성 블록이지 코칭 점수에 섞지 않는다.

### 8.6 권한 (신청서 10항 "발표자와 허용된 팀원")
> **현재 RLS 는 tenant 격리만 한다**(`infra/migrations/private/0001_private_foundation.sql:81-86`).
> **'같은 tenant' 만으로 팀원에게 공개하면 요구 위반이다.**
> private backend 가 owner subject 또는 **명시적 session-report viewer grant** 를 확인해야 한다.
> Stage/projection API 에 report endpoint·table 을 절대 노출하지 않는다.

보존: 원장·리포트는 session FK cascade 로 presentation retention 과 **동일 cutoff** 에 삭제한다
(`0003_retention_cascade.sql:10-57`). **새 테이블에 독립 장기 보존을 만들지 않는다.**

### 8.7 선행 의존성
`TRANSCRIPT_FINALIZED` 는 현재 canonical STT event 에 **없는 필드**(segment revision, start/end offset,
wordCount)에 의존한다. 따라서 §4.3 의 계약 확장이 **선행**되어야 하며,
실시간 화면값으로 대체하면 안 된다.

---

## 9. 코드베이스 접속점 (file:line)

### 9.1 스트리밍 STT
| 무엇 | 위치 |
|---|---|
| canonical 계약 | `services/model-router/src/stt.ts:4-55` |
| 등록 경로 | `registry.ts:203-239, 257-279` (`registerIsolatedStreamingStt()`, 절대경로 `.mjs`) |
| isolate | `isolation.ts:10-35, 113-148`, `isolate-runner.mjs:4-10, 66-82` |
| router 접속점 | `router.ts:302-368, 389-443, 454-478, 479-521, 524-589` (`streamStt()`) |
| chunk sequence 강제 | `router.ts:780-821` (0부터 strict contiguous) |
| private 경계 | `services/private-backend/src/audio-capture.ts:7-59` (`RouterBackedAudioSttPort`) |
| consent/grant/queue | `audio-capture.ts:94-233, 385-392` (`AudioCaptureCoordinator`) |
| Console 컨트롤러 | `apps/console/src/audio-capture.tsx:23-27, 42-89, 91-181` |
| Console 부착 위치 | `apps/console/src/App.tsx:738-789` (cockpit private side column) |
| 시간축 정합 | `packages/state/src/audio-fusion.ts:97-225` — **재설계 대상 아님** |

**배선 없음**: main.ts 에 adapter 등록·port·coordinator·HTTP route 전무. `CaptureUploader` 구현 0개.

### 9.2 외부 검색
| 무엇 | 위치 |
|---|---|
| 포트 | `ExternalSearchBoundary.search(query, signal)` — `verifier/recommendation-pipeline.ts:47-49, 62-92` |
| 후보 진입 | `recommendation-pipeline.ts:187-207` (:194 search, :199 fetchCandidate) |
| fetcher 계약 | `retrieval/external-fetch.ts:8-38, 98-137, 168-278, 281-328` |
| **배선점** | `main.ts:280-283`(fetcher)와 `:292-307`(pipeline) 사이 |
| **막힌 지점** | `externalSearch` 미주입 → 외부 분기 프로덕션 도달 불가 |
| rights 게이트 | external rights 항상 `UNKNOWN`(`external-fetch.ts:271`) vs publication 은 `APPROVED` 만(`pipeline:119-124`) |

### 9.3 하이브리드 RAG
| 무엇 | 위치 |
|---|---|
| 교체 seam | `retrieval/postgres-deck-retrieval.ts:66-92, 93-232, 234-263, 265-330` (`search()`) |
| ACL 흐름 | `retrieval/internal-retrieval.ts:15-75, 109-168, 170-227, 229-258` |
| 현재 검색 | `postgres-deck-retrieval.ts:272-297` — authorized rows 전부 읽어 앱에서 cosine sort |
| 스키마 | `infra/migrations/private/0006_deck_retrieval_chunks.sql:1-28` — **RLS 없음** |
| 권장 migration | private **0008** (FTS column/index + ENABLE/FORCE RLS) |

> RLS 도입 시 주의: 0006 의 `tenant_id` 는 text 인데 foundation 정책은 uuid cast 패턴이라 그대로 복사 불가.
> `main.ts:208-260` 도 tenant transaction context 를 설정하지 않으므로
> **`SET LOCAL app.tenant_id` 를 설정하는 repository wrapper 가 필요**하다.

### 9.4 코칭
| 무엇 | 위치 |
|---|---|
| 입력 seam | `packages/contracts/src/audio.ts:37-81` → `packages/state/src/audio-fusion.ts:12-68, 97-159, 161-235` |
| 새 계약 | `packages/contracts/src/coaching.ts` → **private.ts 에만 export** |
| 새 reducer | `packages/state/src/coaching.ts` → index.ts root 에만, **Stage realtime subpath 에 미export** |
| 표시 | `apps/console/src/App.tsx:779-786` |
현재 coaching 은 capability 문자열만 있고 adapter/schema/service/route/UI 가 0개다.

### 9.5 발표 후 리포트
| 무엇 | 위치 |
|---|---|
| 기존 event source | `packages/state/src/playback.ts:84-111, 129-164` (`acceptedCommands`) |
| capture seam | `prepared-evidence.ts:758-785` (SLIDE_SET reducer 성공 경계), `:1146-1149` (카드 lifecycle) |
| 영속 | `prepared-evidence.ts:204-227`, `prepared-evidence-store-postgres.ts:38-106` |
| 미사용 유틸 | `packages/contracts/src/event-derived-report.ts:8-35, 49-100` — **런타임 호출 0개** |
| outbox | `publication/outbox-dispatcher.ts:33-56, 66-114` — **producer INSERT 없음** |
| 권장 migration | private **0009** |

### 9.6 UNCERTAIN (신청서 8항 4-state) 의 blast radius
> **코드에 이름 붙은 4-state schema 가 없다.** 직접 seam 은 `VerifierModelOutputSchema.verdict` 의
> **3-state enum**(`packages/contracts/src/retrieval.ts:73-79`)이고,
> isolated adapter 가 **같은 enum 을 중복 정의**한다(`model-adapters/openai-compatible.ts:66-71, 260-264`).
>
> **문서와 코드가 다르다**: docs 는 SUPPORTED/UNCERTAIN/CONFLICTING/UNSUPPORTED,
> 코드는 **SUPPORTED/INSUFFICIENT/CONFLICTING**(`docs/PWA-구현-최적화-연구보고서.md:32-44`).
> 단순 추가하면 4개가 되지만 **의미는 여전히 다르다.**

- **최소 blast radius**: model-output terminal 로만 추가 + `RetrievalFailureCodeSchema` 에
  `UNCERTAIN_EVIDENCE` 추가 + pipeline fail-closed ABSTAIN. 변경 지점 4곳
  (contracts enum, adapter enum, `pipeline:275-294`, `test:217-223`).
- **최대**: 후보 lifecycle 까지 상태 보존 시 `EvidenceCandidateSchema`(`private-evidence.ts:49-50`),
  `state/candidate-lifecycle.ts:26-37, 46-63, 138-217, 219-240`, `public-card-stream.ts:291`,
  `prepared-evidence.ts:1330-1342`, fixtures, property tests 까지.
  > `EvidenceCandidateSchema` 는 의도적으로 publish-eligible SUPPORTED 만 표현할 수도 있다.
  > **제품 의미를 먼저 결정하지 않고 확장하면 권위 store 에 unsafe state 를 넣게 된다.**

### 9.7 보안 경계 (모든 기능에 부과)
- STT/search/coaching/report provider runtime·키는 전부 **private backend/model-router server-only**.
  Console 은 audio bytes 와 closed private DTO 만 전송.
  **새 벤더 SDK·키 signature 를 `config/browser-forbidden-dependencies.json` 에 반드시 동기화**한다
  (자동 추가되지 않음).
- Stage 는 private contract/transcript/candidate/RAG/coaching/report 를 import·render 할 수 없다.
  projection-gateway 는 private-backend dependency 를 가질 수 없다.
  **coaching·report 는 Console-only 이므로 declassification 자체가 불필요**하다.
- 신규 private feature table 은 private DB + `private_app` RLS.
  `prepared_evidence_state`/`accounts` 의 no-RLS 는 service-wide auth/state 라서 둔 **의도적 예외**이며,
  신규 tenant session facts 는 그 예외에 해당하지 않는다.

### 9.8 마이그레이션·환경변수
현재 최신: **private 0007, projection 0005**. **projection 신규 migration 불필요.**
권장 예약: private **0008**(hybrid FTS + retrieval RLS) / private **0009**(session·report·coaching ledger).
> 병렬 구현 시 번호 충돌 가능 → **하나의 migration owner 를 지정**해야 한다.

신규 env 최소 후보: `STT_MODEL_API_KEY`/`STT_MODEL_BASE_URL`/`STT_MODEL`,
`EXTERNAL_SEARCH_API_KEY`/`EXTERNAL_SEARCH_BASE_URL`,
(기존 chat origin·key 공유 시) `COACHING_MODEL`/`REPORT_SUMMARY_MODEL`.
동기화 지점 7곳: main 의 required/URL parsing + secretStore + egress binding, `.env.example`,
`compose.production.yaml`, `scripts/dev-services.ts`, main-spawn/E2E env fixtures,
`config/browser-forbidden-dependencies.json`, deploy/prewarm runbook.

### 9.9 이력 교차검증
**삭제된 production 구현은 없다.** STT coordinator 는 b829a8c 에서 서비스 파일·테스트만,
external fetch 는 391d9bd 에서 fetcher 만, report 는 6a8e3fb 에서 contract·test·fixture 만 추가됐다.
`git log --all --diff-filter=D` 결과 0. → **"예전에 있었는데 지워졌다" 는 가설은 사망.**

---

## 10. 적대적 검토

skeptic 레인 2개가 6개 명제를 공격했다. **3개가 무너졌고 1개가 약화, 1개가 부분 방어, 1개가 방어**됐다.
무너진 주장은 이 보고서에서 철회했다.

| # | 명제 | 판정 | 결과 |
|---|---|---|---|
| 1 | 현재 파이프라인이 배정 예산의 2.2배를 쓴다 | **무너짐** | §2.4 철회. 결론은 약화된 형태로 생존 |
| 2 | 한국어 발표 도메인 STT 정확도를 모른다 | **방어됨** | §3.1 강화. 서술 2건 정정 |
| 3 | 하이브리드 lexical+dense 가 필요하다 | **약화됨** | §6 대상을 덱→팀 문서로 재정의 |
| 4 | 한국어 코칭 임계값을 문헌 근거로 정할 수 있다 | **무너짐** | §7.3 '임계값'→'참고 대역'. 실시간 알림 opt-in 강등 |
| 5 | 리포트를 append-only 이벤트 원장으로 | **부분 방어** | §8.4 6종 → **1종**으로 축소 |
| 6 | 5개 기능을 남은 기간에 5인 팀이 구현 가능 | **무너짐** | §10.2 범위 축소 |

### 10.1 가장 중요한 세 개의 반박

**(a) 2.2배 산술의 이중 계상** — 800ms 를 현재 작업 예산으로 쓰면서 동시에 미구현 외부검색 예산으로도
셌다. 합이 3,700ms 를 넘고 fusion/query·render 600ms 는 빠져 있어 애초에 분할이 아니었다.
단계표에 rerank·생성 LLM 항목이 없어 분모 자체가 정의되지 않는다.
→ **어떤 배수도 산출할 수 없다.**

**(b) 코칭 경계는 성과 기준이 아니다** — 제안 경계 폭 `417-302 = 115 SPM` 이고
조음속도 SD 57.6 의 ±1SD 폭은 115.2 다. 즉 **표본 분포에 이름만 다시 붙인 것**이다.
Kim 2018 의 개인 평균 312–492 SPM 을 대입하면 **40명 중 아무도 '느림' 이 아니고
상단 화자는 평소 발화가 '빠름'** 이 된다. 정상적 화자 차이를 교정 대상으로 오인한다.
추가로 Quené 의 JND 5% 는 "지각할 수 있다" 는 뜻이지 **"그 폭의 알림이 유익하다" 는 뜻이 아니다.**

**(c) 병렬화 불가능한 두 개의 긴 의존 경로** — 8/21 → 9월말은 6주 미만이고, 작업은
① STT 계약 → 오디오 ingest → 모델 → VAD/코칭/리포트
② 검색 → 추출 → 인덱싱 → 랭킹 → 근거 카드
로 직렬이다. 5명이 완전 병렬화할 수 없다.

### 10.2 팀의 실제 실패 모드

> "제품 기능이 절반 비어 있는데 ACL/RLS/SSRF/CSP, CAS, Docker/CI 와 483개 테스트가 이미 있다는 사실은
> 기술력 부족보다 **사용자 흐름 완성 전에 플랫폼 완성도를 계속 높인 범위 배분 실패**를 지지한다."

보안은 질의응답에서 점수가 될 수 있으므로 무가치하지 않다. 그러나
**작동하는 제품 흐름이 없으면 보안 깊이는 심사자가 볼 사용자 가치가 아니며,
483개 테스트가 기능 다섯 개의 점수로 환산되지 않는다.**

**가장 유력한 실패 모드는 기능 부족이 아니라, 검증되지 않은 기능마다
운영급 프로토콜·모델·원장·검색 아키텍처를 먼저 붙이는 과잉 엔지니어링이다.**
기존 보안 기반은 삭제하지 말고 **동결**하고, 추가 아키텍처 작업을 중단해야 한다.

### 10.3 살아남은 결론

무너진 주장에도 불구하고 다음은 유지된다:
- **외부 근거는 초기 Console 표시의 blocking dependency 가 되면 안 된다.**
  현 코드의 외부 분기가 내부 materialization 뒤에서 검색·fetch 하므로 critical path 가 늘어난다.
  (단 "동기 경로에 절대 불가능" 은 과장. prefetch·bounded race 는 배제되지 않았다)
- **한국어 STT 순위는 자체 blind bake-off 전에 정할 수 없다.**
- **슬라이드 재방문 dwell 은 현재 snapshot 으로 복원 불가**하므로 순서 있는 방문 기록 1종은 필요하다.
- **원격 LLM rerank 는 실시간 경로에서 배제**한다.

---

## 11. 출처

`sources-ledger.md` 참조 (56개 항목).
1차 출처 우선 원칙을 적용했고, 자체 보고(SELF-REPORTED)·상용 경쟁사 평가·
파생 추정(DERIVED)을 본문에서 명시적으로 구분했다.
