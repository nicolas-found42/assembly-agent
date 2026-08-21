# Research: Web Accessibility Resources & Tooling for ASM::AGENT

**Document Status:** Final Research Note  
**Date:** 2026-08-21  
**Scope:** Harvested from GitHub Awesome Web Accessibility collections (`brandonhimpfen/awesome-web-accessibility`, `brunopulis/awesome-a11y`, and `lukeslp/awesome-accessibility`). Evaluated against ASM::AGENT's Inclusion Checklist for free, keyless, CORS-enabled web accessibility tools, distinguishing between **dev-only/test-harness** tooling (test runners, AST linters, automated CI audit engines) and **runtime-compatible** components (vanilla JS ARIA helpers, diagnostic CSS overlays) suitable for zero-build GitHub Pages deployment.

---

## 1. Dev-Only vs. Runtime Architecture Split

Web accessibility tooling falls into two distinct operational tiers for zero-build static web applications like ASM::AGENT:

1. **Dev-Only & Test Harness (Zero Runtime Overhead):** Tools such as `axe-core`, `lighthouse`, `pa11y`, and `eslint-plugin-jsx-a11y` run strictly during development, automated test execution (`test/`), or continuous integration. For dev-only tools, the **GH Pages** criterion evaluates whether the tool is runnable inside a headless browser fixture, in-memory DOM environment, or developer CLI without adding bundle weight or runtime dependencies to the static distribution. `axe-core` in particular can be injected into browser smoke tests via CDN (`cdnjs`/`jsdelivr`) or executed in Playwright/Puppeteer test scripts to audit the live rendered DOM for WCAG 2.2 AA violations without shipping a single byte to end users.
2. **Runtime Primitives & In-Browser Diagnostics:** Tools such as `a11y-dialog`, `a11y.css`, and `Checka11y.css` operate directly in the client browser. Production runtime utilities must be lightweight, dependency-free vanilla JS or pure CSS that function directly on static GitHub Pages hosting (`build.sh` is zero-build). Diagnostic visual aids (`a11y.css`, `tota11y`) can be loaded on demand or toggled during manual QA to highlight missing ARIA attributes, improper heading hierarchies, or low-contrast elements without requiring backend servers or API keys.

---

## 2. Candidate Evaluation Matrix

Each candidate is evaluated against the Inclusion Checklist:
- **License:** OSI-approved (MIT, Apache-2.0, MPL-2.0, LGPL-3.0) or CC0 / Public Domain.
- **CORS:** Unrestricted access (`Access-Control-Allow-Origin: *` verified on public CDNs).
- **Keyless:** Zero authentication or API keys required (`Auth=No`).
- **ToS / Fan-out:** Unrestricted anonymous client distribution and automated local execution.
- **GH Pages Compatibility:** For runtime tools, drop-in static ESM/CSS; for dev-only tools, compatibility with local/CI test harnesses without build step requirements.

| Candidate | URL | License | CORS | Keyless | ToS fan-out | GH Pages | Verdict | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **axe-core** | [dequelabs/axe-core](https://github.com/dequelabs/axe-core) | MPL-2.0 | `*` (cdnjs/jsdelivr) | Yes (Auth=No) | Yes | Yes (test harness compatible) | **PASS** | Industry-standard WCAG 2.0/2.1/2.2 AA auditing engine. Injectable into `test/` smoke runners or browser test pages via CDN without runtime production overhead. |
| **Lighthouse** | [GoogleChrome/lighthouse](https://github.com/GoogleChrome/lighthouse) | Apache-2.0 | N/A (CLI / DevTools) | Yes (Auth=No) | Yes | Yes (test harness compatible) | **PASS** | Automated audit CLI and DevTools engine for accessibility, performance, and best practices. Generates structured WCAG violation reports in CI. |
| **a11y-dialog** | [KittyGiraudel/a11y-dialog](https://github.com/KittyGiraudel/a11y-dialog) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (runtime static ESM) | **PASS** | Lightweight (<2KB minified), zero-dependency accessible dialog/modal library. Handles focus trapping, keyboard navigation (`Escape`, `Tab`), and ARIA attributes natively. |
| **a11y.css** | [ffoodd/a11y.css](https://github.com/ffoodd/a11y.css) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (runtime/dev CSS overlay) | **PASS** | CSS diagnostic stylesheet that visually highlights accessibility risks, missing `alt`/`aria-*` attributes, and malformed HTML structure during development. |
| **Pa11y** | [pa11y/pa11y](https://github.com/pa11y/pa11y) | LGPL-3.0 | N/A (Node CLI) | Yes (Auth=No) | Yes | Yes (test harness compatible) | **PASS** | Automated accessibility test runner executing in Node.js/headless browser against local static HTML files or deployed endpoints. |
| **Checka11y.css** | [jackdomleo7/Checka11y.css](https://github.com/jackdomleo7/Checka11y.css) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (runtime/dev CSS overlay) | **PASS** | Modern, customizable CSS stylesheet that visually outlines WCAG accessibility errors and warnings across standard HTML elements. |
| **tota11y** | [Khan/tota11y](https://github.com/Khan/tota11y) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (dev visualization script) | **PASS** | In-browser accessibility visualization toolkit (single minified JS bundle) for inspecting contrast ratios, heading outlines, and screen reader annotations. |
| **eslint-plugin-jsx-a11y** | [jsx-eslint/eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) | MIT | N/A (npm package) | Yes (Auth=No) | Yes | Yes (dev-only linter) | **PASS** | Static AST analyzer for JSX/HTML elements enforcing accessible attributes, ARIA roles, and keyboard event bindings during development. |
| **IBM Equal Access Engine** | [IBMa/equal-access](https://github.com/IBMa/equal-access) | Apache-2.0 | N/A (npm `accessibility-checker`) | Yes (Auth=No) | Yes | Yes (test harness compatible) | **PASS** | Automated rule engine mapping web content to WCAG 2.1 AA and IBM 7.2 accessibility standards in Node.js and browser environments. |
| **AccessibilityJS** | [github/accessibilityjs](https://github.com/github/accessibilityjs) | MIT | `*` (unpkg/npm) | Yes (Auth=No) | Yes | Yes (test harness / client JS) | **PASS** | Lightweight client-side library to scan DOM nodes for missing form labels, button text, and ARIA violations on dynamic updates. |
| **WAVE API** | [WebAIM WAVE API](https://wave.webaim.org/api/) | Commercial | Restricted | No (Auth=API Key) | No (Commercial credit system) | No (Requires server secret key) | **FAIL** | Commercial API requiring paid credit tokens and subscription authentication; incompatible with zero-cost static client architecture. |
| **Tenon.io API** | [Tenon.io API](https://tenon.io/) | Commercial | Restricted | No (Auth=API Key) | No (Commercial SaaS) | No (Requires API token) | **FAIL** | Key-gated commercial SaaS accessibility testing API; violates keyless and zero-cost static client constraints. |

---

## 3. Integration Recommendations for ASM::AGENT

1. **Integration into `test/smoke.mjs`:** Integrate `axe-core` via standalone script injection in the smoke test suite to programmatically verify that chat messages, modals, HUD buttons, and inspector drawers produce zero critical or serious WCAG 2.2 AA violations.
2. **Modal & Drawer Focus Trapping:** Adopt patterns from `a11y-dialog` (or include the lightweight ESM script directly) to handle focus trapping and `aria-modal="true"` behavior on `#sidebar` and `#inspector` drawers.
3. **Development Diagnostic Mode:** Provide an optional debug toggle to inject `a11y.css` or `Checka11y.css` in local development mode to immediately catch non-semantic markup without external tooling overhead.

---

## 4. Final Verdict Summary

- **PASS:** 10 (axe-core, Lighthouse, a11y-dialog, a11y.css, Pa11y, Checka11y.css, tota11y, eslint-plugin-jsx-a11y, IBM Equal Access Engine, AccessibilityJS)
- **FAIL:** 2 (WAVE API, Tenon.io API)
- **NEEDS_CHECK:** 0
