# Research: CSS & Styling Accessibility Resources for ASM::AGENT

**Document Status:** Final Research Note  
**Date:** 2026-08-21  
**Scope:** Harvested from GitHub Awesome CSS collections (`awesome-css-group/awesome-css`, `troxler/awesome-css-frameworks`, and community a11y CSS repos). Filtered and evaluated for CSS-only accessibility helpers (focus indicators, reset/normalizers, prefers-reduced-motion media snippets, safe-area viewport insets, dvh sizing, and classless semantic primitives) compatible with ASM::AGENT's zero-build GitHub Pages static architecture.

---

## 1. Candidate Evaluation Matrix

Each candidate is evaluated against the Inclusion Checklist:
- **License:** OSI approved (MIT/BSD/Apache-2.0) or CC0 / Public Domain.
- **CORS:** Unrestricted access (`Access-Control-Allow-Origin: *` verified on public CDN / raw endpoint).
- **Keyless:** Zero authentication or API key required.
- **ToS / Fan-out:** Unrestricted anonymous client distribution from static sites.
- **GH Pages / Zero-Build:** Usable as a standalone drop-in CSS file or inlined snippet without build steps, bundlers, or preprocessing.

| Candidate | URL | License | CORS | Keyless | ToS fan-out | GH Pages | Verdict | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **modern-normalize** | [sindresorhus/modern-normalize](https://github.com/sindresorhus/modern-normalize) | MIT | `*` (cdnjs/jsdelivr) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Normalizes browser default styles, font inheritance, button resets, box-sizing, and text rendering across modern browsers. |
| **modern-css-reset** | [hankchizljaw/modern-css-reset](https://github.com/hankchizljaw/modern-css-reset) | MIT | `*` (jsdelivr/raw) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Built-in `prefers-reduced-motion` reset (`scroll-behavior: auto !important`, animation/transition zeroing), accessible line-heights, and image constraints. |
| **sanitize.css** | [csstools/sanitize.css](https://github.com/csstools/sanitize.css) | CC0-1.0 | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Dedicated modular CSS stylesheets including `sanitize.css`, `forms.css`, `assets.css`, and `reduce-motion.css` for granular a11y styling. |
| **focus-visible polyfill** | [WICG/focus-visible](https://github.com/WICG/focus-visible) | W3C / Apache-2.0 | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (single min JS/CSS) | **PASS** | Provides `.focus-visible` styling fallback for legacy web engines lacking native `:focus-visible` pseudo-class support. |
| **open-props (a11y & sizes)** | [argyleink/open-props](https://github.com/argyleink/open-props) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (modular CSS) | **PASS** | Modern CSS custom properties for adaptive color schemes, fluid typography, safe motion tokens, and modern viewport units (`100dvh`, safe-area insets). |
| **ress** | [filipelinhares/ress](https://github.com/filipelinhares/ress) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Modern CSS reset with default `:focus` preservation, tap highlight color removal, and accessible form element defaults. |
| **minireset.css** | [jgthms/minireset.css](https://github.com/jgthms/minireset.css) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Micro CSS reset (under 1KB) establishing consistent `box-sizing: border-box`, responsive media blocks, and reset margins. |
| **Pico.css (Class-less)** | [picocss/pico](https://github.com/picocss/pico) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Class-less / semantic-first CSS framework with native contrast compliance, automatic dark mode, and keyboard `:focus-visible` indicators. |
| **Simple.css** | [kevquirk/simple.css](https://github.com/kevquirk/simple.css) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Semantic HTML classless stylesheet with accessible defaults, high contrast ratios, and automatic dark/light theme switching. |
| **Water.css** | [kognise/water.css](https://github.com/kognise/water.css) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS) | **PASS** | Drop-in collection of semantic styling with out-of-the-box form focus states, accessible typography hierarchy, and zero build setup. |
| **REVENGE.CSS** | [Heydon/REVENGE.CSS](https://github.com/Heydon/REVENGE.CSS) | MIT | `*` (raw/github) | Yes (Auth=No) | Yes | Yes (CSS bookmarklet) | **PASS** | Accessibility and markup linter in pure CSS using attribute and pseudo selectors to visually flag bad/inaccessible HTML markup. |
| **Tailwind CSS (Core Lib)** | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | MIT | N/A (Build Tool) | Yes (Auth=No) | Yes | No (requires Node/CLI compiler) | **FAIL** | Full utility framework requires build-time PostCSS / compiler steps, violating ASM::AGENT zero-build vanilla static requirements (standalone CDN play-cdn is unsuitable for production). |
| **Bourbon (Sass Mixins)** | [thoughtbot/bourbon](https://github.com/thoughtbot/bourbon) | MIT | N/A (SCSS Mixins) | Yes (Auth=No) | Yes | No (requires Sass compiler) | **FAIL** | Sass-only mixin library; cannot be included directly as runtime vanilla CSS in a browser or GitHub Pages without build step. |

---

## 2. Key CSS-Only Architectural Patterns for ASM::AGENT

### A. Prefers-Reduced-Motion Universal Helper
Recommended snippet derived from `modern-css-reset` and `sanitize.css`:
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### B. Safe-Area Insets & Dynamic Viewport Height (`dvh`)
Recommended CSS sizing patterns for mobile notched displays and virtual keyboards:
```css
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
}

.app-container {
  min-height: 100vh;
  min-height: 100dvh;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
```

### C. Universal Keyboard Focus-Visible Styling
Accessible focus ring styling preserving custom aesthetic while meeting WCAG 2.4.7 / 2.4.11:
```css
:focus {
  outline: none;
}

:focus-visible {
  outline: 2px solid var(--accent, #4af626);
  outline-offset: 2px;
}
```

---

## 3. Summary Count

- **Total Evaluated Candidates:** 13
- **PASS:** 11
- **FAIL:** 2 (due to build-step / Sass compilation requirements)
- **NEEDS_CHECK:** 0
