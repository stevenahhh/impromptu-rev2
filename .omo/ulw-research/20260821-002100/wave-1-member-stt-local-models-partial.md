# wave-1 / stt-local-models (진행 중, 2회 중간보고)

## 배제 확정 (중요 — 후보군이 크게 줄었음)
- **NVIDIA Parakeet TDT 0.6B v3**: 'multilingual' 표기와 달리 25개 **유럽** 언어 전용, 한국어 미지원.
- **NVIDIA Canary 1B Flash**: 4개 언어(en/de/fr/es). 최신 V2 도 25개 유럽 언어. 한국어 미지원.
  추가로 NeMo/PyTorch 경로가 사실상 CUDA 중심 → Apple Silicon 부적합.
- **distil-whisper/distil-large-v3**: 공식 카드가 'English series' 명시. 한국어 미지원.

## 한국어 특화 수치 (전부 자체 보고 — 독립 검증 없음)
- ghost613/whisper-large-v3-turbo-korean: Zeroth 206.7h 학습, self-report WER 4.89% / CER 2.06%
  (기본 turbo 26.75% / 7.58% 대비 개선). **동일 Zeroth 도메인 분할이라 발표·코드스위칭 일반화 근거 없음.**
- kresnik/wav2vec2-large-xlsr-korean (기존 XLS-R CTC): 동일 Zeroth 에서 WER 4.74% / CER 1.78%.
  → **특화 Whisper 의 in-domain 수치가 더 우월하지 않음.**

## 신규 후보 (지정 목록 밖 counter-search 로 발굴)
- **WhisperKit** (Apple 네이티브): 2025 논문이 large-v3-turbo 를 ANE 네이티브 스트리밍화,
  1.6GB→0.6GB 압축(원본 대비 WER 1% 이내), M3 Max encoder 602ms→218ms. **한국어별 WER 미확인.**
- **FunAudioLLM SenseVoiceSmall**: 234M, 한국어 포함 5개 언어(중/광둥/영/일/한), 비자기회귀라 Whisper 보다 빠름 주장,
  ONNX/sherpa-onnx 경로 존재 → Apple Silicon 후보. **비표준 FunASR Model License → 상용 배포 검토 필요.**

## 실사용 결함 (벤치마크가 안 보여주는 것 — 이 축의 핵심 가치)
faster-whisper GitHub 이슈:
- #934 한국어에서 VAD v5 가 v4 보다 발화 대량 누락 (자막 320줄 → 218줄), 재현 보고.
- #254 large-v2 한국어 뉴스에서 앵커는 인식하나 인터뷰 게스트 구간 40초 이상 통째 누락.
- #1356 한국어 hotwords 투입 시 무음에서도 해당 단어 반복 환각 → 전문용어 biasing 은 정확도↔환각 trade-off.
- #918 다국어 자동감지가 영/중/한/이 섞여 나옴 → **발표 코드스위칭에서 언어 고정도 자동감지도 모두 불완전.**
