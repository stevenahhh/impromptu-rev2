# impromptu-r2

`impromptu-r2` is a presentation-assistant PWA that keeps a public Stage separate from a private Presenter Console. It supports Windows extended and mirrored display setups, prepares sourced evidence, and routes every non-trivial AI operation through server-side services.

## Product contract

- The projected machine runs a public-only Stage profile.
- A separately authenticated device runs the private Console in both secure display modes.
- Curated evidence is the first deliverable; live evidence remains private until its safety and usefulness gates pass.
- Publishing is an explicit, server-authorized transition that produces a closed public DTO.
- STT, OCR/VLM, embeddings, reranking, LLM inference, verification, DLP, coaching inference, and generated report summaries run only on the server.

## Repository layout

```text
apps/       Browser PWAs
services/   Server deployables and the Python ingestion worker
packages/   Shared contracts, reducers, and test helpers
infra/      Database migrations and local infrastructure harnesses
tests/      Cross-cutting contract, security, and end-to-end checks
docs/       Product, security, research, and operating documentation
.omo/       Approved implementation plan and research evidence
```

## Toolchain

- Bun 1.3+
- TypeScript 5.9+
- Biome
- Python 3.14+ with `uv` for ingestion

Install and verify:

```bash
bun install
bun run check
```

Python services are added in their own verified increment and use `uv sync`.

Run the disposable PostgreSQL migration and role-isolation harnesses with Docker:

```bash
bun run test:db
bun run test:db:harness
bun run test:db:concurrent
```

See [`infra/database/README.md`](infra/database/README.md) for the database split, outbox consequence, role boundary, migration ledger, and teardown contract.

## Work plan

The binding implementation plan is `.omo/plans/impromptu-r2-hyperplan.md`.

Every green increment is committed locally and atomically. See `CONTRIBUTING.md`.
