# G005 — Console test alignment after Luna locale rewrite

Task: st_01a0e3fe. Re-align the 23 Console tests broken by the en.json/ko.json
writing-agent rewrite (values only; keys unchanged). Edits confined to test files.

## Baseline

`NODE_ENV=test bun test --isolate apps/console/src` — exit 1, 199 pass / 23 fail.

## Failures inspected and fixes applied

Every failure was inspected against the actual rendered DOM and the rewritten
catalogs. Stale literals were replaced with `messages("ko" | "en")` key
references (current semantic values), keeping role/name and machine-state
assertions intact. No assertion was weakened to a mere existence check; no test
added pinning prose; no sleeps introduced.

### presenter-console.test.tsx (3 failures)
- `toContain("발표 화면 연결됨")` → `messages("ko").audienceConnected` (badge copy).
- `toContain("다른 기기에서 발표 화면을 열었다면")` → `messages("ko").connectLead`.
- `getByRole`/`queryByRole("button", {name:"다른 발표 자료 업로드"})` → `messages("ko").newDeck`.

### deck-upload.test.tsx (1 failure)
- `toContain("크기 한도")` → `messages("ko").uploadTooLarge`; the typed-error
  (`input_too_large`) non-leak assertion is unchanged.

### evidence-card.test.tsx (2 failures)
- `toContain("핵심 요약")` → `messages("ko").evidenceSummary`.
- `toContain("기준일")` → `messages("ko").evidenceSourceDate`; `"원문 보기"` → `evidenceSourceUrl`.
- Absence guards kept semantically: `"정보 없음"/"unavailable"` → `ko/en .sourceUnavailable`;
  `"기준일 정보 없음"` → `ko.sourceUnavailable`.

### playback-panel.test.tsx (5 failures)
- Added `const { messages } = await import("./i18n");` (same dynamic-import
  pattern the file already uses).
- `"발표 화면의 슬라이드를 변경했습니다."` → `messages("ko").slideChanged`.
- `"발표 화면 연결이 만료되었습니다."` → `messages("ko").bindingExpired`.
- `"슬라이드 변경에 실패했습니다."` → `messages("ko").slideFailed` (both the
  PROBLEM assertion and the `aria-live` announcer finder).
- `"발표를 종료하고 결과를 정리하고 있습니다."` → `messages("ko").reportFinalizing`.
- `"발표 결과를 정리하지 못했습니다."` → `messages("ko").reportFinalizeFailed`.

### App.test.tsx (12 failures)
- Heading `"화면 안내"` → `messages("ko").liveApproval` (role/name kept).
- `"기준일"` → `messages("ko").evidenceSourceDate`;
  `not.toContain("출처 정보가 없습니다.")` → `ko.sourceUnavailable`.
- `"Open presentation screen first"` → `messages("en").openStagePreview`.
- Navigation name `"발표자 화면"` → `messages("ko").privateWorkspace`.
- `"Connect with the code"` → `messages("en").approveDisplay`.
- `"발표 화면 미리 열기"` (x3) → `messages("ko").openStagePreview`.
- `"이 화면 연결"` → `messages("ko").approveHandshake`.
- `"발표 화면 연결이 끊겼습니다."` → `ko.audienceDisconnected`; reopen button
  `"발표 화면 다시 열기"` → `ko.audienceReopen`.
- `"브라우저가 발표 화면 창을 막았습니다."` → `ko.audiencePopupBlocked`;
  retry button `"다시 시도"` → `ko.audienceRetry`.
- `"발표 화면 연결이 만료되었습니다."` (x2) → `ko.bindingExpired`.
- `"슬라이드 변경에 실패했습니다."` → `ko.slideFailed`; the paired
  `not.toContain` binding-expired guard → `ko.bindingExpired`; connected badge
  `"발표 화면 연결됨"` → `ko.audienceConnected`.
- `"발표 화면은 이 창 옆에 열립니다."` → `ko.audienceOpensBeside`.
- Negative guards `queryByRole("button", {name:"카드 승인"})` (x2) →
  `messages("ko").approveCard` so the retired-surface check tracks the current
  approval-control label instead of dead text.

## Verification (all run this session)

- `NODE_ENV=test bun test --isolate apps/console/src` — exit 0; **222 pass / 0 fail**
  across 27 files, single full run.
- `bun run typecheck` — exit 0 (tsc --noEmit, root + packages/ui + apps/console + apps/stage).
- `bun run lint` — exit 0 (biome check, 526 files, no fixes applied).

## Files changed

- apps/console/src/App.test.tsx
- apps/console/src/presenter-console.test.tsx
- apps/console/src/deck-upload.test.tsx
- apps/console/src/evidence-card.test.tsx
- apps/console/src/playback-panel.test.tsx

No product code, catalogs, or scripts touched; no git staging or commits.
