# Wave 2 Digest

Wave 1 이후 도착분 통합 (upload-mechanics FINAL, ingestion-integration FINAL, auth-session FINAL, file-security 다수, lane-file-security-lit 완료, lane-pwa-file-apis 완료, lane-repo-dive-tus 완료, competitor-benchmark 초기 리드).

## 축 완료 현황 (8개 중 3개 FINAL + 1개 사실상 FINAL)

| 축 | 상태 |
|---|---|
| ingestion-integration | ✅ FINAL (최소-diff 서브프로세스 어댑터 결론) |
| upload-mechanics | ✅ FINAL (단일 multipart POST 결론) |
| auth-session | ✅ FINAL (RLS/테넌트 모순 발견 — 이번 웨이브의 최대 산출물) |
| file-security | 2건 레인 완료·팀원은 사실상 FINAL (VBA/매크로 정책 결정만 남음) |
| competitor-benchmark | 진행 중 (Pitch/Canva/Beautiful.ai 초기 리드 3건) |
| render-pipeline | **미보고** (critical context 전달 후 WORKING — 아직 0 응답) |
| pwa-constraints | **미보고** (WORKING? 미확인) |
| skeptic | **미보고 (pending)** — 라우팅 2건 수신 후 대기 중 |

## 이번 웨이브 핵심 발견

1. **테넌트 ID 모순 (AUTH-SESSION FINAL, HIGH)**: 런타임은 branded `account_*` 텍스트를 tenant처럼 사용(retrieval alias), DB RLS는 UUID `app.tenant_id` 요구. 이 둘을 잇는 어댑터가 전혀 없다. deck을 DB에 저장하려면 `BEGIN; SET LOCAL app.tenant_id = <verified tenant UUID>;` 패턴 + trusted membership tuple `{tenantId, accountId, actorId}`가 필요. **skeptic에게 라우팅함 (과설계/설계철학 판정과 직결).**

2. **업로드 아키텍처 결론 확정 (upload-mechanics FINAL + ingestion-integration FINAL이 수렴)**: 첫 데모 = 동일출처 `multipart/form-data` 단일 POST → account-scoped durable writable volume 스테이징. `request.formData()`가 바디 전체를 메모리에 올리면 안 됨. DB는 메타데이터만(metadata-only, large-object REVOKE와 정합). tus는 지금 도입 안 함. 100MiB 하드캡. 파일을 JSON/base64로 감싸지 말 것.

3. **최소-diff 통합 시점 (ingestion-integration FINAL)**: private-backend에 주입된 비동기 **subprocess 어댑터**로 기존 Python CLI 호출(`uv run --project services/ingestion impromptu-ingestion ingest ...`). 큐는 근거 부재(스키마/의존성/계약 없음), 독립 Python HTTP 서비스는 문서화된 미래 스케일아웃. **멀티파트는 http.ts의 무조건적 `request.json()`(273-274행) 이전에 분기해야 함.** 렌더링 부재(가짜 이미지 URL)는 이 웨이브에서도 재확인된 임계 결함.

4. **보안 3건 (lane-file-security-lit + file-security, HIGH 2건)**:
   - PyMuPDF CVE-2026-3308: 1.27.0 이하 RCE. 설치본 1.28.2는 안전하지만 **선언 범위가 `pymupdf>=1.26,<2`라서 취약 버전이 허용됨** → 핀/보안 바닥 필요.
   - `.pptm`→`.pptx` 리네임 통과: 확장자 게이트와 content-type 확인만 있고 `vbaProject.bin`/OLE/ActiveX 파트를 금지하지 않음. 실행은 안 되지만 로드·재배포 시 악성 전달 경로.
   - `ZipFile.testzip()`은 선언된 크기로 bounded지만 ~10명 동시 업로드 시 ~5GiB 압축해제 처리 + 파서 작업. per-member ratio 캡 부재.
   - CVE-2025-54988 (Tika XFA XXE, CVSS 9.8)은 현재 PyMuPDF 경로에선 도달 불가 — 미래 렌더러(LibreOffice 등) 도입 시 재검토 필요. python-pptx는 `resolve_entities=False`로 XXE 이미 방어 중.

5. **PWA 파일 API (lane-pwa-file-apis 완료)**: `file_handlers`+`launchQueue`는 데스크톱 Chromium 102+만, `share_target`은 데스크톱 89+/Android 76+, FSA 피커는 데스크톱 86+/Android 132+(caniuse와 Chromestatus/BCD가 Android에서 충돌 — 장치 검증 필요). **현재 지원 환경(Windows 11 Chrome/Edge)에서는 in-app picker + drag-drop이 기본이고, `file_handlers`는 설치된 PWA에 OS "Open with…" 통합용 옵션.**

6. **tus Bun 호환성 직접 검증 완료 (본 세션)**: `@tus/server@2.4.4` + `@tus/file-store@2.1.1`이 Bun 1.3.14에서 설치·임포트·클래스 노출 확인. `Server`/`FileStore` export 존재 → **C6 주장 "vendor claim"은 "설치/임포트 가능(실행 스모크 테스트 수준)"으로 승격**. repo-dive 레인도 srvx의 `"bun"` export condition + `handleWeb(req: Request)` 표면을 근거로 고신뢰 결론 제시 (완전 E2E는 미실행).

7. **검증된 미결 1건**: `~10 concurrent users`는 DEMO-SCOPE.md에 **없는 숫자**였다 (upload-mechanics가 지적, 정정 수용 — 이전 대화에서 제가 메모리에 기록한 수치이며 계획상 가정으로 라벨 변경).

## 라우팅 (이번 턴)

- **skeptic** ← auth-session 테넌트/RLS 모순 (HIGH, 설계철학·과설계 판정과 직결) + VBA/매크로 정책 결정 요청
- render-pipeline: 여전히 미보고 — critical context 수신 확인됨(WORKING 메시지)
- pwa-constraints: fetch 스트리밍 리드 전달됨, 미보고

## 다음 마일스톤
- render-pipeline / pwa-constraints / skeptic / competitor-benchmark 회신 대기
- file-security FINAL (매크로 정책 결정)
- 이후: 웨이브 2 수렴 판정 → (필요시) skeptical 검증 → SYNTHESIS.md → HTML+MD 산출물
