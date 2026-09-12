# Research: UI Redesign — Layout & Information Architecture (LANE A)

**Document Status:** Final Research Note
**Date:** 2026-09-11
**Lane:** A — layout, navigation, workspace/panel organization, progressive disclosure, IA
**Scope:** Front-end presentation and interaction only. The WASM engine, chat protocol, and search fan-out are out of scope and untouched. Every recommendation below lands in the three existing first-party files (`index.html`, `styles.css`, `js/*.js`) with **zero new assets and zero new dependencies** — see §4.

---

## 0. Method & tooling note

| Tool | Used for | Result |
| :--- | :--- | :--- |
| `context-awesome` MCP (`find_awesome_section`, `search_awesome_items`) | discovery of awesome-list taxonomy and candidate items | Used. Two calls returned a transient `502 NETWORK_ERROR` on first attempt (`"terminal emulator"`, `"information architecture…"`); both succeeded on retry. |
| `gh_grep` (`searchGitHub`) | real-world code for every mechanism recommended | Used — 8 literal-pattern searches. One (`role="statusbar"`) returned **zero** hits corpus-wide, which is itself a finding (§3). |
| `read` on primary docs | MDN, W3C APG/WAI-ARIA, Chrome for Developers, OpenBSD tmux(1), jsDelivr/npm metadata, upstream repo source | Used. |
| `web_search` | only where a compat fact was not in the rendered doc body | Used twice (`<details name>` support; `startViewTransition` baseline). |
| `grep` on `https://www.w3.org/TR/wai-aria-1.2/` | locating the `statusbar` role | **Returned "No matches found" — inconclusive, not evidence.** Replaced with the MDN ARIA role index (which enumerates all 6 role categories) + the APG. Reported here because it must not be mistaken for proof. |

Awesome-list entries were used **only as discovery pointers**; every claim below is sourced to the project's own docs/source, MDN, the W3C, or an upstream repository I read directly.

---

## 1. Diagnosis, grounded in the current markup

### 1.1 The HUD is a flat row, not a hierarchy

`index.html:33-43` — brand, telemetry, and six buttons share one 44px strip. In `styles.css:70-93` (`#hud`, `.brand`, `.telemetry`, `.hud-btn`) every one of them is the same `VT323` display font, the same `border: 1px solid var(--border)`, the same `border-radius: 3px`, the same `min-height: 44px; min-width: 44px`. The only differentiation is font-size (24 / 17 / 15px) and colour step.

Two consequences beyond "looks flat":

- **The six buttons are functionally three unrelated groups presented as one group:** display effects (`SCAN`, `CURVE`, `FLICKER`, `SND` — `js/main.js:58-65`), and panel openers (`ASM` → `#btn-inspector`, `SET` → `#btn-settings`, `js/main.js:180-185`, `js/main.js:291`). They have nothing in common but their border.
- **Six tab stops for six shortcuts.** `min-height: 44px` is genuinely correct for WCAG 2.5.8, but six individually-focusable toggles in one strip means a keyboard user tabs through 4 CRT effects plus 2 panels before reaching anything else.

### 1.2 Active model and active preset are write-only state

- **Model**: the only visible trace is `#btn-model`, which is *inside the composer row* (`index.html:69-76`) and whose label is rewritten to `MODEL: ${id}` by `refreshModelButton()` (`js/main.js:583-585`). It shows the model as a button caption, in the same visual weight as `SEND`, positioned as far from the moment of decision as possible.
- **Prompt preset**: `js/main.js:786-795` renders `S.PRESETS` keys as `.pill`s that only *fill the textarea*. On `APPLY` the active preset is guessed back by string-equality (`js/main.js:798-800`: `Object.entries(S.PRESETS).find(([,v]) => v === text)?.[0] || 'CUSTOM'`). **The active preset is never rendered anywhere.** You cannot see which preset is live without opening the drawer and comparing text.
- **Session**: `#session-list` items get `.on` (`styles.css:151`) but carry no `aria-current`, so the active session is visual-only.

### 1.3 The tool transcript is semantically hand-rolled and visually subordinate

Structure built in `js/main.js:416-471`: `div.tool-card > div.tool-head[role="button"][tabindex="0"][aria-expanded] + div.tool-body`, containing `div.src-group > div.src-head[role="button"][aria-expanded] + div.src-body`. Keyboard handling is re-implemented by hand for each head (`js/main.js:422-427` and `503-507`: manual Enter/Space + `preventDefault`). Visual weight is `1px dashed var(--amber-mid)` on the card, `12.5px` body type, and only the *first* source group is open (`js/main.js:465`: `head.className = 'src-head' + (i > 1 ? ' collapsed' : '')`).

So: the surface carrying the app's most novel and most information-dense content (grouped, ranked, per-source search results with latency) is the only surface in the app drawn with a *dashed* border and the *smallest* type — while being semantically a pile of divs with re-implemented disclosure behaviour.

### 1.4 Panels are boolean toggles, with no docking, no resize, no address

`#inspector` is `hidden`/unhidden (`js/main.js:182`, `185`); its tabs swap `hidden` (`js/main.js:189-190`). `#sidebar` collapses by class (`styles.css:107-108`, `200-206`). Widths are hard-coded `220px` / `420px` (`styles.css:97`, `283`). Breakpoint behaviour is viewport media queries only (`styles.css:391-433`), so when the inspector opens and the chat column narrows, **nothing inside the chat column adapts** — tool cards keep `max-width: 860px` and `12.5px` body text regardless.

Nothing about view state is addressable. There is no URL representation of "inspector open, MEMORY tab, model X". Back/forward do nothing inside the app.

### 1.5 The thesis

Three structural moves fix all four:

1. **Separate state from controls.** Split the HUD into a status zone (identity + live state, including a *state rail* that carries the active session/model/preset as text) and grouped **toolbars** for controls.
2. **Make every panel first-class and addressable.** Real dock semantics + keyboard resize + container-query-driven internals + a hash representation of view state.
3. **Promote the transcript.** Native exclusive accordion instead of hand-rolled disclosure, and promote the web-search trace from "thing inside a message" to a surface the inspector can host.

---

## 2. Shortlist

### A-1 — Three-zone status bar with `role="toolbar"` control groups

**Enables / where.** Replaces `index.html:33-43`. Three zones: left = identity (`brand`), centre = live state (telemetry + the A-2 state rail), right = two correctly-scoped control groups.

**Precedent (read the source, not a blog).** VS Code models exactly this: `StatusbarAlignment { LEFT, RIGHT }` and a declarative `IStatusbarEntry` carrying `name`, `text`, explicit `ariaLabel`, an optional `role` (*"Default is 'button'"*), a semantic `kind` (`'standard' | 'warning' | 'error' | 'prominent' | 'remote' | 'offline'`), and `showProgress`. Source: [`src/vs/workbench/services/statusbar/browser/statusbar.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/statusbar/browser/statusbar.ts) (MIT). The transferable lesson: **each status item declares its own accessible name and severity kind** — the app's single `#telemetry` string does neither.

**Mechanism.** `role="toolbar"` is a real, non-abstract ARIA role ([ARIA role index](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles), document-structure roles). The [APG Toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) specifies:

- the container has `role="toolbar"` and **must** get a name via `aria-labelledby` or `aria-label`;
- focus management must be roving-tabindex: one tab stop for the whole group, arrow keys move among controls;
- `aria-orientation="vertical"` only if arranged vertically;
- **"Use toolbar as a grouping element only if the group contains 3 or more controls."**

That last rule decides the split. `SCAN/CURVE/FLICKER/SND` = 4 controls → a legitimate toolbar. `ASM`/`SET` = 2 → **must not** be a toolbar (see §3).

```html
<header id="statusbar">
  <button class="brand" aria-expanded="false" aria-controls="sidebar"
          aria-label="Toggle session list">ASM<span class="brand-dim">::</span>AGENT</button>

  <nav id="state-rail" aria-label="Active configuration"><!-- A-2 --></nav>

  <p id="telemetry" aria-label="Engine telemetry">
    <span aria-hidden="true">MEM 128KB · MSG 42 · TOK/S 18.3 · STATE STREAM</span>
  </p>

  <div role="toolbar" aria-label="CRT display" class="hud-group">
    <button id="btn-scan" aria-pressed="true" aria-keyshortcuts="Alt+S">SCAN</button>
    <button id="btn-curve" aria-pressed="true" aria-keyshortcuts="Alt+C">CURVE</button>
    <button id="btn-flicker" aria-pressed="false" aria-keyshortcuts="Alt+F">FLICKER</button>
    <button id="btn-sound" aria-pressed="false" aria-keyshortcuts="Alt+N">SND</button>
  </div>

  <div class="hud-group">
    <button id="btn-inspector" aria-expanded="false" aria-controls="inspector"
            aria-keyshortcuts="Alt+A">ASM</button>
    <button id="btn-settings" aria-keyshortcuts="Alt+,">SET</button>
  </div>
</header>
```

Roving tabindex is ~15 lines: keep `tabindex="0"` on the last-focused control and `tabindex="-1"` on siblings; `ArrowLeft/ArrowRight` move focus. The payoff is a direct answer to §1.1 — six tab stops become two.

**Telemetry handling — a correctness warning.** Do **not** put `role="status"` on `#telemetry`. `js/main.js:172-178` rewrites that string every 500ms; a live region there is a screen-reader flood. ADR 0006 already mandates the decoupled approach (`#a11y-status`, sr-only, `js/main.js:77`, `js/a11y.js`'s `announceStatus`) — keep it, mark the volatile numeric text `aria-hidden="true"`, and expose only meaningful state *transitions* through the existing announcer. Also: `role="statusbar"` does not exist (§3).

**Verified vs inferred.** APG toolbar rules, VS Code interfaces, and `role="toolbar"` existence: **VERIFIED** (read). Roving-tabindex line count and the exact roving algorithm: **INFERENCE** (standard APG toolbar behaviour, not benchmarked here).

**Cost.** No dependency. HTML restructure + ~15 lines of JS + CSS. License: N/A (first-party + platform).

---

### A-2 — State rail: model and preset as visible, named state

**Enables / where.** Replaces the buried `#btn-model` caption and the invisible preset. Sits in the status bar centre; the *value itself is the button's visible label*, so the state is never one click away.

**Mechanism.** The APG [Breadcrumb pattern](https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/) is the right borrowed shape — a labelled `nav` landmark whose items are the *path to the current state*:

```html
<nav id="state-rail" aria-label="Active configuration">
  <ol>
    <li><button id="rail-model" aria-label="Active model: llama-3.1-8b. Change model"
                aria-haspopup="dialog" aria-keyshortcuts="Alt+M">llama-3.1-8b</button></li>
    <li><button id="rail-prompt" aria-label="Active system prompt: BASIC AGENT. Change prompt"
                aria-keyshortcuts="Alt+P">BASIC AGENT</button></li>
    <li><button id="rail-keys" aria-keyshortcuts="?">KEYS</button></li>
  </ol>
</nav>
```

Two things this fixes that a plain label would not:

1. **`rail-prompt` must be driven by real state, not string-guessing.** `S.setSystemPrompt(s.id, guessed, text)` (`js/main.js:800`) already persists a preset *name* per session — `rail-prompt` should render that stored name, which turns the current `'CUSTOM'` fallback from a silent guess into visible truth.
2. **Do not misuse `aria-current`.** APG specifies `aria-current="page"` on *the link to the current page* only, and notes it is *optional* when the current item is not a link. The active-*session* row is the thing that legitimately wants `aria-current="true"` (`styles.css:151` already styles `.session-item.on`; add the attribute at `js/main.js:706` in `renderSidebar`). Model and preset are *configuration*, not location — they get descriptive accessible names, not `aria-current`.

**Verified vs inferred.** Breadcrumb pattern requirements: **VERIFIED** (read). That the rail should live centre-left in the status bar and collapse to icons under container pressure: **INFERENCE** (design judgement).

**Cost.** No dependency. Reuses `S.getActive()` / `getActiveModel()` which already exist.

---

### A-3 — Command palette as the primary IA surface

**Enables / where.** The single highest-leverage change. It converts the six cryptic abbreviations from *the interface* into *shortcuts to the interface*, and makes every buried capability (model, preset, inspector tab, settings, session ops) reachable, searchable, and discoverable by name rather than by a 4-letter abbreviation the user must already know.

**Mechanism — `<dialog>` + `showModal()` gives the hard parts for free.** The app already hand-rolls a focus trap (`js/a11y.js`'s `trapDialog`/`releaseTrap`, called at `js/main.js:277-286`) and a modal backdrop (`styles.css:330-345`). `<dialog>.showModal()` provides: top-layer rendering, **native focus trap**, native `Esc` → `close` event, native `::backdrop`, and automatic inert-ness of the rest of the page — all of which are the failure modes this app currently patches by hand. It is also *less* code.

```html
<dialog id="palette" aria-labelledby="palette-label">
  <label id="palette-label" class="sr-only" for="palette-input">Command palette</label>
  <input id="palette-input" type="text" role="combobox" autocomplete="off"
         aria-expanded="true" aria-controls="palette-list" aria-activedescendant="">
  <ul id="palette-list" role="listbox" aria-label="Commands">
    <li role="option" id="cmd-model" aria-selected="false">Change model…</li>
    <li role="option" id="cmd-preset" aria-selected="false">Apply prompt preset…</li>
    <li role="option" id="cmd-scan" aria-selected="true">Toggle scanlines</li>
  </ul>
</dialog>
```

```js
palette.showModal();          // focus trap, Esc, backdrop, inertness — all native
palette.addEventListener('close', () => trigger.focus());  // restore focus
```

Command list is derived from state the app already has: `S.PRESETS` keys, `S.loadSessions()`, `getActiveModel()`, the CRT keys in `js/main.js:58`, and the inspector tabs at `js/main.js:186`. **One registry, three consumers** — palette (A-3), keymap overlay (A-7), and `aria-keyshortcuts` (A-7) — which is what keeps the shortcut documentation honest.

Progressive enhancement: a trigger can be declarative with the invoker-commands API — `<button commandfor="palette" command="show-modal">`. Verified shipping in the wild: [markuplint](https://github.com/markuplint/markuplint) (`require-dialog-autofocus` rule tests `command="show-modal" commandfor="d"`), [heritrix3](https://github.com/internetarchive/heritrix3/blob/master/engine/src/main/resources/org/archive/crawler/restlet/Job.ftl) (`commandfor="copyJobModal" command="show-modal"`), and [material-web](https://github.com/material-components/material-web/blob/main/labs/aria/menu/demo/stories.ts). Treat as progressive enhancement and keep a JS fallback — this is a newer API.

**The library alternative, and why I reject it.** `ninja-keys` (MIT, 1.7k★) is the obvious CDN candidate — [README](https://github.com/ssleptsov/ninja-keys) documents `<script type="module" src="https://unpkg.com/ninja-keys?module">` and a 0-build "Static Html" integration. I read its published metadata and its source before deciding:

- **VERIFIED:** the npm package publishes only `dist/*.js` with **bare specifiers** — `import {LitElement} from 'lit'`, `import hotkeys from 'hotkeys-js'`, plus `@material/mwc-icon` (`package.json` deps: `lit@2.2.6`, `hotkeys-js@3.8.7`, `@material/mwc-icon@0.25.3`). There is **no bundled standalone file published** (the repo's `docs/ninja-keys.bundled.js` is not in the npm file list). So zero-build consumption depends on a bare-specifier-rewriting CDN (`https://cdn.jsdelivr.net/npm/ninja-keys@1.2.2/+esm`) — workable, but it means a Lit 2 runtime plus a Material Icons font fetch (`document.fonts.load('24px Material Icons','apps')`) landing inside a hand-written amber CRT app.
- **VERIFIED — accessibility gap.** Its `render()` emits `<div class="modal">` with **no `role="dialog"`, no `aria-modal`, no focus trap, and no `role="listbox"/"option"`** on the action list; selection is a `.selected` class. It binds global `hotkeys-js` handlers and a global `esc`. Against a hard WCAG 2.2 AA bar plus the ADR 0006 keyboard-operability clause, that is a regression versus the hand-rolled pattern above, not an improvement.
- **VERIFIED — a real bug for this app's use case.** Filtering does `new RegExp(this._search, 'gi')` against `action.title` in `render()`; typing `(` into the palette throws. In a terminal-flavoured tool where users type punctuation constantly, that is a live footgun.

Recommendation: **hand-roll on `<dialog>` + combobox/listbox.** ~120 lines, no dependency, full control of the CRT aesthetic, and it *retires* `trapDialog`. If a library is ever required, `+esm` is the verified zero-build path.

**Verified vs inferred.** `<dialog>`/`showModal` behaviour: **VERIFIED** (MDN). `commandfor` usage in the wild and its newness: **VERIFIED** for existence, **INFERENCE** for exact browser versions (not read from a compat table this session — ship behind feature detection). ninja-keys internals: **VERIFIED** (source + published metadata read directly).

---

### A-4 — Tool transcript: native exclusive accordion + animated disclosure

**Enables / where.** Rewrites `js/main.js:416-471` and the `.tool-card`/`.src-group` CSS (`styles.css:238-282`). Directly addresses §1.3: it hands the disclosure behaviour to the platform *and* makes "one source group at a time" a declarative property instead of an index comparison.

**Mechanism 1 — `<details name>` for exclusivity.** From [MDN's `<details>` reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details): *"The `name` attribute specifies a group name — give multiple `<details>` elements the same `name` value to group them. Only one of the grouped `<details>` elements can be open at a time… `<details>` elements don't have to be adjacent to one another in the source to be part of the same group."*

This replaces the hand-rolled Enter/Space handling at `js/main.js:503-507` and the `i > 1 ? ' collapsed' : ''` index hack at `js/main.js:465`:

```html
<details class="tool-card" open>
  <summary class="tool-head">
    <span class="tool-name">web_search({"q":"…"})</span>
    <span class="tool-status">4 sources · 812ms</span>
  </summary>
  <div class="tool-body">
    <!-- same name ⇒ at most one source group open, natively -->
    <details class="src-group" name="src-7f3a" open>…</details>
    <details class="src-group" name="src-7f3a">…</details>
    <details class="src-group" name="src-7f3a">…</details>
  </div>
</details>
```

`aria-expanded` becomes unnecessary on the summary (native disclosure semantics are exposed by the UA), and `<summary>` is a real focusable control with correct Enter/Space behaviour — deleting code rather than adding it.

**Support — VERIFIED.** Chrome 120, Safari 17.2, Firefox 130, per [MDN's exclusive-accordions article](https://developer.mozilla.org/en-US/blog/html-details-exclusive-accordions/) and corroborated by [Chrome for Developers](https://developer.chrome.com/docs/css-ui/exclusive-accordion) and [web-platform-dx](https://web-platform-dx.github.io/web-features-explorer/features/details-name/). **Note the degradation risk:** on an engine without `details[name]`, groups are simply independent — the transcript still works, it just loses exclusivity. In browsers that *do* support `name`, a `toggle`-listener fallback is unnecessary; in browsers that don't, exclusivity is cosmetic anyway. Do **not** add a JS exclusivity shim.

**Mechanism 2 — animating the open/close.** Requires two pieces: `interpolate-size: allow-keywords` (so `block-size: auto` can participate in a transition) and `::details-content` (the wrappable content box).

```css
:root { interpolate-size: allow-keywords; }   /* inherits; one line, page-wide */

@supports (interpolate-size: allow-keywords) {
  .tool-card::details-content,
  .src-group::details-content {
    block-size: 0;
    overflow: hidden;
    opacity: 0;
    transition: block-size .22s ease, opacity .22s ease,
                content-visibility .22s allow-discrete;
  }
  .tool-card[open]::details-content,
  .src-group[open]::details-content { block-size: auto; opacity: 1; }
}
```

**Support — VERIFIED as an opt-in with an honest caveat.** [Chrome for Developers' `interpolate-size` guide](https://developer.chrome.com/docs/css-ui/animate-to-height-auto) documents `interpolate-size: allow-keywords` as an opt-in (default `numeric-only`) that must be declared at `:root` or on a subtree, and the compat widget on that page shows **Chrome/Edge 129+, Firefox not supported, Safari not supported**. Two real-world precedents read directly, including the *failure-mode reasoning* worth copying:

- [elementor](https://github.com/elementor/elementor/blob/main/modules/atomic-widgets/module.php) — its source comments distinguish the two degradation paths precisely: `interpolate-size` is a valid selector with an unknown *declaration*, so the rule always parses and an unsupporting browser simply drops that one declaration; but `::details-content` is an unrecognised *pseudo-element*, so the **whole rule is dropped**. Their conclusion, which this app should adopt verbatim: keep `block-size: 0` / `[open] { block-size: auto }` both inside the identical `::details-content` guard so an unsupporting browser *"parses neither and simply keeps the browser's native `<details>` toggle — an instant toggle, never a silently blanked panel."*
- [storybook](https://github.com/storybookjs/storybook/blob/next/code/core/src/components/components/ActionList/ActionList.tsx) and [gravitational/teleport](https://github.com/gravitational/teleport/blob/master/web/packages/teleterm/src/ui/TopBar/Identity/IdentityList/Roles.tsx) both wrap these declarations in `@supports (interpolate-size: allow-keywords)`.

**Free reduced-motion compliance.** The repo already has the universal kill-switch at `styles.css:381-389` (`transition-duration: 0.01ms !important` under `prefers-reduced-motion: reduce`). Because the disclosure animation is authored as a `transition` (not an `animation`), **ADR 0006's reduced-motion clause is satisfied with zero additional CSS.**

**Promote the surface itself.** Beyond semantics, give the transcript real visual standing: solid border at the same weight as `.src-group` (drop the `dashed`), promote `.tool-head` to display-font at the same size as `.msg-head`, and render a per-source **latency bar** using the `ms` value already emitted at `styles.css:270` (`.src-head .ms`). The `MEM` bars in the inspector (`.mem-bar`/`.mem-fill`, `styles.css:311-317`) already establish that visual vocabulary — reuse it.

**Cost.** No dependency, no new assets, ~40 lines of CSS net-negative JS.

---

### A-5 — Inspector as a real dock: keyboard-resizable + container-query internals

**Enables / where.** Replaces the boolean `hidden` toggle (`js/main.js:182`) and the hard-coded `width: 420px; min-width: 420px` (`styles.css:283`), and fixes the "nothing adapts when the column narrows" problem in §1.4.

**Mechanism 1 — APG Window Splitter.** The pattern that is almost always skipped: a draggable splitter must also be *keyboard*-operable, and the W3C specifies exactly how. From [APG Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) (read directly):

- the focusable splitter has `role="separator"` and carries `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `aria-controls` (pointing at the primary pane) and `aria-labelledby`/`aria-label` matching the primary pane's name;
- `Left/Right` move a vertical splitter; `Enter` collapses/restores the primary pane; `Home`/`End` are optional min/max; `F6` optionally cycles panes.

```html
<div id="dock" role="separator" tabindex="0" aria-orientation="vertical"
     aria-label="Inspector" aria-controls="inspector"
     aria-valuemin="0" aria-valuemax="100" aria-valuenow="72"></div>
```

Compose the layout with a single CSS custom property so the splitter, the panel width, and `container` queries all read one number:

```css
#layout { display: grid; grid-template-columns: auto 1fr auto; }
#sidebar  { inline-size: var(--w-sidebar, 220px); }
#inspector{ inline-size: calc((100% - var(--w-sidebar, 220px)) * (1 - var(--split, 0.72))); }
#chat     { container-type: inline-size; min-inline-size: 0; }
```

**Honest caveat, read from the pattern page itself:** APG states this pattern *"has been revised to match the ARIA 1.1 specification"* but the task force *"will not complete its review until a functional example that matches the ARIA 1.1 specification is complete"*, and points to `aria-practices#130` for the missing example. So **there is no reference implementation to copy** — implement to the written spec.

**Mechanism 2 — container queries for the internals.** `container-type: inline-size` on `#chat`, then adapt *content* to *available* width rather than to viewport width. This is the missing piece that viewport media queries in `styles.css:391-433` cannot express:

```css
@container (width < 640px) {
  .msg { max-width: 100%; }
  .tool-body { font-size: 12px; padding-inline: 8px; }
  .src-head .ms { display: none; }   /* latency only when there is room */
}
@container (width < 480px) {
  .msg-body table { display: block; overflow-x: auto; }
}
```

Now opening the inspector genuinely narrows the transcript rather than squeezing it. Note the containment constraint: `container-type: inline-size` applies inline-size containment, so `#chat` must not be sized *by* its contents — it is `1fr` in the grid, so it is already correct. Keep `min-inline-size: 0`.

**Anti-recommendation inside this item.** Do **not** use CSS `resize: horizontal` as the split mechanism. It is widely used for *demo* resizability — verified in the wild in [superset](https://github.com/apache/superset/blob/master/superset-frontend/packages/superset-ui-core/src/components/MetadataBar/MetadataBar.stories.tsx), [twenty](https://github.com/twentyhq/twenty/blob/main/packages/twenty-front/src/modules/ui/layout/tab-list/components/__stories__/Tablist.stories.tsx), [bitwarden](https://github.com/bitwarden/clients/blob/main/libs/vault/src/components/truncated-filename/truncated-filename.stories.ts) and [mantine](https://github.com/mantinedev/mantine/blob/master/packages/%40docs/demos/src/demos/styles/Styles.demo.containers.tsx) — but note that the overwhelming majority of those are *Storybook stories*, i.e. authoring conveniences, not shipped panel docks. It cannot be focused, cannot be arrow-key driven, and requires `overflow != visible`. It cannot satisfy the APG keyboard requirements, so it must never be the only mechanism.

Likewise **Split.js** ([split.js.org](https://split.js.org/), the top "resizable panes" hit in `awesome-js-posts`) is unnecessary: it adds a CDN dependency for pointer-drag behaviour while still leaving the ARIA/keyboard contract to be written by hand. The dock's pointer drag is ~20 lines of `pointerdown`/`pointermove` with `setPointerCapture`.

**Verified vs inferred.** APG splitter requirements (roles, states, keys) and the missing-example caveat: **VERIFIED** (read). `@container`/`container-type` semantics and the containment constraint: **VERIFIED** ([MDN container queries guide](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries)). Broad engine support for `@container`: **INFERENCE** (documented as shipping; exact version table not re-read this session — it is a 2023-era baseline feature, but verify before shipping the layout on it, and keep the current media queries as the fallback).

---

### A-6 — Deep-linkable view state: every panel gets an address

**Enables / where.** New behaviour, no existing code to replace. Gives the redesign a real navigation model (back/forward across panel states), shareable state, and a testable contract for the layout — which matters because the redesign is exactly the kind of change that silently breaks panel wiring.

**Mechanism.** Hash only — never affects asset resolution, needs no server rewrite, safe on GitHub Pages project subpaths.

```js
const VIEW = ['panel', 'tab', 'model', 'preset', 'session'];
let syncing = false;

function readView()  { return Object.fromEntries(new URLSearchParams(location.hash.slice(1))); }
function writeView(patch) {
  const next = { ...readView(), ...patch };
  for (const k of Object.keys(next)) if (!VIEW.includes(k) || !next[k]) delete next[k];
  syncing = true;
  history.replaceState(null, '', '#' + new URLSearchParams(next));
  syncing = false;
}
addEventListener('hashchange', () => { if (!syncing) applyView(readView()); });
```

`writeView({ panel: 'inspector', tab: 'memory' })` on the existing toggles (`js/main.js:182`, `189`) and `applyView()` on boot next to `restoreSession()` (`js/main.js:137`). Use `replaceState` for continuous state (panel/tab) and `pushState` only for deliberate navigations (session switch), so Back means "go back to the previous session", not "undo my last toggle".

**Verified vs inferred.** Platform behaviour (`replaceState`/`hashchange`, relative-path safety of hashes): **VERIFIED** by construction — nothing here needs a network fetch, so there is no path resolution to get wrong. The exact key schema is **INFERENCE** (design choice).

**Cost.** ~30 lines. No dependency.

---

### A-7 — Keymap overlay + `aria-keyshortcuts` from one registry

**Enables / where.** Directly answers "the six buttons are cryptic": a discoverable, searchable keymap. Doubles as the documentation surface for the palette.

**Precedent.** This is the terminal-app convention, and it is worth copying literally. From the [OpenBSD tmux(1) man page](https://man.openbsd.org/tmux) (read directly): the default binding list documents **`?` → "List all key bindings"** and **`:` → "Enter the tmux command prompt"** — i.e. a TUI ships *both* a command prompt and a keys overlay, and the keys overlay is a first-class, non-hidden affordance. The app already has the CRT vocabulary to render this beautifully (the `#boot-lines` display-font pre block, `styles.css:56-62`).

**Mechanism.** One JS array is the source of truth for the palette (A-3), the overlay, and the DOM attribute:

```js
const COMMANDS = [
  { id: 'model',   title: 'Change model…',        hotkey: 'alt+m', run: () => openCombobox(refreshModelButton) },
  { id: 'prompt',  title: 'Apply prompt preset…', hotkey: 'alt+p', run: openPresetPicker },
  { id: 'inspect', title: 'Toggle inspector',     hotkey: 'alt+a', run: toggleInspector },
  { id: 'keys',    title: 'Show key bindings',    hotkey: '?',     run: openKeymap },
];
```

`aria-keyshortcuts` is a real ARIA property — **VERIFIED** from the role/property index in [w3c/aria `roleInfo.js`](https://github.com/w3c/aria/blob/main/common/script/roleInfo.js) — and has a proven *two-way* use in production: [Wagtail's `KeyboardController`](https://github.com/wagtail/wagtail/blob/main/client/src/controllers/KeyboardController.ts) reads `aria-keyshortcuts` **back off the DOM to bind the shortcut**, explicitly citing MDN. That is the pattern to copy: the attribute is the binding table, so the announced shortcut and the working shortcut can never drift apart. Note Gutenberg keeps a separate `ariaKeyShortcut` string precisely because the ARIA syntax (`Control+Shift+P`) differs from the display string — copy that split too.

**Caveat.** `?` as a bare global hotkey must not fire while focus is in `#input` or `#sysprompt-text`. The existing code already has a precedent for guarding (`js/main.js:541-543` intercepts Enter on `#input`) — guard on `ev.target` being a text field, and always provide the non-hotkey path (the rail's `KEYS` button, A-2).

**Verified vs inferred.** `aria-keyshortcuts` existence and the Wagtail/Gutenberg consumption patterns: **VERIFIED** (source read). tmux `?` binding: **VERIFIED** (man page read).

---

### A-8 — Cheap win: `field-sizing: content` for the composer

`js/main.js:536-540` hand-writes autogrow on every keystroke (`input.style.height = 'auto'` then `scrollHeight` clamped to 160px), which forces a synchronous layout on each keypress. [MDN's `field-sizing` reference](https://developer.mozilla.org/en-US/docs/Web/CSS/field-sizing) documents `field-sizing: content` on `<textarea>` with exactly this behaviour, bounded by `min-height`/`max-height`:

```css
#input {
  field-sizing: content;
  min-height: 44px;
  max-height: 160px;      /* keep existing bound */
  scrollbar-width: thin;
}
```

Because `min-height`/`max-height` remain in force and the JS fallback stays in place, this is a pure progressive enhancement and can ship independently. Semantics of the property: **VERIFIED** (MDN read). Engine support: **INFERENCE** — not re-verified from a compat table this session; treat as enhancement only, and keep the JS path.

---

## 3. What I checked and rejected

| Rejected | Why | Evidence |
| :--- | :--- | :--- |
| `role="statusbar"` for the HUD | **The role does not exist.** The ARIA role index enumerates all six categories (document structure, widget, landmark, live region, window, abstract); there is no `statusbar`. Adding it would be an unknown role → exposed as `generic`, silently destroying the semantics the redesign is trying to add. | [MDN ARIA role index](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles) (read) + **0 corpus-wide hits** in `gh_grep` for `role="statusbar"` |
| `role="toolbar"` on the 2-button `ASM`/`SET` group | APG is explicit: *"Use toolbar as a grouping element only if the group contains 3 or more controls."* | [APG Toolbar](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) (read) |
| `role="status"` on `#telemetry` | It is rewritten every 500ms (`js/main.js:172-178`). A live region on a 500ms-updating string is an announcement flood. ADR 0006 already mandates the decoupled `#a11y-status` path. | `js/main.js:172-178`, ADR 0006 (read) |
| `ninja-keys` as the palette | No `role="dialog"`/`aria-modal`/focus trap/`role="listbox"` in `render()`; global `hotkeys-js`; `new RegExp(this._search,'gi')` throws on `(`; no bundled standalone file published (bare `lit`/`hotkeys-js` specifiers); extra Material Icons font fetch. | [source](https://github.com/ssleptsov/ninja-keys/blob/main/src/ninja-keys.ts) + [published file list](https://data.jsdelivr.com/v1/packages/npm/ninja-keys@1.2.2) (read) |
| `resize: horizontal` as the dock mechanism | Cannot be focused or arrow-key driven; requires `overflow != visible`. Fails APG Window Splitter. Wild usage is overwhelmingly Storybook-only. | [APG](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) + superset/twenty/bitwarden/mantine hits (read) |
| Split.js, react-split-pane, `@mantine` split pane | CDN dependency for pointer drag only; Split.js is the top hit in `awesome-js-posts` but still leaves the ARIA contract unwritten. `react-split-pane` is a **build-step** dependency — hard fail against the no-bundler constraint. | awesome-list discovery → [split.js.org](https://split.js.org/), [react-split-pane](https://github.com/tomkp/react-split-pane) |
| Tailwind / PostCSS / any UI kit | Requires a build step. Already rejected on the same grounds in `docs/research/awesome-a11y-resources-css.md`. | reuse of existing repo precedent |
| Command-palette React/Vue/Svelte libraries (`kbar`, `vue-command-palette`, `cmdk`) | Framework-coupled; no framework here. | awesome-command-palette sections (discovery) |

---

## 4. Constraint compliance

| Constraint | How these recommendations satisfy it |
| :--- | :--- |
| **No build step** | Every mechanism is a platform feature (CSS, HTML, DOM APIs) or first-party JS. No recommendation adds an npm package, a bundler, or a compile step. `./build.sh` stays untouched. |
| **Whole-repo-upload / project Pages subpath** | **No new first-party assets at all** — all changes land in `index.html`, `styles.css`, `js/*.js`. Nothing new to make relative. Third-party absolute CDN URLs remain as-is, matching the existing `https://cdn.jsdelivr.net/...` precedent at `index.html:13-15`; the "relative" rule governs *first-party* references. The A-6 hash router is path-inert by construction. |
| **No framework** | `<details>`, `<dialog>`, `popover`, `@container`, `interpolate-size`, `field-sizing`, `aria-*` — all native. Vanilla ES modules only. |
| **`prefers-reduced-motion`** | All new motion is authored as `transition` (not `animation`), so the existing universal kill-switch at `styles.css:381-389` already neutralises it. Any `@starting-style`/`::backdrop` entrance must be wrapped in `@media (prefers-reduced-motion: no-preference)`. |
| **WCAG 2.2 AA** | Toolbars get APG roving tabindex + accessible names; splitter gets APG roles/states/keyboard; `<details>`/`<dialog>` replace hand-rolled disclosure/traps with native semantics; control names become descriptive (`aria-label="Active model: …"`). |
| **Target size (2.5.8)** | Preserve the existing 44px `min-height`/`min-width` on every interactive control, including new toolbar buttons and palette rows. |
| **Focus not obscured (2.4.11, AA in 2.2)** | **Risk to manage:** a taller/multi-row status bar could obscure focused content. Keep the bar to one row ≥ 768px, express its height as `--hud-h`, and set `scroll-padding-top: calc(var(--hud-h) + 8px)` on the scroll container so focus is never hidden under the fixed bar. `#layout`'s `top: calc(44px + var(--safe-top))` (`styles.css:95`) must read the same variable. |
| **320–375px** | The status bar must wrap (as `#hud` already does at `styles.css:405-410`); the palette is a `<dialog>` and naturally goes full-bleed; the dock becomes the existing full-width overlay (`styles.css:412-420`); roving tabindex *reduces* tab stops, which is a mobile keyboard win. |

---

## 5. Verified vs inferred — ledger

**VERIFIED (read the source this session):**
`<details name>` exclusivity + engine versions (Chrome 120 / Safari 17.2 / Firefox 130) · `interpolate-size: allow-keywords` semantics, opt-in nature, and Chrome 129 / no-Firefox / no-Safari support · the `::details-content` whole-rule-drop vs declaration-drop degradation nuance · `role="toolbar"` existence + APG toolbar rules (including the "3 or more controls" rule and roving tabindex) · APG Window Splitter roles/states/keys **and its missing reference implementation** · APG breadcrumb + `aria-current` guidance · `aria-keyshortcuts` as a real ARIA property, plus two production consumers (Wagtail, Gutenberg) · **no `statusbar` role** (MDN role index + zero gh_grep hits) · `<dialog>`/`showModal` semantics · `<dialog popover>`, `popover="hint"`, `interestfor`, `interest-delay`, `:interest-source`/`:interest-target` · `commandfor` + `command="show-modal"` shipping in markuplint/heritrix3/material-web · `document.startViewTransition` = **Baseline 2025**, Chrome 111+ / Safari 18+ / Firefox 144+ · VS Code `StatusbarAlignment{LEFT,RIGHT}` + `IStatusbarEntry` (`ariaLabel`, `role` default `'button'`, `kind`, `showProgress`) · tmux `?` = "List all key bindings" · `field-sizing: content` semantics · `@container`/`container-type: inline-size` + inline-size containment · ninja-keys licence, published files, dependency set, and a11y gaps · `resize: horizontal` wild-usage reality · the app's own diagnosis anchors (`index.html`, `styles.css`, `js/main.js` line ranges).

**INFERENCE / NOT VERIFIED — verify before shipping:**
Exact `commandfor`/invoker-commands browser versions (feature-detect; JS fallback) · broad `@container` version table (keep media-query fallback) · `field-sizing` support table (keep the JS autogrow) · `popover`/`interestfor` maturity (not recommended as load-bearing here — only as the model-picker anchor/hover refinement) · `scroll-driven animations` **not evaluated to a support conclusion and therefore deliberately absent from the shortlist** · View Transitions: baseline is verified but *the taste call is mine* — a full-page cross-fade is a poor fit for a phosphor CRT; if used at all, scope it to a `view-transition-name` on the tool card → inspector promotion (A-4 → A-5) and gate it behind `prefers-reduced-motion: no-preference` · all layout/type-scale/spacing judgements · all line-count estimates.

**Not exercised:** nothing was built or rendered. No browser, no axe run, no Lighthouse. These are research findings with an implementation sketch, not a validated redesign.

---

## 6. Suggested implementation order (each step independently verifiable)

1. **A-3 palette** — biggest IA win, self-contained, and it makes step 2 safe by giving every control a second path.
2. **A-1 status bar + toolbars** — restructure the HUD; verify by keyboarding the whole header (2 tab stops, arrow keys within the CRT group) and re-running `test/a11y.browser.mjs`.
3. **A-2 state rail** — wire the preset name from `S.getActive()` instead of string-guessing at `js/main.js:800`.
4. **A-7 keymap overlay + `aria-keyshortcuts`** — falls out of step 1's registry for free.
5. **A-4 tool transcript** — `<details name>` first (semantics + deleted JS), then the `@supports`-guarded animation.
6. **A-5 dock + container queries** — splitter ARIA/keyboard first, pointer drag second; container queries last, with the current media queries retained as fallback.
7. **A-6 hash view state**, then **A-8 `field-sizing`** — both small and independent.

Existing test surfaces that should be extended at step 2/5/6: `test/a11y.browser.mjs`, `test/a11y.mjs`, `test/smoke.mjs`.
