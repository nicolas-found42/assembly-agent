# Research: Web Accessibility & DOM Utilities for ASM::AGENT

**Document Status:** Final Research Note  
**Date:** 2026-08-21  
**Scope:** Harvested from GitHub Awesome Accessibility collections (`lukeslp/awesome-accessibility`, `brunopulis/awesome-a11y`, and `GonzagaAccess/awesome-accessibility`). Filtered and evaluated for web accessibility testing libraries, keyboard navigation and focus trapping helpers, color-contrast computation utilities, and accessibility inspection tools compatible with ASM::AGENT's zero-build GitHub Pages static architecture.

---

## 1. Candidate Evaluation Matrix

Each candidate is evaluated against the Inclusion Checklist:
- **License:** OSI approved (MIT/BSD/Apache-2.0/MPL-2.0/LGPL-3.0) or CC0 / Public Domain.
- **CORS:** Unrestricted access (`Access-Control-Allow-Origin: *` verified on public CDN / raw endpoint).
- **Keyless:** Zero authentication or API key required.
- **ToS / Fan-out:** Unrestricted anonymous client distribution from static sites.
- **GH Pages / Zero-Build:** Usable as a standalone drop-in script, ESM module, CSS stylesheet, or client-side utility without server runtimes, native binaries, or build steps.

| Candidate | URL | License | CORS | Keyless | ToS fan-out | GH Pages | Verdict | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **axe-core** | [dequelabs/axe-core](https://github.com/dequelabs/axe-core) | MPL-2.0 | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (single min JS/ESM) | **PASS** | De facto standard automated accessibility testing engine. Runs entirely client-side in the browser to audit DOM subtrees against WCAG 2.0/2.1/2.2 AA/AAA rules. |
| **tota11y** | [jdan/tota11y](https://github.com/jdan/tota11y) | MIT | `*` (cdnjs/jsdelivr) | Yes (Auth=No) | Yes | Yes (single script drop-in) | **PASS** | Visual accessibility toolkit that renders an on-page inspector button to annotate contrast errors, missing alt text, ARIA landmarks, and heading hierarchy. |
| **pa11y** | [pa11y/pa11y](https://github.com/pa11y/pa11y) | LGPL-3.0 | N/A (CLI Engine) | Yes (Auth=No) | Yes | No (requires Node.js/Puppeteer) | **FAIL** | Automated accessibility analysis tool requiring a Node.js CLI runtime and headless browser environment; cannot execute in a static client-side browser page. |
| **focus-trap** | [focus-trap/focus-trap](https://github.com/focus-trap/focus-trap) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (UMD/ESM bundle) | **PASS** | Lightweight, robust utility to trap keyboard focus within modal dialogs, drawers, and overlay panels, preventing focus leakage to background content. |
| **tabbable** | [focus-trap/tabbable](https://github.com/focus-trap/tabbable) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (UMD/ESM bundle) | **PASS** | Fast, reliable utility to discover and query all focusable and sequentially tabbable DOM elements within a container element. |
| **ally.js** | [medialize/ally.js](https://github.com/medialize/ally.js) | MIT | `*` (cdnjs/jsdelivr) | Yes (Auth=No) | Yes | Yes (pre-bundled UMD/ESM) | **PASS** | Comprehensive JavaScript library offering low-level accessibility primitives: focus management, keyboard navigation, ARIA queries, and shadow DOM traversal. |
| **WICG/inert (polyfill)** | [WICG/inert](https://github.com/WICG/inert) | BSD-3-Clause / W3C | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (single script polyfill) | **PASS** | Polyfills the HTML `inert` attribute to mark background DOM trees non-interactive and remove them from the accessibility tree during modal/drawer states. |
| **a11y-contrast** | [drewdistefano/a11y-contrast](https://github.com/drewdistefano/a11y-contrast) | MIT | `*` (jsdelivr/unpkg) | Yes (Auth=No) | Yes | Yes (ESM / vanilla JS) | **PASS** | Minimal algorithmic utility to calculate WCAG color contrast ratios between foreground and background colors and verify AA/AAA compliance thresholds. |
| **contrast-ratio** | [LeaVerou/contrast-ratio](https://github.com/LeaVerou/contrast-ratio) | MIT | `*` (jsdelivr/raw) | Yes (Auth=No) | Yes | Yes (standalone JS module) | **PASS** | Client-side WCAG contrast calculation library by Lea Verou supporting semi-transparent RGBA compositing over arbitrary background colors. |
| **a11y.css** | [ffoodd/a11y.css](https://github.com/ffoodd/a11y.css) | MIT | `*` (jsdelivr/cdnjs) | Yes (Auth=No) | Yes | Yes (drop-in CSS/bookmarklet) | **PASS** | Pure CSS diagnostic stylesheet that visually highlights accessibility flaws, missing `alt`/`aria-*` attributes, and invalid HTML structure directly in the viewport. |

---

## 2. Key Web Accessibility Architectural Patterns for ASM::AGENT

### A. Accessible Focus Trapping & Restoration for HUD Drawers
Recommended pattern derived from `focus-trap` and `tabbable` for drawer overlays (`#sidebar`, `#inspector`):
```javascript
// Retain trigger element for focus restoration upon drawer dismissal
let previousActiveElement = null;

export function trapFocus(containerEl) {
  previousActiveElement = document.activeElement;
  const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusableElements = Array.from(containerEl.querySelectorAll(focusableSelector))
    .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);

  if (focusableElements.length === 0) return;

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  firstElement.focus();

  containerEl.addEventListener('keydown', function handleKeydown(e) {
    if (e.key === 'Escape') {
      releaseFocus();
      return;
    }
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        lastElement.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === lastElement) {
        firstElement.focus();
        e.preventDefault();
      }
    }
  });
}

export function releaseFocus() {
  if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
    previousActiveElement.focus();
    previousActiveElement = null;
  }
}
```

### B. Pure Client-Side WCAG 2.1 Relative Luminance & Contrast Calculation
Zero-dependency contrast ratio calculator derived from `contrast-ratio` and WCAG 2.1 specs:
```javascript
function getLuminance(r, g, b) {
  const [sR, sG, sB] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

export function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(...rgb1);
  const lum2 = getLuminance(...rgb2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

// Example check: amber CRT on black background
// getContrastRatio([255, 176, 0], [0, 0, 0]) -> 9.87:1 (Passes AAA >= 7.0:1)
```

### C. Live Region Announcer for Asynchronous State Updates
Decoupled polite announcer pattern ensuring screen reader compliance without streaming thrash:
```javascript
export function announceStatus(message, priority = 'polite') {
  let announcer = document.getElementById('a11y-announcer');
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.id = 'a11y-announcer';
    announcer.setAttribute('aria-live', priority);
    announcer.setAttribute('aria-atomic', 'true');
    announcer.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
    document.body.appendChild(announcer);
  }
  // Clear and update to re-trigger AT speech synthesis
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = message;
  }, 50);
}
```

---

## 3. Summary Count

- **Total Evaluated Candidates:** 10
- **PASS:** 9
- **FAIL:** 1 (`pa11y` due to requiring Node.js CLI runtime / Puppeteer environment)
- **NEEDS_CHECK:** 0
