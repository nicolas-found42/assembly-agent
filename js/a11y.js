// a11y.js — vanilla dialog focus trap + inert + announcer helpers, GH Pages zero-build.
// No dependencies; see awesome-a11y-resources-accessibility.md §2A/§2C.

let prevFocus = null;
let trapHandler = null;
let trapEl = null;
let inertTargets = [];

/** @returns {HTMLElement[]} focusables inside container */
function focusables(container) {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(sel)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null
  );
}

function setInert(on) {
  const targets = [
    document.getElementById('layout'),
    document.getElementById('hud'),
  ].filter(Boolean);
  if (on) {
    inertTargets = targets;
    for (const el of targets) {
      try {
        if ('inert' in el) el.inert = true;
        else el.setAttribute('aria-hidden', 'true');
      } catch {}
      // make focusables untabbable as fallback
      // (axe will flag if focus leaks without inert)
    }
  } else {
    for (const el of inertTargets) {
      try {
        if ('inert' in el) el.inert = false;
        else el.removeAttribute('aria-hidden');
      } catch {}
    }
    inertTargets = [];
  }
}

/**
 * Trap focus inside dialogEl (expected to be the backdrop or modal container).
 * triggerEl is the element to return focus to on close.
 * onClose is called when Escape is pressed or trap needs to close.
 * Returns a release() function.
 */
export function trapDialog(dialogEl, triggerEl, onClose) {
  // release previous trap if any (avoid leak)
  if (trapHandler && trapEl) {
    try { trapEl.removeEventListener('keydown', trapHandler); } catch {}
    try { document.removeEventListener('keydown', trapHandler); } catch {}
    trapHandler = null;
    trapEl = null;
  } else if (trapHandler) {
    releaseTrap();
  }

  prevFocus = triggerEl && typeof triggerEl.focus === 'function' ? triggerEl : document.activeElement;
  trapEl = dialogEl;
  setInert(true);

  const els = focusables(dialogEl);
  const first = els[0] || dialogEl;
  if (!els.length && !dialogEl.hasAttribute('tabindex')) dialogEl.setAttribute('tabindex', '-1');
  try { first.focus(); } catch {}

  trapHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (onClose) onClose();
      else releaseTrap();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = focusables(dialogEl);
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  };
  // single document listener handles both Escape (even when focus on body) and Tab trapping via bubbling
  document.addEventListener('keydown', trapHandler);
  return releaseTrap;
}

export function releaseTrap() {
  if (trapHandler) {
    try { document.removeEventListener('keydown', trapHandler); } catch {}
  }
  trapHandler = null;
  trapEl = null;
  setInert(false);
  if (prevFocus && typeof prevFocus.focus === 'function') {
    try { prevFocus.focus(); } catch {}
  }
  prevFocus = null;
}

// ── announcer (06 live regions) ──────────────────────────────────────────
// Decoupled polite announcer per awesome-a11y-resources-accessibility.md §2C.
let announcerEl = null;
function ensureAnnouncer() {
  if (announcerEl && announcerEl.isConnected) return announcerEl;
  announcerEl = document.getElementById('a11y-status');
  if (announcerEl) return announcerEl;
  announcerEl = document.createElement('div');
  announcerEl.id = 'a11y-status';
  announcerEl.className = 'sr-only';
  announcerEl.setAttribute('role', 'status');
  announcerEl.setAttribute('aria-live', 'polite');
  announcerEl.setAttribute('aria-atomic', 'true');
  document.body.appendChild(announcerEl);
  return announcerEl;
}

export function announceStatus(message, priority = 'polite') {
  const el = ensureAnnouncer();
  if (priority !== 'polite') el.setAttribute('aria-live', priority);
  else el.setAttribute('aria-live', 'polite');
  // clear then set to re-trigger AT (50ms delay per research)
  el.textContent = '';
  setTimeout(() => {
    el.textContent = message;
  }, 50);
}

export function ensureMessagesLog() {
  const m = document.getElementById('messages');
  if (!m) return;
  if (!m.hasAttribute('role')) m.setAttribute('role', 'log');
  // during streaming we keep aria-live off; caller may toggle if needed
  if (!m.hasAttribute('aria-live')) m.setAttribute('aria-live', 'off');
  if (!m.hasAttribute('aria-atomic')) m.setAttribute('aria-atomic', 'false');
  if (!m.hasAttribute('aria-label')) m.setAttribute('aria-label', 'Conversation history');
}
