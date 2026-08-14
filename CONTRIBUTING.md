# Contributing to impromptu-r2

## Atomic increment loop

1. Add the failing behavioral test, contract fixture, or static validation.
2. Confirm it fails for the intended reason.
3. Implement the smallest change that satisfies it.
4. Run the scoped validator and matching manual QA surface.
5. Stage only files belonging to that increment.
6. Run `git diff --cached --check`.
7. Create one local atomic commit.

Do not use `git add .` as the default. Do not mix unrelated cleanup, generated artifacts, credentials, uploaded decks, or another contributor's changes.

## Parallel work

Parallel contributors use separate topic branches and `git worktree` directories. A worktree has one active owner. The integration owner reviews and cherry-picks green commits in dependency order, then reruns the repository gate.

Do not amend, rebase, force-push, or rewrite another contributor's commits without explicit approval.

## Commit messages

Use the repository's Conventional Commit subset:

```text
chore(repo): initialize impromptu-r2 workspace
test(protocol): lock public card transitions
feat(projection): publish closed audience DTO
fix(reconnect): reject stale display binding epoch
docs(ai): define server-only inference boundary
```

## Required checks

Before each commit:

```bash
bun run check
git diff --cached --check
```

Use the narrower package check while developing, but the committed increment must leave all affected consumers green.

## Security boundaries

- Browser packages must not import AI provider SDKs, model runtimes, tokenizers, or model weights.
- Provider secrets are server-only.
- Public Stage code must not import private contracts or private storage clients.
- Logs, analytics, URLs, and browser storage must not contain credentials, transcript content, pairing secrets, or private evidence payloads.
