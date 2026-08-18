# Impromptu sample presentation

- `impromptu-sample-deck.pptx`: seven-slide Korean product demo deck.
- `impromptu-sample-deck.pdf`: static PDF export of the same deck.
- Source: `scripts/generate-sample-deck.py`.

The PPTX uses native fade transitions on most slides and directional push transitions on the
workflow and display-mode slides. PDF cannot preserve presentation transitions, so it keeps the
final visual state of every slide.

Regenerate both files from the repository root:

```bash
uv run scripts/generate-sample-deck.py
```
