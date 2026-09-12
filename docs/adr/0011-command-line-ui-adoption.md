# ADR 0011: Adopt the "Command Line" UI (prototype variant B)

Date: 2026-09-11
Status: Accepted

## Context

Three UI redesign prototypes (A "Signal Deck", B "Command Line", C "Phosphor Stack") were
built in `prototype/` against mock data to explore directions for the app's interface.
The old production UI — boot overlay, HUD strip with six buttons, sidebar, inspector,
composer row — had known structural defects documented in `docs/research/ui-redesign-*.md`:
flat hierarchy, write-only state (active model/preset invisible), a hand-rolled disclosure
widget with a broken spinner, and a focus trap re-implementing what the platform now ships.

## Decision

Adopt **variant B ("Command Line")** as the production UI and delete the old one:

- The whole app is one terminal session: full-bleed scrolling transcript (`role="log"`),
  a tmux-style status line pinned to the bottom, a shell prompt with `:` command mode and
  inline tab completion.
- Everything the old UI kept permanently on screen (model, preset, sessions, CRT flags,
  memory inspector, WAT listing, API key) becomes a command (`:model`, `:preset`,
  `:session`, `:new`, `:mem`, `:wat`, `:status`, `:scan`, `:curve`, `:flicker`, `:sound`,
  `:key`, `:clear`, `:keys`) that prints into the same scrollback or opens a compact
  native `<dialog>` overlay.
- The hand-rolled focus trap (`trapDialog`/`setInert`/`releaseTrap`) is deleted; native
  `<dialog>.showModal()` provides the focus trap, Escape handling, and inertness.
- `js/models.js` keeps only the catalog data + wasm sort/filter surface; the combobox
  modal moves into `js/main.js` as the `:model` dialog.
- `styles.css` is a port of `prototype/variant-b.css` with safe-area top inset, stop-state
  send button, session-row actions, key-test badge, and copy buttons added; the
  prototype-only switcher clearance gutter is dropped.
- The prototype harness (`prototype/`) stays on disk locally as the spec source — gitignored, not tracked
  and never imported by production code.

## Consequences

- All engine/search/session/persistence logic (`bridge.js`, `search.js`, `sessions.js`,
  `guard.js`, `markdown.js`) is untouched — this is a presentation-layer cutover.
- The static a11y harness (`test/a11y.mjs`) and the browser harness
  (`test/a11y.browser.mjs`) are rewritten against the new DOM contract (transcript log,
  prompt line, suggestion list, native dialogs, status segments).
- ADR 0006 bars still hold: WCAG 2.2 AA (contrast 4.62:1 for the dimmest token on the
  shell background), `prefers-reduced-motion` kills caret/spinner/flicker/sweep, 320–375px
  is first-class (breakpoints at 700/560/430px, coarse-pointer 44px targets, safe-area
  insets, visualViewport keyboard offset).
- Boot overlay and `SKIP BOOT` are gone; the terminal banner + session header print
  immediately, and catalog failures render a retry card in the transcript.
