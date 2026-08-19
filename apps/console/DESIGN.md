# Impromptu Presenter Console Design System

## 1. Atmosphere & Identity

An operational, content-first presentation cockpit that behaves like an installed application.
Each state gives the bounded viewport to one primary task: uploading a deck before a session, then
previewing and controlling slides while prepared evidence remains visible. The surface stays plain
and quiet: no gradients, images, glows, shadows, decorative badges, or decorative motion.

## 2. Color

The shared package exposes the standard shadcn token vocabulary: `--background`, `--foreground`,
`--card`, `--card-foreground`, `--primary`, `--secondary`, `--muted`, `--accent`,
`--destructive`, `--border`, `--input`, and `--ring`. Console uses shadcn's neutral dark values.
Existing semantic aliases map directly onto those tokens so all surfaces share one source of truth.
Raw colors are forbidden in app CSS.

## 3. Typography

The shared sans/mono type scale remains authoritative:

- Page title: `--text-title`
- Panel title and primary guidance: `--text-lead`
- Body: `--text-body`
- Supporting labels and status: `--text-small`, `--text-caption`
- Display and body use `--font-body`; numeric labels use `--font-mono`

Workspace titles stay compact because the active task, not a decorative headline, owns hierarchy.

## 4. Spacing & Layout

All intent-based spacing uses the shared `--space-*` scale. The console applies the StyleGallery
`scroll-body-shell` pattern: the app bar is fixed, the route body is bounded by `100dvh`, and only
explicit internal panels may scroll. The document never scrolls.

- App bar: one row, `3.5rem` (56px), containing brand, private navigation, language, and exit.
- Route inset: `--space-4` desktop and `--space-3` at compact widths.
- Upload state: compact heading row plus a full-width, full-height upload panel. The drop zone grows
  to the remaining route height and stays fully inside the viewport.
- Cockpit state: compact heading row plus the StyleGallery `main-with-rail` pattern. A dominant
  preview occupies the main region, while evidence, slides, and audience setup flow through one
  constrained supporting rail.
- Playback controls span the full cockpit width directly below preview and rail, so the primary
  surface and controls consume the complete bounded height without decorative filler.
- Empty evidence uses natural content height. As evidence arrives, the desktop supporting rail owns
  vertical scrolling rather than reserving empty space in advance.
- At 68rem the cockpit reflows to one column: preview and controls remain above the 900px fold, then
  supporting content continues through the cockpit's internal scroll. Page/body scroll stays disabled.
- Every grid/flex descendant that owns overflow has `min-block-size: 0` and `min-inline-size: 0`.
- At 375px primary content reflows without horizontal document scrolling.

## 5. Components

### App bar

- Structure: brand, private route navigation, language segmented control, trailing leave action
- States: default, hover, current, focus, compact overflow
- Accessibility: named `nav`, visible focus, text language labels, actual links and buttons
- Layout: single wrapping-resistant cluster; navigation may scroll inline at compact widths

### Upload zone

- Structure: concise title and guidance, full-surface drop target, file picker, selected-file status,
  primary upload action
- States: idle, drag target, uploading, success, error
- Accessibility: keyboard-operable labelled file input, visible focus, live status
- Layout: full-width stack that fills remaining route height

### Slide rail

- Structure: count plus ordered slide buttons
- States: default, current, hover, focus
- Accessibility: ordered list, `aria-current`, labels tolerate truncation
- Layout: content-sized vertical list inside the supporting rail on wide screens; compact horizontal
  reel after the cockpit reflows to one column

### Preview and playback controls

- Structure: 16:9 preview followed immediately by start, previous, and next controls
- States: ready, presenting, disabled-until-connected, error status
- Accessibility: labelled preview region, visible focus, status live region
- Layout: preview owns the flexible main region; controls span main and rail below it, never scroll
  separately, and remain above the 900px fold at supported desktop widths

### Evidence rail

- Structure: prepared evidence list as the flexible primary panel, followed by compact audience
  screen setup and connection panels
- States: preparing, ready, empty, connected
- Accessibility: semantic articles and source links; status changes announced where needed
- Layout: empty evidence collapses to natural height; the composed supporting rail owns scrolling as
  cards arrive; connected display state collapses to a compact status

### Operational panel

- Structure: heading, body, controls, and status
- States: default, loading, success, error, disabled
- Accessibility: semantic headings and live regions where state changes
- Layout: stack composed inside the bounded route shell

## 6. Motion & Interaction

The beui `file-upload` and `button` sources inform state feedback, adapted without a motion library.
Interactive feedback uses existing `--duration-fast` and `--ease-out` tokens for color, border,
opacity, and filter only. Drag entry changes upload-zone border state; asynchronous controls keep
explicit loading/success/error labels. No hover translation, decorative entrance, or layout
animation is used. `prefers-reduced-motion` removes all transition duration.

## 7. Depth & Surface

Borders-only. Panels use semantic borders and tonal surface tokens. There are no box shadows,
gradients, backdrop filters, background images, or layered atmospheric effects.

## 8. Accessibility Constraints & Accepted Debt

- Target WCAG 2.2 AA.
- Exactly one `main` and one `h1` per route remain in the shared shell structure.
- Every action is keyboard reachable and has a visible focus state.
- Body contrast is at least 4.5:1 and large text at least 3:1.
- Korean and English layouts tolerate long labels and reflow at 375px.
- Internal identifiers, developer terminology, and server reason strings are never rendered.
- User selection is disabled for app chrome and enabled for inputs, textareas, editable content,
  evidence text, and source links.

Accepted debt: none. The current public deck payload provides accessibility labels rather than
raster thumbnails; the Console renders only that available public content and does not invent imagery.
