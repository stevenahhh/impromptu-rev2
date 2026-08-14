# Hyperplan Debate Ledger

## Input

- `docs/PWA-구현-최적화-연구보고서.md`
- `.omo/ulw-research/20260814-040838/`
- User hard requirement: the implementation plan must cover both Windows extended-display mode and mirrored-display mode with a second-device Presenter Console.

## Round 1

### Scope critic attack

1. Pre-approved evidence + approval state machine should precede STT/search.
2. Separate origins and WSS/session service may be overbuilt for an extended-only demo.
3. BroadcastChannel could serve same-origin extended mode.
4. Rights pipeline, analytics vendor, multi-credential taxonomy and takeover UX should be deferred.

### Lead ruling

- Accepted: pre-approved evidence and publication state machine move before live AI.
- Rejected: extended-only completion. It contradicts the user's explicit requirement that both extended and mirrored modes be implemented.
- Partially accepted: BroadcastChannel may optimize local same-origin development, but cannot be the authoritative contract because mirror mode and the security boundary need WSS.
- Accepted: PostHog, full rights automation, WebRTC/WebTransport, anonymous pairing, E2EE and fully offline LAN stay outside initial implementation.

### Systems critic attack

1. A private-origin launcher cannot become a public Stage while preserving two-site isolation and fullscreen activation.
2. Public Stage must not connect to a session authority that can expose private topics; it needs a separate projection gateway/store.
3. Mirror-mode bootstrapping is circular if the presentation PC has only AudienceDisplaySession but a private Console on that PC must approve the phone.

### Lead ruling

- Extended mode uses one of two explicit flows:
  - default security-first: Private Console opens Public Stage on target screen; Stage-local click enters fullscreen;
  - optional one-click enhancement: neutral Public launcher becomes Stage and opens Private Console, only after this distinct flow is tested.
- Architecture separates Private Session Authority from Public Projection Gateway/store. Display receipts use a narrow reverse contract; “data diode” refers to content confidentiality, not literally one-way networking.
- Mirror zero-state is phone-first: authenticated phone owns the session, guest/InPrivate presentation PC opens Stage with a non-authorizing `display_join_id`, phone approves that display binding.

## Open debate

- Whether separate registrable domains are day-one or a hardening milestone.
- Minimum pairing/session/takeover state needed to satisfy mirror mode without overengineering.
- Product ladder that implements both modes before live-web public evidence.
- Exact implementation phases and release gates.

## Round 2

### Delivery critic ruling

- Same-origin BroadcastChannel is acceptable only as a throwaway feasibility demo, not the product contract.
- Product MVP requires both manual extended and mirrored flows, separate origins/builds, a minimal WSS/session spine, and negative reachability tests.
- Separate registrable domains are later hardening; sibling subdomains with host-only cookies, exact Origin, CSRF, separate SW/builds are acceptable initially.
- Mirror bootstrap is phone-first: Stage displays a non-authorizing join locator, authenticated phone approves the display binding and owns the controller lease.
- Pre-approved publication core precedes STT/search; live public web remains feature-off.

### Product critic ruling

- Product promise: “Windows 확장·복제 환경에서 비공개 controller가 private leak 없이 pre-approved evidence를 공개·철회한다.”
- Public live evidence and automatic placement must earn inclusion via numeric gates.
- One-card presenter-triggered reveal is the default; no rotation or card flood.
- Both display modes must pass before calling the result a product MVP.

### Surviving plan shape

`feasibility evidence -> contracts/harness -> curated publication core -> WSS/projection spine -> both display modes -> security/chaos -> ingestion -> private STT/RAG -> guarded public evidence -> optional enhancements`

### Device-trust correction

- Guarded pilot uses an already authenticated private controller device and a public-only Stage browser profile in both Windows topology modes.
- This makes an accidental Windows switch from Extend to Duplicate harmless because the projected machine never contains private Console pixels.
- Stage presents a short-lived non-authorizing display join code; the private device verifies deck/session/display identity and approves binding.
- `displayBindingEpoch` is distinct from `controllerEpoch`; rebind during partition enters `RECONCILE_REQUIRED`.
- A co-resident desktop Console in Extend mode is a later convenience enhancement, not the confidentiality baseline.
- Playback `controllerEpoch`는 card visibility나 CaptureGrant를 무효화하지 않는다. Live card는 session/display/slide occurrence/policy/card version과 PublicCardStream liveness에 묶인다.

### Binding quantitative gates

- Windows 11 + current Chrome/Edge; wired extend, mirror, single-screen fallback; 3 rehearsals per required mode; zero unrecoverable failures and fault recovery <=30s.
- Venue-like profile: >=500 commands p95 <=300ms, >=50 reconnects p95 <=2s, zero duplicate visible effects, zero stale-epoch acceptance.
- Public reachability: seeded canary absence plus endpoint/topic/credential denial, CSP, static bundle scan, bounded differential traces.
- Curated evidence retract: accepted -> ordered tombstone p95 <=500ms, revoked absent after reconnect.
- Live verifier: representative and adversarial suites separate; wrong numeric/date/entity publication zero; false-SUPPORT <=1%; supportable/fetchable yield >=60% within 5s; top-3 relevance >=80%.
- false-SUPPORT 95% one-sided upper bound <1%를 위한 대표 non-supportable zero-escape 최소 표본은 299건이다.
- Presenter approval: median <=2s, p90 <=5s, <=1 induced speech pause per 10 min.
- Audience value: comprehension/source recall +10% without core-slide recall loss >5%; otherwise pivot to Q&A/after-talk.
