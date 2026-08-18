# Impromptu shadcn Console Design System

## 1. Atmosphere & Identity

An operational shadcn-style presentation workspace: plain, predictable, and content-first. The
signature is a fixed, typed library of presentation templates shown before upload. There are no
gradients, background images, glows, atmospheric layers, or decorative motion.

## 2. Color

The shared package exposes the standard shadcn token vocabulary: `--background`, `--foreground`,
`--card`, `--card-foreground`, `--primary`, `--secondary`, `--muted`, `--accent`,
`--destructive`, `--border`, `--input`, and `--ring`. Console uses shadcn's neutral dark values;
Stage uses the corresponding neutral light values. Existing semantic aliases map directly onto
those tokens so all surfaces share one source of truth. Raw colors are forbidden in app CSS.

## 3. Typography

The shared shadcn-oriented sans/mono type scale remains authoritative:

- Display and page title: `--text-display`, `--text-title`
- Body and lead: `--text-lead` and the inherited body size
- Supporting labels: `--text-small`, `--text-caption`
- Display and body use `--font-body`; code and numeric labels use `--font-mono`

## 4. Spacing & Layout

All intent-based spacing uses the existing `--space-*` scale. The application shell owns document
scroll. Content is limited to 90rem, template options use an intrinsic grid, and the presentation
workspace changes to one column below 68rem. At 375px the primary content must not scroll
horizontally.

## 5. Components

### Workspace navigation

- Structure: navigation links plus a trailing leave action
- States: default, hover, current, focus
- Accessibility: named `nav`, visible focus, actual links
- Layout: wrapping cluster

### Template selector

- Structure: radiogroup containing three template buttons
- Variants: briefing, keynote, workshop
- States: default, hover, selected, focus, disabled
- Accessibility: `role="radiogroup"`, `role="radio"`, and `aria-checked`
- Layout: overflow-safe intrinsic grid

### Upload zone

- Structure: file input, selected file status, primary upload action
- States: idle, drag target, uploading, success, error
- Accessibility: keyboard-operable file input and live status
- Layout: centered stack

### Operational panel

- Structure: heading, body, controls, and status
- States: default, loading, success, error, disabled
- Accessibility: semantic headings and live regions where state changes
- Layout: stack

## 6. Motion & Interaction

No entrance animation or decorative translation is used. Interactive feedback is limited to
100-150ms color and border changes. Focus is always visible. Reduced-motion users receive the same
layout without special handling because the Console has no non-essential motion.

## 7. Depth & Surface

Borders-only. Panels use a single semantic border; there are no box shadows, gradients, backdrop
filters, or layered backgrounds.

## 8. Accessibility Constraints & Accepted Debt

- Target WCAG 2.2 AA.
- Every action is keyboard reachable and has a visible focus state.
- Body contrast is at least 4.5:1 and large text at least 3:1.
- Korean and English layouts must tolerate long labels and reflow at 375px.

Accepted debt: none. Presentation templates are built-in typed data; there is no separate Admin
surface with an independent theme.
