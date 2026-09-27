# Sample presentation on the production Vercel origins

2026-09-27. Sources: tracked `docs/samples/impromptu-sample-deck.pdf`,
Console `https://impromptu-rev2-console.vercel.app`, Stage
`https://impromptu-rev2-stage.vercel.app`. Backend and projection gateway
stay in the local Compose stack behind separate Cloudflare HTTPS tunnels.
No credentials, CSRF tokens, cookies, invitation tokens, or deck contents
were recorded.

| Step | Observed status/result |
|---|---|
| Console landing and `/sign-in` | 200, 200 |
| Existing sample presenter sign-in via Console `/v1/account-sessions` | 201, secure session cookie and CSRF issued |
| Authenticated sample PDF upload via `/v1/deck-uploads` | 201, seven-slide public deck `deck_3cca1ac9debe95315d25a273f36fc0be40cb074dc64e8ac4e11e6e6782271cb6`, session `ps_07e713b6f8a1d6bb88cd4b0cc549cfb1` |
| Owner creates non-authorizing invitation | 201, token only in Stage URL fragment, expires within 90 seconds |
| Independent Stage exchanges invitation | 201, pending join only |
| Owner reads pending identity and authoritative epoch | 200, `JOINED`, `dbe_0`, exact display fingerprint |
| Owner explicitly approves that fingerprint and current CAS | 201, binding advanced to `dbe_1` |
| Stage claims display session after approval | 201, display cookie set |
| Stage reads public slide-only snapshot | 200, seven slides, first slide selected, blackout false, `pbr_0` |
| Replayed invitation | 409, no display cookie |
| Snapshot without approved display cookie | 401 |

These are real HTTP observations over both production aliases, not mock tests
or browser screenshots. The browser-level presenter-to-audience rendering
criterion remains open pending the separately captured real-browser run.
