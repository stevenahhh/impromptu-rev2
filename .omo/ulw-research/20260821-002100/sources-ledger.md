# sources-ledger.md

세션: 20260821-002100

[S1] huggingface.co — NVIDIA Parakeet/Canary, distil-whisper 공식 모델 카드 (언어 지원 범위)
[S2] huggingface.co — ghost613/whisper-large-v3-turbo-korean 모델 카드 (self-report WER/CER)
[S3] huggingface.co — kresnik/wav2vec2-large-xlsr-korean 모델 카드
[S4] arxiv.org + github.com — WhisperKit 2025 논문 (ANE 스트리밍, 압축, M3 Max encoder 지연)
[S5] github.com/SYSTRAN/faster-whisper issues #934 #254 #1356 #918 — 한국어 실사용 결함
[S6] huggingface.co + github.com — FunAudioLLM SenseVoiceSmall (234M, 5개 언어, FunASR License)
[S7] https://api-dashboard.search.brave.com/app/plans + https://brave.com/search/api/
[S8] https://www.tavily.com/pricing + https://docs.tavily.com/documentation/api-reference/endpoint/search + /rate-limits
[S9] https://exa.ai/pricing + https://exa.ai/docs/reference/search
[S10] https://serpapi.com/pricing + https://serpapi.com/search-api
[S11] https://developers.google.com/custom-search/v1/overview — 신규 가입 불가, 2027-01-01 종료
[S12] https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement — 2025-08-11 완전 종료
[S13] https://docs.perplexity.ai/api-reference/search-post
[S14] https://help.kagi.com/kagi/api/overview.html
[S15] https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html — ResultId/IsPartial/Stable
[S16] https://platform.openai.com/docs/guides/realtime-transcription — item_id, delta/completed, ordering 비보장
[S17] https://github.com/ufal/whisper_streaming — LocalAgreement-n, long-form 3.3s latency
[S18] https://developers.deepgram.com/docs/endpointing + /docs/utterance-end — default 10ms, UtteranceEnd min/default 1000ms
[S19] https://github.com/snakers4/silero-vad/wiki/Performance-Metrics — 31.25ms chunk 189µs
[S20] https://developer.mozilla.org/.../AudioWorkletProcessor/process + /WebSocket/bufferedAmount + /MediaRecorder/*
[S21] https://www.w3.org/TR/webrtc/
[S22] https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security
[S23] https://cloud.google.com/speech-to-text/docs/data-logging — 기본 logging off
[S24] https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html
[S25] arXiv 2210.11934 (Bruch et al. 2023, TOIS) — 정규화 가중합 vs RRF
[S26] Elastic — RRF 재현 및 40 annotated query 비교
[S27] aclanthology.org/2023.ijcnlp-demo.3/ — Whisper-Streaming
[LOCAL-M1] 로컬 실측: 인메모리 코사인 768d p50 0.57ms(50)/4.78ms(500)/47.6ms(5000) — rag-hybrid 멤버 측정
[LOCAL-M2] 로컬 실측: fix-1 파이프라인 10회, p95 4,506ms, RECOMMEND 수율 6/10 — 구현 에이전트 측정

[S28] Lee et al. 2017, Phonetics and Speech Sciences, DOI 10.13064/KSSS.2017.9.1.027 — 한국어 412명 4,528발화 속도/침묵 (PRIMARY)
[S29] github.com — 리턴제로 Awesome-Korean-Speech-Recognition, AI-Hub 7세트 3,000문장 CER 비교
[S30] openai.com / arxiv.org — Whisper 원 논문 (한국어를 FLEURS 추세 대비 최대 outlier 중 하나로 명시)
[S31] aihub.or.kr — AI-Hub 한국어 음성 데이터셋 및 이중 전사 정규화 규칙
[S32] reddit.com r/LocalLLaMA — '30 Days Testing Parakeet v3 vs Whisper', 'Qwen3 ASR outperform Whisper', 'Whisper 대체 모델?'
[S33] news.ycombinator.com — SenseVoice 토론 (정확도 회의론)
[S34] huggingface.co — bge-reranker-v2-m3 (Apache-2.0, 2.271GB FP32)
[S35] https://support.microsoft.com/en-US/PowerPoint/rehearse-your-slide-show-with-speaker-coach
[S36] https://support.microsoft.com/en-us/teams/meetings-events/speaker-coach-in-microsoft-teams-meetings
[S37] https://orai.com/ — filler words/pace/clarity/energy, 147 WPM 예시
[S38] https://www.yoodli.ai/ — homepage 주장만 (granular metric 미확인)

[S39] https://koreascience.kr/article/JAKO201713647763102.page (+ .xml JATS) — Lee et al. 2017 (PRIMARY)
[S40] https://koreascience.kr/article/JAKO200411921990509.xml — Lee & Ko 2004, 느림/보통/빠름 지시 발화 6명 6,750문장
[S41] https://www.eksss.org/archive/view_article?pid=pss-10-4-19 — Kim 2018 서울 자연발화 40명, 조음속도 5.19–8.20 sps
[S42] https://pure.mpg.de/rest/items/item_1900232/component/file_1900231/content — De Jong & Bosker 2013, pause cutoff 250–300ms
[S43] https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc324.htm — NIST EWMA
[S44] https://doi.org/10.1016/j.wocn.2006.09.001 — Quené 2007, speech tempo JND ~5%
[S45] https://sre.google/sre-book/practical-alerting/ + https://prometheus.io/docs/alerting/latest/alertmanager/
[S46] https://doi.org/10.1037/xhp0000100 — Stothart et al. 2015
[S47] https://support.microsoft.com/.../rehearse-your-slide-show-with-speaker-coach-cd7fc941... (DURING 확인)
[S48] https://yoodli.ai/platform/ai-feedback (POST) / https://www.poised.com/products/real-time (DURING 확인)
[S49] https://huggingface.co/openai/whisper-large-v3-turbo / https://github.com/ggml-org/whisper.cpp / https://arxiv.org/html/2507.10860v1 (WhisperKit)
[S50] https://huggingface.co/Qwen/Qwen3-ASR-0.6B / facebook/mms-1b-all / facebook/seamless-m4t-v2-large
[S51] https://api-dashboard.search.brave.com/documentation/resources/terms-of-service §3.2 §13.3 — Search Results 영구저장 금지
[S52] https://trafilatura.readthedocs.io/en/latest/evaluation.html + corefunctions / https://github.com/mozilla/readability
[S53] https://html.spec.whatwg.org/multipage/tables.html — rowspan/colspan 논리 grid
[S54] https://arxiv.org/abs/2305.14627 (ALCE) / https://arxiv.org/abs/2210.08726 (RARR)
[S55] https://kosis.kr/openapi/devGuide/devGuide_0101List.do + _0201List.do / https://www.data.go.kr/ugs/selectPortalPolicyView.do
[S56] https://schema.org/datePublished + dateModified / https://www.rfc-editor.org/rfc/rfc9110.html#name-last-modified
