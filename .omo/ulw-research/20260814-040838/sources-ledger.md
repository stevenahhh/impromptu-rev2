# Sources Ledger

| id | source | kind | used for |
|---|---|---|---|
| S-01 | `docs/신청서.pdf` | primary specification | product requirements and target architecture |
| S-02 | https://developer.mozilla.org/en-US/docs/Web/API/Window_Management_API | official reference | multi-screen capabilities and permission policy |
| S-03 | https://developer.chrome.com/docs/capabilities/web-apis/window-management | browser vendor | multi-screen placement and slideshow use case |
| S-04 | https://developer.mozilla.org/en-US/docs/Web/API/Window/getScreenDetails | official reference | experimental status, HTTPS and permissions |
| S-05 | https://developer.mozilla.org/en-US/docs/Web/API/ScreenDetails | official reference | live screen topology and mirrored-screen exclusion |
| S-06 | https://developer.mozilla.org/en-US/docs/Web/API/Window/open | official reference | popup blocker and user gesture constraints |
| S-07 | https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API | official reference | fullscreen behavior |
| S-08 | https://www.w3.org/TR/presentation-api/ | web standard draft | Presentation API scope and maturity |
| S-09 | https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API | official reference | same-origin cross-context communication |
| S-10 | https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API | official reference | stable bidirectional transport and backpressure caveat |
| S-11 | https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API | official reference | peer data/media capabilities |
| S-12 | https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API | official reference | HTTPS and offline shell |
| S-13 | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia | official reference | microphone permission and secure context |
| S-14 | https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html | security guidance | authentication, Origin, limits and logging |
| S-15 | https://nextjs.org/docs/app/guides/progressive-web-apps | framework docs | Next.js PWA support |
| S-16 | https://vite-pwa-org.netlify.app/ | framework plugin docs | Vite/Workbox offline support |
| S-17 | https://supabase.com/docs/guides/realtime | service docs | realtime broadcast and presence |
| S-18 | https://supabase.com/docs/guides/auth | service docs | JWT authentication and RLS integration |
| S-19 | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | database docs | default-deny row policies |
| S-20 | https://github.com/pgvector/pgvector | primary repository | Postgres vector search |
| S-21 | https://platform.openai.com/docs/guides/realtime-transcription | provider docs | partial and final streaming transcripts |
| S-22 | https://cloud.google.com/speech-to-text/docs/streaming-recognize | provider docs | streaming STT alternative |
| S-23 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text | provider docs | streaming STT alternative |
| S-24 | https://developers.cloudflare.com/durable-objects/ | platform docs | stateful realtime session coordinator |
| S-25 | https://docs.livekit.io/home/client/connect/ | platform docs | room-based realtime media/data |
| S-26 | https://www.postgresql.org/docs/current/textsearch.html | database docs | lexical full-text search |
| S-27 | https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | official reference | local structured cache |
| S-28 | https://support.microsoft.com/en-us/office/rehearse-your-slide-show-with-speaker-coach-cd7fc941-5c3b-498c-a225-83ef3f64f07b | first-party product docs | Speaker Coach feature boundary |
| S-29 | https://support.google.com/docs/answer/14355071 | first-party product docs | Gemini in Slides features |
| S-30 | https://www.yoodli.ai/ | first-party product page | Yoodli positioning |
| S-31 | https://orai.com/ | first-party product page | Orai positioning |
| S-32 | https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy | official reference | exact origin boundary |
| S-33 | https://developer.mozilla.org/en-US/docs/Web/API/Window/opener | official reference | cross-origin opener restrictions |
| S-34 | https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage | official reference | exact targetOrigin and receiver validation |
| S-35 | https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register | official reference | service worker origin/scope constraint |
| S-36 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy | official reference | opener isolation |
| S-37 | https://datatracker.ietf.org/doc/html/rfc6455 | standard | WebSocket protocol |
| S-38 | https://datatracker.ietf.org/doc/html/rfc8445 | standard | ICE NAT traversal |
| S-39 | https://datatracker.ietf.org/doc/html/rfc8656 | standard | TURN relay |
| S-40 | https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ | security guidance | human approval and downstream authorization |
| S-41 | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | security guidance | cookie scope and session isolation |
| S-42 | https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html | security guidance | origin-wide browser storage risks |
| S-43 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors | official reference | anti-framing stage policy |
| S-44 | https://python-pptx.readthedocs.io/en/latest/api/slides.html | library docs | stable slide IDs and notes extraction |
| S-45 | https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html | first-party docs | headless office conversion |
| S-46 | https://pymupdf.readthedocs.io/en/latest/recipes-text.html | library docs | positioned PDF extraction |
| S-47 | https://revealjs.com/events/ | library docs | authoritative slidechanged events |
| S-48 | https://learn.microsoft.com/en-us/azure/search/search-security-trimming-for-azure-search | vendor docs | principal-string authorization caveat |
| S-49 | https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview | vendor docs | hybrid retrieval and RRF |
| S-50 | https://developers.deepgram.com/docs/models-languages-overview | provider docs | Korean model support |
| S-51 | https://developers.deepgram.com/docs/understand-endpointing-interim-results | provider docs | interim/final and endpointing |
| S-52 | https://www.rfc-editor.org/rfc/rfc8628.html | standard | device authorization pairing |
| S-53 | https://www.rfc-editor.org/rfc/rfc9700.html | standard | replay and audience restrictions |
| S-54 | https://supabase.com/docs/guides/functions/quickstart | service docs | Deno/TypeScript edge runtime |
| S-55 | https://cloud.google.com/run/pricing | provider pricing | Python parser worker free allocation and regions |
| S-56 | https://supabase.com/pricing | provider pricing | measured MVP limits at 2026-08-13 |
| S-57 | https://developers.cloudflare.com/workers/platform/pricing/ | provider pricing | measured Workers limits at 2026-08-13 |
| S-58 | https://deepgram.com/pricing | provider pricing | measured STT rates and credit at 2026-08-13 |
| S-59 | https://platform.openai.com/docs/pricing | provider pricing | measured model rates at 2026-08-13 |
| S-60 | https://posthog.com/pricing | provider pricing | measured observability limits at 2026-08-13 |
| S-61 | https://w3c.github.io/window-management/#usage-overview-initiate-multi-screen-experiences | standard example | one-gesture multi-screen topology |
| S-62 | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable | official reference | installability requirements |
| S-63 | https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers | official reference | update lifecycle and version cohorts |
| S-64 | https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/ | browser vendor | installed Edge PWA behavior |
| S-65 | https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/ux | browser vendor | Windows app integration without extra privileges |
| S-66 | https://developer.mozilla.org/en-US/docs/Web/API/Presentation_API | official reference | non-Baseline casting/receiver alternative |
| S-67 | https://datatracker.ietf.org/doc/html/rfc6454 | standard | origin semantics |
| S-68 | https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis | standard draft | __Host- cookie requirements |
| S-69 | https://html.spec.whatwg.org/dev/web-messaging.html#broadcasting-to-other-browsing-contexts | standard | BroadcastChannel same-origin scope |
| S-70 | https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html | security guidance | deny-by-default and per-request authorization |
| S-71 | https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html | security guidance | hostile retrieved content |
| S-72 | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ | security guidance | indirect prompt injection |
| S-73 | https://genai.owasp.org/llmrisk/llm08-vector-and-embedding-weaknesses/ | security guidance | vector/embedding isolation |
| S-74 | https://csrc.nist.gov/pubs/sp/800/162/upd2/final | standard guidance | attribute-based access control |
| S-75 | https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng | regulation | privacy principles and erasure baseline |
| S-76 | https://www.law.go.kr/법령/개인정보보호법 | regulation | Korea PIPA baseline |
| S-77 | https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop | official reference | microphone shutdown |
| S-78 | https://datatracker.ietf.org/doc/html/rfc9000 | standard | QUIC properties without application SLO |
| S-79 | https://datatracker.ietf.org/doc/html/rfc3986#section-3.5 | standard | URI fragment semantics |
| S-80 | https://www.w3.org/WAI/WCAG22/Understanding/reflow.html | accessibility standard | 320px console reflow |
| S-81 | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | accessibility standard | minimum target size |
| S-82 | https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html | accessibility standard | visible keyboard focus |
| S-83 | https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html | accessibility standard | non-focus-stealing live status |
| S-84 | https://web.dev/learn/pwa/serving/ | platform guidance | service worker caching strategies |
| S-85 | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching | official reference | cache-first/network-first split |
| S-86 | https://www.wipo.int/copyright/en/ | international guidance | copyright baseline |
| S-87 | https://creativecommons.org/about/cclicenses/ | license authority | CC license conditions |
| S-88 | https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution | license authority | TASL attribution |
| S-89 | https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html | security guidance | safe asset fetching |
| S-90 | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | security guidance | asset validation |
| S-91 | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | security guidance | state-changing request protection |
| S-92 | https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html | security guidance | untrusted transcript/RAG rendering |
| S-93 | https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html | security guidance | strict CSP and Trusted Types |
| S-94 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/display-capture | official reference | disable display capture on audience origin |
| S-95 | https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html | security guidance | prevent private payload logging |
| S-96 | https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html | security guidance | generic audience errors |
| S-52 | https://www.rfc-editor.org/rfc/rfc8628.html | standard | device authorization pairing |
| S-53 | https://www.rfc-editor.org/rfc/rfc9700.html | standard | replay and audience restrictions |
| S-54 | https://supabase.com/docs/guides/functions/quickstart | service docs | Deno/TypeScript edge runtime |
| S-55 | https://cloud.google.com/run/pricing | provider pricing | Python parser worker free allocation and regions |
| S-56 | https://supabase.com/pricing | provider pricing | measured MVP limits at 2026-08-13 |
| S-57 | https://developers.cloudflare.com/workers/platform/pricing/ | provider pricing | measured Workers limits at 2026-08-13 |
| S-58 | https://deepgram.com/pricing | provider pricing | measured STT rates and credit at 2026-08-13 |
| S-59 | https://platform.openai.com/docs/pricing | provider pricing | measured model rates at 2026-08-13 |
| S-60 | https://posthog.com/pricing | provider pricing | measured observability limits at 2026-08-13 |
