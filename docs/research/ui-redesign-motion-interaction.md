# Research: Motion & Interaction Techniques for the ASM::AGENT UI Redesign

**Document Status:** Final Research Note
**Date:** 2026-09-11
**Lane:** C — Motion & interaction (parallel with layout/IA and tools/implementation lanes)
**Scope:** Zero-build, CDN-or-vendored motion techniques for a terminal/CRT/hacker tool. Every item below is evaluated against ASM::AGENT's hard constraints: whole-repo-root GitHub Pages upload with **relative** asset paths, **no JS bundler and no `package.json`**, vanilla ES modules + one hand-written `styles.css`, and the WCAG 2.2 AA / `prefers-reduced-motion` / 320–375px bar fixed by `docs/adr/0006-mobile-a11y-bar-and-crt-degrade.md`.

**Tooling actually used:** `context-awesome` MCP (`find_awesome_section`, `browse_awesome_lists` — worked after one initial HTTP 502 retry; used for discovery pointers only, never as proof), `gh_grep` (`searchGitHub`; literal code patterns only — keyword queries return zero results), `read` against MDN, the machine-readable **MDN browser-compat-data (BCD) JSON** (`raw.githubusercontent.com/mdn/browser-compat-data/main/...`), the W3C/WHATWG specs (drafts.csswg.org), developer.chrome.com, and `web_search` where a URL was not already known. `web_search` for the jakearchibald.com springs article returned the site root rather than the article body; the spring-easing values below are therefore sourced from two MIT repositories plus the official generator's README, which is a stronger citation than a blog post.

---

## 1. Where the motion layer actually is today

Grounded in the current source, so the redesign starts from facts rather than the sketch:

| Surface | Current mechanism | Location |
| :--- | :--- | :--- |
| CRT flicker | `@keyframes flickerAnim` 4s infinite, class-toggled | `styles.css:75-76` |
| Cursor blink | `blink` 1s `steps(1)` infinite | `styles.css:244-245` |
| Tool spinner | `spinframes` 0.8s `steps(4)` swapping `content` glyphs | `styles.css:254-255` |
| Accordion chevron | `transition: transform 0.15s` | `styles.css:261-262` |
| Memory bars | `.mem-fill { transition: width .3s }` | `styles.css:317` |
| Boot overlay | `transition: opacity .6s ease` + `.fade` class | `styles.css:86-88` |
| Sidebar collapse | `transition: margin-left .2s ease` | `styles.css:150-152` |
| Boot sequence | JS `setTimeout` per line, then `remove()` after a hard-coded 700ms | `js/main.js:58-138` |
| Only real microinteraction | Web Audio `beep()` → `sfxKey`/`sfxTool`/`sfxDone` | `js/main.js:15-32` |
| Reduced-motion kill-switch | universal `*`, `*::before`, `*::after` | `styles.css:404-411` |

Five structural findings that shape every recommendation below:

**(A) The reduced-motion kill-switch cannot reach View Transition pseudo-elements.** `styles.css:404-411` is a universal-selector rule. `*` does not match `::view-transition-group(...)`, `::view-transition-old(...)` or `::view-transition-new(...)` — pseudo-elements are not elements, and `*::before`/`*::after` do not cover them either. Chrome's own same-document View Transitions guide documents an **explicit** `::view-transition-*` block as the reduced-motion remedy — the current rule silently does nothing for View Transitions.

**(B) The same rule is also unreliable for scroll-driven timelines.** The scroll-animations spec's "Finite Timeline Calculations" (`drafts.csswg.org/scroll-animations-1` §4.1) only defines the used duration for `animation-duration: auto`; it does not define what a `0.01ms` duration means against a progress timeline. Treat `animation-duration: 0.01ms` as *not* disabling a scroll-driven animation.

**(C) Two hand-rolled modals duplicate five things the platform already does.** `.modal-backdrop[hidden]` + `role="dialog"` + `aria-modal` appears twice (`js/main.js:297-380` settings, `js/models.js:177-272` catalog), each wired to the manual trap in `js/a11y.js:38-101` (`trapDialog`, `setInert`, `releaseTrap`, ~65 lines) plus a hand-written `mousedown`-on-backdrop close and a hand-written `Escape` handler. Native `<dialog>` supplies focus movement, page inertness, Esc, `::backdrop`, and focus return for free.

**(D) The accordions are the highest-frequency interaction in the product and the only place a stagger reads as information.** `addToolCard` (`js/main.js:415-535`) creates one `.tool-card` per tool call, expanding into N `.src-group` blocks (one per search source) whose headers are `role="button"` divs with `tabindex="0"` and manual Enter/Space handlers (`js/main.js:487-508`). Bodies hide via `display: none` (`styles.css:257,264`). The JS already computes a group index `i` — the stagger input exists at zero cost.

**(E) Telemetry is a wholesale string write.** `js/main.js:159-177` writes `#telemetry` with `textContent` every 500ms from `STATS` (`Int32Array` read out of WASM memory). Any "numbers count up" effect must therefore restructure that one function into per-field nodes — it cannot be layered on top of the existing `textContent` write.

---

## 2. Shortlist

Ordered by (value to the redesign) ÷ (risk). Compatibility verdicts are split **VERIFIED** (I read the primary source: BCD JSON, spec text, or the project's own file) vs **INFERENCE**.

### Item 1 — View Transitions for the CRT power-on/off and for panel swaps ★ load-bearing

**Enables / where it applies.** The one technique that can carry the redesign's signature moment. (a) **Power-on**: boot overlay dissolves with the beam-line-open rather than a 0.6s opacity fade (`styles.css:86-88`, `js/main.js:88-92`, `128-131`). (b) **Session switch**: `switchSession` (`js/main.js:751-755`) currently blanks the log via `messagesEl.innerHTML = ''` in `restoreSession` (`js/main.js:757-773`) — a jump cut. Giving each session row a `view-transition-name` and animating the log region makes the switch feel like a channel change on one tube. (c) **Sidebar / inspector**: `#sidebar` toggle (`js/main.js:809-828`) and `#inspector` toggle (`js/main.js:181-185`) become slide/push transitions instead of an instant `margin-left` jump.

**Source + working example.**
- Chrome's official guide, section *"React to the 'reduced motion' preference"*, is verbatim the pattern this repo needs: `@media (prefers-reduced-motion) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none; } }` — https://developer.chrome.com/docs/web-platform/view-transitions/same-document
- Real production code that does *both* guards and says why: `stablyai/orca` `src/renderer/src/components/dashboard-popout/agent-board-transitions.css:44` — comment: *"Respect reduced-motion — the JS also skips startViewTransition, but guard the pseudo animations too."*
- Real code gating VT timing and reduced motion in one injected stylesheet: `marcoroth/herb` `javascript/packages/client/src/shared/transitions.ts:113` (`@layer herb-transitions { ::view-transition-group(*) … animation-duration: 150ms }` + the `animation: none !important` reduced-motion block).
- Per-class staggering of many elements instead of naming each: Chrome guide's "card" section — `#cards-wrapper > div { view-transition-class: card }` (guide lines ~319-328), which is the pattern for a filtered model list or a burst of source groups.

**Implementation mechanism.**
```js
const updateTheDOMSomehow = () => { /* existing DOM mutation */ };
if (!document.startViewTransition || isReducedMotion()) { updateTheDOMSomehow(); }
else { document.startViewTransition(updateTheDOMSomehow); }
```
```css
::view-transition-group(root) { animation-duration: 180ms; animation-timing-function: var(--ease-crt-out); }
::view-transition-old(root) { animation-name: crt-collapse; }   /* beam narrows + brightens */
::view-transition-new(root) { animation-name: crt-open; }
.session-item { view-transition-name: match-element; }          /* auto-unique per element */
```
`js/main.js:69-71` already has the `isReducedMotion()` helper — reuse it, do not re-derive.

**Compatibility.** **VERIFIED.** Same-document View Transitions: Chrome/Edge **111**, Firefox **144**, Safari **18** (BCD `api/ViewTransition.json`; corroborated by the version badges on the Chrome guide). `view-transition-class`: Chrome **125**, Firefox **144**, Safari **18.2** (BCD `css/properties/view-transition-class.json`). `view-transition-name: match-element`: Chrome **137**, Firefox **144**, Safari **18.4** (BCD `css/properties/view-transition-name.json`). **Cross-document** VT (Chrome/Edge 126, Firefox **not supported**, Safari 18.2) is **irrelevant here** — this is a single-document app; do not design around `@view-transition { navigation: auto }`.

**Cost / license / limits.** Zero dependencies, zero build, no CDN tag — it is a platform API. Feature-detect and fall back to today's behaviour. Three real limits: (1) **duplicate `view-transition-name` silently skips the transition** (`transition.ready` rejects; the Chrome guide calls this out at ~line 955) — prefer `match-element` or ids that are provably unique; (2) a **root** VT snapshots the whole page, so it must never fire while tokens are streaming — `doSend`'s `requestAnimationFrame(paint)` loop (`js/main.js:657-658`) would be captured mid-flight and the log would visibly stale-flash; prefer named-element VTs scoped to the changing region; (3) VT adds a snapshot of the page to memory during the transition, which matters on the 320px mobile target — keep durations short and regions small.

### Item 2 — Native `<dialog>` + `@starting-style` + `transition-behavior: allow-discrete` for both modals

**Enables / where it applies.** Deletes the manual focus trap and gives the settings and model modals genuine entry/exit animation. Replaces `js/main.js:297-380` and `js/models.js:177-272`; deletes `js/a11y.js:38-101` (`trapDialog` / `setInert` / `releaseTrap`), the `trapDialog(...)` calls at `js/main.js:279` and in `js/models.js`, and the manual `Escape` handler at `js/main.js:377-379`.

**Source + working example.**
- `<dialog>` semantics, `closedby`, invoker commands: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog — `showModal()` puts the dialog in the top layer, makes everything else **inert**, moves focus to the first focusable (or `autofocus`), and Esc closes it; `::backdrop` styles the backdrop.
- Production code transitioning `display`+`overlay` together so the element stays in the top layer through its exit: `mullvad/mullvadvpn-app` `desktop/packages/mullvad-vpn/src/renderer/lib/components/dialog/components/dialog-popup/DialogPopup.tsx:27` (`transition-property: opacity, scale, display, overlay; transition-behavior: allow-discrete;` with `&&[open] { opacity: 1; scale: 1 }`).
- `allow-discrete` + `@starting-style` together, with a real easing token: `GitbookIO/gitbook` `packages/embed/src/standalone/style.css:166-190`.
- Accordion/exit-animation precedent acknowledging this is now expressible in plain CSS: `mastodon/mastodon` `app/javascript/mastodon/components/exit_animation_wrapper.tsx:3` — *"In the future, replace this component with plain CSS once that is feasible. This will require broader support for `transition-behavior: allow-discrete` and `overlay`."*

**Implementation mechanism.**
```css
dialog {
  transition: opacity .18s var(--ease-crt-out), transform .18s var(--ease-crt-out),
              display .18s allow-discrete, overlay .18s allow-discrete;
  opacity: 1; transform: translateY(0);
  @starting-style { opacity: 0; transform: translateY(6px); }
}
dialog:not([open]) { opacity: 0; transform: translateY(6px); }
dialog::backdrop { background: rgba(0,0,0,.65); backdrop-filter: blur(1px); }
```
Declare the `@starting-style` block **after** the original rule (MDN notes they have equal specificity, so order decides). Keep the modal chrome (`.modal`, `.model-list`) as-is — this changes the host element only.

**Compatibility.** **VERIFIED.** `<dialog>`: Chrome **37**, Firefox **98**, Safari **15.4** (BCD `html/elements/dialog.json`) — safe unconditionally. `@starting-style`: Chrome **117**, Firefox **129**, Safari **17.5** (BCD `css/at-rules/starting-style.json`). `closedby` (native light-dismiss): Chrome **134**, Firefox **141**, Safari **preview** (BCD) — **progressive enhancement only**; keep an explicit close button (the repo already has `.set-close` and `.model-close`) and the existing backdrop-click path as the fallback.

**Cost / license / limits.** Platform feature, zero deps. **Test impact is the real cost — VERIFIED:** `test/a11y.mjs:31,39,40` asserts the literal source text `trapDialog` inside `js/a11y.js`, `js/main.js` and `js/models.js`; `test/a11y.browser.mjs:229-405` drives `.modal-backdrop` selectors for open/trap/Esc assertions. A native-`<dialog>` migration therefore breaks those assertions. Those three `mustContain(...)` checks pin *implementation text*, not behaviour — per this repo's testing standards they should be **deleted and replaced with behaviour assertions** (dialog `open` is true, focus is inside, Esc closes, focus returns to the trigger), not re-pinned to `showModal`. Note one behavioural subtlety: because `showModal()` already makes the rest of the page inert, `a11y.js`'s `setInert` fallback becomes dead code — remove it rather than leaving two mechanisms.

### Item 3 — `::details-content` + `interpolate-size` for the tool-card and source-group accordions

**Enables / where it applies.** Real animated height reveal on the app's most-used expanding region, with **less** JS and better keyboard semantics. Applies to `.tool-card` (`js/main.js:415-431`) and `.src-group` (`js/main.js:487-508`), replacing the `display: none` body toggling at `styles.css:257,264` and the manual `role="button"` + `tabindex="0"` + Enter/Space handlers.

**Source + working example.**
- `microsoft/vscode` `src/vs/workbench/contrib/chat/browser/widget/media/chat.css:565` — the exact "collapsed response disclosure" case, including opacity:
  ```css
  .completed-response-disclosure {
    interpolate-size: allow-keywords;
    &::details-content {
      block-size: 0; overflow: hidden; opacity: 0;
      transition: block-size 180ms cubic-bezier(.2,0,0,1), opacity 140ms cubic-bezier(.2,0,0,1),
                  content-visibility 180ms allow-discrete;
    }
    &[open]::details-content { block-size: auto; opacity: 1; }
  }
  ```
- `tokio-rs/topcoat` `crates/topcoat-ui/registry/src/components/accordion.rs:39-56` documents *why* two properties are needed: `::details-content` is the box that grows, and `interpolate-size` is what lets a height land on `auto` and still animate.
- `elementor/elementor` `modules/atomic-widgets/module.php:688` records the degradation argument precisely: both declarations sit behind the same `::details-content` requirement, so an engine that does not know the pseudo-element **drops the whole rule**, meaning "collapse to 0" and "expand on `[open]`" can never apply one without the other — the browser's native `<details>` toggle survives intact. Never a silently blanked panel.
- Stagger with the index the code already has: `{animation-delay: calc(var(--i) * 40ms)}` is a widely used production idiom — `apache/maka` `website/src/styles/site.css:682`, `guilhermerodz/input-otp` `apps/website/src/app/(experiment)/feature-bento.css:281`.

**Implementation mechanism.** Markup: `<details class="tool-card"><summary class="tool-head">…</summary><div class="tool-body">…</div></details>`, and nested `<details class="src-group">` inside. Then:
```css
.tool-card, .src-group { interpolate-size: allow-keywords; }
.tool-card::details-content, .src-group::details-content {
  block-size: 0; overflow: hidden;
  transition: block-size .24s var(--ease-crt-out), content-visibility .24s allow-discrete;
}
.tool-card[open]::details-content, .src-group[open]::details-content { block-size: auto; }
.src-group { --i: 0; animation: src-arrive .3s var(--ease-crt-out) both; animation-delay: calc(var(--i) * 40ms); }
```
Set `--i` from the existing loop counter at `js/main.js:487` (`for (let i = 0; i < groups.length; i++)`). `summary` natively provides `aria-expanded` and Enter/Space, so `syncHead()`/`toggleHead()` (`js/main.js:423-429`) and the duplicate handler at `js/main.js:502-507` both delete.

**Compatibility.** **VERIFIED.** `::details-content`: Chrome **131**, Firefox **143**, Safari **18.4** with a documented caveat — Safari *"does not support chaining pseudo-elements after `::details-content`"* (WebKit bug 283446), so do not style `::details-content::before`. `interpolate-size`: Chrome **129** **only** — Firefox `version_added: false` (bug 1945962) and Safari `false` (webkit bug 295132) in BCD. **Consequence:** Chromium animates; Firefox 143+ and Safari 18.4+ get correct layout with an instant toggle; older engines get native `<details>`. That is acceptable **only because** the animation is decoration — the content is never hidden by the animation.

**Cost / license / limits.** Platform feature, zero deps, net JS deletion. `<summary>`'s content model is phrasing content plus headings, which fits the current heads (they contain only `<span class="arrow">`, text, and `<span class="ms">`). Do not use this as the *only* mechanism for anything whose visibility carries meaning. `sibling-index()` (Chrome 138 / Firefox 154 / Safari 26.2 — **VERIFIED** BCD `css/types/sibling-index.json`) would later remove the need to set `--i` at all, but is not required now.

### Item 4 — `linear()` spring/easing tokens as the motion vocabulary

**Enables / where it applies.** Right now the app has one easing vocabulary — `.2s ease`, `.3s`, `.6s ease` — which is why motion reads as "web app" rather than "instrument". A named token set in `:root`, used by Items 1–3 and 5–8, is what makes the redesign's motion feel deliberate. `linear()` also removes the need for any easing JS.

**Source + working example.**
- Official generator (converts JS/SVG easing definitions to `linear()`): https://github.com/jakearchibald/linear-easing-generator — its README shows a bounce token and `animation-timing-function: var(--bounce-easing)`. Live tool: https://linear-easing-generator.netlify.app/
- Copy-ready MIT token sets: `lazaronixon/css-zero` `app/assets/stylesheets/css-zero/transitions.css:73+` — `--ease-spring-1..5`, `--ease-bounce-1..3`, verbatim `linear(...)` values. Also `romboHQ/tailwindcss-motion` `src/defaults.ts:10+` (MIT) for `--motion-spring-smooth` / `-snappy`.
- The generator's own bounce output, quoted in its README:
  `linear(0, 0.004, 0.016, 0.035, 0.063, 0.098, 0.141 13.6%, 0.25, 0.391, 0.563, 0.765, 1, 0.891 40.9%, …)`

**Implementation mechanism.** `:root { --ease-crt-out: linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001); }` — a fast-out curve with ~1.5% overshoot, which reads as a mechanical relay rather than a rubber band.

**Compatibility.** **VERIFIED — the safest item here.** `linear()`: Chrome **113**, Firefox **112**, Safari **17.2** (BCD `css/types/easing-function.json` → `linear-function`). Usable unconditionally.

**Cost / license / limits.** Zero deps, zero build, pure CSS values. **Taste caveat:** springs and bounces are the wrong dialect for a phosphor terminal — they read as consumer-app playfulness. Recommend a **mostly overshoot-free** vocabulary (fast-out curves, 120–200ms) with exactly **one** deliberate overshoot reserved for the tool-call completion badge, and keep the existing stepped `steps(4)` spinner idiom (`styles.css:254-255`): stepped, not interpolated, is the correct terminal dialect for a busy indicator.

### Item 5 — Animated numeric readouts with `@property` + `counter()`

**Enables / where it applies.** The HUD telemetry (`index.html:26`, written at `js/main.js:174-175`) currently jumps every 500ms; the memory region bars (`styles.css:316-318`, driven from `js/main.js:239-260`) move but their numbers do not. Registering the numeric field as an animatable `@property` lets MEM / MSG / TOK-S **count** instead of snap, which is the single cheapest way to make the HUD feel alive.

**Source + working example.** The idiom is `@property --num { syntax: "<integer>" }` + `counter-reset: num var(--num)` + `content: counter(num)`:
- `lensvol/fl-small-mercies` `src/css/extension.css:132` — uses a **transition** (`transition: --num 1s`), which is exactly the shape a live-updating telemetry number needs (unlike `@keyframes`, a transition retargets cleanly when the value updates mid-flight).
- `viperrcrypto/picasso` `references/micro-interactions.md:166` and `service-mesh-performance` `docs/_sass/layout/_meshmark.scss:174` — same pattern.

**Implementation mechanism.** Restructure `js/main.js:174-175` into per-field nodes:
```html
<span id="telemetry">MEM <b class="stat" id="t-mem" style="--num:0"></b><span>KB</span> · …</span>
```
```css
@property --num { syntax: "<integer>"; inherits: false; initial-value: 0; }
.stat { transition: --num .4s var(--ease-crt-out); counter-reset: num var(--num); }
.stat::after { content: counter(num); }
```
and have the 500ms tick call `el.style.setProperty('--num', n)`.

**Compatibility.** **VERIFIED.** `@property`: Chrome **85**, Firefox **128**, Safari **16.4** (BCD `css/at-rules/property.json`, including the `syntax`/`inherits`/`initial-value` descriptors) — effectively unconditional.

**Cost / license / limits.** Zero deps. Two limits: (1) **never animate a live region's text** — `#a11y-status` (`index.html:47`, `js/a11y.js:announceStatus`) must keep settling instantly, and the animated `.stat` nodes should be `aria-hidden="true"` with the settled number exposed alongside or in the announcer, otherwise a screen reader reads every intermediate value; (2) `counter()` emits text, so the node's box can reflow as digits change — use `font-variant-numeric: tabular-nums` and a `min-inline-size` to stop the HUD from twitching.

### Item 6 — SVG `feTurbulence` phosphor grain, and the verdict on canvas/WebGL

**Enables / where it applies.** The CRT identity today is scanlines + vignette + flicker, all geometric. Grain is what makes amber read as *phosphor*. Applies to the boot overlay (static/snow) and to `#crt-overlay` (`index.html:17-20`, `styles.css:59-72`) as a low-opacity overlay behind the same class gates as the existing effects.

**Source + working example.** `feTurbulence` is a Filter Effects primitive — spec: https://www.w3.org/TR/filter-effects-1/#feTurbulenceElement (attributes: `type`, `baseFrequency`, `numOctaves`, `seed`, `stitchTiles`), implemented across engines (`LadybirdBrowser/ladybird` `Libraries/LibWeb/SVG/SVGFETurbulenceElement.cpp`; `google/skia` `modules/svg/src/SkSVGFeTurbulence.cpp`). Notably, `gh_grep` shows it is **essentially absent from application-level CSS in the wild** — the searches returned only engine implementations, wasm bindings and type definitions, no product CSS. That is the underused-technique opportunity, and simultaneously the risk: there is no mainstream precedent to copy, so budget visual tuning time.

**Implementation mechanism.** Inline, once, at the top of `<body>`:
```html
<svg width="0" height="0" aria-hidden="true" focusable="false">
  <filter id="crt-grain">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>
</svg>
```
```css
#crt-overlay .grain { position: absolute; inset: 0; filter: url(#crt-grain); opacity: .05; mix-blend-mode: screen; }
```
Animate motion by translating the grain layer in `steps()` (stepped = correct terminal dialect) rather than animating `baseFrequency` (which re-runs the filter each frame).

**Compatibility.** `feTurbulence` itself: **VERIFIED** as a spec primitive with multi-engine implementations; **INFERENCE** that it is safe at this usage — SVG filters are rasterized on the CPU in some engines, and `filter: url()` on a full-viewport fixed overlay can cost frames. **Measure on the 320px mobile target before shipping**, and keep it behind an existing toggle plus the reduced-motion gate.

**Verdict on canvas/particle effects — considered, recommended against.**
- **WebGL CRT post-processing** (barrel distortion + scanline + bloom fragment shader) gives the most authentic geometry, but requires a `<canvas>` overlay that cannot host `role="log"` content, duplicates the existing scanline/vignette/flicker work, and breaks the ADR 0006 CSS-only degrade path. **Do not.**
- **`canvas-confetti`, GSAP, Motion One, anime.js, Lottie** — all rejected. Confetti is the wrong taste for this product; the animation runtimes are general-purpose solutions to a ~6-effect vocabulary, and several require a build step or introduce a second authoring model next to plain CSS. `romboHQ/tailwindcss-motion` and `animate.css` are likewise wholesale vocabularies that would fight the CRT identity rather than reinforce it.
- The one canvas effect worth revisiting later is a small **vendored** (checked-in, no build) phosphor-decay trail on the streaming caret — and only behind the sound/reduced-motion gates.

### Item 7 — Command-palette model switcher: `role="combobox"` + `aria-activedescendant` + uFuzzy

**Enables / where it applies.** The redesign's "command palette" moment for models (extensible to sessions and system-prompt presets) with keyboard-driven fuzzy search and an instant, animated filter. The current catalog (`js/models.js:148-280`) is mouse-first: rows correctly carry `role="option"` and `aria-selected` (`js/models.js:306-308`), but the *active* row is communicated only by a `.active` class toggled in `highlight()` (`js/models.js:274-276`), and the search input is not a `combobox` and carries no `aria-activedescendant` — so a screen-reader user gets no announcement as the highlight moves.

**Source + working example.**
- uFuzzy — https://github.com/leeoniya/uFuzzy. **VERIFIED MIT** (read `LICENSE`), **~7.5KB min**, zero dependencies, and it ships an IIFE build (`dist/uFuzzy.iife.min.js`) usable as a plain `<script src>` exactly like the existing CDN tags at `index.html:12-14`. API from its README: `uf.search(haystack, needle, outOfOrder, infoThresh) => [idxs, info, order]`, plus `uFuzzy.highlight(hay, info.ranges[i], mark)` for match highlighting. The README also states its own guidance: only run `info`/`sort` when matches are ≤1000 (irrelevant here — the catalog is a few hundred rows) and that `unicode: true` is 50–75% slower (unnecessary — OpenRouter ids are Latin).
- The ARIA contract for a palette is the WAI-ARIA APG combobox-with-listbox pattern: `role="combobox"` + `aria-expanded` + `aria-controls` on the input, `aria-activedescendant` pointing at the active `role="option"` id. https://www.w3.org/WAI/ARIA/apg/patterns/combobox/

**Implementation mechanism.** Host the palette in a native `<dialog>` (Item 2), then:
```js
const uf = new uFuzzy({ intraMode: 1 });            // tolerate one typo per term
const [idxs, info, order] = uf.search(haystack, query);
```
set `input.setAttribute('aria-activedescendant', 'model-row-' + activeId)` inside the existing `highlight()`; give every row a stable `id`. For the filter animation, name only the list region so the whole page is not snapshotted:
```css
.model-list { view-transition-name: model-list; }
.model-row  { view-transition-class: model-row; }
::view-transition-group(.model-row) { animation-duration: 90ms; animation-timing-function: var(--ease-crt-out); }
```
Run the DOM update inside the `startViewTransition` callback and skip the transition while `streaming()`.

**Compatibility.** uFuzzy: zero-build, CDN `<script>` or `https://esm.sh/@leeoniya/ufuzzy`. `view-transition-class`: Chrome 125 / Firefox 144 / Safari 18.2 (**VERIFIED**, Item 1). The plain filter itself works everywhere with no VT at all — the animation is decoration.

**Cost / license / limits.** MIT, ~7.5KB, one `<script>` tag or one ESM import; no build step. Limitations from the README: Latin-script-optimized regexes (augmentable via `{alpha}`), case-sensitive search not supported, no index (fast startup, but re-filters the whole haystack per keystroke — fine at a few hundred rows). **Do not add a second fuzzy library**: `models.js` already has its own filter path — replace it rather than layering uFuzzy on top. Fuse.js and fuzzysort were considered and are heavier with less predictable ranking for id-shaped strings; uFuzzy's own comparison page benchmarks itself against both.

### Item 8 — Boot sequence as a CSS timeline + a real power-on

**Enables / where it applies.** `js/main.js:58-138` builds the boot sequence with one `setTimeout` per line, then adds `.fade` and removes the overlay after a hard-coded 700ms — timers that must stay in sync with `styles.css:86`. Rendering all lines up front and revealing them with a single CSS timeline removes every timer and makes the sequence synchronous with the power-on transition.

**Source + working example.** The power-on/off keyframes are already solved in the wild, in plain CSS:
- `m00grin/ph-intercept` `static/css/game.css:169-175` (MIT):
  ```css
  @keyframes crt-power-on {
    0%   { opacity: 0;    transform: scaleY(0.04); }
    10%  { opacity: 0.75; transform: scaleY(0.04); }  /* soft beam-line */
    42%  { opacity: 0.3;  transform: scaleY(1);    }
    100% { opacity: 0;    transform: scaleY(1);    }
  }
  ```
- `GeneralDussDuss/poseidon` `docs/codex.html:70` adds the brightness component: on = `scaleY(.004) scaleX(1.25); filter: brightness(6)` → `scaleY(1); brightness(1)`; off = the reverse ending at `scaleY(.002) scaleX(1.35); filter: brightness(9); opacity: 0`. This is the correct pair of shapes to copy.

**Implementation mechanism.** Emit every boot line in one pass with `style="--i:N"`, drop the per-line timers:
```css
#boot-lines > span { opacity: 0; animation: boot-line .28s var(--ease-crt-out) both; animation-delay: calc(var(--i) * 120ms); }
```
then trigger the dissolve as a **named** View Transition on `#boot-overlay` so the beam-open keyframes play on the transition pseudo-elements instead of on a class toggle.

**Compatibility.** CSS `calc()`/`animation-delay` staggering: universal. The power-on keyframes: universal. The View Transition half inherits Item 1's support (Chrome 111 / Firefox 144 / Safari 18) with `isReducedMotion()` and a no-VT fallback to today's `.fade` path.

**Cost / license / limits.** Zero deps; net JS deletion (removes the per-line timers and the 700ms `setTimeout` at `js/main.js:90,130,876`). **The SKIP BOOT affordance must survive** — it is an a11y requirement, not a nicety (`index.html:23`, `js/main.js:78/105`, plus Esc and overlay-click at `js/main.js:104-106`). Keep skip as "remove the overlay immediately", and make sure skipping also cancels the pending CSS timeline (removing the node does). Keep the existing boot copy (`js/main.js:59-70`) verbatim — it is the product's voice.

---

## 3. Cross-cutting contract changes (the part that would otherwise be silently violated)

1. **Extend the reduced-motion kill-switch for pseudo-elements and timelines.** `styles.css:404-411` does not cover View Transitions and does not reliably neutralize scroll-driven animations (Findings A and B). Add inside that same block:
   ```css
   @media (prefers-reduced-motion: reduce) {
     ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none; }
     /* any scroll-driven rule added later: */ animation-timeline: none;
   }
   ```
   **VERIFIED** basis for the first half: Chrome's official VT guide documents exactly this block as the reduced-motion remedy. **INFERENCE** for the second half: the spec only defines the `auto` duration case, so `animation-timeline: none` is the safe, explicit remedy.
2. **Prefer positive gating for new decorative motion**: `@media (prefers-reduced-motion: no-preference) { … }`. Precedent: `m00grin/ph-intercept:131` gates its CRT flicker this way; `WordPress/gutenberg` `packages/boot/src/components/root/_view-transitions.module.scss:43` uses `@media not (prefers-reduced-motion: reduce)` around VT CSS. Keep the existing global block as the backstop for the legacy rules.
3. **Mirror every CSS gate in JS.** `isReducedMotion()` already exists at `js/main.js:69-71` and boot already branches on it (`js/main.js:79, 90, 129, 874`). The same branch must guard every `document.startViewTransition` call — the CSS guard alone removes the *animation* but the transition still runs its default cross-fade window.
4. **Never animate a live region's text.** `#a11y-status` (`index.html:47`, `js/a11y.js:announceStatus`) and `#messages[role="log"]` must keep settling instantly. Animate `aria-hidden` decoration only (see Item 5).
5. **Motion must not share a frame budget with streaming.** `doSend` runs a `requestAnimationFrame` paint per token (`js/main.js:657-658`). Skip View Transitions and large staggers while `streaming()` is true, or a root VT will snapshot stale text mid-response.
6. **Motion must not add tab stops.** The current accordions deliberately add `tabindex="0"` + `role="button"` (`js/main.js:487-489`, and the duplicate at `js/main.js:496-507`). Moving to `<details>`/`<summary>` (Item 3) and `<dialog>` (Item 2) *reduces* tabbable surface and deletes two hand-rolled keydown handlers — a net accessibility win, not a cost. Do not regress this by adding focusable dimmer/overlay elements.
7. **ADR 0006 needs an amendment.** Its done-bar lists "`prefers-reduced-motion` kill-switch" as one clause; after this work the clause is not satisfied by the universal selector alone. Either amend the ADR or record the extended block as the definition of that clause.

---

## 4. Explicitly not recommended

| Rejected | Reason |
| :--- | :--- |
| GSAP, Motion One, anime.js, Lottie, `tailwindcss-motion`, animate.css | General-purpose runtimes/vocabularies for a ~6-effect need; several need a build step; their generic easing and transform defaults fight the CRT identity rather than reinforce it. |
| WebGL fragment-shader CRT | Needs a canvas overlay that cannot host `role="log"` content; duplicates existing scanline/vignette/flicker; breaks the ADR 0006 CSS-only degrade path. |
| `canvas-confetti` and particle bursts | Wrong taste for an instrument panel; a tool-call completion should read as a *relay clack*, not a celebration. |
| `animation-timeline` / `scroll()` / `view()` as a load-bearing effect | **VERIFIED** Firefox is `version_added: "preview"` in BCD (`css/properties/animation-timeline.json`) while Chrome is 115 and Safari 26 — a two-engine feature. Optional progressive enhancement only, and it requires the `animation-timeline: none` reduced-motion remedy from §3. |
| Cross-document View Transitions (`@view-transition { navigation: auto }`) | Single-document app; nothing to navigate between, and Firefox has no cross-document VT support at all (`version_added: false`). |
| `interpolate-size` as the *only* height mechanism | **VERIFIED** Chromium-only (Chrome 129; Firefox and Safari both `false` in BCD). Use it as the animating half of a native-`<details>` disclosure (Item 3), never as the thing that hides content. |
| `field-sizing: content` to replace the composer's JS autosize (`js/main.js:536-540`) | **VERIFIED** Chrome 123, Firefox **152**, Safari **26.2** — too new to remove the existing JS sizing; add later as an enhancement, not a replacement. |
| Tailwind / PostCSS / any bundled CSS | Violates the no-`package.json`, no-bundler constraint outright. |

---

## 5. Suggested landing order (cheap → visible → risky)

1. **Tokens + counters + accordions** (Items 4, 5, 3). All progressive-enhancement-safe, no modal restructure, immediate perceived-quality gain.
2. **Native `<dialog>` migration** (Item 2). Deletes `js/a11y.js`'s trap code; requires the `test/a11y.*` assertions to be rewritten as behaviour tests.
3. **Command palette** (Item 7). Depends on Item 2 for its shell; independent of View Transitions (the filter works without the animation).
4. **View Transitions** (Items 1, 8) plus the §3 reduced-motion additions. Highest visible payoff, highest risk of feeling wrong — do it after the vocabulary (Item 4) exists so the durations and curves are already decided.
5. **Boot restructure last**, together with the grain layer (Item 6) once it has been measured on the 320px target.
