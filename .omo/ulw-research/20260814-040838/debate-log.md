# Debate Log

| round | claim | attack | defense | verdict | graph change |
|---|---|---|---|---|---|
| D-01 | 공개/비공개 UI를 별도 origin으로 분리 | 별도 origin은 BroadcastChannel·service worker·opener 조정을 깨뜨림 | 공개 stage는 WSS만 쓰므로 BroadcastChannel 불필요; 쿠키·storage·SW 격리 이점이 더 큼 | stage와 app은 별도 origin, WSS가 유일한 data plane | C-01 supported |
| D-02 | 검증과 승인 이중 게이트가 5초 목표를 깨뜨림 | 발표자 인지부하와 지연 증가 | 5초는 publish가 아니라 최대 3개 추천 SLA; 승인 무응답은 만료, 단축키 1회 | 세 필드 상태 머신으로 유지, 자동 공개 금지 | C-05 강화 |
| D-03 | controller가 cross-origin stage를 자동 fullscreen 가능 | Window Management로 좌표를 아는 만큼 가능하다는 가정 | fullscreen의 transient activation은 요청 문서 자체에서 필요 | stage의 1회 클릭을 setup wizard에 포함 | C-09 supported |
| D-04 | 1클릭 확장 모드에서 console을 그대로 두고 child stage를 fullscreen | child 문서에는 transient activation이 전달되지 않음 | launcher를 stage로 전환하고 console을 popup으로 열면 같은 클릭 안에서 가능 | 이 흐름을 Chromium tier의 우선 경로로 채택 | C-13 supported |
| D-05 | 별도 subdomain이면 SameSite=Strict로 CSRF 격리 | sibling subdomain은 same-site라 cookie가 전송될 수 있음 | 별도 registrable domain 또는 exact Origin+CSRF token 필요 | MVP는 subdomain 가능하나 SameSite를 보안 경계로 주장하지 않음 | C-01 caveat added |
| D-06 | QR fragment의 256-bit secret으로 phone console 권한 부여 | fragment도 소유로 권한을 얻으면 bearer이며 사진·extension·JS 노출을 막지 못함 | QR은 비권한 pair_id만 담고 새 기기 로그인+기존 console 승인 후 별도 device session 발급 | authenticated-account MVP에서 bearer secret 제거, 익명 pairing 제외 | C-11 supported |
