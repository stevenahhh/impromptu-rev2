# ULW-Research Synthesis: AI 발표 에이전트 PWA와 이중 화면 전략

STATUS: draft - 연구팀 결과와 반론 라운드 대기 중

Members + lanes: 17 · Waves: 1+ · Excursions: 0 · Sources: 집계 중 · Verifications: 집계 중 · Debate rounds: 진행 중

## Executive summary

초기 결론은 **하나의 PWA 코드베이스, 두 개의 표시 모드, 서버 권한으로 분리된 세 화면 역할**이다. Windows 확장 화면에서는 Window Management API를 progressive enhancement로 사용해 공개 발표 창을 외부 디스플레이에 배치하고 Presenter Console을 주 화면에 둔다. 이 API는 실험적이며 Baseline이 아니므로, 권한 거부나 미지원 시 사용자가 창을 직접 옮기는 폴백을 제품의 정식 흐름으로 제공해야 한다.

화면 복제 환경에서는 같은 머신에 콘솔을 띄우면 청중에게 그대로 노출되므로, 발표 머신에는 공개 화면만 유지하고 휴대폰·태블릿·노트북이 QR/코드로 Presenter Console 세션에 참여하도록 한다. 두 화면은 브라우저끼리 직접 신뢰하는 구조가 아니라 서버가 역할별 인증과 메시지 계약을 강제하는 세션 허브를 통해 동기화한다.

## Findings by theme

### 신청서의 실제 제품 계약

- 현재 슬라이드는 웹 뷰어가 내는 `deck_id`, `slide_id`, `version`, `observed_at` 이벤트를 권위 정보로 삼는다. [S-01]
- 부분 STT는 자막과 검색 예열에만 쓰고, 확정 STT와 현재 슬라이드가 결합된 뒤에만 검증 작업을 시작한다. [S-01]
- 청중 화면은 `SUPPORTED`이면서 사람의 publish 승인을 받은 카드만 받는다. [S-01]

### PWA와 멀티스크린

- Window Management API는 연결된 화면 열거와 특정 화면에 창 배치를 지원하며 슬라이드 쇼를 명시적 사용 사례로 든다. [S-02][S-03]
- `getScreenDetails()`는 HTTPS, 사용자 권한, 지원 브라우저가 필요하고 MDN은 실험적·Limited availability로 표시한다. [S-04]
- 미러링된 화면은 `ScreenDetails.screens`에서 별도 화면으로 나타나지 않으므로 복제 여부를 자동 멀티스크린으로 오판해서는 안 된다. [S-05]
- `window.open()`은 사용자 제스처와 팝업 차단 정책에 좌우되고 실패 시 `null`을 반환한다. [S-06]

### 역할과 데이터 경계

- 공개 화면과 Presenter Console은 UI 라우트만 나누지 말고 역할별 서버 topic과 최소 DTO를 사용해야 한다. [S-01][S-14]
- WebSocket은 내장 인증이 없으므로 연결과 각 메시지에서 인증·인가를 검증하고 Origin, 크기, 속도를 제한해야 한다. [S-14]

## Codebase findings

- `C:/Users/steve/Desktop/projects/impromptu-r2/docs/신청서.pdf`: 유일한 프로젝트 자료이며 17쪽 전체를 분석했다.
- 구현 코드는 아직 없으므로 본 계획은 greenfield 아키텍처다.

## Sources (ranked)

완성 보고서의 번호 목록으로 정리한다.

## Verified claims

연구와 반론 라운드 완료 후 claim graph에서 승격한다.

## Epistemic instrumentation

- `intent-diff.md`: 화면 모드와 공개 경계의 기대 사실을 추적한다.
- `claim-graph.md`: 브라우저 API, 원격 동기화, 공개 게이트 주장을 추적한다.
- `observation-manifest.md`: 신청서와 공식 문서 관찰을 독립 그룹으로 기록한다.

## Debate record

진행 중.

## Contradictions

1. 신청서 p7은 `SUPPORTED`를 공개 가능 상태로 설명하지만 p10은 발표자/팀 승인 후 표시한다고 한다. 해결안은 `evidence_status=SUPPORTED`와 `publication_status=APPROVED`를 분리하는 것이다.
2. Window Management API는 요구에 정확히 맞지만 Baseline이 아니다. 따라서 핵심 기능이 아니라 자동 배치 향상 기능으로만 사용한다.

## Gaps

- 2026년 브라우저별 실제 지원표와 설치형 PWA 동작 검증
- 원격 콘솔의 WebSocket/WebRTC 선택과 reconnect 상태 머신
- STT 공급자별 한국어 지연·정확도 실측

## Expansion trace

- Wave 0: PDF 전수 추출, 페이지 렌더링, 요구·도식 분석.
- Wave 1: 8명 연구팀 + 9개 독립 lane으로 PWA, 화면 모드, AI 파이프라인, 보안, UX, 경쟁 서비스, 반론 조사.
