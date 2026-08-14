# Verified Claims

연구 전 상태. 검증 완료 후 갱신한다.

# Claim Graph

| claim_id | statement | type | risk | scope | intents | support | contradiction | groups | convergence | counter-search | primary | dependencies | status | synthesis |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C-01 | 운영 환경은 공개 stage와 Presenter Console을 별도 origin·서버 namespace·DTO로 분리하고 공개 클라이언트에는 비공개 데이터를 전송하지 않아야 한다 | architecture/security | high | all modes | I-01 | O-01,O-02,O-03 | same-origin coordination convenience | 3 | converged | WSS relay removes BroadcastChannel dependency; platform reviewer reversed | OWASP + MDN origin model | auth model | supported | architecture |
| C-02 | 확장 화면은 Window Management API와 수동 폴백이 필요하다 | platform | high | extended | I-02 | - | - | 0 | open | open | TBD | browser support | unresolved | TBD |
| C-03 | 복제 화면은 세션 기반 원격 콘솔 동기화가 필요하다 | architecture | high | mirrored | I-03 | O-01 | - | 1 | open | open | 신청서 p8-9 | realtime transport | partial | TBD |
| C-04 | 5초 목표는 비동기 후보 준비와 확정 발화 검증 파이프라인이 필요하다 | performance | high | realtime | I-04 | O-01 | - | 1 | open | open | 신청서 p6-11 | STT/search | partial | TBD |
| C-05 | 청중 공개에는 근거 검증과 사람 승인이 모두 필요하다 | security/workflow | high | audience cards | I-01,I-04 | O-01 | - | 1 | open | open | 신청서 p7,p10 | approval protocol | partial | TBD |
| C-06 | 공개 카드는 서버의 단방향 publish 전이로 최소 불변 DTO를 새로 만들어야 한다 | security/workflow | high | audience channel | I-01 | O-02 | - | 1 | open | open | OWASP + applicant boundary | C-01,C-05 | partial | TBD |
| C-07 | 원격 콘솔 기본 전송은 WSS relay이고 WebRTC는 선택적 fast path여야 한다 | transport | high | mirror/remote | I-03 | O-04 | WebRTC peer-first | 2 | open | ICE/TURN counter-search supports relay baseline | RFC 6455/8445/8656 | auth,reconnect | partial | TBD |
| C-08 | 5초는 공개가 아니라 Presenter Console 추천 완료 SLA다 | performance/workflow | high | realtime | I-04 | O-01,O-05 | publish-within-five-seconds reading | 2 | debated | applicant page cross-check | 신청서 p6-11 | C-05 | supported | latency |
| C-09 | 별도 origin stage의 fullscreen은 stage 문서 내부의 사용자 제스처가 필요하다 | platform/security | high | extended | I-02 | O-03,O-06 | controller-triggered fullscreen assumption | 2 | converged | transient activation requirement confirmed | MDN requestFullscreen + W3C Window Management | C-01,C-02 | supported | extended flow |
| C-10 | 내부 RAG의 principal은 클라이언트 문자열을 신뢰하지 않고 서버 인증에서 파생해야 한다 | security | high | internal RAG | I-01 | O-07 | - | 2 | open | official caveat supports | PostgreSQL RLS + Azure security trimming | auth | partial | security |
| C-11 | 원격 콘솔 페어링은 QR bearer token이 아니라 짧은 device-authorization 거래여야 한다 | security | high | mirror/remote | I-03 | O-08 | QR bearer shortcut | 2 | open | RFC/OWASP counter-search | RFC 8628/9700 + OWASP | auth | partial | pairing |
| C-12 | PPTX/PDF 전처리는 라이브 경로 밖의 로컬 Python 도구 또는 Cloud Run worker에서 수행해야 한다 | architecture/cost | normal | ingestion | I-04 | O-09 | Supabase Edge Function parser | 2 | converged | Deno-only runtime refutes edge parser | Supabase/Cloud Run/python-pptx | ingestion | supported | stack |
| C-13 | 확장 모드의 매끄러운 1클릭 흐름은 launcher 자체를 외부 화면 stage로 fullscreen하고 내부 화면에 console popup을 열어야 한다 | platform/UX | high | extended | I-02 | O-06,O-10 | console-stays-put design | 2 | debated | W3C usage pattern confirms | Window Management + Fullscreen | C-09 | supported | extended flow |
| C-14 | PWA 오프라인은 shell·준비 자산만 보장하고 cloud AI/WSS의 오프라인 동작을 약속하면 안 된다 | platform | normal | degraded | I-01,I-03 | O-11 | offline-AI interpretation | 2 | converged | SW scope/lifecycle supports | MDN Service Worker | connectivity | supported | degraded mode |
