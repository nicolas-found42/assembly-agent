# Research: Zero-Build Tools & Implementation Feasibility for the UI Redesign

**Document Status:** Final Research Note
**Date:** 2026-09-11
**Scope:** Lane D — concrete, zero-build-step-compatible tools, libraries and native browser APIs that can implement the intended UI redesign (layout/IA/navigation/visual identity/motion) of ASM::AGENT, without violating the deployment constraints: `actions/upload-pages-artifact@v3` with `path: .`, `./build.sh` as the only build step (`wat2wasm`), no `package.json`, no bundler, hand-written vanilla ES modules, all asset references relative.

**Tooling availability (as required, reported honestly):**

| Tool | Status | Outcome |
| :--- | :--- | :--- |
| `mcp__context_awesome_*` | **Used** | `find_awesome_section`, `search_awesome_items`, `get_awesome_items` all worked. One call (`find_awesome_section` for "sparkline chart") returned `502 NETWORK_ERROR` from the backend; retried successfully via `search_awesome_items`. |
| `mcp__gh_grep_searchgithub` | **Used** | Works, but **only accepts literal code patterns**; natural-language queries return `No results found`. First attempts with prose queries failed; all quoted results below come from literal-pattern retries. |
| `read` on raw GitHub / jsDelivr / MDN / npm registry URLs | **Used** | Primary verification channel. |
| `web_search` | **Used** | Only for corroboration where mandatory. |
| `write` to repo path | **BLOCKED in scout harness** | Findings delivered inline to the main agent, which wrote this file to the repo. |

---

## 1. Verified baseline: what the app does today (file:line anchors)

| Surface | Where | Note |
| :--- | :--- | :--- |
| CDN `<script>` tags (marked, DOMPurify, highlight.js) | `index.html:12-14` | Already plain non-module CDN scripts, no SRI/build. |
| CRT overlay (scanlines / vignette / flicker) | `styles.css:56-72` | `repeating-linear-gradient` scanlines; vignette via `radial-gradient` + inset `box-shadow`; `@keyframes flickerAnim` animating **`body` opacity** 1↔0.97 over 4s. |
| HUD (brand / telemetry / 6 buttons) | `index.html:23-38`, `styles.css:104-141` | All buttons `min-height/min-width: 44px` — already meets the 44px target. |
| HUD↔layout sync JS | `js/main.js:~827-865` | `ResizeObserver` on `#hud` + `window.__asm.syncHudLayout`. **Any HUD height change ripples through this.** |
| Left sidebar + system-prompt drawer | `index.html:41-59`, `styles.css:143-152`, `js/main.js:~700-712` | Drawer is a raw `hidden` toggle, no animation. |
| Tool card / source groups | `styles.css:247-274` | `.tool-card` dashed border; `.tool-body { display: none }` when collapsed; `.src-head` arrow rotates 90°. All JS-toggled. |
| Model combobox modal | `js/models.js:148-303` | `.modal-backdrop` div + `role="dialog"` + `aria-modal="true"`, manual `trapDialog()` call, **120 ms input debounce**, `role="listbox"` rows, **render capped at 400 rows** (`Math.min(n, 400)`). |
| Settings modal | `js/main.js:~299-303` | Same `.modal-backdrop` pattern. |
| Memory inspector bars | `js/main.js:230-260`, `styles.css:311-318` | Pure CSS width-percentage bars. **No ARIA whatsoever** (see §5.3). |
| Focus trap / inert | `js/a11y.js:43-101` | ~50 lines: `focusables()`, `setInert()` (targets `#layout` + `#hud` only), document-level `keydown` for Tab-cycling + Escape, `releaseTrap()`. |
| a11y gates | `test/a11y.mjs:30-42` | **Source-text grep assertions** — see §6. |

---

## 2. Shortlist (7 items + 1 optional)

### 2.1 Native `<dialog>` — deletes the hand-rolled focus trap

**Enables / applies to:** Both existing modals (`js/models.js:169-267`, `js/main.js:~299-303`) and any new palette/drawer. Replaces `js/a11y.js:trapDialog` + `setInert` + `releaseTrap` outright.

**Primary sources:** MDN `<dialog>` reference (<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog>); compat data <https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/dialog.json>.

**VERIFIED.** BCD `html.elements.dialog`: Chrome **37**, Firefox **98**, Safari **15.4**. MDN states verbatim: *"Modal dialog boxes block interaction with other UI elements, making the rest of the page inert"* and *"When using `<dialog>` along with the `HTMLDialogElement.showModal()` method, this behavior is provided by the browser."* MDN also confirms the browser provides Esc-to-close and correct stacking of nested modals.

**Mechanism:**
```js
const dlg = document.getElementById('model-dialog'); // <dialog id="model-dialog">
dlg.showModal();          // focus moves in, focus trapped, rest of page inert, Esc closes
dlg.addEventListener('close', () => trigger.focus()); // focus return is still yours to do
```
```css
dialog::backdrop { background: rgba(12,7,0,.82); backdrop-filter: blur(2px); }
dialog { background: var(--crt-bg); color: var(--amber-bright); border: 1px solid var(--border); }
```

**Impact on existing code (net deletion):**
- Delete `js/a11y.js:43-101` (`focusables`, `setInert`, `trapDialog`, `releaseTrap`, and the `prevFocus`/`trapHandler`/`trapEl`/`inertTargets` module state).
- Keep `announceStatus()` and `ensureMessagesLog()` in `js/a11y.js` — both still needed (`js/main.js:8` imports all three; the import list must shrink).
- `js/models.js:~172` `try { trapDialog(modal, modalTrigger, closeCombobox) }` and the manual `releaseTrap()` call disappear.

**Limitations / gotchas (VERIFIED):**
1. **Light dismiss is not portable.** `closedby="any"` is Chrome **134**, Firefox **141**, Safari **preview only** (BCD `html.elements.dialog.closedby`). Do **not** rely on it — keep an explicit backdrop-click handler for click-outside close.
2. **Firefox will not animate open/close.** Animating `display` requires `transition-behavior: allow-discrete` (Chrome 117 / Fx 129 / Safari 17.4 — fine) **plus** support for transitioning `display` itself, which is **not implemented in Firefox** (BCD `transition-behavior.transitionable_display`, `version_added: false`, bug 1882408). Therefore the `<dialog>` entry/exit animation is a **progressive enhancement**, never the only feedback that a dialog opened. Gate with `@supports` or accept an instant toggle in Firefox.
3. **Do not put `tabindex` on `<dialog>`** (MDN explicitly warns).

---

### 2.2 View Transitions API — the missing microinteraction layer, zero dependencies

**Enables / applies to:** Exactly the gap identified in the brief — "no purposeful microinteractions tied to user actions (sending, model switch, tool-call completion, session switch)." Maps to: model switch (`js/models.js` selection callback), session switch (`js/main.js:restoreSession`), tool-call completion (`js/main.js` tool card `done()`), send/stop (`#btn-send`).

**Primary sources:** BCD <https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ViewTransition.json>; caniuse <https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/view-transitions.json>.

**VERIFIED — and this is the headline finding of this lane.** BCD `api.ViewTransition`: Chrome **111**, **Firefox 144**, Safari **18**. Firefox flipped to supported in 144; caniuse confirms (`firefox` 143 = `"n d #1"`, 144 = `"y"`). `ViewTransition.types` (typed transitions for different animation per action) is Chrome **125**, Firefox **147**, Safari **18.2 (BCD `types`) — also now in all three engines.

> Contrast with `@view-transition { navigation: auto }` (cross-document), which is Chrome 126 / Safari 18.2 / **Firefox unsupported** (bug 1860854). **Irrelevant here** — ASM::AGENT is a single-page app with no navigations, so only same-document `startViewTransition()` matters.

**Mechanism (a session switch with a purposeful CRT "retune"):**
```js
function swapSession(id) {
  if (!document.startViewTransition || prefersReducedMotion()) { swapSessionNow(id); return; }
  const t = document.startViewTransition(() => swapSessionNow(id));
  t.types.add('session-swap');           // needs Fx147/Safari18.2; harmless if ignored
}
```
```css
::view-transition-old(root),
::view-transition-new(root) { animation-duration: 180ms; }
html:active-view-transition-type(session-swap)::view-transition-old(root) {
  animation: 140ms steps(4) both retune-out;   /* steps() = authentically 'digital' */
}
```

**Accessibility (hard requirement, ADR 0006):** `startViewTransition` does **not** consult `prefers-reduced-motion`. It MUST be gated in JS (as above) or the transition made a no-op via the reduced-motion block already documented in `docs/research/awesome-a11y-resources-css.md` §2A. Also do not transition focus-visible or the composer caret.

**Cost:** 0 bytes. **License:** n/a (platform). **Build step:** none.

---

### 2.3 `<details name>` + `::details-content` — exclusive accordions replace JS toggles

**Enables / applies to:** The tool card + per-source groups (`styles.css:247-274`, currently JS-toggled via `.collapsed` classes) and the system-prompt drawer (`js/main.js:~700-712`). `name` gives *exclusive* open (only one source group open at a time) for free — genuinely useful for the fan-out source list, and it makes the source accordion a keyboard/screen-reader-native disclosure.

**Primary sources:** BCD <https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/details.json> and <https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/selectors/details-content.json>.

**VERIFIED.** `details.name` (exclusive accordions): Chrome **120**, Firefox **130**, Safari **17.2**. `::details-content` pseudo-element: Chrome **131**, Firefox **143**, Safari **18.4** (Safari notes it *cannot chain* pseudo-elements after it — bug 283446).

**Mechanism:**
```html
<details class="src-group" name="sources">
  <summary class="src-head">… 218 ms</summary>
  <div class="src-body">…</div>
</details>
```
```css
details::details-content {
  block-size: 0; overflow: hidden;
  transition: block-size 160ms, content-visibility 160ms;
  transition-behavior: allow-discrete;
}
details[open]::details-content { block-size: auto; }
```

**Limitation (VERIFIED):** the height animation above depends on `content-visibility` being transitionable — Chrome 117 / Safari 18 / **Firefox ✗** (BCD `transition-behavior.transitionable_content-visibility`). `interpolate-size: allow-keywords` / `calc-size()` would be the clean fix but is **Chrome-only** (BCD: Fx `false` bug 1945962, Safari `false` bug 295132) → **do not use**. Firefox gets an instant expand; acceptable.

**Cost:** 0 bytes. **Build step:** none.

---

### 2.4 `popover` + CSS anchor positioning — HUD overflow menus without layout reflow

**Enables / applies to:** De-cluttering the crowded 44px HUD (`index.html:23-38`). The current 6 same-weight buttons (SCAN/CURVE/FLICKER/SND/ASM/SET) can collapse into 2-3 grouped triggers opening non-modal `popover` panels. `popover` is the right primitive here (non-modal, light-dismiss, top-layer) — **not** `<dialog>`, which would make the rest of the app inert.

**Primary sources:** MDN `<dialog>` page documents `popovertarget`/`popovertargetaction`; BCD `<https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/properties/anchor-name.json>`.

**VERIFIED.**
- CSS anchor positioning — BCD `css.properties.anchor-name`: Chrome **125**, **Firefox 147**, Safari **26**. Cross-engine as of today, but Firefox 147 is *very* recent → **must be `@supports`-gated** with a static `position: fixed` fallback. Real precedent for exactly this: `microsoft/fluentui` `packages/web-components/src/listbox/listbox.styles.ts:36` wraps anchor positioning in `@supports (anchor-name: --anchor) { … } / @supports not (anchor-name: --anchor) { … }`, and `packages/web-components/src/tablist/tablist.styles.ts:207` adds a Safari-crash guard (`@supports (anchor-name: --a) and (text-size-adjust: auto)`) with the comment *"Safari 26.0 … crashes"*. **Note that Safari 26.0 caveat — it is a real production workaround, not a theoretical one.**
- `popover` — **corroborated, not BCD-read** (see §7): Chrome **114**, Safari **17.0**, Firefox **125**, per caniuse `mdn-api_htmlelement_popover` and web.dev's "Popover API lands in Baseline".

**Mechanism (zero JS):**
```html
<button popovertarget="crt-menu">CRT ▾</button>
<div id="crt-menu" popover>
  <button id="btn-scan">SCAN</button>…
</div>
```
```css
#crt-menu { position: fixed; position-anchor: --hud-crt; top: anchor(bottom); left: anchor(left);
            margin: 4px 0 0; inset: unset; }
#hud .crt-trigger { anchor-name: --hud-crt; }
```

**A11y note:** `popover` light-dismiss and Esc are handled natively, but the trigger must set `aria-expanded`/`aria-controls` — the app already does this for the brand button (`js/main.js:~815`), so follow that pattern.

---

### 2.5 uFuzzy — fuzzy model search (the ONE dependency worth adding)

**Enables / applies to:** The model catalog combobox (`js/models.js:148-303`), which today does substring filtering over a few hundred OpenRouter models with a 120 ms debounce and a 400-row render cap. Typo-tolerant search (`clade` → `Claude`, `sonet` → `sonnet`) is a real UX gain in a command-palette-style switcher, and uFuzzy also returns match ranges for highlighting.

**Primary sources:** README + source <https://github.com/leeoniya/uFuzzy>; package file listing <https://data.jsdelivr.com/v1/packages/npm/@leeoniya/ufuzzy@1.0.19>; **live CDN fetch** of <https://cdn.jsdelivr.net/npm/@leeoniya/ufuzzy@1.0.19/dist/uFuzzy.iife.min.js>.

**VERIFIED (all four checks the brief demanded):**
- **License:** MIT (README package listing shows `LICENSE`, 1069 bytes; source banner reads `All rights reserved. (MIT Licensed)`).
- **CDN, plain `<script>`:** `dist/uFuzzy.iife.min.js` — **8,410 bytes**, and I fetched it: it is real, served as `application/javascript`, starts `/*! https://github.com/leeoniya/uFuzzy (v1.0.19) */` and exposes the global `uFuzzy`.
- **CDN, ESM (`import` directly):** `https://cdn.jsdelivr.net/npm/@leeoniya/ufuzzy@1.0.19/+esm` — fetched successfully; jsDelivr bundles `dist/uFuzzy.mjs` via Rollup+esbuild and emits `export { he as default }`. **Works with plain `<script type="module">`.**
- **Build step required:** **NO.** Pure static file; zero dependencies.
- Other dist files: `uFuzzy.mjs` (26,276 B), `uFuzzy.cjs` (26,286 B), `uFuzzy.iife.js` (27,130 B). Latest published: **1.0.19**.

**Mechanism (integrate at `applyView`/`refresh` in `js/models.js:268-303`):**
```js
import uFuzzy from 'https://cdn.jsdelivr.net/npm/@leeoniya/ufuzzy@1.0.19/+esm';
const uf = new uFuzzy({ intraMode: 1 });          // SingleError: tolerates 1 typo/term

function filterModels(haystack, needle) {
  if (!needle) return { idxs: null, info: null, order: null };
  const [idxs, info, order] = uf.search(haystack, needle, /*outOfOrder*/ true, /*infoThresh*/ 1e3);
  return { idxs, info, order };
}
// highlighting:
uFuzzy.highlight(name, info.ranges[i])   // → "cl<mark>aude</mark>" style ranges
```
The library's own README documents exactly this `filter → info → sort → highlight` pipeline and notes it is tuned for *"list filtering, auto-complete/suggest"* with *"no index to build, so startup is below 1ms with near-zero memory overhead"* — precisely this workload. Search syntax supports exclusions (`claude -free`) which could power a palette-style `!` filter.

**Limitations:** Latin/Roman alphabet optimised (`{ unicode: true }` is 50–75% slower); case-insensitive only; for >1,000 matched rows it returns unsorted results (irrelevant here — the render cap is 400).

**Alternative considered — fzf-for-js (`fzf` npm, the thematic pick):**
**VERIFIED.** BSD **3-Clause** (not MIT) per the fetched dist banner: `/** @license fzf v0.5.2 … Licensed under BSD 3-Clause */`. Real port of junegunn/fzf's algorithm, motivated explicitly by *"Command palette is becoming ubiquitous"* (<https://github.com/ajitid/fzf-for-js>). CDN: `https://cdn.jsdelivr.net/npm/fzf@0.5.2/dist/fzf.es.js` (fetched — real, 1,358 lines, `import { Fzf } from 'fzf'` API) and `dist/fzf.umd.js`. **Weigh against uFuzzy:** 36,104 B ESM / 15,748 B UMD vs 8,410 B — **~4× uFuzzy's bytes**. Pick it only if literal fzf muscle memory (`'exact`, `^prefix`, `!invert`) is a deliberate product goal for the "hacker tool" persona; otherwise uFuzzy wins on cost.

**Also surfaced by discovery, not recommended:** `fuzzysort` v4.0.2 (17,585 B min, converted to a UMD `fuzzysort.min.js`; larger than uFuzzy), and the under-2 kB `awesome-tiny-js` set — `fzy.js`, `liquidmetal`, `quick-score`, `libsearch`, `fuzzysearch` (<https://github.com/thoughtspile/awesome-tiny-js>) — all viable if you want zero-ish bytes, but none offers uFuzzy's combination of typo tolerance, exclusion syntax and built-in `highlight()`.

---

### 2.6 Memory inspector: keep the CSS bars, add ARIA; inline SVG for any sparkline

**Enables / applies to:** The live WASM memory-usage chart (`js/main.js:230-260`, `styles.css:311-318`).

**VERIFIED (read from the repo):** the bars are already dependency-free CSS — `styles.css:316` `.mem-bar { height: 10px; border: 1px solid var(--border) }` and `:317` `.mem-fill { … width: 0%; transition: width .3s }`, driven by `js/main.js:258` `row.querySelector('.mem-fill').style.width = …`. **A charting library is not needed and would be a regression in bytes.**

**VERIFIED GAP — this is an a11y bug, not a preference.** `js/main.js:230-232` builds each row as:
```js
row.innerHTML = `<div class="mem-label"><span>${name}</span><span class="mem-val"></span></div>
  <div class="mem-bar"><div class="mem-fill"></div></div><div class="mem-note">${note}</div>`;
```
There is **no `role`, no `aria-valuenow`/`min`/`max`, no `aria-labelledby`, no association between the label and the bar** anywhere in the file. The numeric value exists only as visual text in `.mem-val`. This fails WCAG 1.3.1 (Info and Relationships) and 4.1.2 for the memory readout. A redesign that keeps these bars **must** add:
```js
row.innerHTML = `<div class="mem-row">
  <span class="mem-label" id="mem-l-${k}">${name}</span>
  <span class="mem-val"></span>
  <div class="mem-bar" role="meter" aria-labelledby="mem-l-${k}"
       aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${used}"
       aria-valuetext="${label}"></div>
</div>`;
```
(Use `role="meter"` for a bounded scalar, not `progressbar`.) Note `aria-valuenow` must be updated in the same loop at `js/main.js:257-259`.

**If a real trend/sparkline is wanted (zero bytes):** hand-write an inline SVG polyline — no library, no build:
```html
<svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="Heap usage, last 60s">
  <polyline points="0,20 10,18 20,12 …" fill="none" stroke="var(--amber-core)"
            vector-effect="non-scaling-stroke" pathLength="1"
            stroke-dasharray="1" stroke-dashoffset="1"/>
</svg>
```
`preserveAspectRatio="none"` + `vector-effect="non-scaling-stroke"` gives a full-width trace with a constant stroke; `pathLength="1"` + `stroke-dashoffset` animates the "draw-on" without measuring the path.

**If a genuine time-series canvas chart is ever required:** **uPlot 1.6.32** — **VERIFIED** MIT, `"type": "module"`, `"module": "./dist/uPlot.esm.js"` (<https://raw.githubusercontent.com/leeoniya/uPlot/master/package.json>), and the CDN file was fetched live: `https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.esm.js` serves real bytes with the `(MIT Licensed)` banner (~6,140 lines). Zero deps, no build step. **Recommendation: do not add it** — the load is disproportionate to five fixed memory regions, and the existing CSS bars plus ARIA solve the actual requirement. Explicitly reject Chart.js on the same grounds (canvas, an order of magnitude more bytes, for the same five bars).

---

### 2.7 CRT visual identity & motion: the amber-corrected technique set + `@property`

**Enables / applies to:** `styles.css:56-72` (scanlines/vignette/flicker) and the "amber-phosphor, single hue, no secondary accent" identity constraint.

**Reference implementations found via literal-pattern code search (gh_grep):**
- **Production presence:** `MaterializeInc/materialize`, `console/src/platform/shell/crt.css` — a real shipping console CRT mode: a 2-gradient scanline overlay (`linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,.25) 50%)` at `background-size: 100% 2px`, plus a horizontal RGB-triplet stripe at `3px 100%`), a `flicker` keyframe at `0.15s infinite` on `::after`, and a `textShadow` keyframe **animating chromatic aberration** (`±Npx 0 1px rgba(0,30,255,.5)` / `rgba(255,0,80,.3)`) at `1.6s infinite`. **License caveat (VERIFIED):** the file header is the **Business Source License** converting to Apache-2.0 — treat it as a *technique* reference, not copy-paste source.
- **Permissively licensed equivalent of the same scanline pattern (Unlicense):** `coding-horror/basic-computer-games`, `00_Utilities/javascript/style_terminal.css` (same two-gradient background, `pointer-events: none`, `z-index: 2`).
- The pattern recurs widely (10+ independent repos in one search), so it is effectively public-domain technique.

**CRITICAL DESIGN CORRECTION for this app:** that canonical snippet's `rgba(255,0,0,…)`/`rgba(0,255,0,…)`/`rgba(0,0,255,…)` subpixel striping and the blue/red `textShadow` aberration are **RGB shadow-mask CRT** artifacts. ASM::AGENT's identity is **single-hue amber** (`--crt-bg:#0c0700`, `--amber-bright:#ffcf7a`, `--amber-core:#ffb000`, `--amber-mid:#e09600`, `--amber-dim:#c28200`). Copying the RGB fringe would inject three foreign hues and break the identity the brief says to strengthen. **Amber-corrected substitute:** collapse the fringe to one hue (e.g. `rgba(255,176,0,.06)` fringing or none at all) and get the bloom from a **multi-layer same-hue `text-shadow` stack** — the currently used single `--glow: 0 0 6px rgba(255,176,0,.35)` is the thinnest possible version; a 3-layer stack (tight bright core + mid halo + wide dim halo) is what produces the phosphor look.

**`@property` — makes CRT parameters animatable (VERIFIED):** BCD <https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/at-rules/property.json>: Chrome **85**, Firefox **128**, Safari **16.4** — safely Baseline. Registering a numeric custom property makes it interpolable, so glow amplitude / scanline offset / flicker strength can be `transition`ed between states rather than only keyframed:
```css
@property --glow-amp { syntax: '<number>'; inherits: true; initial-value: 1; }
@property --scan-offset { syntax: '<length>'; inherits: false; initial-value: 0px; }
body { --glow-amp: 1; }
body.is-streaming { --glow-amp: 1.6; transition: --glow-amp 240ms; }   /* ties identity to STATE */
```
This directly serves the stated goal of *"purposeful microinteractions tied to user actions"* — telemetry `STATE`, streaming, tool-call activity — using the existing single amber hue.

**Correcting an existing motion defect (VERIFIED in-repo):** `styles.css:72` — `@keyframes flickerAnim { 0%,100%{opacity:1} 50%{opacity:.97} }` applied as `body.crt-flicker { animation: flickerAnim 4s infinite }`. Two problems: (a) animating **`body`** opacity promotes the entire document to a composited layer and forces opacity changes across every paint; animate the `#crt-overlay` (`position: fixed; inset: 0; pointer-events: none`, already isolated at `z-index: 900`) instead; (b) an opacity flicker on full-page content is a **WCAG 2.3.3 / motion-sensitivity** risk and must stay behind the existing `FLICKER` toggle **and** the `prefers-reduced-motion` block (per `docs/adr/0006-mobile-a11y-bar-and-crt-degrade.md`). The app already reads `isReducedMotion()` in `js/main.js:~60` — reuse it.

**Cost:** 0 bytes, CSS-only. **Build step:** none.

---

### 2.8 (Optional) `invokers-polyfill` — declarative dialog opening

**Enables / applies to:** Removes JS wiring for HUD/sidebar buttons that open the model and settings dialogs: `<button command="show-modal" commandfor="model-dialog">`.

**Primary sources:** <https://github.com/keithamus/invokers-polyfill>; npm registry <https://registry.npmjs.org/invokers-polyfill/latest>.

**VERIFIED.** MIT. Published version **1.0.4** (npm registry `latest`, with SLSA provenance attestation, unpacked 21,574 B). CDN confirmed by live fetch: `https://cdn.jsdelivr.net/npm/invokers-polyfill@1.0.4/invoker.min.js` returns real bytes; it is a self-guarding IIFE — the last line is `w()||g()`, i.e. it feature-detects `command`/`CommandEvent` support and **no-ops on browsers that already implement Invoker Commands**. It also polyfills `commandForElement`, `oncommand`, and `HTMLDialogElement.prototype.requestClose` (see the fetched source).

**Why it's optional, not recommended-by-default:** the app already has working click listeners, so this saves a handful of lines in exchange for a third-party script on the critical path, and it exists solely to polyfill an API you may not adopt. Adopt it **only if** you commit to declarative `command`/`commandfor` as the interaction model — in which case this is the correct, maintained, feature-detecting shim (authored by a WHATWG/Open UI-adjacent contributor). Compare against a plain `addEventListener` before adding a dependency.

---

## 3. Explicitly NOT usable (or not advisable) — with reasons

| Candidate | Verdict | Evidence |
| :--- | :--- | :--- |
| `field-sizing: content` (CSS-only auto-growing composer, replacing JS in `#input`) | **NO** | BCD: Chrome 123, **Firefox 152**, **Safari 26.2** — not broadly shipped. Keep the existing JS auto-grow. |
| `interpolate-size: allow-keywords` / `calc-size()` (animate `height: auto`) | **NO** | BCD: Chrome 129 only; **Firefox `false`** (bug 1945962), **Safari `false`** (bug 295132). Status `experimental`. |
| Scroll-driven animations (`animation-timeline: view()/scroll()`) | **NO** | BCD: Chrome 115, Safari 26, **Firefox `preview`** — not cross-engine. |
| `@view-transition { navigation: auto }` (cross-document) | **N/A** | BCD: Firefox unsupported (bug 1860854); also irrelevant — the app never navigates. |
| Animating `display`/`content-visibility` via `allow-discrete` on the dialog/accordion | **PARTIAL** | `allow-discrete` itself is fine (C117/Fx129/S17.4) but the `display`/`content-visibility` *transition* sub-features are **Firefox-unsupported**. Enhancement only. |
| Tailwind / PostCSS / Sass / any bundler | **NO** | Violates the no-`package.json`, no-bundler constraint (consistent with the earlier verdict in `docs/research/awesome-a11y-resources-css.md`). |
| React/Vue/Svelte component libs (incl. Headless UI, Radix) | **NO** | Framework + build step. Note the existing `marked`/`DOMPurify`/`highlight.js` are already plain CDN `<script>` tags — stay on that pattern. |
| Chart.js, GSAP, Motion One | **NO / unjustified** | All are CDN-loadable and MIT (GSAP's standard license is free), so they are *technically* zero-build-compatible — but Chart.js is an order of magnitude heavier than five CSS bars, and CSS + WAAPI already cover the motion needs. Reported as a **deliberate tradeoff decision, not silently assumed away.** |
| A "CRT CSS library" | **Does not exist as a maintained package** | Discovery surfaced only tutorial repos and app-specific stylesheets (e.g. `ManzDev/twitch-*` CSS-art repos are device reconstructions, not reusable CRT shaders). The technique is a ~15-line snippet — vendor-inline it rather than depend on anything. |

---

## 4. Compatibility evidence matrix (all figures VERIFIED from BCD unless noted)

| Feature | Chrome | Firefox | Safari | Read for? | Relevance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `<dialog>` / `showModal()` | 37 | 98 | 15.4 | Yes | Replaces focus trap |
| `<dialog closedby>` | 134 | 141 | **preview** | Yes | Don't rely on light dismiss |
| `ViewTransition` (same-doc) | 111 | **144** | 18 | Yes + caniuse | Microinteractions |
| `ViewTransition.types` | 125 | 147 | 18.2 | Yes | Per-action transitions |
| `@starting-style` | 117 | 129 | 17.5 | Yes | Dialog/popover entry |
| `transition-behavior: allow-discrete` | 117 | 129 | 17.4 | Yes | Exit animations |
| transitionable `display` | 117 | **✗** | 18 | Yes | Firefox can't animate it |
| `details name=` | 120 | 130 | 17.2 | Yes | Exclusive accordions |
| `::details-content` | 131 | 143 | 18.4 | Yes | Accordion styling |
| `anchor-name` | 125 | **147** | 26 | Yes | Gate with `@supports` |
| `@property` | 85 | 128 | 16.4 | Yes | Animatable CRT params |
| `:has()` | 105 | 121 | 15.4 | Yes | State-driven styling |
| `animation-timeline` | 115 | **preview** | 26 | Yes | Not usable |
| `field-sizing` | 123 | **152** | **26.2** | Yes | Not usable |
| `interpolate-size` | 129 | **✗** | **✗** | Yes | Not usable |
| `popover` | 114 | 125 | 17.0 | **No — corroborated** | HUD menus |
| `inert` | — | — | — | **No** | Not independently verified this pass |
| `color-mix()` | — | — | — | **No** | Not verified (caniuse path 404'd) |

---

## 5. Discovered defects the redesign must not swallow

**5.1 `test/a11y.mjs:30-42` pins implementation by grepping source text.**
```js
mustContain('js/a11y.js', 'trapDialog', 'D3-1: focus trap helper exists');
mustContain('js/main.js', 'trapDialog', 'D3-2: settings trap');
mustContain('js/models.js', 'trapDialog', 'D3-2: model trap');
ok('D3-1: modal aria-modal', read('js/main.js').includes('aria-modal') && …, 'aria-modal missing');
```
Deleting `trapDialog` in favour of native `<dialog>` (2.1) makes these fail **while the accessibility behaviour gets strictly better**. These assertions test *source text*, not behaviour, and MUST be replaced with behavioural assertions — not re-pinned to a new string. Same class of problem at `test/a11y.mjs:31-42` (`mustContain('js/a11y.js','aria-hidden')`).

**5.2 `test/a11y.browser.mjs` asserts on `.modal-backdrop`.** Lines **229, 235, 301, 304, 309-311, 320-322, 334, 344-345, 371-372, 376-377, 387-388, 396-397, 403-404** query `.modal-backdrop` for open/focus-trap/Shift+Tab-20×/Escape-close across desktop and 375px. These are *behavioural* tests but bound to a CSS class. Swapping to `<dialog>` means retargeting them to `dialog[open]` (and note `getComputedStyle(m).display === 'none'` no longer expresses "closed" — `dialog:not([open])` is the correct predicate). These are worth **keeping and updating**, unlike 5.1.

**5.3 Memory inspector bars expose no accessible value** — see §2.6. This is the single clearest a11y defect found in this lane.

**5.4 `body`-level flicker animation** — `styles.css:72`; see §2.7 for the compositing and motion-sensitivity reasons to move it to `#crt-overlay`.

---

## 6. Implementation impact map

| Proposed change | Files/lines to touch |
| :--- | :--- |
| `<dialog>` migration | `index.html:41-94` (new `<dialog>` elements), `js/main.js:~299-303`, `js/models.js:169-267`, `styles.css:320-383`, **delete** `js/a11y.js:43-101`, trim `js/main.js:8` import, update `test/a11y.browser.mjs` + rewrite `test/a11y.mjs:30-42` |
| View Transitions on session/model/tool events | `js/models.js` (selection cb), `js/main.js` (`restoreSession`, tool-card `done()`, send/stop), `styles.css` append `::view-transition-*` block; gate in JS |
| `<details name>` accordions | `static` markup wherever tool cards/`.src-group` are generated (`js/main.js` + `js/search.js` call sites), `styles.css:247-274`, drawer at `js/main.js:~700-712` |
| `popover` + anchor positioning HUD menus | `index.html:23-38`, `styles.css:104-141`; **watch `js/main.js:~827-865`** — the HUD `ResizeObserver` + `syncHudLayout` depends on HUD height and must be re-verified after any HUD regroup |
| uFuzzy in model switcher | `js/models.js:148-303` (replace filter in `applyView`/`refresh`); add one ESM import |
| Memory-bar ARIA | `js/main.js:230-260` (markup + value updates), `styles.css:311-318` |
| Amber-corrected CRT + `@property` | `styles.css:56-72` (and `:root` custom props at `styles.css:3-16`) |

---

## 7. Limitations / what I could NOT verify

Stated explicitly so nothing above is over-read:

1. **I did not run a browser.** Every compatibility figure is from static compat data (MDN BCD JSON, caniuse JSON) or library metadata — **not** from live rendering. Any item should be smoke-tested in the target matrix (320-375px mobile per ADR 0006) before being treated as proven.
2. **`popover` and `inert` are NOT BCD-verified here.** BCD raw paths `api/HTMLElement/popover.json`, `html/global_attributes/popover.json`, `api/HTMLElement/inert.json`, `html/global_attributes/inert.json` and `api/Document/startViewTransition.json` all returned **HTTP 404** (path structure differs from expectation). `popover` is therefore **corroborated** from caniuse (`mdn-api_htmlelement_popover`: Chrome 114, Safari 17.0, Firefox 125) plus web.dev's "Popover API lands in Baseline" and Vuetify0's compatibility table. `inert` was **not** independently re-verified this pass (it is already relied upon in `js/a11y.js`). Treat both as corroborated, not primary-verified.
3. **`color-mix()` is unverified.** BCD `css/types/color-mix.json` 404'd and caniuse `features-json/css-color-mix.json` 404'd. It is widely believed to be Baseline (Chrome 111 / Safari 16.2 / Firefox 113) — **[INFERENCE]**, verify before relying on it. The same applies to any relative-color-syntax proposal.
4. **`uPlot`'s exact runtime cost is unknown** (file size not measured; the ESM file is ~6,140 lines). I verified it is MIT, ESM, and CDN-served, but not its gzipped weight.
5. **No ESM-module-graph test was performed.** I verified that the jsDelivr `+esm` uFuzzy build emits a real `export { he as default }` and that the packaged `.mjs` exists, but I did not load either inside the app's actual module graph.
6. **awesome-list entries were used strictly as discovery pointers**, as instructed; every retained claim is backed by the project's own README/source/license or a compat database, never by an awesome-list blurb.
7. **Tool failures encountered (recorded as required):** `find_awesome_section("sparkline chart")` → `502 NETWORK_ERROR` (worked around via `search_awesome_items("sparkline")`); `gh_grep` rejected natural-language queries twice, requiring literal-pattern retries. No capability was unavailable except `write` to the repo path.

---

## 8. Bottom line

- **Do not add a UI, dialog, motion or charting library.** The four biggest wins — the dialog primitive, the microinteraction layer, the accordions, and the HUD menus — are all native platform features now Baseline across Chrome/Firefox/Safari, and two of them (`<dialog>`, `<details name>`) let you **delete** existing hand-written code rather than add any.
- **Add exactly one dependency: uFuzzy** (MIT, 8,410 B, CDN-verified end-to-end) at the model switcher. It is the only place where the redesign needs an algorithm the platform does not provide, and it is the single highest-value-per-byte change in this lane.
- **Keep the memory chart as CSS.** It is already correct and dependency-free — it just needs ARIA, which is currently absent.
- **Do not import the canonical RGB CRT snippet.** Amber identity requires a single-hue variant; copying the widely-shared RGB-fringe version would introduce three foreign hues.
- **Two gates before shipping:** (1) `prefers-reduced-motion` must gate `startViewTransition` in JS (it does not consult the media query itself); (2) `test/a11y.mjs:30-42` must be rewritten as behavioural assertions, since it currently pins the very implementation this redesign removes.
