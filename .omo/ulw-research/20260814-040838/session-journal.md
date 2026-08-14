# Session Journal

## 2026-08-14 Wave 0

- PyMuPDF로 17쪽 텍스트와 이미지 메타데이터를 추출했다.
- 전체 페이지를 접촉 시트로 렌더링해 구조도, 상태도, 표를 육안 검토했다.
- 핵심 요구를 브리프와 intent diff에 기록했다.
- 코드베이스에는 PDF 외 파일이 없어 greenfield 구현 계획으로 분류했다.

## 2026-08-14 Wave 1 - realtime-ai 중간 관찰

- 신청서는 상시 LLM이 아니라 확정 발화와 현재 `slide_id`가 결합된 이벤트 기반 호출을 명시한다.
- 부분 STT는 자막과 검색 예열에만 사용하고 공개 카드 생성에는 쓰지 않는다.
- 공개 조건은 `SUPPORTED` 검증과 발표자/팀 승인이라는 서로 다른 두 개의 게이트로 해석해야 한다.
- 카드에는 `STALE`, `SUPERSEDED` 수명 상태가 필요하고, 미검증 상태는 청중 화면으로 절대 전달하지 않는다.
- security-privacy는 단순 라우트 분리가 부족하다고 지적했다. 공개 화면은 별도 origin·topic·최소 DTO를 사용하고, 비공개 데이터를 DOM에 숨겨 전달하는 방식을 금지해야 한다.
- pwa-platform 반론 결과 UI 별도 origin은 BroadcastChannel, opener, service worker lifecycle을 깨뜨린다. 결론은 same-origin UI route + 역할별 서버 topic/DTO/권한이다.
- remote-console은 WSS relay를 기본으로 하고 ICE/TURN·signaling이 필요한 WebRTC는 선택적 fast path로 제한하라고 권고했다.
- 5초 목표는 공개 SLA가 아니라 Presenter Console의 최대 3개 추천 SLA로 해석되었다.
- origin 경계는 재논쟁 상태다. same-origin은 BroadcastChannel/SW 조정이 쉽지만, 보안팀은 쿠키·localStorage·공개 SW 격리를 위해 별도 origin을 요구한다. WSS relay를 기준 통신으로 삼으면 공개 창과 콘솔이 BroadcastChannel을 공유할 필요가 없으므로 별도 origin이 유력하다.
- stack-economics는 Vite+React PWA, Supabase(Postgres/pgvector/Auth/Realtime/Storage), Deepgram Nova-3, OpenAI API의 월 $0 MVP를 제안했다. 다만 가격·무료 한도는 시점 의존이며 한국어 STT 정확도와 Supabase 휴면 복구를 실측해야 한다.
- origin 논쟁은 보안 우선으로 수렴했다. `app.example`(setup/controller/presenter)와 `stage.example`(public display)를 분리하고 WSS만 data plane으로 사용한다.
- controller는 cross-origin stage를 대상 화면 좌표에 열 수 있지만 stage DOM에 접근할 수 없다. stage fullscreen은 stage 화면에서 한 번 클릭해야 하므로 setup wizard의 명시 단계가 된다.
- 내부 RAG principal은 인증 서버에서 도출하고 Postgres RLS로 default-deny한다. 검색 엔진의 문자열 필터만 authorization으로 취급하지 않는다.
- 원격 콘솔 QR에는 credential을 넣지 않는다. 128-bit pair_id, 90초 TTL, 양 기기 동일 확인 문자열, 기존 콘솔의 명시 승인, 단일 사용 후 새 presentation-scoped device session 발급 흐름을 사용한다.
- Supabase Edge Functions는 Deno/TypeScript 전용이므로 python-pptx/LibreOffice 전처리를 둘 수 없다. MVP는 로컬 Python 업로더, 다중 사용자 단계는 Cloud Run Python worker가 최소 경로다.
- 확장 모드 1클릭 최적 흐름은 launcher를 외부 stage로 fullscreen하고 내부 화면에 console popup을 여는 것이다. console을 그대로 둔 채 cross-origin child stage를 열면 stage에서 fullscreen 1회 클릭이 추가된다.
- 브라우저 capability tier를 정의했다: Tier 0 수동 drag/fullscreen+WSS, Tier 1 Chromium desktop 자동 placement, Tier 2 설치형 standalone+offline shell. 설치는 멀티스크린 권한을 늘리지 않는다.
- cross-origin launch 최종 흐름은 setup permission과 popup activation을 분리한다: 권한 확인 후 `Open audience display` 클릭으로 `noopener,noreferrer` stage를 배치하고, stage 자체 클릭으로 fullscreen한다. WSS presence가 liveness source다.
- Presentation API는 Cast/TV adapter 후보지만 attached Windows monitor의 deterministic geometry를 주지 못해 핵심 폴백에서 제외한다.
- 원격 console/display socket은 서로 다른 BFF와 server-assigned topic ACL을 사용하고, display credential로 private topic 구독 시 403이 되는 통합 테스트를 필수로 한다.
- 내부 RAG는 retrieval 전 authorization, source materialization 시 재인가, publication 직전 revision/hash/ACL 재인가의 3중 TOCTOU gate를 사용한다. ANN 후 post-filter만 가능한 저장소는 수용하지 않는다.
- `presenter can read`와 `audience can see`는 별도 정책이며, 내부 제목·URI·ACL·raw excerpt는 명시적 declassification 없이는 공개 DTO에 포함하지 않는다.
- 오디오 권한과 데이터 처리 동의는 분리한다. app origin만 mic 권한을 가지며 원음은 메모리 내 최대 30초 retry buffer 외에는 저장하지 않고, transcript·embedding·report 삭제 cascade를 session 단위로 시험한다.
- 원격 WSS protocol은 revisioned authoritative snapshot, idempotent commandId, controllerEpoch, role-scoped snapshot, gap 시 full resync를 사용한다. offline 중 relative next/toggle은 자동 replay하지 않는다.
- pairing QR에 secret을 담을지, 인증된 device-authorization transaction만 담을지는 상충해 skeptic 반론으로 넘겼다.
- PWA 캐시는 shell, 현재 deck, 이미 승인된 evidence asset, 복구 안내만 versioned precache한다. 서버 불가/기기 offline/display disconnect를 구분하고 마지막 sync와 freshness를 표시한다.
- session credential은 Account/PresentationControl/Device/AudienceDisplay 네 종류의 opaque host-only cookie로 나누고, role 변경·handoff·종료 시 회전/폐기하며 WSS도 즉시 닫는다.
- 공개 이미지·인용은 RightsRecord가 없는 경우 default-deny한다. unknown license는 private link candidate로만 남기고, 승인된 asset hash만 자체 CDN에서 제공한다.
- public byte invariant를 확정했다: Audience의 HTTP/WSS/DOM/storage/cache/telemetry는 `PublishedAudienceCard`만의 함수여야 한다. audience service account는 별도 published store/topic만 읽는다.
- 미러 모드는 발표 PC에 AudienceDisplaySession만 두고 개인 기기에 Console을 두는 것을 기본 보안 모드로 권고한다. topology 변화 시 Console privacy curtain을 즉시 적용하고 재확인 전 비공개 이벤트 전달을 중지한다.
- 중요 교정: `console.example.com`과 `audience.example.com`은 origin은 다르지만 site는 같다. 최강 경계는 서로 다른 registrable domain이고, subdomain을 쓸 때는 SameSite에 의존하지 말고 exact Origin + CSRF token + WSS Origin 검사를 강제한다.
- pairing 반론 결론: QR은 90초 single-use 비권한 `pair_id`만 담는다. 새 기기는 동일 계정 로그인 후 device key/scope 요청을 보내고 기존 console이 승인하면 새 host-only DeviceSession을 받는다. 익명 pairing은 MVP에서 제외한다.
- 승인 책임자는 active presenter/controller 한 명으로 제한하고 팀 메시지는 advisory로 둔다. approval accepted→audience applied SLO는 별도 300~500ms 목표로 측정한다.
- remote-console은 fragment pair secret도 account auth와 결합하면 제한된 credential로 수용 가능하다고 보았으나, skeptic의 더 단순한 non-authorizing pair_id 흐름이 권한 노출 면에서 우월해 최종 권고로 채택한다.
- takeover는 현재 controller의 10초 승인, 응답 불가 시 deck owner의 재인증 force-takeover, controllerEpoch 증가와 이전 socket 폐기로 확정한다.
