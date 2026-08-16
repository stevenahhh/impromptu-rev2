# PRIVATE BACKEND GUIDE

## OVERVIEW

Private/control-plane Bun service for account and presentation authority, evidence, retrieval,
recommendations, publication, and projection dispatch.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Runtime composition | `src/main.ts` | Services, persistence, model router |
| HTTP/auth boundary | `src/http.ts`, `src/config.ts` | Origin, Referer, CSRF, internal auth |
| Session/publication authority | `src/prepared-evidence.ts` | Serialization, CAS, rollback |
| Projection port | `src/projection-http-port.ts` | Narrow private-to-public calls |
| Durable publication | `src/publication/` | Outbox and dispatcher |
| Retrieval/recommendation | `src/retrieval/`, `src/verifier/` | ACL and evidence gates |

## CONVENTIONS

- Authenticate first; mutations also require exact Origin, Referer, and CSRF.
- Internal Stage receipts use their dedicated bearer-authenticated route.
- Serialize publication per presentation and preserve CAS, staleness, and idempotency checks.
- Reauthorize live evidence immediately adjacent to the projection side effect.
- Roll local mutation state back when projection rejects an event.
- Retrieval is ACL-first: validate tenant, manifest/source hashes, rights, and PII before private reads.
- External retrieval keeps DNS pinning, redirect revalidation, bounded content, and HTTPS-only policy.
- Persist only after applied mutations; outbox delivery completes only on `APPLIED` or `DUPLICATE`.

## ANTI-PATTERNS

- Never expose private session state, candidates, deck data, RAG, or model credentials publicly.
- Never promote an unverified snippet directly into publishable evidence.
- Never separate authorization from the private-byte read/publication it protects.
- Never weaken closed request DTOs or accept unknown mutation keys.
- Never mark outbox rows delivered before public projection acknowledgement.

## CHECKS

```bash
bun test services/private-backend
bun run --cwd services/private-backend typecheck
bun run test:retrieval
bun run test:security
```
