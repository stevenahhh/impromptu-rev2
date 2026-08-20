# wave-1 / stt-streaming-arch (축 완주, 5m37s)

## 코드 그라운드 트루스 (file:line 확인됨)
- stt.ts:25-56 — streaming 계약은 `{sequence,audio}` 청크 + `{kind,sequence,transcript{text,language,durationMs}}` 이벤트가 전부.
- router.ts:302-306,345-477 — 이중 파싱, **마지막 final 하나만** terminal output. final 없이 끝나면 provider_error.
- router.ts:780-821 — audio chunk sequence 0부터 strict contiguous, gap/중복은 invalid_request.
- registry.ts:58-93,174-229 — fake/isolated 등록 경로 분리 완료. **router 재설계 불필요, production module 등록만 하면 됨.**
- audio-capture.ts:7-60 — RouterBackedAudioSttPort 가 모든 transcript item 을 건너뛰고 complete 만 반환. **partial 소비 경로 단절.**
- audio-capture.ts:193-233,286-305,323-381 — strict frame sequence, 30초 pending queue(전체 녹음 상한 아님, backpressure 상한), samples.slice() 소유권 복사, terminal 시 clear/abort 구현됨.
- apps/console/src/audio-capture.tsx:23-27,42-86 — mic consent/controller + 추상 CaptureUploader 만. **실제 전송 구현 0개.**
- packages/state/src/audio-fusion.ts:97-225 — final transcript device interval → session clock → slide occurrence 귀속. 재설계 대상 아님.
- `git log --all -S` 결과: 계약/보안 lifecycle 은 2026-08-14 도입. production adapter/AudioWorklet/uploader 가 삭제된 흔적 **없음**(가설 사망).

## 핵심 claim
C1 (high) 현재 계약으로 adapter 구현은 가능하나 **세션 길이 스트림의 다중 발화 revision/final 을 안전하게 소비하는 구조는 표현 불가**.
  근거: canonical event 에 utteranceId/replacesRevision/audioStart·EndDeviceMs/word timing 없음. sequence 는 단순 번호.
  대조: AWS Transcribe 는 ResultId/StartTime/EndTime/IsPartial, OpenAI realtime 은 item_id+delta/completed 로 발화 identity 제공.
  → 최소 계약 확장 필요: stream-local utteranceId + revision + replacesRevision? + audioStart/EndDeviceMs, final 마다 immutable transcriptFinalId.
C2 (high) partial 은 교체 가능한 ephemeral view 로만. final 만 주장/근거/공개 경계 진입. LocalAgreement-n 도 공통 prefix 만 commit.
  → 물리 분리: partial → private caption + TTL prefetch namespace / final → transcriptFinalId → audio-fusion → retrieval.
C3 (normal) 권장 경계: AudioWorklet 채널 downmix+resample+PCM s16le 고정 → 50ms 패킷 → private WSS → bounded queue → server endpointing → revision reconciler.
  실수치: 16kHz mono s16le = 32KB/s, 50ms=1.6KB. AWS 권고 uniform PCM 50-200ms.
  주의: Worklet render quantum 128 Float32 는 향후 변경 가능(MDN 경고) → array length 를 읽고 별도 accumulator 로 packetize.
  브라우저 WebSocket 에 자동 backpressure 없음 → bufferedAmount high-water mark + 1~2초 hard cap 에서 fail-closed. audio replay/retry 금지.
C4 (normal) MediaRecorder 는 fallback. timeslice 부정확, "significantly larger chunks" 발생 가능(MDN). 현재 streaming chunk schema 에 encoding/sampleRate/channel 이 없어 blob 을 그대로 넣으면 adapter 가 해석 불가.
C5 (high) **endpoint/final p95 예산 700ms**(docs/PWA-구현-최적화-연구보고서.md:239-252, DEMO-SCOPE.md:45). 전체 final→Console p95 5s, 구현 할당 합계 4.4s.
  실수치: Deepgram endpointing default 10ms, 예시 300/500ms; UtteranceEnd min/default **1000ms** → 구조적으로 예산 초과.
  Silero V5 ONNX 31.25ms chunk 를 189µs 처리. Whisper-Streaming 논문 long-form latency 3.3s → 이 예산에 부적합.
  권장 시작점 50ms 패킷 + 300~400ms endpoint silence. **벤더 보장 아님, 한국어 코퍼스로 검증할 tuning hypothesis.**
C6 (high) 원본 음성 무보존은 "DB에 안 씀"으로 불충분. vendor retention 설정까지 배포 게이트.
  Azure: realtime audio 메모리 처리, at-rest 저장 안 함 명시. Google STT: 기본 audio/transcript logging off.
  **AWS: service improvement 목적 content 저장 가능 → Organizations opt-out 정책 필수.**
  deletion receipt 는 secure zeroization 을 주장하지 말고 "no durable persistence + references released + vendor no-retention config" 로 표현.

## 권장 구현 순서 (멤버 제시)
1) streaming session-open metadata(encoding/sampleRate/channels/device-time anchor) vs adapter 전 16k mono pcm-s16le 고정 — **먼저 잠글 결정**
2) private WSS START/AUDIO/STOP/CANCEL + binary frame, short-lived capture grant 결합
3) adapter 가 vendor ResultId/item_id 를 canonical utterance/revision 으로 normalize
4) private backend transcript fan-out: partial private view 와 final authority 를 타입/스토어/토픽으로 분리
5) 200+ 한국어 발표 utterance 로 endpoint/final p50·p95, revision count, false endpoint, 숫자/개체 정확도 측정
6) stop/revoke/logout/network gap/provider failure 각각에서 raw buffer=0 검증

## DEAD END
- production adapter/uploader 과거 삭제 가설 — git log -S 흔적 없음
- SSE/HTTP receipt 를 raw audio transport 로 재사용 — duplex/backpressure 요구와 불일치
- Deepgram retention 문서 기존 URL — index stub 이라 1차 근거로 사용 불가
