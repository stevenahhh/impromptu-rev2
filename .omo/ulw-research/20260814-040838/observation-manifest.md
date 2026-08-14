# Observation Manifest

| observation_id | source | layer | group | independence | observer | observed_at | valid_at | artifact | anchor | contamination |
|---|---|---|---|---|---|---|---|---|---|---|
| O-01 | docs/신청서.pdf | primary | applicant-spec | direct source | lead | 2026-08-14 | application dated 2026-07-24 | PDF extraction | pages 2-13 | contains applicant assumptions requiring verification |
| O-02 | OWASP WebSocket Security + security-privacy review | primary/reviewer | security | independent of applicant | security-privacy | 2026-08-14 | current guidance | team message | audience/private boundary | final source citations pending |
| O-03 | MDN same-origin/opener/postMessage/BroadcastChannel/service worker docs | primary | web-platform | independent official docs | pwa-platform | 2026-08-14 | current docs | team message | origin coordination tradeoff | browser support still pending |
| O-04 | RFC 6455, RFC 8445, RFC 8656 | primary standards | transport | three standards | remote-console | 2026-08-14 | current standards | team message | WSS/ICE/TURN | implementation economics pending |
| O-05 | docs/신청서.pdf cross-page state analysis | primary | applicant-spec | page-level cross-check | realtime-ai | 2026-08-14 | application dated 2026-07-24 | team message | pages 6-11 | same source, independent observer |
| O-06 | MDN Window.open, opener, requestFullscreen and W3C Window Management | primary | web-platform | independent official docs | pwa-platform | 2026-08-14 | current docs | team message | cross-origin placement/fullscreen | runtime two-monitor test pending |
| O-07 | PostgreSQL RLS, Azure security trimming, pgvector hybrid docs | primary | data-security | independent vendors | realtime-ai | 2026-08-14 | current docs | team message | ACL-prefilter hybrid retrieval | benchmark pending |
| O-08 | RFC 8628, RFC 9700, OWASP session/WebSocket guidance | primary | pairing-security | standards + security guidance | security-privacy | 2026-08-14 | current standards | team message | device authorization | UX validation pending |
| O-09 | Supabase Functions, Cloud Run pricing, python-pptx, LibreOffice docs | primary | stack-economics | independent vendor docs | stack-economics | 2026-08-14 | prices observed 2026-08-13 | team message | parser runtime and pricing | temporal figures must be rechecked |
| O-10 | W3C Window Management usage pattern + MDN fullscreen activation | primary | web-platform | two official groups | extended-display | 2026-08-14 | current docs | team message | one-gesture topology | physical two-monitor QA pending |
| O-11 | MDN Service Worker lifecycle/scope + PWA install docs | primary | web-platform | independent official pages | pwa-platform | 2026-08-14 | BCD checked 2026-08-13 | team message | offline/installability | browser private-mode caveats |
