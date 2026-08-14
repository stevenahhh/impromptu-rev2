---
plan_id: impromptu-r2-hyperplan
approval_state: APPROVED
execution_state: IN_PROGRESS
repository_state: INITIALIZED
---

# impromptu-r2 구현 Hyperplan

## 0. 계획 상태

- **계획 유형:** Greenfield guarded-pilot 구현 계획
- **현재 상태:** 2026-08-14 실행 승인 후 진행 중. WP0 저장소 기반은 생성되었고 독립 worktree에서 후속 기반 작업이 진행 중이다.
- **프로젝트 이름:** `impromptu-r2`
- **근거:** `docs/신청서.pdf`, `docs/PWA-구현-최적화-연구보고서.md`, `.omo/ulw-research/20260814-040838/`, `.omo/hyperplan/pwa-presentation-debate.md`
- **제품 완료 조건:** Windows 확장·복제 환경 모두에서 별도 private controller 기기가 Public Stage를 제어하고, pre-approved evidence와 supervised live evidence를 공개·철회하며, Stage에 private data path가 관찰되거나 provision되지 않는다.
- **인력·기간:** 5 core FTE + part-time privacy/ops 기준 13~16주. 3 generalist이면 20~26주 또는 live-public AI와 자동 배치를 명시적으로 제거한다.
- **저장소 상태:** Git 저장소와 project policy skeleton이 commit `31ec229`에서 초기화되었다. 현재 작업은 topic branch/worktree에서 수행하고 integration owner가 검증 후 통합한다.
- **WP0 증거 상태:** `BLOCKED`. 계획 실행 승인은 제품 오너의 평가 threshold 승인, staffing 수락, vendor/privacy 승인 또는 holdout 통과를 뜻하지 않는다.

### 구현 시작 승인 기록

사용자가 이 plan의 실행을 명시했고 다음 시작 경계는 완료되었다.

1. `git init`과 `.gitignore` 생성 및 검증.
2. `chore(repo): initialize impromptu-r2 workspace` local atomic commit (`31ec229`).
3. 독립 topic branch/worktree에서 WP0 이후 dependency 작업 시작.

Provider account 설정, 대표 deck/corpus 수집, holdout freezing/unblinding과 provisional live gate 승인은 아직 수행되지 않았다. 해당 작업은 아래 WP0 blocking evidence contract를 만족하기 전까지 통과로 주장하지 않는다.

## 1. 잠긴 결정

### 1.1 보안·디바이스

1. **양 화면 모드의 보안 기본값은 동일하다:** 깨끗한 public Stage PC/browser profile + 이미 인증된 private controller phone/tablet/laptop.
2. 확장 화면에서도 co-resident Console은 편의 기능일 뿐이다. `Win+P`가 Duplicate로 바뀌는 순간 private pixel이 노출될 수 있으므로 “no private pixel” 주장은 별도 기기 Console에만 붙인다.
3. Private Console과 Public Stage는 별도 origin·build·service worker·cookie·BFF/WSS endpoint를 사용한다. guarded pilot은 sibling subdomain을 허용하되 host-only cookie, synchronizer CSRF token, exact Origin, CSP를 강제한다. 별도 registrable domain은 후속 hardening이다.
4. Stage는 public projection gateway/store만 접근한다. Private Session Authority, transcript, candidate, private deck, RAG, team message 경로에 credential이나 network route가 없다.
5. 자동 배치는 보안 경계가 아니다. Stage는 자기 문서에서 명시적 클릭으로 fullscreen한다.

### 1.2 권위·상태

- Stage/viewer: 관찰된 `(deckVersion, publicSlideKey, slideSeq)` 권위
- Session Authority: controller lease, command acceptance, display binding
- Publish Service: card publication CAS, tombstone, expiry
- 별도 gap-free revision:
  - `controlRevision`
  - `publicPlaybackRevision`
  - `publicCardRevision`
- 별도 capability:
  - `PlaybackControlLease`
  - `PublicationAuthority`
  - `CaptureGrant`
  - `DisplayBinding`
- 별도 epoch:
  - `controllerEpoch`
  - `displayBindingEpoch`

### 1.3 Evidence

1. `CURATED_PREAPPROVED`: version/current/rights/DLP 통과 후 명시 승인으로 공개 가능.
2. `LIVE_VERIFIED`: 확정 발화에서 생성하고 verifier를 통과해도 기본은 private. 별도 품질 게이트를 통과한 feature-flagged supervised 경로에서만 공개 가능.
3. `SUPPORTED`는 “공개됨”이 아니라 “공개 자격 후보”다.
4. public JSON은 server가 `candidate_id`로부터 만든 닫힌 DTO다. Console/LLM은 public payload를 제출하지 않는다.
5. 의료·법률·금융 고위험 주장은 guarded-pilot live-public에서 제외한다.

### 1.4 5초 계약

- 시작: expert-annotated semantic acoustic endpoint
- 종료: eligible candidate가 private Console에 render
- 최대 3개
- p95 <= 5초
- timeout, error, stale-slide late insert, answerable event에서의 abstention은 failure
- component timing은 진단용이며 p95 합산을 end-to-end 증명으로 사용하지 않는다.

### 1.5 AI 실행 경계

**결정:** 모델 추론, 임베딩, OCR/VLM, STT decoding, 검색 query 생성, RAG reranking, 근거 verdict, DLP/PII model inference, coaching inference와 report summary 생성은 모두 서버에서만 실행한다.

클라이언트 PWA가 허용하는 일:

- microphone capture와 encrypted streaming upload
- slide/display event 관찰
- deterministic schema validation
- 이미 서버가 승인한 public DTO 렌더링
- local timer, connection state, cached public deck navigation
- 단순 문자열 정규화·UI 정렬·접근성 처리
- 서버 발급 lease/expiry/tombstone의 결정론적 적용

클라이언트 PWA가 금지하는 일:

- WebGPU/WASM/ONNX/TensorFlow.js를 이용한 모델 inference
- browser-side OCR, embedding, reranker, LLM/VLM/STT
- model weight·tokenizer·vector corpus download/cache
- raw internal RAG corpus 또는 private prompt를 Stage/Console bundle에 포함
- client-generated verdict·public payload·ACL decision
- offline fallback이라는 이유로 작은 모델을 자동 실행

서버 adapter 계약:

```text
Audio/Deck/Event DTO
  -> authenticated server boundary
  -> ServerModelRouter
      -> STT adapter
      -> OCR/VLM adapter
      -> embedding/rerank adapter
      -> LLM/verifier adapter
  -> typed result + model/version/policy/latency metadata
```

모든 provider 호출은 server-side secret manager를 사용하고, client bundle·source map·network payload에 provider API key가 없어야 한다. “경량” 여부가 애매하면 서버에서 실행하는 것을 기본값으로 한다.

### 1.6 배포 topology와 데이터 소유권

`services/*`는 개별 microservice를 뜻하지 않는다. guarded pilot은 다음 **4개 deployable**만 사용한다.

1. `console-web`: private PWA static build. private cookie를 읽지 못하고 같은 origin Console BFF만 호출한다.
2. `stage-web`: public PWA static build. AudienceDisplaySession만 사용하고 Projection Gateway만 호출한다.
3. `private-backend`: modular monolith. Console BFF, Session Authority, Publish, Ingestion job control, Retrieval, Verifier, Model Router를 한 process/deployment 안의 module로 둔다.
4. `projection-gateway`: Stage 전용 public BFF/WSS. public projection tables/topics만 읽고 private schema, object storage prefix, provider secret에 IAM/network access가 없다.

Postgres는 한 cluster를 사용할 수 있지만 DB role과 schema를 분리한다.

- `private_app_role`: private schema와 public projection write transaction
- `projection_role`: public projection read + narrow display receipt write
- migration owner: deploy pipeline 전용, runtime에서 사용 금지

Object storage도 `private-decks/`와 `published-decks/` bucket/prefix 및 signing key를 분리한다. Public Stage는 `PublishedDeckArtifact`와 `PublishedAudienceCard`만 읽는다.

### 1.7 인증·session·capability 발급

- Account identity: Supabase Auth 또는 동등한 OIDC provider. browser가 provider access/refresh token을 저장하지 않고 Console BFF가 server-side session으로 교환한다.
- `AccountSession`: Console origin의 `__Host-account` HttpOnly/Secure/SameSite cookie.
- `PresentationSession`: account authorization에서 server가 생성하는 presentation-scoped private session.
- `PublicationAuthority`: account/role policy에서 server가 발급하고 매 publish/retract CAS에서 재검증.
- `PlaybackControlLease`: 명시적 acquire/replace transaction으로 한 actor에게 발급.
- `CaptureGrant`: consent record와 capture device를 묶어 별도 발급.
- `display_join_id`: Stage가 Projection Gateway에 요청하는 128-bit+ CSPRNG opaque locator. 90초 TTL, single-use, non-authorizing.
- `AudienceDisplaySession`: 인증된 controller가 deck/session/display fingerprint를 승인하고 DisplayBinding CAS가 성공한 뒤 Stage origin에만 host-only cookie로 발급.

HTTP mutation은 synchronizer CSRF token + exact Origin/Referer를 요구한다. WSS는 cookie 인증 전 101을 반환하지 않고 exact Origin을 검사한다. Session ID, provider token, pairing secret은 URL/query/fragment/Web Storage/log에 두지 않는다.

### 1.8 Protocol identity와 epoch 의미

- `presentationSessionEpoch`: session start/restart/rebind로 증가하며 모든 playback/card causal envelope의 상위 identity.
- `displayBindingEpoch`: Stage binding CAS마다 증가.
- `controllerEpoch`: PlaybackControlLease 교체마다 증가하며 playback command에만 적용.
- `publicSlideOccurrence`: `{publicSlideKey, occurrenceSeq}`. 같은 slide 재방문마다 새 occurrence를 만든다.
- `candidateVersion`: candidate 내용을 바꾸지 않고 supersession은 새 candidate ID/version으로 생성한다.
- `publicationPolicyVersion`: rights/DLP/claim-class policy snapshot.

각 role stream revision은 해당 presentation session의 Postgres transaction에서 gap-free로 할당한다. Internal global event sequence가 있더라도 client에 노출하지 않는다. Playback takeover는 live card나 CaptureGrant를 자동 무효화하지 않는다.

## 2. 목표 파일 구조

```text
apps/
  console/                 # Private React PWA
  stage/                   # Public React PWA
services/
  session/                 # WSS authority, leases, epochs, snapshots
  projection/              # Public gateway/store, receipts
  publish/                 # candidate -> public DTO CAS/tombstone
  ingestion/               # Python upload worker
  retrieval/               # ACL-first hybrid RAG + external fetch
  verifier/                # deterministic + model-assisted verdict
  model-router/            # Server-only AI provider adapters, budgets, policy
packages/
  contracts/               # Zod schemas, role DTOs, protocol versions
  state/                   # pure reducers/state machines
  deck/                    # deck manifest/public-private artifact types
  test-harness/            # replay/fault/differential/canary helpers
  client-safe/             # No-model browser utilities only
infra/
  migrations/              # Postgres schema/RLS
  policies/                # CSP, CORS, Origin, retention
tests/
  contract/
  property/
  security/
  e2e/
  corpus/
docs/
  DEMO-SCOPE.md
  AI-BOUNDARY.md
  threat-model.md
  runbooks/
```

브라우저 import graph는 `services/model-router`, provider SDK, Python AI package를 참조할 수 없다. CI에서 Stage/Console bundle의 model weight, tokenizer, provider key name, forbidden package import를 검사한다.

## 2.1 원자 커밋 운영 계약

구현은 검증된 작은 증분마다 로컬 커밋한다. “WP 완료 후 한 번”이 아니라 아래 루프를 모든 task에 적용한다.

```text
failing test/contract
 -> minimal implementation
 -> scoped diagnostics/tests/manual QA
 -> exact files stage
 -> one local atomic commit
```

규칙:

1. 첫 increment는 `git init`, `.gitignore`, 기본 `README.md`, package/toolchain skeleton만 포함한다.
2. 관련 없는 변경을 한 commit에 섞지 않는다.
3. commit 전 `git diff --cached --check`와 해당 increment의 validator를 통과한다.
4. 실패 중이거나 부분 구현인 상태는 commit하지 않는다.
5. 다른 사람의 기존 변경은 stage하지 않는다.
6. generated report screenshot/PDF, runtime `.omo/senpi-task`, credentials, `.env`, model weights, deck uploads는 `.gitignore`한다.
7. schema와 producer/consumer 변경은 같은 commit에 넣어 각 commit이 green이게 한다.
8. migration과 이를 사용하는 code/test는 같은 atomic increment에 포함한다.
9. fixup/amend/rebase/force 작업은 별도 명시 승인 없이는 하지 않는다.
10. remote push는 요청 범위가 아니며 local commit까지만 수행한다.

병렬 작업은 한 shared worktree에서 하지 않는다.

- 각 contributor/agent는 `git worktree add`로 독립 worktree와 topic branch를 사용한다.
- 하나의 worktree에서 동시에 두 agent가 파일을 수정하지 않는다.
- 각 topic branch는 자체 validator를 통과한 atomic commit만 가진다.
- integration owner는 dependency 순서대로 commit을 검토해 local integration branch에 cherry-pick하고 전체 gate를 다시 실행한다.
- conflict 해결은 별도 `fix(integration): ...` commit으로 남기며 원 커밋을 amend하지 않는다.
- integration branch가 green이기 전 다음 dependent WP를 시작하지 않는다.

커밋 메시지 형식은 아직 저장소 관례가 없으므로 다음 Conventional Commit subset으로 시작한다.

```text
chore(repo): initialize impromptu-r2 workspace
test(protocol): lock public card transitions
feat(projection): publish closed audience DTO
feat(display): bind public stage from private controller
feat(ai): route Korean STT through server adapter
fix(reconnect): reject stale display binding epoch
docs(plan): define server-only AI boundary
```

각 WP의 exit gate를 만족하는 마지막 commit에는 evidence command를 commit body에 기록한다. 구현 중 실제 관례가 안정되면 `CONTRIBUTING.md`에 고정한다.

## 3. Work packages

### WP0 — 결정·평가 사전등록

**기간:** 1주 · **의존성:** 없음

**산출물**

- Git 저장소와 `.gitignore`, `README.md`, `CONTRIBUTING.md`
- `docs/AI-BOUNDARY.md`: client/server 허용·금지 import와 data boundary
- `docs/DEMO-SCOPE.md`: first demo, guarded pilot, 지연 기능, unblock 조건
- 지원 환경: Windows 11 + current Chrome/Edge, wired Extend, Duplicate, single-screen fallback
- 대표 deck 3종과 Korean claim corpus
- frozen hashed disjoint holdout protocol
- staffing owner 표와 vendor account/prewarm runbook

**사전등록 항목**

- corpus hash, claim/paraphrase/source/deck/speaker 분리
- semantic endpoint, expert label, class, network/cache 조건
- sample size, formula, exclusion, failure treatment
- 대표 holdout과 adversarial/security suite 분리
- 실패 후 exposed holdout 폐기, 새 disjoint holdout 생성, 실패 결과 보존

**Gate**

- `git status --short`가 의도한 파일만 표시되고 `.env`, model weight, uploads, runtime artifact가 무시됨
- client bundle/import graph에 AI provider SDK·model runtime·secret name이 없음
- 제품 오너가 잠정 live gates를 평가 전 승인:
  - supportable/fetchable claim 중 5초 내 eligible yield >=60%
  - answerable event top-3 direct usefulness >=80%
  - unanswerable abstention >=95%
- false-SUPPORT one-sided 95% upper bound <1%
- 이 gate의 최소 대표 non-supportable zero-escape 표본은 299건
  - numeric/date/entity critical error 0

**현재 WP0 evidence readiness (2026-08-14)**

| Evidence | Record | Truthful state | Blocking condition |
|---|---|---|---|
| Staffing owners | `docs/wp0/staffing-owners.json` | `BLOCKED`; all required owners `UNASSIGNED` | named assignees must accept each role; product owner must separately approve provisional thresholds |
| Vendor account/prewarm | `docs/runbooks/vendor-prewarm.md` | account `NOT_PROVISIONED`; evidence `NOT_COLLECTED` | privacy/vendor/account/region/retention/deletion approval and pinned-release prewarm evidence |
| Frozen holdout | `tests/corpus/holdout-manifest.json` | corpus `NOT_COLLECTED`; `frozen: false`; gate `BLOCKED` | collect disjoint records, canonicalize/hash, assign approvers, approve protocol before unblinding |
| Korean claim corpus | `tests/corpus/korean-claims.manifest.json` | `NOT_COLLECTED`; gate `BLOCKED` | rights/privacy review, exact record contract, canonical artifact and hash |
| Representative decks | `tests/fixtures/deck-registry.json` | three required fixtures `NOT_COLLECTED`; rights `NOT_APPROVED` | collect Korean font/layout, chart/table, image/scanned fixtures with provenance, rights and hashes |

Repository verification checks both the explicit missing states and their collection/approval contracts. It does **not** interpret these manifests as a passed WP0 product/evaluation gate. WP1 may only consume approved WP0 assumptions; live-public evaluation and any holdout claim remain blocked until the records transition with real evidence.

### WP1 — Contract와 fault harness

**기간:** 1주 · **의존성:** WP0

**구현**

- `PrivateDeckContext`와 `PublishedDeckArtifact` 분리
- role session, command, snapshot, receipt, publication, tombstone schema
- causal envelope:
  - presentation session epoch
  - display binding epoch
  - deck version/manifest hash
  - public slide occurrence `{publicSlideKey, occurrenceSeq}`
  - transcript final ID
  - source/revision/content hash
  - ACL/policy/rights/DLP decision version
- formal transition table에서 legal/illegal transition, concurrent approve/retract, partition, stale snapshot, incompatible build를 열거
- `{releaseId, protocolRange, buildId}` handshake
- pure reducers와 generated schedule property tests

**명령·상태 규칙**

1. current lease/epoch를 먼저 검증
2. `(session, actor, epoch, commandId)` + request hash dedupe
3. 동일 payload duplicate는 original ACCEPTED receipt
4. 다른 payload는 `IDEMPOTENCY_CONFLICT`
5. `ACCEPTED`와 `STAGE_APPLIED`를 분리
6. relative command는 ready/bound Stage에서만 허용, offline queue 금지

**Gate**

- duplicate/out-of-order/gap/restart/CAS schedule에서 terminal state가 결정적
- unauthorized role/topic/read/write 모두 거부
- restart 후 role-scoped snapshot 복구
- unknown public schema field 거부

**권고 원자 커밋**

1. `test(contracts): define role-scoped protocol fixtures`
2. `feat(contracts): add closed public schemas`
3. `test(state): cover legal and illegal transitions`
4. `feat(state): implement deterministic reducers`
5. `test(protocol): add restart and stale-epoch properties`

### WP2 — 병렬 기반

**기간:** 2주 · **의존성:** WP1

#### WP2-A Two-site noninterference spike

- 별도 Console/Stage static build·origin·SW
- private authority와 public projection endpoint 분리
- Stage XSS/third-party simulation이 cookie/storage/SW/private API/private WSS/topic을 공격
- public CSP `connect-src`, no third-party JS, exact Origin

**Gate**

- seeded canary 0 byte
- endpoint/topic/credential reachability deny
- static bundle scan clean
- varied private input에 대한 bounded differential audience trace clean
- 이 증거의 표현: “선언한 threat model에서 private data path가 관찰되거나 provision되지 않음”

#### WP2-B Coordinator persistence spike

- Postgres transaction/CAS 기반 lease, binding, snapshot, tombstone
- Redis/NATS/Supabase Realtime은 correctness primitive로 사용하지 않음

**Gate**

- process restart, duplicate, stale epoch, concurrent bind/takeover에서 linearizable result
- slow consumer bounded queue, superseded state coalescing

#### WP2-C Canonical ingestion corpus

- Python 3.14 + `uv`
- ingestion은 server/local-admin worker이며 PWA browser에서 Python/WASM parser나 OCR model을 실행하지 않음
- python-pptx, LibreOffice headless, PyMuPDF
- 3종 한국어 PPTX/PDF: font, chart/table, image/scanned

**Gate**

- stable deck/slide identity
- deterministic manifest hash
- accepted render fidelity
- private notes가 `PublishedDeckArtifact`에 0 byte
- 실패 slide는 selective OCR/VLM 또는 명시적 unsupported warning

#### WP2-D ServerModelRouter와 AI boundary

- `private-backend` 내부 `ServerModelRouter` interface와 typed provider adapters
- server-only secret loading, outbound provider allowlist, timeout/cancellation, budget/tenant quota
- 모든 result에 provider/model/version/policy/latency/trace metadata
- STT, OCR/VLM, embedding, rerank, LLM/verifier, DLP/PII, coaching/report-summary capability registry
- Console/Stage build의 forbidden import/bundle scan
- browser CSP에서 AI provider origin 직접 연결 금지

**Gate**

- fake provider contract tests와 provider timeout/cancel tests
- browser bundle에 provider SDK, model runtime, tokenizer, weight, secret identifier 0
- client가 provider endpoint에 직접 연결하면 CSP·network test로 실패
- DLP/PII model decision은 Publish Service가 server-side policy version과 함께 재검증

### WP3 — Prepared-evidence end-to-end slice

**기간:** 2주 · **의존성:** WP2-A/B/C

**흐름**

```text
upload
 -> private/public deck artifacts
 -> authenticated private controller
 -> Stage display_join_id
 -> controller verifies deck/session/display
 -> DisplayBinding CAS
 -> AudienceDisplaySession
 -> absolute slide.set
 -> Stage applied receipt
 -> curated candidate approve
 -> PublishedAudienceCard
 -> retract/expire tombstone
```

**Pairing**

- QR/code는 short-lived non-authorizing locator
- code 소유는 controller/private scope를 부여하지 않음
- authenticated controller가 Stage identity를 승인
- exactly one binding wins
- replay/expiry/wrong deck/concurrent bind 거부

**Public card stream**

- ordered upsert/tombstone
- `PUBLISHED | RETRACTED | EXPIRED`
- projection ID는 private ID와 correlation 불가
- snapshot은 tombstone watermark/retention 포함
- connected retract -> ordered tombstone p95 <=500ms
- reconnect snapshot에서 revoked content 제외

**Gate**

- public Stage clean profile에서 전체 흐름 성공
- old binding socket 즉시 close
- wrong `displayBindingEpoch` 거부
- card stale/resurrection 0

### WP4 — Windows 두 화면 모드

**기간:** 2주 · **의존성:** WP3

같은 WSS/projection protocol을 사용하고 topology는 setup instruction만 바꾼다.

#### Extend

- public Stage PC/projector
- private controller는 별도 기기
- manual drag + Stage-local fullscreen이 canonical
- co-resident Console은 convenience flag 뒤에 두고 no-private-pixel claim 금지

#### Duplicate

- PC에는 Public Stage profile/session만 존재
- private controller는 phone/tablet/laptop
- accidental Extend->Duplicate와 Duplicate->Extend를 모두 drill

#### Single-screen fallback

- Stage-only public mode
- private controller는 별도 기기
- local emergency keyboard fallback은 공개 slide absolute set만 허용

**Fault matrix**

- popup blocked
- fullscreen exit
- monitor unplug
- Win+P topology switch while projector recording
- browser refresh
- phone lock/background
- WSS drop/server restart

**Gate**

- 각 required mode 3 full rehearsals
- unrecoverable failure 0
- injected-fault recovery <=30s
- fresh signed-out user audience-ready success >=85%, median <=3m, p90 <=5m
- private pixel 0; 하나라도 나오면 co-resident convenience feature 비활성

### WP5 — Realtime·reconnect soak

**기간:** 1주 · **의존성:** WP4

**Gate profile**

- venue-like >=500 commands
- command -> `STAGE_APPLIED` p95 <=300ms
- >=50 reconnects
- reconnect -> snapshot p95 <=2s
- duplicate visible effect 0
- stale epoch acceptance 0

**Partition semantics**

- cached Stage는 public slides를 absolute local navigation할 수 있음
- dynamic/live cards는 server lease 기반
- explicit error/tombstone/stale/epoch change 또는 lease expiry 시 hide
- 여기서 epoch는 `presentationSessionEpoch` 또는 `displayBindingEpoch`이며 playback-only `controllerEpoch` 변경은 card visibility를 무효화하지 않음
- lease <=3s, silent-partition exposure <=3s
- reconnect는 hash-pinned absolute state를 보고
- binding/manifest가 다르면 `RECONCILE_REQUIRED`
- relative replay와 snapshot blind overwrite 금지
- curated card offline 지속은 signed package의 `offlineDisplayAllowed` + local expiry일 때만

### WP6 — Audio consent와 STT bake-off

**기간:** 2주 · **의존성:** WP4, WP2-C

**구현**

- purpose/vendor/region/retention/deletion notice
- short-lived CaptureGrant
- raw PCM memory ring <=30s, durable storage 금지
- CaptureGrant revoke/expiry, capture actor logout, session end, explicit stop에 track/uploader/vendor stream 종료
- PlaybackControlLease transfer만으로 capture를 중단하지 않으며, 중단하려면 같은 transaction에서 CaptureGrant를 명시적으로 revoke
- adapter: Deepgram/Azure/Google/AWS
- audio capture 외의 endpointing/finalization/STT decoding은 server model-router가 수행
- delayed final을 processing-time current slide와 join하지 않음
- capture-time slide history로 bind
- revision spanning utterance는 split 또는 `AMBIGUOUS`
- 다른 기기의 audio와 Stage event를 위해 session readiness에서 monotonic device-to-session clock mapping과 uncertainty를 측정
- `[audioStart-uncertainty, audioEnd+uncertainty]` 전체를 한 immutable slide occurrence가 덮을 때만 eligible
- reconnect 후 mapping 불연속·boundary crossing·허용치 초과 uncertainty는 `AMBIGUOUS`로 abstain
- replay를 위해 audio interval, slide occurrence ID, mapping version, uncertainty, verdict를 보존
- partial STT는 cancelable speculation, final과 causal match 없으면 폐기

**Gate**

- no grant frame reject
- revoke 후 next frame reject
- raw audio storage/log 0
- 100% candidate가 올바른 slideSeq 또는 AMBIGUOUS
- frozen Korean corpus에서 provider 선택 기록

### WP7 — Private retrieval·verifier

**기간:** 2주 · **의존성:** WP6

**Internal**

- server-derived principal
- tenant partition + ABAC/ReBAC prefilter before ANN
- object post-auth
- materialization·publication 직전 재인가
- policy unavailable/stale metadata -> zero result

**External**

- search snippet은 후보만
- HTTPS origin fetch, redirect마다 private/link-local/metadata IP 차단
- size/time/type limits
- canonical URL/date/hash/anchor/quote

**Verifier**

- number/unit/date/entity deterministic reconciliation
- retrieved content는 untrusted data
- model은 tool/URL/ACL/publication을 선택하지 못함
- terminal recommend-or-abstain by 5s
- embedding, reranking, LLM structured output, verifier model inference는 server model-router 전용

**Gate**

- cross-tenant/group deny
- ACL revoke between retrieval/approval deny
- stale deck/source hash deny
- prompt injection·SSRF·PII·unknown rights publish 0
- private Console end-to-end p95 <=5s

### WP8 — Supervised live publication

**기간:** 2주 · **의존성:** WP7, WP5

**구현**

- `verdict`, `publication`, `freshness`의 독립 state
- `PublicationAuthority`는 playback controller lease와 분리
- presenter 또는 approved teammate가 candidate-version CAS로 승인
- automatic publication 금지
- multiple approver race는 CAS+idempotency로 한 결과
- live public card lease <=3s
- live card binding은 `{presentationSessionEpoch, publicSlideOccurrence, publicationPolicyVersion, cardVersion}`이며 playback takeover와 독립
- explicit retract/tombstone p95 <=500ms
- fresh authoritative snapshot/new lease 없이 재노출 금지

**Gate**

- frozen representative holdout:
  - false-SUPPORT <=1%와 one-sided 95% upper bound <1%
  - wrong numeric/date/entity 0
  - false-CONFLICT <=5%
  - authoritative conflict auto-publish 0
  - usefulness/yield/abstention preregistered thresholds 통과
- separate adversarial suite critical escape 0
- approval median <=2s, p90 <=5s
- induced speech pause <=1/10min
- effort delta <1/7
- stale candidate approval 0

**실패 시**

- live public flag OFF
- private LIVE_VERIFIED + curated public publication으로 guarded pilot 진행
- application full contract는 미완료로 명시하며 완료로 주장하지 않음

### WP9 — Audience value와 optional enhancements

**기간:** 2주 · **의존성:** WP8

#### Audience study

- baseline slides
- presenter-triggered curated card
- supervised live card

**Gate**

- source recall/answer correctness +10 points
- core-slide recall loss <5 points
- distraction report <20%
- n=10은 formative; superiority claim 금지
- 실패 시 Q&A/after-talk evidence로 pivot

#### Window Management enhancement

- feature detection only
- manual flow remains canonical
- target screen placement, topology change recovery

**Gate**

- supported Windows Chrome/Edge success >=95%
- median setup saving >=20s
- privacy incident 0
- failure >5%이면 marketing/feature 제거

### WP10 — 보고·삭제·release hardening

**기간:** 2~3주 · **의존성:** WP5~9

**구현**

- append-only/tamper-evident event는 bounded retention 안에서만 사용
- event-derived report와 purpose-limited erasable metrics
- “immutable event store” 용어 금지
- provider/transcript/vector/cache/report/export deletion receipt
- SW active-session build pinning, compatible cohort readiness
- update는 session 종료 후
- accessibility: 320px, 200%, keyboard, screen reader, forced colors
- runbook: prewarm, captive portal, vendor outage, emergency PDF/URL
- coaching inference와 report summary는 `ServerModelRouter`의 optional server-only adapter로 구현하며, deterministic metrics/report는 model 없이 생성 가능해야 함

**Release gate**

- target venue/hardware 10회 연속 P0 failure 0
- setup/publish/retract/recovery task completion 100%
- privacy-critical mistake 0
- deletion cascade와 backup tombstone restore test 통과
- Stage-compromise test 통과
- public/private schema and reachability negative matrix 통과

## 4. Test-first 규칙

각 behavioral increment는 다음 순서를 지킨다. 문서·설정·순수 scaffold increment는 failing test 대신 해당 static validator 또는 smoke check를 먼저 정의한다.

1. contract/property/E2E에 실패 test 작성
2. 올바른 이유로 실패 확인
3. 최소 구현
4. 관련 test 1회 green
5. 실제 matching surface manual QA

권고 명령:

```bash
bun install
bun run lint
bun run typecheck
bun test
bun run test:property
bun run test:security
bun run test:e2e
uv sync --project services/ingestion
uv run --project services/ingestion pytest
uv run --project services/ingestion ruff check .
uv run --project services/ingestion basedpyright
```

프로젝트 생성 후 위 명령을 root scripts로 고정한다. 실제 package manager/tool version은 lockfile에 pin한다.

각 green increment 후:

```bash
git diff --cached --check
git status --short
git commit -m "<type>(<scope>): <verified increment>"
```

단, 실제 stage 대상은 그 increment에서 직접 만든 파일만 명시적으로 선택하며 `git add .`를 기본값으로 사용하지 않는다.

## 5. Manual QA matrix

### CLI/ingestion

- valid PPTX/PDF
- malformed/unsupported file
- Korean font/chart/table/image-heavy deck
- `--help`

### HTTP/WSS

- valid controller/display
- wrong Origin
- expired/replayed display join
- duplicate/out-of-order/stale epoch
- restart/reconnect
- slow consumer/oversized frame

### Browser

- Windows 11 Chrome/Edge
- Extend/Duplicate/single screen
- installed PWA/browser tab
- popup denied/fullscreen exit/monitor unplug
- Win+P transition while recording projected output
- phone lock/network handoff
- offline/lease expiry/tombstone/reconnect

### Security

- compromised Stage XSS simulation
- cookie/storage/SW/cache/log/telemetry enumeration
- private API/topic reachability
- private canary differential trace
- ACL revoke, prompt injection, SSRF, PII, rights denial

## 6. Non-goals

- anonymous pairing
- WebRTC/WebTransport/LAN relay
- fully offline AI
- Electron/native wrapper
- Kubernetes/microservices/event-store product
- automatic live publication
- high-impact medical/legal/financial live-public claims
- multi-controller free-for-all
- raw audio retention
- browser/local-device AI inference와 model weight 배포
- client-side OCR/STT/embedding/VLM/LLM fallback
- general chat-first collaboration
- automatic placement as completion dependency

## 7. 종료 기준

Guarded-pilot MVP는 다음을 모두 만족할 때만 완료다.

1. Windows Extend와 Duplicate 모두 별도 private controller로 동작한다.
2. Public Stage에 private path가 관찰되거나 provision되지 않는다.
3. curated card publish/retract/expiry와 tombstone 복구가 결정적이다.
4. voice-triggered 최대 3개 private eligible recommendation이 preregistered 5초·품질 gate를 통과한다.
5. supervised live candidate -> explicit approval -> public Stage 경로가 feature flag 아래 존재하고 safety gate를 통과한다.
6. automatic placement 없이 manual flow로 모든 supported 환경이 동작한다.
7. release matrix, accessibility, deletion, venue rehearsals가 모두 green이다.

Live-public gate가 실패하면 private recommendation과 curated publication은 출시할 수 있으나, 신청서의 full MVP contract 완료라고 주장하지 않는다.
