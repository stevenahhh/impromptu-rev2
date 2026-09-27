# G006 — ideal-experience implementation ledger (final)

## Landed with evidence (merged to main d8725c6)
- 6,7 invite contract + CAS epoch authority (stage/console, failing-first)
- 8,14,35 teammate question grants + owner inbox (migration 0012, RLS, 29 focused tests)
- 10 SSE heartbeat across silent whisper inference (real-socket regression)
- 18 zero-activity /end 500 via ensureOwningRows
- 19 deduplicated background deck indexing + per-wave commits
- 12/13/31/32 display invitations mint + #invite consumer + unified pairing UI
- 20/21 docs rebuilt (DEMO-SCOPE, manual QA ledger, runbooks, vercel-demo)
- 37 persisted presentation library + resume + rename
- G004 design sweep (i18n, SLIDE_FAILED, dead-page removal, layout) — 48 shots

## Verified-but-open (automatable, next iteration)
- 24/25/26/27/28/29/30 surface polish refinements (workspace transport strip, copy inventory, auth/private-shell/evidence-card/ref-docs polish) — files exist, per-surface acceptance not yet captured
- 33 stage display recovery polish (SLIDE_FAILED landed; recovery affordance refinement open)
- 34 Q&A panel STT/FINAL copy alignment (panel exists; copy-truth refinement open)
- 36 report/Q&A unified integration (QaDefensePanel mounted on report; residual data-compat polish open)
- 38-41 final integration verification + customer-facing notes (38 locale-parity landed for stage; 39 stage-origin util landed; 40 stage-routes i18n landed; 41 DEMO-SCOPE updated)

## Open with named blockers (not automatable in this env)
- F-physical rows: venue two-screen Extend/Duplicate checks need real hardware
- Provider-account rows: OpenCode/whisper/ollama host installs superseded by Compose topology

## Gates at final HEAD
- typecheck 0 · lint 0 · boundaries/browser-boundary/repo green · build 0
- scoped suites green; canonical serial run env-blocked only
- production QA: invite+library+reentry proven on Vercel aliases
