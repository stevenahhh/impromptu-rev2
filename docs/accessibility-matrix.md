# Console and Stage accessibility matrix

The production browser validator (`bun run check:browser-runtime`) applies this matrix to the built PWAs in Chrome. It waits on DOM, navigation, service-worker, and media-query events; it does not use polling or fixed sleeps.

## Route coverage

| Surface | Route | State |
| --- | --- | --- |
| Console | `/sign-in` | Signed out; username and password sign-in fields |
| Console | `/` | Authenticated fixture |
| Console | `/session` | Authenticated fixture |
| Stage | `/` | Public display setup |
| Stage | `/display/rehearsal` | Public rehearsal display |

## Assertions on every route

| Requirement | Automated assertion |
| --- | --- |
| Keyboard focus order | Tab traversal exactly follows the rendered focusable DOM order; disabled controls are excluded. |
| Landmarks | Exactly one `main` and one page `h1`; authenticated Console routes also expose exactly one named private-workspace navigation landmark. |
| Labels and names | Inputs have associated labels, interactive controls have non-empty accessible names, and every image has `alt`. |
| Contrast where computable | Rendered text and controls are composited against their ancestor backgrounds and checked against WCAG 2.x ratios: 4.5:1 for normal text and 3:1 for large/bold text. Image/video text and background-image pixels are outside the computable set. |
| Forced colors | With `forced-colors: active`, buttons, panels, brand marks, and badges retain a visible system-color border. |
| Reduced motion | With `prefers-reduced-motion: reduce`, computed animation and transition durations do not exceed 1 ms. |

The same validator retains the Stage 320 px and 200%-equivalent layout checks. Browser screenshots are emitted under the validator's temporary artifact directory for release evidence; they are not committed.
