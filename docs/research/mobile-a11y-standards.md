# Research: Mobile & Assistive Accessibility Standards for ASM::AGENT

**Document Status:** Final Research Note  
**Date:** 2026-08-21  
**Scope:** Standards analysis, compliance thresholds, and platform-specific constraints for ASM::AGENT (static vanilla-JS retro CRT chat agent).

---

## 1. Touch Targets & Pointer Sizing

### Standards & Thresholds
- **WCAG 2.2 SC 2.5.8 Target Size (Minimum) (Level AA):** The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except where targets have an offset spacing resulting in a 24px diameter circle, inline targets in text, or user-agent defaults.  
  *Citation:* [W3C WCAG 2.2 SC 2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum)
- **Apple Human Interface Guidelines (Touch & Gestures):** Minimum interactive target size is 44 × 44 pt (points) on iOS and iPadOS to prevent mis-taps and accommodate thumb interaction.  
  *Citation:* [Apple HIG — Touch and gestures](https://developer.apple.com/design/human-interface-guidelines/inputs/touch-and-gestures/)
- **Google Material Design 3 (Touch Targets):** Minimum touch target size is 48 × 48 dp (density-independent pixels) with at least 8 dp of space between targets.  
  *Citation:* [Material Design 3 — Accessibility Basics](https://m3.material.io/foundations/accessible-design/accessibility-basics)

### Application to ASM::AGENT
- HUD buttons (`.hud-btn`, currently `padding: 2px 8px`, ~20px rendered height), code block copy buttons (`.copy-btn`, ~18px height), session action buttons (`.session-actions button`), and the drawer close icon (`.icon-btn`) fail WCAG 2.5.8 (24×24px) and fall far short of mobile HIG/Material baselines (44×44px / 48×48px).
- The brand title toggle (`.brand`, non-semantic `<span>`) acts as the sole mobile sidebar switch without any explicit touch target padding or button semantics.

---

## 2. Focus Visibility & Obscuration

### Standards & Thresholds
- **WCAG 2.2 SC 2.4.7 Focus Visible (Level AA):** Any keyboard-operable user interface has a mode of operation where the keyboard focus indicator is visible.  
  *Citation:* [W3C WCAG 2.2 SC 2.4.7](https://www.w3.org/TR/WCAG22/#focus-visible)
- **WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum) (Level AA):** When an item receives keyboard focus, it is not entirely hidden due to author-created content (such as fixed headers, banners, or modal drawers).  
  *Citation:* [W3C WCAG 2.2 SC 2.4.11](https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum)
- **CSS `:focus-visible` Pseudo-Class:** Provides distinct focus styling only when the user agent determines keyboard or non-pointer focus modality.  
  *Citation:* [MDN — :focus-visible](https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible) / [W3C CSS Selectors Level 4](https://www.w3.org/TR/selectors-4/#the-focus-visible-pseudo)

### Application to ASM::AGENT
- `styles.css` sets `outline: none` on `#input` and `.model-list` without establishing universal `:focus-visible` indicators across HUD buttons, session items, tabs, and drawer controls.
- When fixed mobile overlays (`#sidebar`, `#inspector`, `#hud` at 44px fixed top) open, background chat elements and inputs can receive keyboard focus while being 100% visually obscured by the overlay layer, violating SC 2.4.11 unless focus is trapped or inerted.

---

## 3. Motion, Flicker & Vestibular Safety

### Standards & Thresholds
- **WCAG 2.2 SC 2.2.2 Pause, Stop, Hide (Level A):** For any moving, blinking, or scrolling information that starts automatically, lasts more than five seconds, and is presented in parallel with other content, there is a mechanism for the user to pause, stop, or hide it.  
  *Citation:* [W3C WCAG 2.2 SC 2.2.2](https://www.w3.org/TR/WCAG22/#pause-stop-hide)
- **WCAG 2.2 SC 2.3.1 Three Flashes or Below Threshold (Level A):** Web pages do not contain anything that flashes more than three times in any one-second period, or the flash is below the general flash and red flash thresholds.  
  *Citation:* [W3C WCAG 2.2 SC 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold)
- **WCAG 2.2 SC 2.3.3 Animation from Interactions (Level AAA):** Motion animation triggered by interaction can be disabled unless the animation is essential to the functionality or the information being conveyed.  
  *Citation:* [W3C WCAG 2.2 SC 2.3.3](https://www.w3.org/TR/WCAG22/#animation-from-interactions)
- **CSS `@media (prefers-reduced-motion)`:** Detects if the user has requested the system minimize the amount of non-essential motion/animation.  
  *Citation:* [MDN — prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) / [W3C Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)

### Vestibular Disorder Rationale & Degradation
- *Rationale:* Repetitive luminescence fluctuations (CRT flicker), moving scanline overlays, infinite terminal cursor blinks, and animated spinframes trigger vestibular disorientation, vertigo, migraines, nausea, and motion sickness in susceptible users.
- *Compliant Degradation:* Under `@media (prefers-reduced-motion: reduce)`, CSS must suppress `flickerAnim` (set opacity to 1), disable the blinking cursor animation (`.cursor-blink::after`), replace rotating tool spinners (`spinframes`) with a static glyph, and disable boot screen fade transitions (`transition: none`).

---

## 4. Live Regions & Streaming Output Accessibility

### Standards & Thresholds
- **WCAG 2.2 SC 4.1.3 Status Messages (Level AA):** In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus.  
  *Citation:* [W3C WCAG 2.2 SC 4.1.3](https://www.w3.org/TR/WCAG22/#status-messages)
- **WAI-ARIA 1.2 `aria-live` & Live Region Roles (`role="status"`, `role="log"`):** Defines how dynamic content updates are surfaced to screen readers.  
  *Citation:* [W3C WAI-ARIA 1.2 — Live Region Attributes](https://www.w3.org/TR/wai-aria-1.2/#aria-live) / [W3C ARIA APG Live Regions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)

### Token-by-Token Streaming Tradeoffs & Granularity
- **Assertive vs Polite Hazard:** `aria-live="assertive"` interrupts current speech immediately; applying it to streaming chat makes assistive technology unusable. `aria-live="polite"` queues announcements until the user pauses.
- **Per-Token Live Region Thrashing:** Binding `aria-live` directly to the live message container during streaming causes the screen reader to receive hundreds of rapid mutation events. This creates buffer thrashing, voice stuttering, fragmented syllable repetition, and sluggish browser rendering.
- **Compliant Architectural Pattern:**
  1. *Turn State Announcements:* Use a dedicated, visually hidden live region (`role="status"`, `aria-live="polite"`, `aria-atomic="true"`) to announce state transitions (e.g., "ASM Agent is generating response...", "Tool search executed", "Response complete").
  2. *Message Stream History:* The `#messages` container should use `role="log"` with `aria-live="off"` or `aria-atomic="false"` during active token streaming, allowing screen reader users to navigate the conversation history with standard virtual cursor reading commands after generation completes.

---

## 5. Color Contrast, Typography & Reflow

### Standards & Thresholds
- **WCAG 2.2 SC 1.4.3 Contrast (Minimum) (Level AA):** Visual presentation of text and images of text has a contrast ratio of at least 4.5:1, except for large-scale text (at least 18pt/24px or 14pt/18.66px bold), which requires at least 3:1.  
  *Citation:* [W3C WCAG 2.2 SC 1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum)
- **WCAG 2.2 SC 1.4.11 Non-text Contrast (Level AA):** Visual presentation of UI components (states, boundaries) and graphical objects has a contrast ratio of at least 3:1 against adjacent background colors.  
  *Citation:* [W3C WCAG 2.2 SC 1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast)
- **WCAG 2.2 SC 1.4.4 Resize Text (Level AA):** Text can be resized without assistive technology up to 200 percent without loss of content or functionality.  
  *Citation:* [W3C WCAG 2.2 SC 1.4.4](https://www.w3.org/TR/WCAG22/#resize-text)
- **WCAG 2.2 SC 1.4.10 Reflow (Level AA):** Content can be presented without loss of information or functionality, and without requiring scrolling in two dimensions for vertical scrolling content at a width of 320 CSS pixels.  
  *Citation:* [W3C WCAG 2.2 SC 1.4.10](https://www.w3.org/TR/WCAG22/#reflow)

### Application to ASM::AGENT Palette & Typography
- **Contrast Calculations on `--crt-bg` (`#0c0700`):**
  - `--amber-bright` (`#ffcf7a`): **13.82:1** (PASS AA/AAA).
  - `--amber-core` (`#ffb000`): **10.96:1** (PASS AA/AAA).
  - `--amber-mid` (`#e09600`): **8.16:1** (PASS AA/AAA).
  - `--amber-dim` (`#7a5200`): **2.90:1** (**FAIL** SC 1.4.3 for body/HUD text; **FAIL** SC 1.4.11 for borders/badges).
  - `--err` (`#ff6a3d`): **7.06:1** (PASS AA).
- **Pixel Font (VT323) Legibility:** Pixelated display fonts require higher physical pixel density to maintain glyph recognition. At small sizes (12px–14px), thin strokes degrade rapidly under zoom or low-resolution screens.
- **Reflow & Text Zoom Failure Modes:** Fixed pixel container heights (`#hud` at 44px, `#layout` absolute positioning, `body { overflow: hidden }`) cause UI clipping and unscrollable overflows when browser text zoom reaches 200% or viewport drops to 320px width.

---

## 6. Semantic Structure, Labels & Interactive Controls

### Standards & Thresholds
- **WCAG 2.2 SC 3.3.2 Labels or Instructions (Level A):** Labels or instructions are provided when content requires user input.  
  *Citation:* [W3C WCAG 2.2 SC 3.3.2](https://www.w3.org/TR/WCAG22/#labels-or-instructions)
- **WCAG 2.2 SC 4.1.2 Name, Role, Value (Level A):** For all user interface components, the name and role can be programmatically determined; states, properties, and values can be programmatically set.  
  *Citation:* [W3C WCAG 2.2 SC 4.1.2](https://www.w3.org/TR/WCAG22/#name-role-value)

### Application to ASM::AGENT
- `#input` textarea lacks an associated `<label>` or `aria-label`, relying exclusively on a placeholder attribute (violates SC 3.3.2 / 4.1.2).
- HUD buttons rely on HTML `title` attributes alone, which are inaccessible on touchscreens and inconsistently exposed to screen readers.
- The brand element (`<span class="brand">`) functions as a drawer button on mobile but has no `role="button"`, `tabindex="0"`, or `aria-expanded` state.
- Accordion cards (`.tool-head`, `.src-head`) and modal dialogs (`#inspector`, model catalog, settings) lack ARIA expanded states (`aria-expanded`), dialog semantics (`role="dialog"`, `aria-modal="true"`), and accessible name bindings (`aria-labelledby`).

---

## 7. Mobile Viewport, Safe Areas & iOS Safari Fixed Overlays

### Standards & Technical Constraints
- **W3C CSS Values and Units Module Level 4 (Dynamic Viewports):** `100dvh` (dynamic viewport height) reflects the actual visible viewport as browser chrome expands/collapses.  
  *Citation:* [W3C CSS Values Level 4 — Viewport-percentage Lengths](https://www.w3.org/TR/css-values-4/#small-large-dynamic-viewports)
- **W3C Visual Viewport API:** `window.visualViewport` tracks offset and height changes when the on-screen keyboard (OSK) opens.  
  *Citation:* [W3C Visual Viewport API](https://www.w3.org/TR/visual-viewport/) / [MDN Visual Viewport API](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)
- **WebKit Safe Area Insets & Viewport Fit:** Handling display cutouts and home indicator bars via `viewport-fit=cover` and CSS `env(safe-area-inset-*)`.  
  *Citation:* [WebKit Blog — Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)

### iOS Safari Quirks & Failure Modes
- **`100vh` vs `100dvh` Bug:** Using `height: 100%` or `100vh` with fixed layouts causes the bottom composer bar (`#composer`) to be obscured behind the Safari bottom toolbar on initial load.
- **Fixed Positioning & Virtual Keyboard (OSK):** On iOS Safari, `position: fixed` elements attached to the bottom of the viewport frequently detach, bounce, or get trapped behind the virtual keyboard when typing in `#input`. The layout container must dynamically adjust to `visualViewport.height` and `visualViewport.offsetTop`.
- **Safe Area Clipping:** Header buttons and bottom composer controls clip into the iPhone Dynamic Island / notch and home indicator without `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`.

---

## 8. Proposed Audit Checklist

The following 16 testable criteria constitute the baseline accessibility bar for ASM::AGENT:

1. **[Target Size]** All interactive controls (HUD buttons, session items, copy buttons, close icons, brand toggle) measure at least 24 × 24 CSS px (WCAG 2.5.8) and offer a 44 × 44 pt minimum touch hit area on mobile viewports (Apple HIG / Material).
2. **[Focus Ring]** Every interactive element displays a high-contrast focus indicator (`:focus-visible`) with at least a 3:1 contrast ratio against the background.
3. **[Focus Obscuration]** When mobile overlay drawers (`#sidebar`, `#inspector`) are open, focused elements behind the overlay are not reachable by keyboard navigation (focus is trapped or background is `inert`).
4. **[Reduced Motion: Flicker]** When `@media (prefers-reduced-motion: reduce)` is enabled, the 4-second infinite CRT flicker animation (`body.crt-flicker`) is disabled.
5. **[Reduced Motion: Spinners]** When `@media (prefers-reduced-motion: reduce)` is enabled, animated tool spinners (`.tool-spin`) and blinking cursors (`.cursor-blink`) render as static glyphs.
6. **[Reduced Motion: Transitions]** Boot overlay transitions and drawer slide animations degrade to immediate cuts under reduced motion settings.
7. **[Color Contrast: Text]** All text in body copy, HUD buttons, telemetry strings, timestamps, and badges meets a minimum contrast ratio of 4.5:1 against its background (or 3:1 for text ≥18pt/24px).
8. **[Color Contrast: Dim Amber]** Color `--amber-dim` (`#7a5200`, 2.90:1) is not used for essential text or standalone interactive icons without luminance adjustment to ≥4.5:1 (or ≥3:1 for UI borders).
9. **[Input Labeling]** `#input` textarea and all settings/dialog inputs provide an explicit accessible name via `<label>`, `aria-label`, or `aria-labelledby`.
10. **[HUD Button Names]** HUD buttons and icon-only controls have accessible names accessible to screen readers rather than depending solely on the `title` attribute.
11. **[Brand Toggle Semantics]** The brand sidebar toggle (`.brand`) is exposed as an accessible button (`role="button"`, `tabindex="0"`, `aria-label`, `aria-expanded`).
12. **[Live Regions: Granularity]** Live streaming token updates do not broadcast every SSE token mutation; assistant status changes are announced politely via a dedicated `role="status"` region.
13. **[Conversation History Semantics]** The chat history container (`#messages`) is marked with `role="log"` and allows structured navigation of individual user/assistant turns.
14. **[Text Zoom & Reflow]** The entire interface remains legible, operable, and free of clipped content when browser text is scaled to 200% or viewed at a 320 CSS px width.
15. **[iOS Safe Areas]** The HUD header and composer footer respect `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` when `viewport-fit=cover` is set.
16. **[Virtual Keyboard Layout]** The composer textarea and send buttons remain fully visible and sticky above the iOS virtual keyboard without clipping or detached scrolling.
