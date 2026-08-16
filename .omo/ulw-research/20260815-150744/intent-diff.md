# Intent Diff

| intent_id | Expected truth | Observed reality | Diff | Violated invariant | Source | Supporting obs | Status | Linked claims |
|---|---|---|---|---|---|---|---|---|
| IT1 | 웹 업로드는 private 경로에만 새 콘텐츠를 추가하고, public Stage 노출은 기존 curation/승인 게이트를 통과해야 한다 | auth-session: attribution 체인(ownerAccountId 전파)이 이미 존재해 구조적으로 private-first를 지지함. 그러나 ingestion-integration: private->public 렌더링 경로 자체가 존재하지 않아 "게이트를 통과해 노출"까지 가는 흐름이 오늘은 도달 불가능 | 부분 일치 | 없음(철학은 유지), 실행 가능성 전제가 깨짐 | brief.md 예상진실 1 | O-AUTH-1, O-ING-2 | **partial** | C20, C21, C31 |
| IT2 | 실제 PPTX/PDF 구조 추출은 기존 services/ingestion 로직을 재사용/래핑하면 된다 | 구조/텍스트 추출은 재사용 가능(확인됨). 이미지 렌더링은 adapters/base.py가 RenderingUnsupportedError를 명시적으로 던짐 — 새 컴포넌트(Gotenberg 등) 없이는 불가능 | 부분 일치 | "새로 만들 필요 없다"는 전제가 렌더링 부분에서 깨짐 | brief.md 예상진실 2 | O-ING-2, O-ING-3, O-CONV-1 | **partial** | C21, C23 |
| IT3 | 데모 규모(~10명 동시 사용자)를 고려하면 가벼운 경로가 적합하다 | lane-resumable-upload: 5-10MB 미만·안정 네트워크에선 plain multipart POST가 적절, resumable은 10MB+에서만 가치. 데모 데크는 대부분 임계값 이하로 예상 | 잠정 일치 | 없음 | brief.md 예상진실 3 | O-RES-1 | **true (skeptic 검증 대기)** | C7 |
| IT4 (신규) | 업로드된 콘텐츠를 표시하려면 기존 렌더링 컴포넌트를 쓰면 된다 (암묵적 전제) | private/public 어디에도 렌더링 컴포넌트가 없음. PDF.js도 미사용. lane-conversion-tooling이 Gotenberg+LibreOffice+poppler 조합을 신규 추천 | 불일치 | "기존 컴포넌트로 충분" 가정이 깨짐 — 신규 서비스(컨테이너) 추가가 필요한 아키텍처 결정 | 조사 중 발견 | O-ING-2, O-CONV-1 | **violated** | C21, C23-C30 |
| IT5 (신규) | 브라우저 앱에 업로드 UI 스캐폴딩이 일부 존재한다 (이전 대화 추정) | App.tsx/session-client.ts/audio-capture.tsx/packages/ui 전체 조사 결과 업로드/파일선택/드래그드롭 UI 전무. 유일한 "Uploader"는 마이크 스트림용 | 불일치 (더 명확해짐) | "일부 존재" 가정이 완전히 깨짐 | ingestion-integration + lane-frontend-sweep (2개 독립 워커 수렴) | O-ING-1, O-FE-1 | **violated** | C12, C13 |
| IT6 (신규) | 업로드된 결과는 DB(deck_storage_uri)나 최소한 어떤 영속 저장소에 남는다 | 런타임은 in-memory 코디네이터 + PRIVATE_SNAPSHOT_PATH 스냅샷 파일만 사용; DB deck_storage_uri 컬럼은 실제 사용 경로가 아님; /v1/deck-artifacts는 결과를 반환만 하고 영속화하지 않음 | 불일치 | "저장된다"는 암묵적 전제가 깨짐 — ephemeral-by-design인지 결정 필요 | ingestion-integration 3차 보고 | O-DB-2, O-ING-4 | **violated (or intentional — needs product decision)** | C31, C-NEW1 |

## 아직 unknown 인 항목
- IT1/IT2가 "partial"에서 "true"로 수렴하려면 skeptic의 설계철학 공식 검증(전달됨, 이번 턴 라우팅)과 render-pipeline의 실제 구현 가능성 확인이 필요.
- IT6은 사실이 아니라 **제품 결정**의 문제 — upload-mechanics/render-pipeline이 답을 정해야 함(필드시스템 스테이징 vs 오브젝트 스토어 vs 현재처럼 ephemeral 유지 후 나중에 커밋).
