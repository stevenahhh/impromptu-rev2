# G006 — Locale/Copy Audit (apps/console)

## Scope
`apps/console/src/locales/en.json`, `apps/console/src/locales/ko.json`, `apps/console/src/locale-parity.test.ts`, checked against plan `.omo/plans/impromptu-ideal-experience.md` tasks 25 (copy inventory / §3.2 terminology table), 27 (auth copy), 28 (retire public-approval nav), 29 (contextual copy / provenance labels), 38 (parity test).

## Files → plan tasks served
- `en.json`, `ko.json` (both `M` in git): partially implement the §3.2 glossary — serve tasks **29** (evidence→"related materials"/"관련 자료" rename) and **27** (sign-in title change).
- `locale-parity.test.ts` (`??` untracked, 9 lines): serves task **38** QA command `bun test apps/console/src/locale-parity.test.ts` — asserts ko/en key-set equality only (no placeholder/variable parity, though §3.3 requires variable-set equality too).

## Key-set delta (both catalogs, identical)
- **Removed (16):** `approvalFailed`, `audienceOpening`, `connectDisplay`, `evidenceDateUnavailable`, `evidenceRights`, `evidenceSource`, `invalidCode`, `manualPairing`, `openStage`, `preparingSlides`, `screenApproved`, `stageOpenBlocked`, `started`, `toolsReady`, `uploadLead`, `wrongPresentation`. Grep confirms zero remaining references to these keys in `apps/console/src/**.{ts,tsx}` — removals are safe.
- **Added (12):** `bindingExpired`, `captureRetry`, `preparationWhileSpeaking`, `uploadTooLarge`, `reportQaTitle`, `reportQaEmpty`, `reportQaUnavailable`, `reportQaTyped`, `reportQaSpoken`, `reportQaAskedAt`, `reportQaAnswerHeading`, `reportQaRetryable`, `reportQaFinal` — all referenced by workspace/deck-upload/cockpit-audio-capture/playback-panel/presentation-report sources.
- **Changed values:** `근거`/`evidence` → `관련 자료`/`related materials` in `evidenceApproval`, `preparedEvidence`, `evidenceInternalApproved`, `evidencePreparingQuietly`, `evidencePrepared`, `evidenceEmpty`, `evidenceFailed`, `referenceLead`, `reportEvidenceEmpty`, `reportEvidenceItem` (matches 3.2 `준비된 근거 → 관련 자료`); `signInTitle` `비공개 발표 제어`→`발표 준비` / `Private presentation control`→`Presentation preparation`; `liveApproval` → `실시간 관련 자료 승인`/`Live candidate approval`; `uploadTitle` simplified.

## Parity test result — PASS
```
bun test v1.4.2 (744846f84)
(pass) locale catalogs > ko and en expose the same key set [0.90ms]
 1 pass, 0 fail, 1 expect() calls
EXIT=0
```

## Defects vs plan copy inventory (§3.2/§3.3)
Jargon the plan requires removed/changed but still present in current `ko.json`:
- `ko.json:2,7` `발표 워크스페이스` — 3.2 wants `발표 준비/발표자 화면`; `signInTitle` was changed but `workspace`/`readyTitle` were not (inconsistent).
- `ko.json:5` `워크스페이스 나가기` — 3.2 wants `로그아웃` (task 27: logout action must match name).
- `ko.json:14` `발표자 콘솔` — 3.2 wants `발표자 화면`.
- `ko.json:15–17,22` `코칭 지표`, `코칭 표시 음소거`, `큐 횟수` — 3.2 wants `발표 도움말`, `도움말 잠시 숨기기`, `안내 횟수`. (`코칭 표시 음소거` is one of the five E12 items.)
- `ko.json:44` `{count}개 조각 색인됨` — 3.2 wants `분석 완료`. (E12 item; en side `{count} chunks indexed` also unchanged.)
- `ko.json:45` `추출된 텍스트 없음` — 3.2 wants `문서에서 읽을 수 있는 내용을 찾지 못했습니다.`
- `ko.json:49–63,119–135` `청중 화면` throughout — 3.2 wants `발표 화면`.
- `ko.json:71` `발표 리포트` — 3.2 wants `발표 결과`.
- `ko.json:77,80–82,85,91–93` auth strings `사용자 이름`, `비공개 워크스페이스 입장`, `발표자 계정 만들기`, `이 브라우저에 저장되지 않습니다` (×2) — task 27 unimplemented; §3.3 explicitly requires removing the "not stored" claim. En mirrors (`Username`, `Enter private workspace`, `Create a presenter account`, `never stored by this browser`).
- `ko.json:101` `신뢰 가능한 최신 상태` — 3.2 wants it hidden from customers (task 29), still catalogued.
- `ko.json:139,141` `질의응답 세션 열기`/`세션이` — 3.2 wants `질문 답변 시작`.
- `ko.json:149` `질문에 답변하기` — 3.2 wants `답변 제안 받기`.
- `ko.json:153` `참고 문서 {ordinal}번째 조각` — 3.2 wants 문서명+page/section (E12-adjacent `조각`).
- `ko.json:165` `일시적 보류` — 3.2 wants `답변을 만들지 못했습니다. 다시 시도해 주세요.`
- `ko.json:176–185` `발화 집계`, `발화 요약`, `최종 발화 수`, `마지막 현재 속도`, `마지막 직전 속도` — 3.2 wants `말하기 기록/통계`, 제외, `마지막으로 측정한…`, `직전 구간의…`.
- `ko.json:193` `파생 집계` — 3.2 wants `발표 시간과 질문 기록을 확인하세요.`
- `ko.json:2 (en:2)` en `evidenceApproval`→"Related materials approval" still exposes "approval" of a flow task 28 retires; `liveApproval*` keys (ko:100–111) for the disabled public-approval card remain in the catalog (task 28 scope, UI-side removal not verifiable here).
- `청RE중` (E12-listed): NOT present in current file or HEAD — either already fixed or E12 cites a stale revision; not a defect in this tree.

## Verdict
The two locale files serve plan tasks 27 (auth copy — barely started: only `signInTitle` changed), 28 (public-approval copy — `liveApproval*` keys still catalogued), and 29 (§3.2 glossary — partially applied: the `근거→관련 자료` sweep is done but ~20 flagged terms remain, including 4 of 5 E12 items); `locale-parity.test.ts` serves task 38's QA command and `bun test` exits 0. Repro for every defect: `grep -n "<term>" apps/console/src/locales/ko.json` at the cited lines. Unimplemented for this scope: auth copy (username/logout/privacy claim), coaching/report/Q&A jargon renames, `청중 화면→발표 화면`, `발표 리포트→발표 결과`, `일시적 보류` rewording, removal/hiding of `신뢰 가능한 최신 상태` and retired public-approval copy, and placeholder-set parity assertion in the test.
