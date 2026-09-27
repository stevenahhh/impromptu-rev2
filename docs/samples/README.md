# Impromptu sample presentation

- `impromptu-sample-deck.pptx`: seven-slide Korean product demo deck.
- `impromptu-sample-deck.pdf`: static PDF export of the same deck.
- Source: `scripts/generate-sample-deck.py`.

The sample is uploaded to the private Console. Stage receives the public slide render after the
owner approves the exact display identity. The sample does not publish evidence cards or expose
transcripts, questions, source details, or account data to Stage.

## Current demo path

1. Open the Console `/sign-in` route on the private controller and sign in with a task-owned demo
   account.
2. In Console `/` or `/session`, upload the PDF or PPTX and wait for the deck to finish rendering.
3. Create a short-lived, one-use invitation for the active deck. Open the returned Stage path on
   the independent public device. The token belongs in the URL fragment, not a query string.
4. In Console, check the pending display ID, fingerprint, deck version, and binding epoch. Approve
   only the exact public device.
5. Stage claims `/display/:displayId` and renders the slide-only public snapshot. Change slides
   from Console and wait for the Stage-applied receipt.

A bare Stage URL, an invitation by itself, or a copied join object does not authorize a display. If
the deployed Console and Stage do not expose the one-use invitation flow, stop the two-device demo
and use the approved emergency public artifact. Do not restore the retired manual join guidance.

## Regenerate the files

From the repository root:

```bash
uv run scripts/generate-sample-deck.py
```

Keep generated files free of account credentials, invitation tokens, participant data, and private
source material. The Vercel, Compose, and Cloudflare demo setup is documented in
`docs/runbooks/vercel-demo.md`.
