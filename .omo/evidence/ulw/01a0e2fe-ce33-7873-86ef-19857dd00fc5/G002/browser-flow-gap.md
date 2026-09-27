# Public browser flow: remaining gap

2026-09-27. Own real-browser check against the production Vercel aliases,
using an isolated Chrome-for-Testing profile. Both landing URLs returned
HTTP 200. The Console sign-in form rendered with a working Korean username,
password, and submit control. The seeded `presenter` account authenticated
and the browser moved from `/sign-in` to `/`; its first authenticated screen
said "발표 자료를 올려 주세요" and offered a file picker. It showed no saved
sample presentation or reentry list, even though a seven-slide sample deck
was uploaded successfully through the production alias earlier (see
`sample-deck-flow.md`).

An independent browser on the production Stage URL showed the intentional
inert notice. Source at `apps/stage/src/landing-page.tsx` only creates a join
when `window.opener` exists and never reads `#invite`; the public HTTP
invitation flow works, but the current deployed UI cannot exercise it.
This fails the browser portion of deployment criterion G002/C001; the
existing HTTP receipt does not substitute for a visible, paired slide.

The owned browser and its temporary profile were closed and deleted in a
`finally` block. One login was performed and the profile was deleted
without an explicit application logout; its server-side session remains
until expiration. No credential, cookie, CSRF value, invitation token, or
private deck content was written to this receipt. The Console invitation
and Stage fragment wiring are now assigned to Devin-routed workers; task
37 additionally requires server-backed presentation reentry.
