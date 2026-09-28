# Impromptu tutorial — first presentation in four steps

The demo account `demo` / `12341234` is printed on the Console sign-in page. After
`bun run seed:demo` (or the `demo-seed` service in `compose.production.yaml`) runs once, that
account opens with a seeded sample deck and two reference documents attached.

## 1. Sign in

Open the Console `/sign-in` route. The demo box under the submit button shows the credentials;
**Fill in demo account** copies them into the form.

## 2. Open the seeded deck

On `/presentations` (My presentations), press **Continue setup** on `Impromptu sample deck`.
The cockpit loads the slides, playback lease, and prepared evidence. To upload your own deck
instead, drop a PPTX or PDF on the upload panel — PDFs render via PyMuPDF, PPTX via
LibreOffice.

## 3. Attach reference material

The seeded presentation already carries `impromptu-product-brief.md` and `impromptu-faq.md`.
To attach your own, use the reference panel — `.md`, `.txt`, `.pdf`, and `.pptx` are indexed
into the same retrieval store as the slides, so live recommendations cite them. Files also
live in `docs/samples/reference/` if you want to try the upload path yourself.

## 4. Present

1. **Stage:** create a one-use invitation (90-second cap) and open the returned `/display`
   path on the public screen — the secret travels in the URL fragment, never a query string.
2. **Approve:** check the pending display's fingerprint and binding epoch in Console, then
   approve. Stage renders slide images only.
3. **Drive:** advance slides from Console; a Stage-applied receipt confirms each visible
   slide.
4. **Wrap up:** ending the talk finalizes the report — timings, slide dwell, and audience
   questions — under **View results**.

Deleting a presentation from My presentations removes the deck, its playback state, prepared
evidence, and report access for that account.

## Notes

- The in-app quick start card on the upload surface repeats steps 2–4 and dismisses itself
  once acknowledged (`localStorage`), the same first-run-only pattern as the per-tab
  walkthroughs in `projectnmbd`.
- `docs/DEMO-SCOPE.md` defines what a venue demo must and must not show; this tutorial only
  covers the Console-side flow.
