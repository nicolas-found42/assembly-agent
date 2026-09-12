// a11y.js — polite announcer helper, GH Pages zero-build.
// Dialog focus trapping is native now (<dialog>.showModal()); only the decoupled
// live-region announcer lives here (ADR 0006: no per-token thrashing).

let announcerEl = null;
function ensureAnnouncer() {
  try {
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
  } catch { return announcerEl || null; }
}

export function announceStatus(message, priority = 'polite') {
  try {
    const el = ensureAnnouncer();
    if (!el) return;
    try { el.setAttribute('aria-live', priority !== 'polite' ? priority : 'polite'); } catch {}
    el.textContent = '';
    setTimeout(() => {
      try { el.textContent = String(message ?? ''); } catch {}
      if (priority !== 'polite') {
        setTimeout(() => { try { el.setAttribute('aria-live', 'polite'); } catch {} }, 1000);
      }
    }, 50);
  } catch {}
}
