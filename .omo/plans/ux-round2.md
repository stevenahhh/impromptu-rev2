# UX Round 2 — Console 8건 결함 일괄 수정 (ulw)

User: "그럼 전부 다 해야하는 거 아니노? 다 해라!!" — 시각 QA findings.md(/tmp/ulw-ux/)의 결함 전부를 한 라운드에 수정.

## 기준 (RED → GREEN → SURFACE)
- C1 1024x768 발표 중 transport가 접힘선 위 (sticky + preview 캡)
- C2 ui-badge--success 대비 ≥4.5:1
- C3 리포트 슬라이드 해시 미노출, 인간 식별자
- C4 Q&A 카드에 질문 문구 표시 (답변·기권)
- C5 발표 중 '미리 열기/승인/새 자료 업로드' 숨김 (링크 복사 유지)
- C6 마이크 실패 주의 스타일 + 재시도
- C7 근거 카드 배지 1개·'정보 없음' 행 0
- C8 업로드 요청 1문장 + Debug 토글 비-콕핏 미노출
- 회귀: console suite 152+ 0fail / lint / typecheck / ko=en 키 + 사망 0 / Stage·backend·boundary 게이트

## 위임 토폴로지 (disjoint write scope, 6레인 병렬)
| 레인 | 파일 | 비고 |
|---|---|---|
| ux2-stageflow | workspace-page, playback-panel, audience-panel, console.css, packages/ui(badge만) | C1+C2+C5 |
| ux2-report | presentation-report + 리포트 호스트 + session-client(필요 시) | C3 |
| ux2-qa | qa-defense-panel, qa-answer-cards | C4 |
| ux2-mic | cockpit-audio-capture | C6 |
| ux2-evidence | evidence-card, evidence-preparation-panel | C7 |
| ux2-upload | deck-upload-panel, debug 오버레이 마운트 | C8 |

locale ko/en: 전 레인 추가 가능(기능 접두 키), lead가 최종 정합+사망 스캔. console.css는 stageflow만.

## QA surface 계약 (lead 통합 브라우저 QA가 사용)
[data-cockpit-phase](cockpit root 추가) [data-transport-strip] [data-copy-stage] [data-report-slide-title] [data-qa-question] [data-capture-retry] [data-evidence-badge] + 기존 유지.