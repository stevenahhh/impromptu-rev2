# Writing agent evidence

## Scope

Reviewed every entry in the requested catalogs:

- `apps/console/src/locales/en.json`: 202 entries reviewed.
- `apps/console/src/locales/ko.json`: 202 entries reviewed.
- `apps/stage/src/locales/en.json`: 13 entries reviewed. This catalog was missing and was added.
- `apps/stage/src/locales/ko.json`: 13 entries reviewed.

The copy now uses warm, concise sentence-case English and natural Korean haeyo체. It avoids raw enum names, implementation terms, private-data claims, automatic-publication claims, and retry wording that implies a request is safe to repeat when it may already have been recorded. Screen pairing, screen recovery, material readiness, microphone, Q&A, report, source, and retired-publication states were reviewed. Existing keys and interpolated placeholder names were retained.

## Changed files

- `apps/console/src/locales/en.json`
- `apps/console/src/locales/ko.json`
- `apps/stage/src/locales/en.json`
- `apps/stage/src/locales/ko.json`
- `apps/console/src/app/(console)/layout.tsx`
- `apps/console/public/manifest.webmanifest`
- `apps/stage/public/manifest.webmanifest`
- `apps/stage/src/windows-topology.ts`

No backend, style, test, or other worker files were changed. No staging or commit was performed.

## Verification and exits

| Command | Exit | Result |
| --- | ---: | --- |
| `bun test apps/console/src/locale-parity.test.ts` | 0 | 3 tests passed. Console key, placeholder, nonblank, and brace checks passed. |
| `bun test apps/console/src/locale-parity.test.ts apps/stage/src/windows-topology.test.ts` | 0 | 8 tests passed. Console locale checks and Stage topology copy checks passed. |
| `bun run typecheck` | 0 | Root, UI package, Console, and Stage typechecks passed. |
| Stage catalog parity audit, 13 keys | 0 | KO/EN keys, placeholders, nonblank values, and dash scan passed. |
| Final catalog, machine-key, placeholder, and manifest audit | 0 | Console keys and placeholder sets stayed unchanged; Console and Stage locale parity passed; four catalogs and two manifests parsed; all 430 catalog entries were nonblank. |
| `git diff --check` | 0 | No whitespace errors. No em dash or en dash was found in the catalogs or evidence. |

LSP diagnostics reported no diagnostics for `apps/stage/src/windows-topology.ts` or `apps/console/src/app/(console)/layout.tsx`. The new JSON catalog was validated by typecheck and the explicit catalog audit.

## Related UI test result

The broader focused UI command was run once:

`bun test apps/console/src/evidence-card.test.tsx apps/console/src/session-report-view.test.ts apps/console/src/presentation-report.test.tsx apps/console/src/presentation-report-page.test.tsx apps/console/src/qa-defense-panel.test.tsx apps/console/src/console-routes.test.tsx apps/console/src/deck-upload.test.tsx apps/stage/src/App.test.tsx apps/stage/src/windows-topology.test.ts`

Exit: `1`.

The run recorded 10 passing assertions and 49 failures. The failures were the same test-runtime error during React Testing Library render or cleanup: `TypeError: React.act is not a function`. The passing non-React parser and topology checks, plus the final focused localization/topology run above, show no locale assertion failure. This runtime failure remains unmodified because tests and dependencies are outside this copy-only scope.
