# wave-1 / stt-local-models (2차 중간) — 벤치마크 vs 실사용 괴리 확정

## 독립 다도메인 한국어 CER (리턴제로 Awesome-Korean-Speech-Recognition)
AI-Hub 7개 세트, 각 3,000문장 샘플링 (MEASURED, 단 평가자는 상용 경쟁사)

| 엔진 | 평균 CER | 세트별 |
|---|---|---|
| OpenAI Whisper | **11.39%** | 주요회의 10.49 / 회의 10.16 / 상담 7.51 / **저음질 전화 17.27** / 강의 10.89 / Kspon clean 12.06 / other 11.34 |
| 리턴제로 fine-tuned Whisper | 6.59% | 6.84 / 8.33 / 4.10 / 4.26 / 7.11 / 7.78 / 7.73 |
| 리턴제로 (한국어 전용 상용) | **5.91%** | |
| Naver | 7.52% | |
| ETRI | 10.19% | |

**결정적 함의**: 모델 카드의 "Zeroth test CER 2.06%" 와 실제 잡음·회의·강의 다도메인 6~17% CER 은
**직접 비교 불가**. '한국어 fine-tune 이면 2%' 기대는 과대평가.
주의: 평가 주체가 상용 경쟁사(리턴제로)이고 Whisper 행의 정확한 체크포인트/API 버전이 미명시
→ large-v3 자체 수치로 간주 불가. **독립성 결함으로 기록.**

## Whisper 원 논문의 한국어 자인
한국어를 FLEURS 추세보다 성능이 나쁜 **최대 outlier 중 하나로 명시**.
원인 후보: 고유 문자 / 인도유럽어와의 거리 / byte-level BPE 부적합 / 데이터 품질.
large-v3, v3-turbo 공식 카드는 **한국어별 수치를 공개하지 않음**.

## 한국어 평가 방법론 (보고서에 반드시 포함)
교착어·조사·모호한 띄어쓰기 때문에 **WER 보다 CER 가 적절**.
예: '학교에'→'학교' 는 WER 25% 지만 CER 6.7%.
숫자/영문 이중 전사 정규화가 점수를 크게 바꿈: `(7시)/(일곱시)`, `(ARS)/(에이 알 에스)`, `(16%)/(십육프로)`.
→ **정규화 정책 없이 WER/CER 를 비교하면 무의미.**

## 커뮤니티 평판 (RSS / HN Algolia 우회 확인)
- r/LocalLLaMA '30 Days Testing Parakeet v3 vs Whisper': macOS 개발자가 Parakeet v3 를 장기 통합했으나
  **지원 목록이 유럽어 전용임을 전제하고 중/일/한에는 맞지 않는다고 명시** → 영어 평판의 한국어 전이 금지.
- 'Qwen3 ASR seems to outperform Whisper': Whisper Large Turbo / Voxtral / Qwen3-ASR-1.7B 비교에서
  Qwen3 가 속도·정확도 모두 우위 평가. 짧은 청크 실시간 정확도 높음.
  **단 vLLM 스트리밍은 시간이 갈수록 성능 문제** → 공식 'unified streaming' 주장과 운영 안정성이 갈림.
  **한국어별 결과 미제시.**
- 'Whisper 대체 모델?' (요구: en/ja/ko + faster-whisper 급 속도 + timestamps + 8GB):
  답변에서 검증된 한국어 winner 확인 안 됨.
- HN SenseVoice 토론: 'Small 은 large-v3 보다 확실히 나쁘지만 usable',
  'better accuracy 주장이 중국어/광둥어로 후퇴해 dishonest 하게 느껴진다', 'third-party comparison 을 못 봤다'
  → 공식 5x/15x 속도 홍보와 한국어 정확도 근거 부재의 괴리.

## rag-hybrid 로부터 (rerank)
bge-reranker-v2-m3: Apache-2.0, multilingual XLM-R 24층/hidden 1024, FP32 safetensors **2.271GB**.
로컬 실행 가능하나 **현재 머신/한국어 top-k 지연 근거 없음**.
→ 후보 10~20개에만 batch 적용, 실제 p95 예산 통과 전 기본 경로 투입 금지.
**25초 변동 원격 LLM rerank 는 실시간 발표 경로에서 배제.**
