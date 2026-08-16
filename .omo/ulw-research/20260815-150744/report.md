# 웹 업로드 UI 및 사용자 단말용 발표 기능 리서치 보고서

> **ULW-Research · 2026-08-15 · 세션 `.omo/ulw-research/20260815-150744`**
>
> 워커 17개(팀 워커 8개 + 레인 워커 9개) · 출처 30개 이상(외부 도메인 11개) · 토론 4라운드 · 코드 검증 2건
>
> 산출물: 본 문서(Markdown) + `report.html`(Mermaid 다이어그램 포함)

## 1. 한 줄 요약

현재 원하는 슬라이드를 추가할 수 없는 이유는 버그가 아니라 업로드 기능 자체가 아직 없기 때문입니다. 그리고 업로드 버튼을 추가하는 것만으로는 끝나지 않습니다. 이 저장소에는 렌더링 파이프라인이 전혀 없어서, 업로드한 파일을 화면에 표시하는 경로를 새로 만들어야 합니다.

> **권고 (skeptic 토론 확정):** 첫 데모는 비공개 업로드 후 운영자가 수동으로 렌더링, 검토, 발행하는 방식입니다. 항상 켜져 있는 자동 변환 서비스(Gotenberg 등)는 데모 규모에서 과설계입니다.
>
> **경계 선언 (`PRIVATE_INTAKE`):** 업로드는 발표자의 비공개 영역에만 저장되며, 운영자가 렌더링하고 검토한 뒤 발행하기 전에는 어떤 공개 URL이나 카드, Stage 이미지도 생성되지 않습니다. 자동으로 공개 상태로 전환되지 않습니다.

## 2. 진단: 현재 상태 (코드 검증 완료)

| 확인 사항 | 결과 | 근거 |
|---|---|---|
| 브라우저 업로드 UI | 없음. 파일 입력, 드래그 앤드 드롭, 업로드 컴포넌트가 전혀 없음. 유일한 업로더(`CaptureUploader`)는 마이크 스트림 전송용 | `apps/console/src/App.tsx`, `audio-capture.tsx` (독립 워커 두 개가 각각 조사한 결과가 일치함) |
| `POST /v1/deck-artifacts` | 스텁. `{title, content}` JSON 텍스트를 해시해 가짜 이미지 URL(`public.example.test`)을 생성함 | `services/private-backend/src/http.ts:298-314`, `prepared-deck-upload.ts` |
| 실제 PPTX/PDF 파싱 | HTTP 인터페이스가 없는 CLI 전용 Python 워커이며, TypeScript 호출 코드도 없음 | `services/ingestion/` (`cli.py`, `worker.py`) |
| 렌더링(슬라이드→이미지) | 전무. `render_slides()`가 `RenderingUnsupportedError`를 던짐. 공개 데크 계약에서는 슬라이드마다 이미지를 요구함 | `adapters/base.py:34-39` (리드가 다시 확인), `packages/contracts/src/public-deck.ts` |
| 업로드/스테이징 DB 테이블 | 없음. 마이그레이션 12개 어디에도 존재하지 않음. PostgreSQL 대형 객체 함수의 `PUBLIC` 권한은 `REVOKE` 처리됨 | `infra/migrations/` 전수 조사, `0001_cluster.sql` |
| 인증/CSRF 게이트 | 이미 구현되어 있음. `__Host-account` + CSRF + `Origin`/`Referer` 검증이 완성된 상태 | `http.ts:38-70, 147-213` |

> **핵심 결함:** `createPresentation`은 비공개 데크와 공개 데크가 함께 있을 때만 성공합니다(`prepared-evidence.ts:492-514`). 공개 데크는 렌더링 이미지를 요구하는데 렌더링이 없으므로, 현재 코드로는 업로드한 파일로 실제 발표를 제공할 수 없습니다.

## 3. 권고 아키텍처 (첫 데모)

```
발표자 브라우저(Console PWA)
  │  multipart/form-data (XHR 진행률)
  ▼
private-backend ──스트리밍──▶ 스테이징 디스크 (계정별, .part → 원자적 승격)
  │  서브프로세스: uv run impromptu-ingestion ingest ...
  ▼
Python ingestion CLI (기존 검증 재사용) ──CompletedIngestion JSON──▶ coordinator
  ▼
운영자 수동 렌더·검토 → 발행 게이트(createPresentation) → projection-gateway → Stage
```

### 3.1 단계별 결정

| 영역 | 결정 | 근거 |
|---|---|---|
| 전송 방식 | 동일 출처의 단일 `multipart/form-data` POST. `request.formData()`로 바디 전체를 메모리에 올리지 말고 스트리밍. JSON/base64 인코딩 금지 | C39 |
| tus / resumable | 지금은 도입하지 않음. 오브젝트 스토리지를 도입한 뒤, 파일 크기 상한을 100MiB보다 높이거나 불안정 네트워크가 확인되면 사전 서명 멀티파트 업로드로 전환 | C39 |
| 통합 방식 | `private-backend`에 주입된 비동기 서브프로세스 어댑터로 기존 CLI 호출. 큐는 스키마·계약이 없어 부적절. 독립 Python HTTP 서비스는 향후 확장안 | C40 |
| 파일 크기 | `.pptx`/`.pdf`만 허용. 하드 캡 100MiB(코드에 이미 명시, `contracts.py:35-40`), 50MiB에서 경고 | C52 |
| 저장 | DB에는 메타데이터만 저장(바이트 금지, 대형 객체 권한 회수 정책과 일치). 원본은 계정별 스테이징. 파일 시스템 스풀 확정: `deck_storage_uri`에 `file:` URI 저장(스토리지에 종속되지 않는 계약). MinIO와 R2는 데모에서 제외. 경로는 서버가 생성한 값(`account+uploadId+hash`)을 사용하며 사용자 파일명 금지 | C65 |
| 발행 | 운영자가 수동 렌더링(LibreOffice→PDF→Poppler→PNG 참조) 후 기존 `createPresentation` 흐름. 래스터라이저는 한국어 검증용 코퍼스를 사용해 기존 PyMuPDF(리소스 제한 적용 워커의 `get_pixmap()`)와 Poppler를 비교한 뒤 결정(C61). PDF.js는 클라이언트 미리보기 전용이며 공개 아티팩트 경로로 사용 금지 | C61 |
| 렌더링 SLO | 5초 SLO는 라이브 추천 전용(`semantic-audio-end`)이며 업로드 변환에는 적용되지 않음. 별도의 비동기 UX/SLO 계약 필요 | C51 |

> **렌더링 방식의 명확화:** 첫 데모에서는 운영자가 변환 도구를 직접 실행하고 결과를 검토하는 수동 게이트를 둡니다. 상시 실행되는 자동 오케스트레이션(작업 재시도, 아티팩트 승격, 공개 저장 자동화)은 도입하지 않습니다. 자동화는 운영자 처리량을 측정해 수동 게이트가 병목으로 확인된 이후에 검토합니다(skeptic D2).

### 3.2 수명주기 계약 (C62)

업로드 접수와 상태 조회에는 비동기 작업과 폴링을 사용하되, 렌더링은 운영자가 직접 시작합니다.

```
POST multipart → 검증/스테이징/해시 → 작업 레코드 생성 → 202 + jobId
운영자: 대기 작업 선택 → 변환 워커 도구 수동 실행
워커 도구: PPTX → PDF → 이미지 변환 → 비공개 미리보기 저장 → READY_PREVIEW
운영자·발표자: 미리보기 검토 → 운영자 승인 → 공개 아티팩트로 수동 승격 → createPresentation 실행
```

Gotenberg 웹훅은 콜백 인증과 SSRF 방어가 복잡하고 산출물도 PDF에 그치므로 채택하지 않습니다.

### 3.3 최소 변경 통합 지점

1. **브라우저**: `session-client.ts`에 `uploadDeck(csrfToken, file)` 추가. `FormData`를 사용하며 `Content-Type`을 직접 설정하지 않음
2. **HTTP 경계**: `http.ts:273`의 무조건적 `request.json()` 이전에 multipart 분기. 공유 보안 게이트는 그대로 유지 (C41)
3. **런타임**: `main.ts:214-228`에서 스풀 파일 경로로 CLI 실행, `CompletedIngestion`을 TS Zod 스키마로 파싱, 임시 파일 정리
4. **매핑**: `deckId = private_deck_${source_sha256}`, 슬라이드의 `extractedText`에는 구조 요소를 결정론적으로 평탄화한 값을 저장

> ⚠️ 가짜 이미지 URL(`public.example.test`)을 절대 유지하지 말 것. 렌더링 완료 전까지 API는 처리 중이거나 비공개 상태임을 나타내는 응답만 반환해야 합니다.

## 4. 보안 요구사항 (웹 노출 전 필수)

| 항목 | 심각도 | 내용 |
|---|---|---|
| PPTX 파서 격리 | **필수 수정** | 현재 PPTX는 프로세스 내부에서 타임아웃·격리·픽셀 예산 없이 파싱됨(D1). 웹 경로가 PPTX를 파싱하기 전에 강제 종료 가능한 워커·컨테이너(데드라인, 리소스 상한, 동시성 제한)가 필요 |
| 액티브 콘텐츠 거부 | **필수 수정** | VBA(`vbaProject.bin`), OLE(`ppt/embeddings`), ActiveX, 외부 관계, 암호화된 멤버가 포함된 파일은 파싱 전 거부(D4). 이름을 바꾼 `.pptm`이 현재 검증을 통과함(C45) |
| PyMuPDF 버전 고정 | 필수 | CVE-2026-3308의 영향을 받는 1.27.0 이하 버전(RCE)이 현재 선언된 의존성 범위 `pymupdf>=1.26,<2`에 포함됨. `>=1.28.0`으로 고정하고 보안 권고 사항 검사 도입(C44) |
| PDF 액티브 액션 | 미결 | `/OpenAction`, `/Launch`, `/JavaScript`, `/EmbeddedFiles`를 차단하지 않음. 원본 파일 수명주기(추출 후 폐기할지, 격리된 상태로 제공할지) 결정 필요(C60) |
| 보존 정책 공백 | 필수 | DB `apply_retention()`은 외부 스토리지 오브젝트를 삭제하지 않음. 스풀 루트의 TTL 기반 고아 파일 정리 필요(사용자 경로 순회 금지)(C59) |

## 5. UX 명세

```
Selected → Uploading (바이트·%) → Verifying → Awaiting Operator Render → Converting → READY_PREVIEW
```

- 진행률은 `XMLHttpRequest.upload.onprogress`를 사용(`fetch`에는 업로드 진행률 API가 없음, C36/C37)
- 업로드 100%는 변환 완료를 의미하지 않음. 상태를 분리해 표시
- 실패 시: "63%에서 연결이 끊겼습니다. 처음부터 다시 시도합니다."라고 명시하고 멱등성 키 사용
- 변환 완료 후 운영자와 발표자가 비공개 미리보기를 검토하되, 승인과 공개 아티팩트로의 수동 승격은 운영자만 수행(`READY_PREVIEW` → 운영자 승인 → 공개 아티팩트 승격). 폰트 대체·레이아웃 변화를 세션 시작 전에 확인하는 안전 게이트 (C63)
- `Service Worker`는 일반 업로드 요청(`non-GET`)을 완전히 우회. 단, `Web Share Target` 파일 수신 경로는 예외적으로 가로챔 (C54)
- 파일 입력 방식: 앱 내 파일 선택기와 드래그 앤드 드롭이 기본. 데스크톱 설치 PWA는 `file_handlers`(OS "Open with…"), 모바일은 `share_target`으로 보강 가능 (C38)
- 모바일 백그라운드 전환 시 업로드가 계속되지 않을 수 있음. "앱을 화면에 유지" 안내와 재개용 세션 정보 보존 필요 (C69)

## 6. 경쟁사 벤치마크

| 제품 | 접근 | 한도 | 참고 |
|---|---|---|---|
| Mentimeter | 정적 이미지 변환 + 별도 URL 임베드 경로 | 60MB, 슬라이드 200장 | 다중 경로 신뢰 경계 설계 참조 (C48) |
| Canva | 편집 가능한 형식으로 변환. 스캔 자료는 단일 이미지로 가져옴 | `.ppt` 100MB, `.pptx` 300MB, 슬라이드 300장 | 가져오기 경로가 가장 다양하고 한도 문서화가 구체적 |
| Pitch | `.pptx` 전용 편집 변환 | 해당 없음 | 충실도 경고(폰트, 16:9) (C49) |
| Google Slides | 변환 한도 100MB. Office 편집 모드 기본 | 100MB 변환 | 변환 엔진 비공개 |
| Poll Everywhere | 덱 업로드 없음. 네이티브 통합과 플레이스홀더 교체 | 해당 없음 | 파일 가져오기 위험을 회피하는 대안 (C53) |

어느 벤더도 PPTX 변환 엔진 내부를 공개하지 않았습니다. 변환 품질 수치는 자체 검증만 가능합니다. 참고로 "동시 사용자 약 10명"은 `DEMO-SCOPE.md`에 명시된 수치가 아니라 계획상 가정입니다(C42/C64).

**경쟁사 아키텍처는 4가지 모드로 수렴합니다 (C73):** ① 편집 가능한 객체 변환(Pitch, Canva, Beautiful.ai, Google Slides) ② 정적 래스터 가져오기(Mentimeter, Prezi 클래식, Sendsteps) ③ URL 임베드(Mentimeter) ④ 메타데이터만 담은 자리표시자 슬라이드(Poll Everywhere, Slido). 어느 벤더도 Office 파일 업로드에 적용하는 악성 코드 검사 정책을 공개하지 않았으며(C72), 업로드 신뢰 경계를 명확히 공개해 차별화할 수 있는 지점입니다.

## 7. 남은 결정·미검증 항목

- **원본 파일 수명주기**: 추출 후 폐기할지, 격리된 첨부 파일로만 제공할지 (C60)
- **Gotenberg 실측 지연**: 슬라이드 10~20장으로 구성된 한국어 데크의 변환 시간 (C24, 구현할 때 측정해야 하며 현재 저장소에는 PPTX 픽스처가 없음)
- **래스터라이저 벤치마크**: `get_pixmap()`과 `pdftoppm` 비교 (한국어 검증용 코퍼스) (C61)
- **공개 이미지 제공**: Stage가 실제로 가져올 수 있고 계약 요건을 충족하는 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트). 현재 가짜 URL은 별도 차단 항목
- **렌더링 구성 버전 고정**: Gotenberg와 LibreOffice(LO)의 컨테이너 이미지 다이제스트, 폰트 번들, 래스터라이저 버전을 `deckVersion` 산정 기준에 포함(같은 PPTX라도 렌더러 업그레이드로 다른 픽셀이 나올 수 있음)
- **스풀 용량 예산**: 데모 기준 약 4~5GiB 전용 쿼터(100MiB 원본 10개와 복사본 10개로 약 2GiB). 동시 파싱 풀은 2개로 시작해 벤치마크 후 4개로 확장. 초과 시 429/503
- **Android FSA**: Can I Use와 ChromeStatus의 기록이 충돌. 기기 검증 전에는 결론 보류 (C38)
- **한국어 폰트**: Noto CJK에 필요한 글리프가 있어도 Malgun Gothic을 썼을 때와 같은 레이아웃 충실도가 보장되지는 않음 (C63)
- **RLS 브리지**: DB 기반 업로드를 채택할 경우 `{tenantId, accountId, actorId}` 튜플과 `SET LOCAL app.tenant_id`가 선행되어야 함 (C57)

## 8. 검증된 주장 (코드 실행)

| 주장 | 판정 | 방법 |
|---|---|---|
| 렌더링 경계 부재. `render_slides()`가 예외를 던짐 | 확인됨 | 리드가 `adapters/base.py`를 다시 확인 (`verify-adapters.md`) |
| `@tus/server`의 Bun 호환성 | 부분 확인 | `@tus/server@2.4.4`를 Bun 1.3.14에서 설치 및 임포트 확인 (`verify-bun-tus.md`) |

## 9. 출처 (선별)

1. `services/private-backend/src/http.ts`: 인증 게이트, 라우트 (S1)
2. `services/private-backend/src/prepared-deck-upload.ts`: 텍스트 해시 스텁 (S2)
3. `packages/contracts/src/public-deck.ts`: 공개 슬라이드 이미지 계약 (S4)
4. `services/ingestion/src/impromptu_ingestion/adapters/base.py`: 렌더링 경계 (S9)
5. `infra/migrations/cluster/0001_cluster.sql`: 대형 객체 권한 `REVOKE` (S5)
6. tus.io 프로토콜 1.0.x (SHA c6a11fa) (S16)
7. AWS S3 multipart 문서 (S17), GCS resumable 문서 (S18)
8. Gotenberg v8 소스 (SHA c0f487e), `soffice(1)`과 `pdftoppm(1)` 매뉴얼 (S22, S23)
9. CVE-2026-3308 (NVD), CVE-2025-54988 (CVE.org), MuPDF CVE ledger
10. MDN BCD v8 (SHA ba5f572): File Handling, Share Target, FSA
11. Mentimeter, Canva, Pitch, Poll Everywhere 공식 헬프센터 (C48-C53)

출처 30개 이상과 주장 노드(C1~C73), 관측 매니페스트 14건, 리드 로그 23건, 토론 로그 4건은 세션 디렉토리(`.omo/ulw-research/20260815-150744/`)에 보관되어 있습니다.
