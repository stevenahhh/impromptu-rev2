# Bilingual catalog and copy audit

2026-09-27. The dedicated Luna writing-agent patch was read, scoped and
applied to the four Console/Stage catalogs, app metadata, both PWA
manifests and Stage topology guidance. Commit `c9b31c3` contains the
rewrites and the corresponding accessible-name assertions; the full
writing-agent review is in `writing-agent.md`, with test alignment in
`test-alignment.md`.

- Console catalog parity: `NODE_ENV=test bun test
  apps/console/src/locale-parity.test.ts
  apps/stage/src/windows-topology.test.ts` -> 8 pass, 0 fail.
- Console complete mounted suite: `NODE_ENV=test bun test --isolate
  apps/console/src` -> 222 pass, 0 fail, one run. Stage suite ->
  40 pass, 0 fail.
- `bun run typecheck` and `bun run lint` -> exit 0 (526 files checked,
  no fixes).
- Literal scans over Console and Stage catalogs for
  `비공개 발표 제어|스냅샷|바인딩|CAS|epoch|DTO|artifact|fallback|토큰`
  returned zero matches in both roots; `근거` returned zero matches in
  the Console Korean catalog.
- The writing agent's catalog audit counted 202 keys each in Console
  KO and EN, and 13 keys each in Stage KO and EN, preserving matching
  placeholder sets. All 430 values were nonblank.

This audit proves catalog and copy criterion C001. It does not claim
that every Stage English entry is yet selectable at runtime or that
legacy route removal and malformed-input coverage (C002/C003) are
complete; those remain separate implementation checks.
