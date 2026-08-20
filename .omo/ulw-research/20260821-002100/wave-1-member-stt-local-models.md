# wave-1 / stt-local-models (축 완주, 10m52s)

## 결론
1차 구현 **whisper.cpp + large-v3-turbo Q5 / CoreML+Metal** 를 기준선,
**WhisperKit compressed turbo** 를 동일 corpus challenger, **SenseVoiceSmall ONNX int8** 를 제3 후보.
**문헌만으로 한국어 승자를 확정하면 안 된다.**

## 후보 전수표 (RTF 는 출처 있는 값만)
| 계열 | 크기 | 한국어 실측 | Apple Silicon | 스트리밍 | 라이선스 |
|---|---|---|---|---|---|
| Whisper large-v3 | 1.55B / fp16 ~3.1GB | 공식 한국어별 **없음**. 원 논문이 한국어를 FLEURS 추세 대비 최대 outlier 로 지목 | MPS/whisper.cpp/MLX. **M5 E2E RTF 공개 없음** | native ✗ | HF weights Apache-2.0, 코드 MIT |
| large-v3-turbo | 809M / ~1.6GB | Zeroth 기본 **SELF-REPORTED** WER 26.75 / CER 7.58 | whisper.cpp Metal/CoreML, MLX, WhisperKit ANE | native ✗ / WhisperKit ○ | MIT |
| 한국어 turbo FT (ghost613) | 809M | Zeroth **SELF-REPORTED** WER 4.89 / CER 2.06 (동일 도메인 분할) | CT2·GGML 변환 존재 | runtime 의존 | **카드 license 미기재 → 배포 위험** |
| Distil-large-v3 | 756M | **English-only → 한국어 N/A** | whisper.cpp M1 provisional >5x | wrapper | MIT |
| faster-whisper | 체크포인트 동일 | 체크포인트와 동일 | **CTranslate2 arm64 CPU 전용, MPS 미지원**. M1 에서 thread 증가가 역효과 보고 | Whisper-Streaming/WhisperLive | MIT |
| **whisper.cpp** | large ggml 2.9GiB, quant 지원 | 변환/quant 전 원본과 비교 필요 | **Apple first-class** NEON/Accelerate/Metal/CoreML. M1 Pro encoder CoreML **>3x CPU (MEASURED)**. M5 E2E RTF 없음 | 실시간 예제/슬라이딩 창 | MIT |
| MLX Whisper | 4-bit 변환 가능 | quant 별 재평가 필요 | M2 Ultra turbo 특정 sample 12.246s (MEASURED) **단 음원 길이 미기재 → RTF 산출 불가** | native ✗ | MIT |
| **WhisperKit** | turbo compressed **0.6GB** | 한국어별 WER **없음** | M3 Max ANE encoder **602→218ms/30s block**, **mean interim latency 0.46s (MEASURED)**. E2E RTF 미보고 | **진짜 partial/confirmation streaming** | MIT, Swift/CoreML |
| Parakeet v3 | 600M | **한국어 미지원(25 유럽어)** | NeMo/CUDA | ○ | CC-BY-4.0 |
| Canary Flash/V2 | 883M/~1B | **한국어 미지원** | NeMo/CUDA | 제한 | CC-BY-4.0 |
| MMS-1B-all | 1B | kor adapter 있으나 **공개 CER 없음** | PyTorch, 무거움 | ✗ | **CC-BY-NC-4.0 (비상업)** |
| SeamlessM4T-v2 | 2.3B | 한국어 ASR 지원, **공개 WER 없음** | 24GB 가능하나 발열·지연 과함 | 별도 checkpoint | **CC-BY-NC-4.0** |
| **SenseVoiceSmall** | 234M / GGUF q8 ~254MB | 한국어 지원, **한국어별 CER 비공개** | sherpa-onnx macOS arm64/Swift, GGUF. 공식 >5x/>15x 는 **SELF-REPORTED 상대속도**, Apple RTF 없음 | VAD/chunk pseudo-stream | 코드 MIT, **weights FunASR custom** |
| Fun-ASR Nano | 800M | 31어 포함, 한국어별 WER 없음 | 공식 고속은 CUDA 중심 | 주장 있음 | Apache-2.0 |
| Qwen3-ASR | 0.6B/1.7B | 공개표는 **다국어 평균(FLEURS 7.57/4.90) → 한국어 수치 아님** | **공식 streaming/fast path 가 vLLM+FA2 → macOS 부적합** | vLLM 만 | Apache-2.0 |
| XLS-R Korean (kresnik) | ~317M | Zeroth **SELF-REPORTED** WER 4.74 / CER 1.78 | PyTorch CPU/MPS | CTC chunk 가능 | Apache-2.0 |
| Korean Conformer-RNNT | 31.2M | KsponSpeech **SELF-REPORTED** CER 11.76 | PyTorch | 구조상 가능 | 미기재 |
| SNU/ETRI | **공개 weight 없음** | ETRI 는 API 평가만 | 로컬 배포 후보 아님 | — | — |

## 독립 한국어 실측 (AI-Hub 7도메인 × 3,000문장)
Whisper 평균 CER **11.39** [주요회의 10.49 / 회의 10.16 / 상담 7.51 / **저음질전화 17.27** / 강의 10.89 / Kspon clean 12.06 / other 11.34]
리턴제로 FT Whisper **6.59**, 리턴제로 상용 **5.91**, Naver **7.52**, ETRI **10.19**
→ **Zeroth 카드 CER 1.78~2.06 을 발표 환경 기대값으로 쓰면 안 됨. 도메인 이동 시 2~8배 악화.**
(단 평가자가 상용 경쟁사이고 OpenAI 체크포인트 불명 — 독립성 결함)

## 벤치마크 vs 실사용이 갈리는 5개 지점
1. Whisper FT: Zeroth in-domain 2.06 vs AI-Hub 다도메인 FT 평균 6.59 (과적합/split 영향)
2. SenseVoice: 공식은 속도·정확도 강조, HN 은 "large-v3 보다 나쁘나 usable / 우위는 중국어·광둥어 한정 / 제3자 비교 없음"
3. Qwen3-ASR: LocalLLaMA 는 turbo 보다 낫다 평가하나 **vLLM 장기 streaming 저하** 보고, 한국어 미분리
4. faster-whisper: 한국어 VAD v5 자막 **320→218줄 누락**(#934), 뉴스 게스트 **40초+ 누락**(#254), hotword **무음 반복 환각**(#1356)
5. Parakeet: macOS 장기 평판이 좋아도 한국어는 지원 목록 밖 — **benchmark halo 전이 금지**

## 한국어 발표 특유 리스크
- **코드스위칭**: whisper #2004 가 한국인 억양 영어를 한국어로 오감지. `auto` 는 언어 혼입, `language=ko` 는 영어 전문용어 손실. → Korean-English 동일 corpus 의 segment CER + language-ID error rate 필요.
- **전문용어**: 슬라이드 용어 prompt/hotword 가능하나 **무음 환각 실측**. VAD 이후에만 bias + **silence fixture 를 release gate 로.**
- **숫자**: `(7시)/(일곱시)`, `(16%)/(십육프로)`, `(ARS)/(에이 알 에스)` 이중 전사 정책이 점수를 바꿈. **UI 출력 규약(ITN) 을 먼저 고정.**
- **조사/띄어쓰기**: 교착어라 WER 과대평가 → **CER 우선**, term recall / number exact-match 보조.
  Kiwi 는 후처리 도구일 뿐 **Whisper 품질 개선 공개 실측/구현 발견 못함.**

## 권장 bakeoff (M5 Pro, 발열 민감)
A whisper.cpp large-v3-turbo Q5 + CoreML encoder + Metal decoder — 통합 기준선
B WhisperKit compressed turbo — **700ms endpoint 예산과 sustained thermals 우승 가능성 최고**
C SenseVoiceSmall ONNX int8 — 저전력 challenger, **custom weight license 확인 필수**
D Qwen3-ASR-0.6B — 정확도 challenger 이나 Apple 공식 streaming path 부재로 기본값 아님
측정: ko CER / en-token recall / 고유명사 recall / 숫자 exact-match / **silence hallucination per min** /
partial→final p95 / RTF / peak RSS / **30분 sustained package power·thermal pressure**
→ **문헌에 M5 Pro 한국어 E2E RTF 가 하나도 없으므로 자체 측정 없이 발열 결론 불가.**

## DEAD END
공식 large-v3/turbo·MMS·Seamless·SenseVoice 의 한국어별 WER/CER / M5 Pro 공개 E2E RTF·thermal / 검증된 Kiwi+Whisper 개선 구현
