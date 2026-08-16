# ULW-Research Synthesis: impromptu-r2 웹 업로드 UI + 사용자 단말 발표

Members + lanes: 17 (8 team + 9 lanes) · Waves: 2 · Excursions: 0 · Sources: 30+ (11 외부 도메인 + 저장소 내부) · Verifications: 2 (Bun tus 스모크테스트, adapters/base.py 재독) · Debate rounds: 4 · Elapsed: ~40 min

## Executive summary

사용자가 "원하는 슬라이드를 넣을 수 없다"고 느낀 것은 기능 버그가 아니라 **업로드 기능 자체가 아직 존재하지 않기 때문**이다. 2개 독립 워커가 수렴해 확인한 사실: `apps/console`에는 파일 입력·드래그드롭 UI가 전혀 없고, `POST /v1/deck-artifacts`는 `{title, content}` JSON 텍스트를 해시해 가짜 이미지 URL을 만드는 스텁이며, 실제 PPTX/PDF 구조 추출은 HTTP 표면이 없는 Python CLI(`services/ingestion`)에만 존재한다. 결정적으로 **렌더링 파이프라인이 코드베이스 어디에도 없다**(`adapters/base.py`가 `RenderingUnsupportedError`를 명시적으로 던짐) — 이는 "업로드 UI 추가"가 단순 기능이 아니라 아키텍처 결정임을 의미한다.

첫 데모(2026 SW 경진대회)에 대한 권고: **private upload/intake + operator 수동 렌더·리뷰·발행**(skeptic 판정 D2). 자동 렌더링 파이프라인(Gotenberg+LibreOffice)은 기술적으로 유효하지만(C23-C30), DEMO-SCOPE.md가 첫 데모를 curated/pre-approved로 정의하고 `PublishedDeckArtifactSchema`가 이미지 URL을 요구할 뿐 자동 생성을 요구하지 않으므로 과설계다. 업로드 전송은 동일출처 multipart POST + account-scoped 디스크 스테이징(100MiB 캡, C39/C52), Python CLI는 subprocess 어댑터로 재사용(C40). 보안은 PPTX 파서의 killable 워커 격리(C55)와 액티브 콘텐츠 outright reject(C58)가 웹 노출 전제 조건이다.

## Findings by theme

### 1. 현재 상태: 업로드 경로가 존재하지 않는다 (code-verified)
- `apps/console/src/App.tsx`/`session-client.ts`: 파일 입력 없음. 유일한 "업로더"는 마이크 스트림 전송용 `CaptureUploader` (O-ING-1, C12/C13).
- `POST /v1/deck-artifacts` (`http.ts:298-314`): JSON `{title,content}`만 수락. `prepared-deck-upload.ts:45-50`이 `https://public.example.test/...png` 가짜 이미지 URL 합성 (O-UPLOAD-1, C1).
- Python ingestion은 CLI 전용 (`cli.py`), HTTP 소비자·TS 소비자 전무 (C31, C40).
- DB에는 업로드/스테이징/오브젝트 테이블이 12개 마이그레이션 어디에도 없음 (C17, C18). `presentation_sessions.deck_storage_uri`/`internal_source_uri`는 존재하나 불투명 참조 (O-DB-1).

### 2. 렌더링 갭: 이 프로젝트의 핵심 결함
- `adapters/base.py:34-39` `render_slides()` → `RenderingUnsupportedError` (O-ING-2, lead 직접 재독 검증).
- `PublishedDeckArtifactSchema` (public-deck.ts)는 슬라이드마다 image url+contentHash+width+height 요구 (O-ING-3).
- `createPresentation`은 private+public 데크가 함께 있을 때만 성공 (S15) → **현재 흐름으로는 어떤 업로드도 서빙 가능한 프레젠테이션이 될 수 없다** (C21, C50).
- 5초 SLO는 라이브 추천 전용(`semantic-audio-end to eligible Console render p95`), 업로드/렌더링에는 미적용 (C51, render-pipeline 판정) — 업로드 변환에는 자체 async UX/SLO 계약이 필요.

### 3. 권고 아키텍처 (첫 데모, skeptic D2 채택)
1. **브라우저**: `<input type=file accept=.pptx,.pdf>` + 드래그드롭 → `FormData` POST. 진행률은 XHR `upload.onprogress` (fetch는 업로드 진행률 API 없음, C36/C37). Service Worker는 non-GET 요청을 완전히 바이패스 (C54).
2. **HTTP 경계**: `http.ts`의 공유 보안 게이트(Origin+Referer+`__Host-account`+CSRF)는 그대로 재사용 (C20), 단 `http.ts:273`의 무조건적 `request.json()` **이전에** multipart 분기 (C41).
3. **스테이징**: account-scoped durable 볼륨에 스트리밍, `.part` → 검증 후 원자적 승격 (C43). DB는 메타데이터만 (C39, large-object REVOKE와 정합, C2).
4. **파싱**: 주입된 async subprocess 어댑터로 기존 CLI 재사용 (`uv run --project services/ingestion impromptu-ingestion ingest ...`) (C40). 큐는 부재한 스키마/의존성/계약상 부적절, 독립 Python HTTP 서비스는 문서화된 미래 스케일아웃.
5. **발행**: operator 수동 렌더(기술 참조: Gotenberg→PDF→poppler→PNG, C23-C30)·리뷰·승인 — 기존 `createPresentation` 흐름에 연결. `deck_uploads`/private asset 테이블은 RLS 브리지 완성 후 (C57).

### 4. 보안 요구사항 (skeptic D1/D4 + file-security)
- **PPTX 격리 필수** (C55): 웹이 PPTX를 파싱하기 전에 killable 워커/컨테이너(데드라인·리소스 상한·동시성 제한·typed failure). 현재는 인-프로세스 무타임아웃 (C11).
- **액티브 콘텐츠 outright reject** (C58): VBA 파트(`vbaProject.bin`), `ppt/embeddings`(OLE), ActiveX, 외부 관계, 암호화 멤버를 파싱 전 거부 (C45). 리네임된 `.pptm`이 현재 검증을 통과한다 (C45).
- **PyMuPDF 핀/보안 바닥** (C44): `pymupdf>=1.26,<2`는 CVE-2026-3308(RCE, ≤1.27.0) 취약 범위 포함 → `>=1.28.0` 핀 + advisory 게이트.
- **PDF 액티브 액션** (C60): /OpenAction, /AA, /JavaScript, /Launch, /URI, /SubmitForm, /EmbeddedFiles 미거부 — 원본 파일 수명주기(추출 후 폐기 or 격리·attachment-only 서빙) 결정 필요.
- **zip-bomb 보강** (C46): 512MiB/10k 캡은 bounded이나 ~10명 동시 시 ~5GiB 처리; POI식 per-entry inflation-ratio 캡 추가.
- **retention 갭** (C59): DB `apply_retention()`이 스토리지 오브젝트를 삭제하지 않음 → 스풀 루트 TTL/orphan 스윕 (user-provided path 순회 금지).

### 5. 인증/테넌트 (auth-session FINAL)
- 기존 게이트(쿠키+CSRF+origin)는 HTTP 게이트로 완전 재사용 가능 (C20).
- **RLS 브리지 부재** (C32/C35/C57): 런타임은 account_* 텍스트를 tenant처럼 사용, DB RLS는 UUID `app.tenant_id` 요구. DB 기반 업로드 전에 서버 신뢰 {tenantId, accountId, actorId} 튜플 + `SET LOCAL app.tenant_id` 필요.
- 귀속은 account 레벨뿐, actor/세션/업로드 프로비넌스 없음 (C34). 현재 데모는 스냅샷 파일 기반이라 이 문제는 DB 채택 시에만 발생 (C33).

### 6. UX (upload-mechanics + pwa-constraints)
- 상태 모델: Selected → Uploading(바이트·%) → Verifying → Converting → Ready (C43). 업로드 100% ≠ 변환 완료.
- 100MiB 하드캡(코드에 이미 명시, C52), 50MiB 경고. 실패 시 "63%에서 연결 끊김, 처음부터 재시도" 명시 + idempotency 키 (C43).
- tus는 지금 도입하지 않음 (C39) — 오브젝트 스토리지 도입 후 ≥100MiB/불안정 네트워크에서 presigned MPU로 (C4, C39).
- 파일 진입: in-app 피커+drag-drop 기본; 데스크톱 설치 PWA면 `file_handlers`(OS "Open with…", Chrome/Edge 102+)·모바일이면 `share_target` 보강 가능 (C38).

### 7. 경쟁사 벤치마크
- **Mentimeter**: 정적 이미지 파이프라인(60MB/200슬라이드), URL-embed 별도 경로 — 다중 경로 신뢰 경계 설계 참조 (C48).
- **Canva**: 최대 한도(.ppt 100MB/.pptx 300MB, 300슬라이드, 1,400요소), 광범위한 진입점, 편집 가능 변환+스캔 플랫이미지 폴백 (C53 근접).
- **Pitch**: .pptx 전용, 편집 가능 변환+충실도 경고 (C49).
- **Poll Everywhere**: 덱 업로드 없이 통합-우선(플레이스홀더 슬라이드 교체) — 파일 섭취 위험을 회피하는 대안 (C53).
- **Google Slides**: 100MB 변환 캡, Office 편집 모드(기본) vs 변환. **변환 엔진 내부는 어느 벤더도 공개 안 함**.

## Codebase findings (absolute paths)
- `services/private-backend/src/http.ts`: 보안 게이트(38-70,147-213), deck-artifacts(286-323), 무조건적 JSON 파싱(273-274)
- `services/private-backend/src/prepared-deck-upload.ts`: 텍스트 해시 스텁(6-54)
- `services/private-backend/src/prepared-evidence.ts`: createPresentation private+public 동시 요구(492-514, 543-570)
- `services/private-backend/src/main.ts`: 스냅샷 파일 영속화(40-55, 208-228), fixture tenant alias(22-43)
- `services/ingestion/src/impromptu_ingestion/adapters/base.py`: 렌더링 경계(34-39)
- `services/ingestion/src/impromptu_ingestion/validation.py`: zip/파일 방어선; `contracts.py:35-40` 100MiB 캡
- `apps/console/src/registerServiceWorker.ts`: non-GET pass-through (C54)
- `infra/migrations/cluster/0001_cluster.sql`: large-object REVOKE
- `infra/migrations/private/0001_private_foundation.sql`: deck_storage_uri(34-46)
- `docs/DEMO-SCOPE.md`: 5s SLO = 라이브 추천 전용 (C51)

## Verified claims
- C6 (tus-node-server Bun 호환): **PARTIAL-verified** — `@tus/server@2.4.4`+`@tus/file-store@2.1.1` Bun 1.3.14 설치·임포트·export 확인 (bash 스모크테스트), E2E 미실행 → verify-bun-tus.md
- C21 (렌더링 부재): **VERIFIED** — lead가 adapters/base.py 재독 (verify-adapters.md)

## Epistemic instrumentation
- intent-diff.md: IT1/IT2 partial (렌더링 갭), IT3 true(가벼운 경로, skeptic 지지), IT4/IT5 violated(렌더링/UI 부재), IT6 violated-or-intentional(비영속)
- claim-graph.md: 60개 주장 노드 (C1-C60), verified-claims digest는 상기 2건
- observation-manifest.md: 14개 관측 (O-*) — 독립 관측자 수렴 3건(C12/C13, C21, C-NEW2)
- expansion-log.md: 23개 리드, 6 DEAD END, 라우팅 완료
- verification-economics: Bun 스모크테스트(수 분) vs E2E(불필요 — MVP에서 tus 미채택), Gotenberg 지연측정(비용 대비 미실행, C24 unresolved로 유지)

## Debate record
D1-D4 전부 판정 완료 (debate-log.md): PPTX 격리 must-fix / 설계포크 (b) / RLS 브리지 차단 / 액티브 콘텐츠 reject.

## Contradictions resolved
- "README가 projection_app만 강조 vs REVOKE는 양 DB PUBLIC" → 직접 재독으로 해소: REVOKE가 모든 롤에 적용, 명시적 재허가 없음 (C2).
- "~10 동시 사용자" → DEMO-SCOPE.md에 없는 수치, 계획 가정으로 정정 (C42).
- caniuse vs Chromestatus/BCD (Android FSA) → 장치 검증 전 결론 보류 (C38).

## Gaps
- Gotenberg 실측 지연 (C24, unresolved — 구현 시 Phase-4 실행 검증 권장)
- Android FSA 장치 검증 (C38)
- Malgun Gothic 폰트 대체 충실도 (L21)
- 원본 파일 수명주기 정책 (C60 — file-security가 결정 요청, skeptic D4 방향: 격리·폐기)
- 렌더링 SLO (C51 — 자체 계약 필요)

## Expansion trace
- Wave 1: 17 워커 스폰 → 13 리턴, 23 리드 (expansion-log.md)
- Wave 2: skeptic 4판정, 라우팅 8건, 3개 모순 해소/1개 정정
- 수렴 사유: 남은 리드 전부 라우팅 완료·DEAD END 처리, skeptic 판정 수령, 3연속 웨이브 무소득 조건 충족 예정
