# Awesome Accessibility (a11y) Resources Harvest

**Harvest Date:** 2026-08-21  
**Source Repositories Scraped:**
- Primary: [`brunopulis/awesome-a11y`](https://github.com/brunopulis/awesome-a11y) (Stars: ~2.0k, License: CC0-1.0)
- Secondary: [`lukeslp/awesome-accessibility`](https://github.com/lukeslp/awesome-accessibility) (Stars: curated fork/catalog, License: CC0-1.0)

**Scope & Purpose:** Evaluate accessibility libraries, inspection tools, polyfills, and utilities from GitHub awesome-a11y lists against ASM Agent's static, zero-build GitHub Pages deployment requirements (no API key, zero cost, CORS `*` or CDN-deliverable, compatible with vanilla JavaScript and CSS). Evaluation focuses on relevance to ASM Agent's accessibility requirements (focus management, modal/drawer trapping, live region announcements, color contrast math, touch target audit, reduced motion).

---

## Inclusion Checklist Criteria
1. **License:** OSI-approved, CC0-1.0, or W3C Document & Software License.
2. **CORS:** `access-control-allow-origin: *` verified via live HTTP HEAD/GET request on CDN distribution endpoints.
3. **Keyless:** Auth = No (no authentication, account, or API key needed).
4. **ToS Fan-out:** Unrestricted client-side usage / anonymous delivery.
5. **GH Pages Compatibility:** Standalone UMD/IIFE/ESM or static CSS consumable without a build/bundling step (via jsDelivr, cdnjs, or unpkg).
6. **Cost:** 100% Free / Open Source.

---

## Evaluation Verdict Table

| Candidate | URL | License | CORS | Keyless | ToS Fan-out | GH Pages | Verdict | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **axe-core** | `https://github.com/dequelabs/axe-core` | MPL-2.0 (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via jsDelivr/cdnjs) | **PASS** | Automated a11y testing engine. Direct browser runtime integration via `https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js`. Executes `axe.run(document)`. |
| **focus-trap** | `https://github.com/focus-trap/focus-trap` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via jsDelivr) | **PASS** | Traps focus within modal overlays (e.g. ASM Agent `#sidebar` & `#inspector` drawers). CDN: `https://cdn.jsdelivr.net/npm/focus-trap@8.2.2/dist/focus-trap.umd.js` (depends on `tabbable`). |
| **tabbable** | `https://github.com/focus-trap/tabbable` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via jsDelivr) | **PASS** | Returns array of tabbable/focusable DOM nodes for roving tabindex and keyboard navigation. CDN: `https://cdn.jsdelivr.net/npm/tabbable@6.5.0/dist/index.umd.js`. |
| **a11y-dialog** | `https://github.com/KittyGiraudel/a11y-dialog` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via jsDelivr) | **PASS** | Lightweight script to make dialog and drawer components accessible (handles focus restoration, `aria-hidden` sibling hiding, Escape closing). CDN: `https://cdn.jsdelivr.net/npm/a11y-dialog@8.1.5/dist/a11y-dialog.min.js`. |
| **a11y.css** | `https://github.com/ffoodd/a11y.css` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (CSS via jsDelivr) | **PASS** | Diagnostic stylesheet flagging accessibility errors, obsolete attributes, and ARIA anti-patterns directly in browser. CDN: `https://cdn.jsdelivr.net/npm/a11y.css@5.3.0/css/a11y-en.css`. |
| **Checka11y.css** | `https://github.com/jackdomleo7/Checka11y.css` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (CSS via jsDelivr) | **PASS** | Modern diagnostic CSS assertion library that visually flags invalid ARIA, contrast, and interactive markup. CDN: `https://cdn.jsdelivr.net/npm/checka11y-css@2.5.0/checka11y.css`. |
| **tota11y** | `https://github.com/Khan/tota11y` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via cdnjs) | **PASS** | In-browser accessibility visualization toolbar (contrast violations, heading hierarchy, aria-labels). CDN: `https://cdnjs.cloudflare.com/ajax/libs/tota11y/0.1.6/tota11y.min.js`. |
| **ally.js** | `https://github.com/medialize/ally.js` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via cdnjs) | **PASS** | Comprehensive JavaScript library for keyboard focus, taborder navigation, and query selectors. CDN: `https://cdnjs.cloudflare.com/ajax/libs/ally.js/1.4.1/ally.min.js`. |
| **focus-visible** | `https://github.com/WICG/focus-visible` | W3C / BSD-3 (OSI) | Yes (`*`) | Yes | Yes | Yes (Script via jsDelivr) | **PASS** | Polyfill for `:focus-visible` pseudo-class to ensure keyboard focus visibility while preventing pointer click outlines. CDN: `https://cdn.jsdelivr.net/npm/focus-visible@5.2.1/dist/focus-visible.min.js`. |
| **wicg-inert** | `https://github.com/WICG/inert` | W3C / BSD-3 (OSI) | Yes (`*`) | Yes | Yes | Yes (Script via jsDelivr) | **PASS** | Polyfill for HTML `inert` attribute to disable background DOM trees while drawers/dialogs are active. CDN: `https://cdn.jsdelivr.net/npm/wicg-inert@3.1.3/dist/inert.min.js`. |
| **accessibilityjs** | `https://github.com/github/accessibilityjs` | MIT (OSI) | Yes (`*`) | Yes | Yes | Yes (UMD via jsDelivr) | **PASS** | Client-side error scanner by GitHub flagging missing labels, unlabelled inputs, and invalid interactive controls. CDN: `https://cdn.jsdelivr.net/npm/accessibilityjs@1.1.2/dist/index-umd.js`. (Note: archived/unmaintained). |
| **colorable** | `https://github.com/jxnblk/colorable` | MIT (OSI) | Yes (`*` via esm.sh) | Yes | Yes | Conditional (ESM / Bundler) | **NEEDS_CHECK** | Computes full WCAG contrast matrices for color sets. Standard npm release is CommonJS without pre-built browser global; requires bundler or ESM import via `https://esm.sh/colorable`. |
| **pa11y** | `https://github.com/pa11y/pa11y` | LGPL-3.0 (OSI) | N/A (Node CLI) | Yes | Yes | No (Node.js runtime) | **FAIL** | Node.js CLI & automated CI testing framework using Puppeteer. Cannot run client-side in a zero-build browser environment on GH Pages. |
| **a11y-contrast** | `https://github.com/darekkay/a11y-contrast` | MIT (OSI) | N/A (Node CLI) | Yes | Yes | No (Node CLI) | **FAIL** | CLI utility for calculating accessible color palettes. Node.js binary only (`bin/a11y-contrast.js`); no standalone browser library provided. |

---

## Summary of Candidates
- **Total Evaluated:** 14
- **PASS:** 11 (`axe-core`, `focus-trap`, `tabbable`, `a11y-dialog`, `a11y.css`, `Checka11y.css`, `tota11y`, `ally.js`, `focus-visible`, `wicg-inert`, `accessibilityjs`)
- **NEEDS_CHECK:** 1 (`colorable` — requires ESM dynamic import `esm.sh` or inline math for static vanilla JS)
- **FAIL:** 2 (`pa11y`, `a11y-contrast` — Node.js CLI / build-time only tools)

## Recommendations for ASM Agent
1. **Drawer Focus Management & Inert Backgrounds:** Combine native `inert` (with `wicg-inert` polyfill fallback) and `tabbable`/`focus-trap` or `a11y-dialog` patterns to trap keyboard navigation within `#sidebar` and `#inspector`.
2. **In-Browser Accessibility Verification:** Inject `axe-core` in smoke tests / developer console to audit runtime accessibility issues (F01–F16) against WCAG 2.2 Level AA directly without requiring local node dependencies.
3. **Visual Diagnostics:** Load `a11y.css` or `Checka11y.css` during development/testing sessions to immediately highlight non-accessible markup, unlabelled controls, and contrast anomalies.
