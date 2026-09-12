# Research: Visual Direction for the ASM::AGENT Redesign

**Document Status:** Final Research Note — Lane B (visual direction)
**Date:** 2026-09-11
**Scope:** Typography systems, color systems, composition and layered-depth treatments for the amber-phosphor CRT identity. Constraints: GitHub Pages project page served from the repo root via `actions/upload-pages-artifact@v3` (`path: .`) — relative asset paths only; the sole CI step is `./build.sh` (`wat2wasm`); no `package.json`, no bundler; vanilla ES modules + one hand-written `styles.css`; third-party code only as CDN `<script>`/`<link>` or vendored static files; ADR-0006 WCAG 2.2 AA + `prefers-reduced-motion` + 320–375px remain hard bars. **Not in scope:** WASM engine, chat protocol, search fan-out, IA/navigation (Lane A), motion timing (Lane D), tooling (Lane C).

---

## 0. Diagnosis — measured, not eyeballed

### 0.1 Hierarchy is structurally impossible in the current type stack

| Fact | Evidence |
| :--- | :--- |
| `VT323` has **one** style, **one** weight (400), **zero** axes | `google/fonts/ofl/vt323/METADATA.pb` — single `fonts{}` block, `weight: 400`, no `axes{}` |
| The app requests only `JetBrains+Mono:wght@400;700` | `index.html` `<link href="...family=VT323&family=JetBrains+Mono:wght@400;700...">` |
| JetBrains Mono actually ships **100..800 + italic** | `https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800` → 16 `@font-face` blocks, weights 100–800 in both styles |
| `--font-display` (VT323) is used for **~20 roles**, from 13px labels to the 24px brand | `styles.css` — `.brand` 24px, `.modal-title`/`.msg-body h1` 22px, `.msg-head`/`.tool-head` 17px, `.side-btn`/`.insp-tab`/`.src-head`/`.session-title-btn`/.msg-body th`` 16px, `.hud-btn`/.mem-row .mem-label`/.mr-provider` 15px, `.pill` 14px, `.copy-btn`/.session-actions button` 13px |
| The only differentiation between those roles is hand-picked tracking | `letter-spacing: 1px` ×13, `letter-spacing: 2px` on `.msg-head`/`.modal-title`, `letter-spacing: 0` on `.session-title-btn`/`.src-head .ms` — no scale, no system |

**The real defect is not "no hierarchy" — it is that a single-weight decorative pixel face is doing the legibility-critical job.** VT323 at 13–15px, plus `text-shadow: 0 0 6px rgba(255,176,0,.35)` on `body`, carries button labels, table headers and status text. Small pixel type + glow + tracking is where the mush comes from. Any redesign that keeps one weight in the display face and only restyles boxes will reproduce the same flatness.

### 0.2 The palette is a narrow luminance ladder, and the error accent is dimmer than body text

Relative luminance per WCAG 2.x (`L = 0.2126R + 0.7152G + 0.0722B`, sRGB-linearised; contrast `= (L₁+0.05)/(L₂+0.05)`) against `--crt-bg #0c0700` (`L = 0.00230`):

| Token | Hex | Relative luminance | Contrast vs `--crt-bg` |
| :--- | :--- | ---: | ---: |
| `--amber-bright` | `#ffcf7a` | 0.67293 | **13.8:1** |
| `--amber-core` | `#ffb000` | 0.52310 | **11.0:1** |
| `--amber-mid` | `#e09600` | 0.37650 | **8.2:1** |
| `--amber-dim` | `#c28200` | 0.27433 | **6.2:1** |
| `--err` | `#ff6a3d` | 0.31904 | **7.1:1** |

> **INFERENCE** — computed by hand from the WCAG formula above; re-verify in-browser (axe/devtools) before citing. The derivation is shown so it is reproducible.

Two consequences. (a) The whole text palette spans 6.2:1 → 13.8:1, a **2.2×** dynamic range across four tokens, while body text sits at the top at 13.8:1 — maximum brightness everywhere is exactly why nothing reads as emphasised. (b) **Errors are quieter than ordinary text** (7.1:1 vs 13.8:1): a failed source or a transport error is visually *less* salient than the prose around it. `--err` should out-rank body luminance, not trail it.

### 0.3 Depth is two layers of one idea, one of which is not CRT-authentic

The shipped effects are `repeating-linear-gradient` scanlines and a `radial-gradient` + `inset box-shadow` vignette. The bloom is a single `text-shadow: 0 0 6px rgba(255,176,0,.35)` applied once on `body` — one Gaussian, no scattering tail. Everything else in the CRT vocabulary (halation falloff, afterglow, hum bar, glass) is absent, while the two most-copied CSS "CRT" effects on the web — RGB chromatic separation and the aperture-grille triad mask — are **physically impossible on this display**. See §1 V3 for the primary-source basis and why this matters for a project whose whole pitch is that it hand-wrote its engine.

### 0.4 The tool-call surface — the app's deepest information — has a *frozen* spinner

`js/main.js:419` renders:

```js
<span class="tool-status"><span class="tool-spin">▖▘▝▗</span> SEARCHING…</span>
```

`styles.css:254`: `.tool-spin { display: inline-block; animation: spinframes 0.8s steps(4) infinite; }` where `@keyframes spinframes` animates **`content`**. `content` only applies to replaced elements and `::before`/`::after`/`::marker` — on a plain `<span>` it is ignored, and there is no `.tool-spin::before` rule anywhere in the stylesheet. **VERIFIED by reading both files: the spinner never animates.** The user sees the literal four glyphs `▖▘▝▗` sitting still while a search runs. Even if it worked, `0.8s / 4 frames` = 200 ms per frame, ~2.5× slower than a real terminal's ~80 ms and out of step with a "live" tool call.

### 0.5 Composition defects that are one line each

- **Digits jitter.** `js/main.js:174` rewrites `#telemetry` every 500 ms (`MEM nKB · MSG n · TOK/S n.n · STATE …`) and `tabular-nums` appears **nowhere** in `styles.css` (verified by grep). During streaming the HUD string reflows every half-second.
- **Measure is expressed in pixels, not characters.** `.msg { max-width: 860px }` with 14px JetBrains Mono (advance ≈ 0.6em ≈ 8.4px) gives **≈102 characters per line** — well past any comfortable prose measure. **[INFERENCE]** — the 0.6em advance should be measured in-browser; the fix (`max-width: 72ch`) does not depend on the measurement being exact.
- **The vocabulary the team already agreed on is not shipped.** ADR-0005's Tool Card wireframe is drawn with `┌─ ▶ web_search("WASM SIMD") · 8 SOURCES · MISSED: wikidata ─┐`, `│ ▼ WIKIPEDIA · 3 hits · 212ms │`, `└───┘`. The implementation renders `border: 1px dashed` plus a rotatable `▸`. Box-drawing is the repo's own notation, already accepted — see §1 V6.
- **Cascade arms race.** `styles.css` already carries `[hidden] { display: none !important }`, `.modal-backdrop[hidden] { display: none }` and `#sidebar.collapsed { margin-left: -100vw !important }` — three `!important`s that exist only because there is no cascade layer. See §1 V8.

---

## 1. Shortlist

### V1 — Rebuild the type system on variable axes (the single highest-leverage change)

**(a) What it enables, where.** Three roles instead of one face doing everything: **wordmark/panel-label** (the display face, used *only* at sizes where a pixel face is legible and expressive), **console** (body/UI — the face you actually read), **micro/data** (telemetry, `· ms` timings, WAT line numbers, memory percentages). This is what converts "brand vs six same-weight buttons" into a visible rank order, and it is the precondition for every other visual-hierarchy item.

**(b) Primary sources + working examples.**

| Face | Axes (VERIFIED) | Source of truth |
| :--- | :--- | :--- |
| **Sixtyfour** | `BLED` 0–100, `SCAN` **−53**–100; category MONOSPACE; OFL; Jens Kutílek | `google/fonts/ofl/sixtyfour/METADATA.pb`; demo `jenskutilek.github.io/homecomputer-fonts/documentation/demo-sixtyfour.html` |
| **Handjet** | `ELGR` 1–2, `ELSH` 0–16, `wght` 100–900; OFL; 10 subsets incl. Arabic/Hebrew/Cyrillic | `google/fonts/ofl/handjet/METADATA.pb`; `github.com/rosettatype/handjet` |
| **Doto** | `ROND` 0–100, `wght` 100–900; OFL; Óliver Lalan | `google/fonts/ofl/doto/METADATA.pb` |
| **Workbench** | `BLED` 0–100, `SCAN` −53–100; OFL; MONOSPACE | `google/fonts/ofl/workbench/METADATA.pb` |
| **Martian Mono** | `wdth` 75–112.5, `wght` 100–800 (GF emits `font-stretch: condensed…semi-expanded`) | GF css2 API returned 200 with 32 faces spanning those stretches |
| **JetBrains Mono** | **100..800 + italic** (already on the page, currently capped) | GF css2 API, 16 faces |
| **Departure Mono** | static pixel mono, OFL (font; site MIT), Helena Zhang; **woff2 = 22,496 bytes** | `github.com/rektdeckard/departure-mono`; jsDelivr gh file listing `@1.500`; cool-retro-term ships it at `app/qml/fonts/departure-mono/` |
| **Monaspace Neon/Argon** | SIL OFL 1.1; texture healing (`calt`), ligature sets `ss01`–`ss10`, variants `cv01`–`cv99` | `github.com/githubnext/monaspace`; CDN `@fontsource/monaspace-neon@5.3.0/index.css` VERIFIED live |

**(c) Mechanism.** The *point* of these faces is that their axes describe the app's own physics. Sixtyfour's `BLED` is beam bleed and `SCAN` is the scanline grid — the wordmark can be made to look more or less like the CRT effect it sits inside, and `SCAN`'s negative range removes the grid entirely. Handjet's `ELSH`/`ELGR` morph one wordmark from a 1×1 grid to a chunky 2×2 grid. Doto's `ROND` switches between square-pixel and round-LED rendering.

```css
/* one zero-cost win, no new family, no new host */
/* index.html: family=JetBrains+Mono:ital,wght@0,100..800;1,100..800 */
:root { --phos-bled: 40; --phos-scan: 60; }
.brand {
  font-family: 'Sixtyfour', var(--font-body);
  font-variation-settings: 'BLED' var(--phos-bled), 'SCAN' var(--phos-scan);
}
@supports not (font-variation-settings: normal) { .brand { font-family: var(--font-body); } }
```

Animating axes is spec'd and tested: MDN lists `font-variation-settings` **Animation type: a transform**, and WPT `css/css-fonts/animations/font-variation-settings-interpolation.html` asserts "supports animation pairwise by 'like' properties".

**(d) VERIFIED vs INFERENCE.** Axes, weights, licences and file sizes above: **VERIFIED** (GF css2 API responses, `google/fonts` METADATA.pb, jsDelivr file listings, GitHub repo metadata). Two caveats to treat as INFERENCE until checked in-browser: (i) the `css2` endpoint serves static instances to legacy UAs — my reads came back as TTF with no `font-variation-settings` descriptor, so **confirm in a real browser that the served file is actually variable** (check for the descriptor in the response CSS); (ii) whether the Sixtyfour request accepts `SCAN@-53..100` was **not** verified — I only verified `@0..100` (HTTP 200).

**(e) Cost / limitations.** All Google-Fonts faces: one `<link>` edit, **no build step**, no new host, already covered by the existing `preconnect`s. Departure Mono: one vendored woff2 (22 KB) or a jsDelivr `gh` URL — but its README requires **size multiples of 11px**, so it is a label/wordmark face, never body text. Monaspace: OFL, one family + one weight range only — shipping all five families is a large payload. **Two traps:** (1) `font-variation-settings` *overrides* the corresponding high-level property regardless of cascade position (MDN: "will always override those set using the corresponding basic font properties, e.g. `font-weight`") — so never mix `font-weight` and `'wght'` on the same element, and treat `font-weight`/`font-stretch`/`font-optical-sizing` as the preferred controls for registered axes; (2) if a single-weight face is used anywhere, declare `font-synthesis-weight: none` so an accidental `font-weight: 700` **fails visibly instead of smearing the glow** with faux-bold.

---

### V2 — A three-phosphor color system: one hue/chroma pair is the whole theme switch

**(a) What it enables, where.** Amber is already correct — this makes it *deep* rather than replacing it. Deliver (i) a real luminance **ladder** with named roles instead of four near-neighbours, (ii) an error/alert accent that out-ranks body text, and (iii) the novelty the brief asks for: **P3 amber / P1 green / P4 page-white as selectable phosphors**, which is both historically exact and a genuinely delightful settings affordance for a CRT tool.

**(b) Primary sources.** Wikipedia *Monochrome monitor* (VERIFIED): "If the P1 phosphor is used, the screen is green monochrome. If the P3 phosphor is used, the screen is amber monochrome. If the P4 phosphor is used, the screen is white monochrome (known as 'page white')". Same article supplies two design justifications the palette should honour: mono displays offered **"only a limited set of brightness levels"** (1-bit on the VT100, 2-bit on the NeXT MegaPixel) — a *small, discrete* luminance ladder is the historically faithful model, not a continuum; and mono panels used a **"continuous coating of phosphor"** rather than colour triads, which is exactly why V3 forbids an RGB mask.
Solarized (`ethanschoonover.com/solarized/`, VERIFIED) is the methodological precedent for this whole item: "sixteen color palette (eight monotones, eight accent colors)", "precise CIELAB lightness relationships", *selective contrast* — "reduces **brightness contrast** but … retains **contrasting hues**".

**(c) Mechanism.** Author the ladder as **relative-luminance-anchored stop values** and let `color-mix()` generate the rest, so the ADR-0006-verified anchors are preserved exactly and only phosphor identity changes:

```css
:root {
  /* phosphor identity: exactly two numbers per phosphor */
  --phos-h: 76;   /* P3 amber; P1 green ≈ 143; P4 page-white: chroma → ~0.02 */
  --phos-c: 0.17;
  /* role ladder (L values), one stop per hardware brightness level */
  --l-dim: .62; --l-mid: .74; --l-core: .84; --l-bright: .93;
  --amber-dim:    oklch(var(--l-dim)    var(--phos-c) var(--phos-h));
  --amber-mid:    oklch(var(--l-mid)    var(--phos-c) var(--phos-h));
  --amber-core:   oklch(var(--l-core)   var(--phos-c) var(--phos-h));
  --amber-bright: oklch(var(--l-bright) var(--phos-c) var(--phos-h));
  /* surfaces derive from the same identity */
  --border: color-mix(in oklab, var(--amber-core) 25%, transparent);
  --panel:  color-mix(in oklab, var(--amber-core) 6%, transparent);
}
```

`color-mix()` is **Baseline widely available, low-date 2023-05-09** (Chrome 111 / Safari 16.2 / Firefox 113) per the webstatus.dev API; its default interpolation space is `oklab` (MDN). `oklch()` is the same generation of support.

**(d) VERIFIED vs INFERENCE.** Phosphor designations, the limited-brightness-levels model and the continuous-phosphor-coating fact: **VERIFIED** (Wikipedia). `color-mix()` support/baseline: **VERIFIED** (webstatus.dev API). Solarized quotes: **VERIFIED**. The specific OKLCH numbers are **INFERENCE** — hand-converted anchors: `#FFB000 ≈ oklch(0.812 0.171 76.3)` and `#33FF33 ≈ oklch(0.872 0.279 142.8)`. Treat them as starting points.

**(e) Cost / limitations — including one trap that must not be missed.** No dependency, no build step, ~10 lines. **But OKLCH lightness is not WCAG luminance, so a fixed L ladder does NOT give equal contrast across phosphors.** Demonstrated numerically from the same computations as §0.2: amber `#ffb000` (OKLab L ≈ 0.812) yields **11.0:1**, while green `#33ff33` (OKLab L ≈ 0.872, barely higher) yields **≈14.8:1** — a ~34% contrast swing for a small perceptual-lightness difference. Therefore: **contrast must be re-verified per phosphor**, and the honest implementation is to keep the currently-passing hex anchors as the source of truth for the amber theme and add per-phosphor L overrides that are axe-checked before shipping. A second, cheap win while in here: `@media (prefers-contrast: more) { :root { --l-dim: .72 } }` to lift the dim stop for users who ask for it. Error accent: move `--err` to a role above `--amber-bright`, not below it (see §0.2) — and note that `--err` is the only non-amber hue in the palette, so if it is retuned, keep it *outside* the phosphor identity variables so it survives a phosphor switch.

---

### V3 — A monochrome-authentic depth stack (and an explicit ban on the two ahistorical tropes)

**(a) What it enables, where.** Depth that is *earned*: five independent layers, each mapped to a documented physical behaviour of a P3 mono CRT, each behind its own `body.crt-*` class (matching the existing `crt-scan`/`crt-curve`/`crt-flicker` pattern) and each degradable under `prefers-reduced-motion`.

**(b) Primary sources.** Wikipedia *Monochrome monitor* (VERIFIED) documents the authentic artifact set: **afterglow / "ghosting"** — "a dim afterglow of the screen's contents is briefly visible after the screen has been blanked", deliberately present on **long-persistence** monitors to reduce flicker; and **screen burn**. That is the physical basis for this app's two most frequent visual events: streaming text and replacing a turn. cool-retro-term (26k★, GPL-3.0 — *read for vocabulary, do not copy code*) names the same effect family in its own UI (`BurnInEffect.qml`, `SettingsEffectsTab.qml`, and profiles literally named "Default Amber"/"Default Green"/"IBM DOS").

**The ban, with the source admitting it.** The most-copied CRT-CSS write-up on the web — Alec Lownes, *Using CSS to create a CRT* (2017), which is where the ubiquitous `textShadow` keyframe block comes from — says of its own centrepiece: *"The color separation effect isn't really a CRT TV-specific effect, but one which people like to associate with CRT TVs. I'm not sure if this really ever happened with CRT TVs, but it does give a cool effect, so we'll use it anyway."* And Wikipedia supplies the mechanical reason: mono panels have **one** phosphor over a continuous coating, whereas colour panels "display text and graphics in multiple colors through the use of alternating-intensity red, green, and blue phosphors" divided into "triads of three phosphor dots … separated by a mask". With one phosphor and no mask there is nothing to mis-converge and no triad to mask. **Chromatic aberration and RGB-triad masks are therefore wrong for this app** — not merely clichéd, but inconsistent with the physical model the rest of the design claims. Recommendation: either drop them, or explicitly reframe as *"a photograph of the screen"* (lens/glass dispersion) and confine to the boot overlay.

**(c) Mechanism — five layers.**

1. **Scanlines snapped to the type grid.** Today: `repeating-linear-gradient(0deg, rgba(0,0,0,.25) 0 1px, transparent 1px 3px)` — a 3px period that drifts against a `1.55` line-height. Fix by deriving the period from the line box so scanlines land *between* text rows rather than across them; this is the difference between "a display showing text" and "a texture on top of text":
   ```css
   :root { --lh: calc(1.55 * 1em); --scan-period: calc(var(--lh) / 3); }
   #crt-overlay .scanlines {
     background: repeating-linear-gradient(0deg,
       rgba(0,0,0,.25) 0 1px, transparent 1px var(--scan-period));
   }
   ```
2. **Halation as a scattering tail, not one blur.** `text-shadow: 0 0 6px rgba(255,176,0,.35)` is a single Gaussian. Real halation is light scattering in the glass — a long tail. Stack 2–3 shadows at increasing radius / decreasing alpha, and put the radius behind a registered property so it can be ramped (e.g. brighter while streaming):
   ```css
   @property --bloom { syntax: '<length>'; inherits: true; initial-value: 6px; }
   :root { --glow: 0 0 2px rgba(255,176,0,.55), 0 0 8px rgba(255,176,0,.30), 0 0 22px rgba(255,176,0,.12); }
   ```
   `@property` is Chrome 85 / Safari 16.4 / **Firefox 128** (VERIFIED, BCD) — gate any *animation* of it with `@supports`, and keep the static multi-shadow working without it.
3. **Afterglow / persistence.** A deliberate low-opacity duplicate of the *previous* turn head, or a short decay trail behind the streaming cursor — the exact event Wikipedia describes. Keep the *presence* static and let Lane D own the timing; this is the one layer where a wrong duration is worse than no layer.
4. **Hum bar.** A slow, low-contrast bright band rolling vertically every ~4–8s — a mains-hum brightness artifact, so it needs **no colour** and is therefore fully mono-authentic. One absolutely-positioned `linear-gradient` layer animated on `translateY`. **Trap:** ADR-0006's global reduced-motion block only zeroes `animation-duration`, which *pauses* the band mid-screen rather than removing it. The band must be hidden by the same media query (`display: none`), not merely stopped.
5. **Glass.** Keep the vignette; add a very low-opacity top-edge highlight to imply a curved phosphor face. `corner-shape: superellipse` would match real bezel geometry (superelliptical, not circular-rounded) — **UNVERIFIED this pass**, so gate with `@supports` and treat circular `border-radius` as the fallback.

**(d) VERIFIED vs INFERENCE.** Afterglow/ghosting/long-persistence, limited brightness levels, continuous-phosphor/no-mask, and the Lownes quote: **VERIFIED** (Wikipedia; aleclownes.com). The five-layer mechanism is CSS I have not executed: **INFERENCE / must be built and eyeballed**. `corner-shape` support is unverified.

**(e) Cost / limitations.** All CSS/SVG, no dependency, no build step. Costs are real: layers 2–3 duplicate text and are therefore **only** affordable on the brand, panel titles and the streaming cursor — never per-message; layer 4 must be off under reduced-motion *and* on the ≤480px breakpoint (ADR-0006 makes mobile a first-class target and every ambient full-screen layer is a battery/repaint cost there); `box-shadow`/`text-shadow` stacks are cheap per element but multiplied by a long transcript.

---

### V4 — Grain: one static SVG tile, never animated

**(a) What it enables, where.** Removes the flat-vector feel from the large black fields (the chat column, the boot overlay, the modal backdrops) and gives the amber a material. It is the cheapest single upgrade to "this looks like a screen" after V3.1.

**(b) Primary source.** CSS-Tricks, *Grainy Gradients* (Jimmy Chion, 2021) — the canonical write-up, with two findings that matter here: the recipe, and a hard constraint. Recipe (VERIFIED): `<feTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/>` rendered into a `<rect>`, then used **as a background image** layered under a gradient, boosted with `filter: contrast(170%) brightness(1000%)`. Constraint (VERIFIED, quoted): *"It doesn't work to reference the SVG by its `id` in CSS, for some quirky reason, but you can inline the SVG"* — so the noise must be an inline data-URI or a real file in a `url()`, never `filter: url(#noise)` against an external document.

**(c) Mechanism.** Either vendor one `noise.svg` (≈1 KB, keeps the `path: .` artifact self-contained) or inline it:

```css
body::before {
  content: ''; position: fixed; inset: 0; z-index: 899; pointer-events: none;
  background: url('noise.svg') repeat;
  background-size: 180px 180px;
  opacity: .05;
  mix-blend-mode: overlay;
}
```

**(d) VERIFIED vs INFERENCE.** The `feTurbulence` recipe, the background-not-filter constraint and the brightness/contrast boost: **VERIFIED** (article text). Grain size/opacity values: **INFERENCE**, tune visually.

**(e) Cost / limitations.** Zero dependency, zero build, no new host. **Do not animate it.** The popular variant animates `background-position` at 8–24 fps, which forces a full-viewport repaint every frame; stacked on a fixed HUD, a scrolling `role="log"` and a streaming markdown re-render, that is a guaranteed stutter at 320–375px and a photosensitivity concern under ADR-0006. Static grain + one moving ambient layer (the hum bar) is the right budget. `mix-blend-mode` on a full-screen fixed layer also creates a stacking context — harmless here, but it is one more reason to keep it `pointer-events: none` and `aria-hidden`.

---

### V5 — Curvature: use SVG displacement **only** on a decorative surface, never on the live app

**(a) What it enables, where.** True barrel/CRT glass warp is the one effect that cannot be faked with `border-radius` — and it is exactly the effect that will break this app if applied naively. Recommendation: **apply it to the boot screen and any idle/attract state only**; express curvature in the live UI through the vignette, edge falloff and corner geometry instead.

**(b) Primary sources + working examples.** MDN, `<feDisplacementMap>` (VERIFIED, exact transform): `P'(x,y) ← P(x + scale·(XC(x,y) − 0.5), y + scale·(YC(x,y) − 0.5))` — i.e. a mid-gray map means *no displacement*, and the map must be built so R varies about 0.5 horizontally and G vertically. Real production construction of a custom gradient map (`feImage` pointing at a nested data-URI SVG holding `linearGradient`s + `feGaussianBlur`, then `feDisplacementMap` with `color-interpolation-filters='sRGB'`): `assistant-ui/assistant-ui`, `packages/tw-glass/src/index.css` (MIT) — found via gh_grep. Real-world turbulence→displacement→colour-matrix chain in a shipped project: `NielsLeenheer/cssDOOM`, `src/renderer/scene/entities/enemies.css` + `#fuzz` in `index.html` (GPL-2.0 — technique reference only). Background reading with worked code: Smashing Magazine, *A Deep Dive Into The Wonderful World Of SVG Displacement Filtering* (Dirk Weber, 2021) — which also warns that misapplied SVG filters "can hurt the performance of your site drastically".

**(c) Mechanism.** Inline the filter **in `index.html`** (same-document reference — see the trap):

```html
<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0">
  <filter id="crt-warp" color-interpolation-filters="sRGB" x="-5%" y="-5%" width="110%" height="110%">
    <!-- map: R ramps left→right, G ramps top→bottom, both about 0.5 -->
    <feImage href="data:image/svg+xml,..." result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="12"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</svg>
```

**The trap, VERIFIED.** MDN's *Layout and the containing block* lists, for `absolute`/`fixed` elements, a containing block formed by the nearest ancestor with "a `filter`, `backdrop-filter`, `transform`, `perspective`, `rotate`, `scale`, or `translate` value other than `none`" — with an explicit note that *"There are browser inconsistencies with `perspective` and `filter` contributing to containing block formation."* This app is built on fixed positioning: `#hud`, `#layout`, `#crt-overlay`, `.modal-backdrop`, and (≤980px) `#sidebar`/`#inspector` are all `position: fixed`. Putting `filter: url(#crt-warp)` on `<body>` or `#layout` silently reparents every one of them. Add the second cost: an SVG filter on the app root re-rasterises a full-viewport layer on every scroll and every streaming markdown tick.

**(d) VERIFIED vs INFERENCE.** The transform formula, the containing-block rule (including the browser-inconsistency note), the external-reference pitfall, and both real-world examples: **VERIFIED**. The specific displacement map and `scale` value: **INFERENCE** — needs authoring and eyeballing.

**(e) Cost / limitations.** No dependency, no build step; one inline SVG and ~10 lines of CSS. Limitations: `scale` must stay small (~8–15 px) or text edges tear; the filter must be applied to a layer that contains no fixed-position descendants; and `backdrop-filter` confers the **same** containing-block behaviour (same MDN list), so any "glass panel" design has to account for it too. If the team wants warp in the live UI anyway, the defensible version is to warp a *non-interactive decorative copy* (a static screenshot-like overlay), never the live DOM — which keeps text selectable, in the accessibility tree, and inside `role="log"`.

---

### V6 — Iconography: ship the box-drawing vocabulary the repo already speaks

**(a) What it enables, where.** Replaces the current two-glyph vocabulary (`▸`, `✕`) with a semantic set that can express tool-call states, source groups, panel frames, focus, and progress — and gives the Tool Card (the deepest information in the app) a frame language instead of `border: 1px dashed`.

**(b) Primary sources.** The strongest evidence is *internal*: ADR-0005's own Tool Card wireframe is drawn in box-drawing and middot notation — `┌─ ▶ web_search("WASM SIMD") · 8 SOURCES · MISSED: wikidata ─┐`, `│ ▼ WIKIPEDIA · 3 hits · 212ms │`, `└────┘` — and the `·` separator is already the shipped idiom (`js/main.js:175`). The proposal is to promote accepted wireframe notation to shipped chrome, not to invent a style.
For pixel-art icons: **pixelarticons** (`github.com/halfmage/pixelarticons`, **MIT**, VERIFIED) — 1036 hand-crafted icons on a strict 24×24 grid, no anti-aliasing, pure `<path>`, `fill="currentColor"`, browsable at `pixelarticons.com`, usable straight from CDN as `https://unpkg.com/pixelarticons@latest/svg/heart.svg`, with a prebuilt webfont (`pixelart-icons-font-*` classes). For spinner frame data: **cli-spinners** (`sindresorhus/cli-spinners`, **MIT**, VERIFIED) — "The list of spinners is just a JSON file", 70+ definitions of `{interval, frames}`, e.g. `dots` = `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']` at **80 ms** — directly usable as the frame set for the fix in §0.4.

**(c) Mechanism.**

*Unicode chrome (preferred — zero bytes, inherits everything).* Box-drawing corners `┌ ┐ └ ┘`, heavy `┏ ┓ ┗ ┛ ═ ║`, splitters `├ ┤ ┬ ┴ ┼`; block ticks `▏▎▍▌▋▊▉█` for meter fills (a natural upgrade for `.mem-fill`); `░ ▒ ▓` for degradations; markers `▸ ▾ ● ○ ◆ ◇`; arrows `↑ ↓ → ← ⇅`; braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`. Because these are *text*, they inherit `font-family` (so they take the glow), `color` (so they participate in the phosphor ramp and its contrast budget), and they can be wrapped in `aria-hidden` while the accessible name lives on the button — unlike an icon font, which needs `aria-hidden` anyway and cannot inherit a text-shadow.

*Recolouring external SVG without inlining it:* `mask-image` + `background-color: currentColor` — the mainstream production pattern (VERIFIED via gh_grep in `facebook/lexical` `packages/lexical-playground/src/index.css`, `langflow-ai/langflow` `docs/css/sidebar.css`, `handsontable` `src/themes/static/css/icons/*.css`, `microsoft/azuredatastudio`, `perspective-dev/perspective`; note that every one of them ships the `-webkit-mask-image` prefix alongside `mask-image` — keep both):

```css
.icon-scan {
  width: 16px; height: 16px; background-color: currentColor;
  -webkit-mask-image: url('icons/scan.svg'); mask-image: url('icons/scan.svg');
  -webkit-mask-size: contain;          mask-size: contain;
  -webkit-mask-repeat: no-repeat;      mask-repeat: no-repeat;
}
```

*Spinner fix (replaces the dead code in §0.4).* Keep the mechanism JS-free but apply it where `content` works:

```css
.tool-spin::before { content: '⠋'; animation: spin 0.8s steps(1, end) infinite; }
@keyframes spin { 0%{content:'⠋'} 10%{content:'⠙'} /* …10 frames… */ 90%{content:'⠇'} }
```
(80 ms × 10 frames = 0.8 s — the same duration already in the stylesheet, now with a real spinner and at `cli-spinners`' own interval.)

**(d) VERIFIED vs INFERENCE.** pixelarticons' licence/grid/CDN/webfont, cli-spinners' licence and `dots` frames+interval, the `mask-image`+`currentColor` pattern in five real codebases, ADR-0005's wireframe notation, and the `content`-animation defect in §0.4: **VERIFIED**. Which specific glyphs a chosen display font actually contains is **UNVERIFIED and must be eyeballed** (see (e)). Pointer I did **not** open this pass: `sindresorhus/figures` and `sindresorhus/cli-boxes` (both MIT) are reference data sets for portable Unicode markers and box-drawing border styles respectively — treat as unverified leads.

**(e) Cost / limitations — two real traps.** (1) **Font fallback is silent.** VT323's subsets are latin/latin-ext/vietnamese (VERIFIED, METADATA.pb), so box-drawing and block glyphs will very likely come from a *fallback* font, mid-line, at a different weight and optical size — exactly the misalignment this redesign is trying to fix. Two mitigations: put a full-coverage mono in the stack (`'JetBrains Mono', ui-monospace, monospace` after the display face) and inspect; or draw the heavy frame in CSS (`border` + `::before` bars sized in `ch`) and reserve Unicode for light markers, where a fallback is invisible. This must be verified per-glyph in-browser. (2) **pixelarticons' free-icon count is inconsistent in its own README** (header says 1036 free; the licensing section says "the free package includes 880 icons" and advertises 4400+ in Pro) — so **pin a version and confirm the icon names you need are in the free set**. Preferred integration for the ~6–10 icons this app needs: **vendor the SVGs** (MIT, attribution in a comment) rather than adding unpkg as a runtime host — same visual result, one fewer third-party dependency in a repo whose selling point is that it has none. Reject the shipped webfont for the same reason Nerd Fonts is rejected (below): a large font download for a handful of glyphs.

---

### V7 — Composition: frame vocabulary, ledger alignment, and a measure that tracks the font

**(a) What it enables, where.** Applies to the HUD, the sidebar/panel chrome, the transcript and the Tool Card — i.e. Lane B's "composition" remit (visual hierarchy and rhythm), deliberately *not* IA or navigation (Lane A).

**(b) Primary sources.** Internal: ADR-0005 already fixes the Tool Card's information order (grouped by source weight, `TAG · n hits · ms`, inline `MISSED:`, `FAILED:` only when `sources == 0`) — a visual redesign must *frame* that structure, not re-order it. External, and all VERIFIED: MDN + BCD for `text-wrap: balance` (Chrome 114 / Firefox 121 / Safari 17.5) and the explicit warning that **`text-wrap: pretty` is not supported in Firefox** (BCD records `firefox: {version_added: false}`) — so `pretty` may be used only as a progressive enhancement, never as the plan. Solarized's *selective contrast* principle for the rule weights.

**(c) Mechanism.**

- **Three rule weights as tokens:** heavy outer frame per panel (`═`/2px), light internal separators (`─`/1px at lower alpha), and `·` middots inside a line. Map to `--rule-heavy`, `--rule-light`, `--sep` derived by `color-mix()` from the phosphor identity (V2) so they survive a phosphor switch.
- **Corner brackets for active/focused regions** — four pseudo-elements with paired `border-top`+`border-left` etc., one `ch` wide. Marks the active session/tab/panel *without* a full box, which matters at 320px where a full box costs 2–3 characters of content width.
- **Ledger alignment:** `font-variant-numeric: tabular-nums slashed-zero` on `.telemetry`, `.src-head .ms`, `.mem-*` and `#wat-listing .ln`. Fixes the §0.5 jitter and is the single cheapest "this is a machine readout" signal in the whole document. (`slashed-zero` needs the font's `zero` feature — verify per chosen face.)
- **Measure in `ch`, not px:** `#messages .msg { max-width: 72ch; }` — tracks the font and size, so the measure survives the V1 swap.
- **Optical alignment:** `text-box-trim`/`text-box-edge` to centre the brand lockup in the 44px HUD strip by its caps rather than by magic numbers — **UNVERIFIED this pass**, gate with `@supports`.
- **A 2px spatial base** with the CRT line period as a multiple of it, so vertical rhythm and the scanline grid share a modulus (ties this item to V3.1).

**(d) VERIFIED vs INFERENCE.** `text-wrap` support and the Firefox gap: **VERIFIED** (BCD). `tabular-nums` being absent today: **VERIFIED** (grep). `text-box-trim`, the 72ch value and the bracket geometry: **INFERENCE**.

**(e) Cost / limitations.** All CSS, no dependency, no build step. Limitations: `text-wrap: balance` only affects ≤6 lines (Chromium) / ≤10 (Firefox), so it belongs on heads and short labels, not the transcript; `tabular-nums` widens digits slightly (fine in a mono face, and already `ch`-stable); corner brackets need `pointer-events: none` if they overlap hit targets.

---

### V8 — Substrate: cascade layers and a token surface, so the identity is swappable

**(a) What it enables, where.** A ~15-line restructure of the top of `styles.css` that (i) ends the specificity arms race already visible in the file, (ii) makes the three phosphor identities and the density/contrast modes plain variable overrides, and (iii) makes every V1–V7 feature `@supports`-gated so the ADR-0006 baseline is satisfied *by construction* rather than by review.

**(b) Primary sources.** The evidence for (i) is in the repo: `[hidden] { display: none !important }`, `.modal-backdrop[hidden] { display: none }` and `#sidebar.collapsed { margin-left: -100vw !important }` — three `!important`s that exist purely because `#hud`-vs-class specificity is unmanaged. `@layer` is Baseline (2022-era) and needs no build step.

**(c) Mechanism.**

```css
@layer tokens, base, layout, components, crt, utilities;
/* then: @layer components { .tool-head { … } }  — no !important anywhere */
@supports (font-variation-settings: normal) { /* V1 axes */ }
@supports (color: color-mix(in oklab, red, blue)) { /* V2 derived tokens */ }
@supports (text-wrap: balance) { /* V7 */ }
```

Plus a documented token block that *is* the theme API: `--phos-h`, `--phos-c`, the L ladder, `--rule-heavy/-light`, `--glow`, `--crt-line`, `--scan-period`, and `[data-phosphor="amber|green|paper"]` / `@media (prefers-contrast: more)` overrides on top.

**(d) VERIFIED vs INFERENCE.** The existing `!important`s and the current token list: **VERIFIED** (read `styles.css`). `@layer` support: well-established, not re-verified in this pass — **INFERENCE**; the `@supports` gating pattern means a wrong guess degrades to today's verified look rather than breaking.

**(e) Cost / limitations.** No dependency, no build step. Real cost: reordering the cascade is a whole-file edit with real regression surface, so it should be a single deliberate commit with the existing a11y checks run after it — not an opportunistic change smuggled into a feature branch. Do **not** pair it with V1/V2 variable changes in the same commit, or a regression becomes unbisectable.

---

## 2. Rejected, with the blocking reason

| Candidate | Why it is rejected |
| :--- | :--- |
| Tailwind / any PostCSS–Sass–bundler pipeline | Requires a build step; the repo has no `package.json` **by design** and CI runs only `wat2wasm`. Blocking, not a tradeoff. |
| `Ichiaka/CRTFilter` (canvas CRT: barrel distortion, chromatic aberration) | Canvas moves the transcript out of the DOM — out of `role="log"`, out of text selection, out of the accessibility tree — contradicting ADR-0006's streaming/a11y bar. Rejected on **accessibility**, not performance. |
| Nerd Fonts webfont (`nerdfonts.com/assets/css/webfont.css`, v3.5.1 — VERIFIED to exist) | Thousands of PUA glyphs behind one large font download, for perhaps six icons; and PUA glyphs are meaningless to assistive tech unless `aria-hidden`-wrapped. Vendored SVG or plain Unicode wins on every axis. |
| An icon-font build (`svgtofont` — pixelarticons ships a `.svgtofontrc`) | Producing shippable bytes requires Node. Use the prebuilt font, the raw SVGs, or vendored files instead. |
| Animated grain / animated `background-position` overlays | Full-viewport repaint per frame on top of a scrolling log and a streaming render; stutter at 320–375px plus a photosensitivity concern under ADR-0006. |
| Full-app SVG displacement warp (`filter: url(#…)` on `<body>`/`#layout`) | Containing-block trap for `position: fixed` descendants (MDN) — the app's entire shell is fixed — plus per-frame full-viewport rasterisation. See V5. |
| `backdrop-filter` "glass" panels | Appears in the same MDN containing-block list as `filter`, and blurs a scrolling log every frame. Reach for it only on a small, static surface. |
| Chromatic aberration / RGB triad masks as an identity accent | Physically impossible on a single-phosphor, maskless display; the technique's own populariser says so. Consistency with the app's own "we wrote the engine" claim is worth more than the effect. See V3. |

---

## 3. Constraint matrix

| Item | CDN-only? | New host? | Build step? | Reduced-motion safe? | 320–375px? | Keyboard/WCAG risk |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| V1 fonts (Google Fonts) | Yes | No (existing `preconnect`s) | No | n/a (static) | Yes — but re-check 13–15px labels | Low; axis animation must be null under reduced-motion |
| V1 fonts (Departure Mono) | Yes, or vendored 22 KB woff2 | Only if CDN route | No | n/a | Yes at 11px multiples | Low |
| V2 OKLCH phosphors | Yes | No | No | n/a | Yes | **Medium — must re-run contrast per phosphor** |
| V3 depth stack | Yes | No | No | Layers 3–4 must be removed (not paused) under reduced-motion | Layer 4 off ≤480px | Low; ambient layers need `aria-hidden` + `pointer-events: none` |
| V4 grain | Yes | No (vendored file) | No | Static, so inherently safe | Yes | Low |
| V5 curvature | Yes | No | No | n/a if static | **Only on boot/idle surfaces** | Low **if** not applied to the live DOM |
| V6 unicode + vendored pixel icons | Yes | No if vendored | No | n/a | Yes | Low; `aria-hidden` on glyphs, name on the control |
| V7 composition | Yes | No | No | n/a | Yes | Low; brackets need `pointer-events: none` |
| V8 `@layer` + `@supports` | Yes | No | No | n/a | Yes | Low; keeps the verified baseline as fallback |

A relative-path note for whichever agent lands the actual implementation: any new asset (`noise.svg`, vendored icon SVGs, a vendored woff2`) must be referenced **relatively** — the `path: .` Pages artifact means root-absolute URLs would 404 under the project subpath, which is why the existing app already uses `styles.css` / `js/main.js`.

---

## 4. Must-verify in-browser before implementation is called done

1. Whether the Google Fonts CSS actually serves a **variable** file for the chosen faces (check the `@font-face` for a variation descriptor / test an axis at runtime). My API reads came back as static instances because of the reader's user agent.
2. Whether the `css2` endpoint accepts Sixtyfour's **negative** `SCAN` range (`SCAN@-53..100`) — only `@0..100` was verified.
3. **Per-glyph** rendering of box-drawing/block/braille characters in the shipped font stack (silent fallback is the default failure mode).
4. Contrast ratios **for each phosphor variant** (OKLab L ≠ WCAG luminance — demonstrated numerically in V2(e)).
5. Real measured advance width of the console face, to convert the 860px measure into `ch` correctly.
6. `@supports` gating behaviour for `corner-shape`, `text-box-trim` and `@property`-animated glow.
7. That the Tool Card frame changes do **not** disturb ADR-0005's information order (source-weight grouping, `TAG · n hits · ms`, inline `MISSED:`, `FAILED:` only at zero sources).

---

## 5. Tool coverage (disclosed, per brief)

- **Used:** `context_awesome.find_awesome_section` (3 queries: typography/fonts, retro CRT, CSS effects) and `context_awesome.search_awesome_items` (3 queries: CRT shader, variable fonts, pixel icons). **Not used:** `browse_awesome_lists`, `get_awesome_item`, `get_awesome_items`, `compare_awesome_items`.
- **Honest assessment of that corpus:** it is a developer-tooling corpus and is **thin for visual/typographic direction**. It surfaced list names worth knowing — `jolg42/awesome-typography`, `brabadu/awesome-fonts`, `deanhume/typography`, `Siilwyn/awesome-pixel-art`, `avtzis/awesome-linux-ricing`, `iamdanre/awesome-macos-command-line` (Terminal Fonts section) — but **no item in this report is grounded in an awesome-list entry**; every claim traces to the primary sources cited inline. I did not open any awesome-list item page for this document.
- **`gh_grep`:** used for `feTurbulence`, `font-variation-settings`, `feDisplacementMap` and `mask-image`. **Limitation to be aware of:** for CSS-technique keywords its index is dominated by WPT/servo/Ladybird conformance-test files rather than production stylesheets. It did yield four genuinely useful production hits (`assistant-ui`, `facebook/lexical`, `langflow`, `NielsLeenheer/cssDOOM`), which is why `mask-image` and the `feImage` construction in this report stand on real code — but this tool should not be relied on as a CSS-pattern search engine.
- **`web_search` + `read`:** used for primary-source verification (Google Fonts css2 API, `google/fonts` METADATA.pb, MDN, MDN BCD JSON, webstatus.dev API, jsDelivr data API, Wikipedia, Solarized, cool-retro-term, the CSS-Tricks and Smashing articles, and the real-world CSS files).
- **Repo files read (not modified):** `index.html`, `styles.css`, `README.md`, `js/main.js` (targeted grep), `docs/adr/0005-expanded-results-ux.md`, `docs/adr/0006-mobile-a11y-bar-and-crt-degrade.md`, `docs/research/awesome-a11y-resources-css.md` (format reference).
- **Lane boundaries respected:** no IA/navigation, no keyframe timing or transition choreography (Lane D owns motion), no tooling/toolchain proposals (Lane C), no layout/grid restructuring (Lane A) — V7 is limited to visual composition (frame vocabulary, ledger alignment, measure, optical alignment) and V8 to the cascade substrate.
