# ULW-Research Brief: impromptu-r2 웹 업로드 UI + 사용자 단말 발표 기능

Session: `.omo/ulw-research/20260815-150744`
Started: 2026-08-15 15:07:44
Format gate 답변 (사용자 확정, 3회 재확인): **HTML(스타일링된 보고서, Mermaid/차트 포함) + Markdown** (`docs/PWA-구현-최적화-연구보고서.md`와 동일한 스타일) — PDF/DOCX 불필요.

## Core question

impromptu-r2에 웹 기반 슬라이드(PPT/PPTX/PDF) 업로드 UI를 추가하고, 발표자가 자신의 디바이스("user end")에서 그 자료로 실제 발표를 진행할 수 있게 하려면 무엇을 어떻게 구현해야 하는가 — 그리고 이것이 현재 아키텍처(curated evidence-first, live evidence safety-gated 설계)와 충돌하지 않으려면 어떻게 통합해야 하는가.

## Known starting facts (이번 세션에서 이미 코드로 확인됨)

- `services/private-backend/src/http.ts`의 `POST /v1/deck-artifacts`는 `{title, content}` **JSON 텍스트만** 받는 스텁이며, `createPreparedDeckArtifacts()`(`prepared-deck-upload.ts`)가 해시 기반으로 가짜 `publicSlideKey`/이미지 URL(`https://public.example.test/slides/...`)을 합성한다 — **실제 PPTX/PDF 파일 업로드나 파싱은 이 경로에 아직 없음.**
- 실제 구조적 추출(PPTX/PDF → 텍스트/구조)은 `services/ingestion`의 **Python CLI 워커**(`cli.py`, `worker.py`, `pdf_worker.py`, `adapters/`, `validation.py`, `doctor.py`)에만 존재하며, HTTP 표면이 없고 오프라인 배치 실행 전제(mkstemp 기반 원자적 발행, hardlink 신원 검증 등)로 설계됨.
- `packages/contracts/src/public-deck.ts`의 `PublishedDeckArtifactSchema`는 공개 슬라이드를 **오직 렌더링된 이미지**(`url`, `contentHash`, `width`, `height`)로만 정의 — 원본 파일이나 raw 텍스트는 공개 계약에 없음. Public Stage는 항상 사전 렌더링 이미지만 받는 설계.
- `packages/contracts/src/private-deck.ts`의 `PrivateDeckContextSchema`는 슬라이드별 `extractedText`/`speakerNotes`/`sourceAssetIds`를 담는 private 컨텍스트 — 업로드된 원본은 이쪽에 귀속되어야 함.
- 인증은 `__Host-account` 쿠키 + CSRF 토큰(HMAC 기반, `x-csrf-token` 헤더) + origin/referer 검증 조합으로 이미 구현되어 있음(`http.ts`) — 새 업로드 엔드포인트도 이 패턴을 재사용할 수 있음.
- README/DEMO-SCOPE.md: 현재 마일스톤은 "curated, pre-approved evidence reveal"이며 최종 MVP가 아님; "Curated evidence is the first deliverable; live evidence remains private until its safety and usefulness gates pass."
- DEMO-SCOPE.md 확정 규모: 동시 사용자 약 10명, Windows 11 + 최신 Chrome/Edge.

## Axes (8, 팀 정원 최대 채움)

| # | Axis owner | 범위 |
|---|---|---|
| 1 | `ingestion-integration` | 웹 업로드 경계 → 기존 ingestion 파이프라인 → PrivateDeckContext까지 정확한 코드 경로/격차. deck-artifacts 스텁과 실제 Python worker를 잇는 방법. |
| 2 | `upload-mechanics` | 전송 방식(단일 multipart POST vs resumable/chunked(tus) vs presigned 직접 업로드), 저장 위치, 파일 크기 제한, 진행률/재시도. |
| 3 | `file-security` | PPTX(zip+XML)/PDF 임의 업로드 위협 모델: zip-bomb, XXE, 매크로, PDF 파서 CVE. 오프라인 CLI→실시간 웹 노출 시 변화. |
| 4 | `auth-session` | 업로드를 인증된 account/session/presentation에 귀속시키는 방법; 기존 쿠키+CSRF+origin 패턴 재사용; RLS 테넌트 격리. |
| 5 | `competitor-benchmark` | Pitch, Prezi, Beautiful.ai, Google Slides, Canva, Mentimeter, Sendsteps 등의 업로드+발표 아키텍처. |
| 6 | `render-pipeline` | 업로드된 PPTX/PDF → `PublishedDeckArtifactSchema` 요구 사전 렌더링 이미지 변환: 서버측(LibreOffice headless, Gotenberg) vs 클라이언트 PDF.js. |
| 7 | `pwa-constraints` | File API/drag-drop 호환성, PWA File Handling/Web Share Target API, 기존 Service Worker와 업로드 상호작용, 모바일 UX. |
| 8 | `skeptic` | 전 축 공격. (a) 셀프서브 업로드 vs curated-first 설계 철학 충돌 여부 (b) 데모 규모(~10명) 대비 과설계 여부. |

## Expected truths (intent-diff.md 시딩용)

1. 웹 업로드는 **private 경로**(PrivateDeckContext)에만 새 콘텐츠를 추가하고, public Stage 노출은 기존 curation/승인 게이트(`/v1/publications/approve` 등)를 그대로 통과해야 한다 — 업로드 자체가 즉시 공개되지 않는다.
2. 실제 PPTX/PDF 구조 추출은 새로 만들 필요 없이 기존 `services/ingestion` 로직을 재사용/래핑할 수 있다.
3. 파일 크기·동시 사용자 규모(~10명)를 고려하면 무거운 인프라보다 가벼운 경로가 적합할 수 있다 — skeptic이 검증.

## Team roster (team_create, 8 members)

- deep: ingestion-integration, upload-mechanics, auth-session, render-pipeline
- unspecified-high: file-security, competitor-benchmark, pwa-constraints
- ultrabrain: skeptic

## Lane roster (9, "Multi-faceted" floor: 2 explore + 4 librarian + 2 browsing + 1 repo-dive = 9)

1. explore — infra/database + tests 스윕 (업로드/스테이징 스키마 흔적)
2. explore — apps/console, apps/stage, packages/ui + browser-boundary 스크립트 스윕
3. librarian — resumable upload 프로토콜 (tus.io, S3 multipart, GCS resumable)
4. librarian — OOXML/PDF 보안 문헌 (zip bomb, XXE, macro, PDF CVE)
5. librarian — 서버측 office-to-image 변환 도구 (LibreOffice headless, Gotenberg, unoconv)
6. librarian — PWA 파일 처리 API (File Handling, Web Share Target, File System Access)
7. browsing — Google Slides / PowerPoint Online / Canva 업로드+발표 아키텍처
8. browsing — 경쟁 제품 업로드 플로우 스크린샷 UX 조사
9. repo-dive — tus 참조 구현 + pdf.js 소스 조사

## Lifecycle

Research team 우선 실행 → 수렴 시 해체 → refinement/공격팀(ultrabrain/architect/deep)으로 교체 후 최종 synthesis (스킬 Phase 1 lifecycle 표: 6+ 축 + 코드베이스/웹 혼합 소스 기준).

## Deliverables

- `SYNTHESIS.md` (인용 포함 종합)
- 최종 산출물: 스타일링된 HTML(Mermaid/차트 포함) + Markdown 리포트
- 두 게이트: visual QA → `writing` 프루프리드
- 클로징 브리핑(소스 수/도메인 수/경과 시간) 포함해 한국어로 전달
