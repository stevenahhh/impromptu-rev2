# Wave 1 Digest

세션 시작 이후 도착한 모든 팀원/레인 리턴의 통합 다이제스트. 상세는 claim-graph.md / observation-manifest.md / expansion-log.md 참조.

## 헤드라인 발견 (가장 중요한 것부터)

1. **렌더링 파이프라인이 코드베이스 어디에도 없다 (C21, IT4 violated).** `services/ingestion`의 `adapters/base.py`는 `render_slides`가 `RenderingUnsupportedError`를 던지도록 명시적으로 구현되어 있고, PPTX 어댑터 문서는 "no rendering"이라 명시한다. 하지만 `PublishedDeckArtifactSchema`(공개 계약)는 슬라이드마다 렌더링된 이미지(url/hash/width/height)를 요구한다. 즉 **"업로드 UI 추가"는 단순 기능이 아니라, 새 렌더링 서비스 전체를 신규 구축해야 하는 아키텍처 결정**이다. lane-conversion-tooling이 Gotenberg(LibreOffice)+poppler 조합을 1차 소스 기반으로 추천했다(render-pipeline에 전달, 라우팅 완료).

2. **프론트엔드에 업로드 UI가 전혀 없다 (C12/C13, IT5 violated) — 2개 독립 워커가 수렴.** `ingestion-integration`과 `lane-frontend-sweep`이 각각 독립적으로 App.tsx/session-client.ts/packages-ui 전체를 조사해 동일한 결론에 도달: 파일 입력, 드래그드롭, `/v1/deck-artifacts`를 호출하는 프로덕션 코드가 전혀 없다. 유일한 "업로더"는 마이크 스트림 전송용.

3. **오브젝트 스토리지가 없고, PostgreSQL도 그 용도로 쓸 수 없다 (C1, C2).** 리포지토리에 S3/버킷 서비스가 없고, `/v1/deck-artifacts`는 텍스트만 받는 스텁이다. `infra/migrations/cluster/0001_cluster.sql`은 large-object 관련 함수를 PUBLIC으로부터 REVOKE — DB에 바이트를 넣는 경로가 의도적으로 막혀 있다(리드가 직접 재확인). `deck_storage_uri`/`privateObjectPrefix` 네이밍 컨벤션은 원래 오브젝트 스토어 간접 참조를 의도했던 흔적으로 보이나(2명이 독립적으로 지적), 실제 구현은 없다.

4. **보안 비대칭: PDF는 샌드박스, PPTX는 무방비 (C11, HIGH RISK).** PDF 파서는 서브프로세스+wall timeout+리소스 상한으로 격리되어 있지만, PPTX는 python-pptx가 호출 프로세스 내부에서 타임아웃도, 격리도, 크기 상한도 없이 실행된다. 오프라인 CLI에서는 저위험이었지만, 웹 엔드포인트로 노출되면 원격 트리거 가능한 DoS 벡터가 된다. **skeptic에게 심각도 판정 요청 라우팅함.**

5. **인증/귀속 체인은 이미 완성되어 있어 재사용 가능 (C20, C-AUTH2) — 유일하게 "새로 안 만들어도 되는" 부분.** `__Host-account` 쿠키 + CSRF + origin/referer 게이트가 이미 존재하고, `ownerAccountId`가 deck-artifacts 생성부터 `PresentationSessionLifecycle`까지 전파된다.

6. **Resumable upload는 이 프로젝트 규모에서 대체로 불필요 (C7).** tus/S3 MPU/GCS 3자 비교 결과, 안정 네트워크·5-10MB 미만에서는 plain multipart POST로 충분. 데모 데크 크기는 대부분 이 임계값 아래일 것으로 예상 — skeptic의 과설계 검증 대기 중이나 현재까지는 "가벼운 경로가 맞다"는 예상진실 IT3을 지지하는 방향.

## 축별 상태

| 축 | 상태 | 핵심 산출 |
|---|---|---|
| ingestion-integration | 활발히 보고 중 (3개 LEAD) | C21, C31, C-NEW1 — 렌더링/영속화 갭 확인 |
| upload-mechanics | 활발히 보고 중 (1개 LEAD) | C1, C2, C-NEW2 — 스토리지 부재 확인, resumable-upload 레인 결과 전달받음 |
| file-security | 활발히 보고 중 (3개 LEAD) | C-SEC1/2, C11, C22 — 기존 방어선 + PPTX 무방비 갭 |
| auth-session | 보고 시작 (1개 LEAD) | C20, C-AUTH2 — 인증 체인 재사용 가능 확인 |
| competitor-benchmark | WORKING (착수) | 대기 중 |
| render-pipeline | 아직 미보고 | 방금 critical context 전달함 (렌더링 갭 + Gotenberg 추천) |
| pwa-constraints | 아직 미보고 | 방금 저priority 리드 전달함 |
| skeptic | 아직 미보고 | 방금 2건의 공격 대상(보안 비대칭 심각도, 설계철학 포크) 전달함 |
| lane-db-sweep | **완료** | C17-C19 |
| lane-frontend-sweep | **완료** | C12-C16 |
| lane-resumable-upload | **완료** | C3-C7, C-NEW2 관련, L2(Bun 호환성) 검증 중 |
| lane-file-security-lit | 진행 중 | — |
| lane-conversion-tooling | **완료** | C23-C30 |
| lane-pwa-file-apis | 진행 중 | — |
| lane-competitor-arch | 대기열 | — |
| lane-competitor-ux-shots | 대기열 | — |
| lane-repo-dive-tus | 대기열 | — |

## 이번 턴 라우팅

- render-pipeline ← 렌더링 갭(critical) + Gotenberg 추천 + 검증 과제(L20) 전달
- upload-mechanics ← resumable-upload 리서치 결과 + 오브젝트스토어 결정 리드(L18) 전달
- skeptic ← 보안 비대칭(C11) 심각도 판정 요청 + 설계철학 포크(자동 렌더링 vs 수동 큐레이션 유지) 판정 요청
- pwa-constraints ← fetch 스트리밍 제약 리드(L5, 저priority) 전달

## 진행 중인 직접 검증

- Bun 환경에서 `@tus/server`+`@tus/file-store` 설치/임포트 가능 여부 직접 테스트 중 (C6, HIGH RISK 주장 검증)
- `adapters/base.py` 직접 재독해 렌더링 미지원 주장(C21) 교차검증 완료 이번 턴
