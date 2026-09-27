# Public Stage boundary on the Vercel origin

Origin: `https://impromptu-rev2-stage.vercel.app`; 2026-09-27.
Unauthenticated requests with Stage Origin and Referer:

| Request | Status | Response |
|---|---:|---|
| `GET /v1/account-session` | 404 | `{"error":"not_found"}` |
| `GET /v1/presentation-sessions` | 404 | `{"error":"not_found"}` |
| `GET /v1/snapshot` | 401 | `{"error":"display_session_required"}` |
| `GET /internal/display-invitations` | 404 | Plain-text Vercel not-found page |

None of the four response bodies contained `csrfToken`, `privateDeck`, `accountId`,
`sessionToken`, or `__Host-account`. The Stage `/v1` rewrite reaches the projection
gateway (the 401 snapshot response matches the gateway's unauthenticated response);
`/internal` is not rewritten. This verifies the public denial boundary only, not
the presenter-to-audience happy path.
