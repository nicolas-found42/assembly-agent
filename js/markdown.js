// markdown.js — incremental markdown render (marked + DOMPurify + hljs).

const MD = () => window.marked;
const PURIFY = () => window.DOMPurify;

let hljsTimers = new WeakMap();

export function renderMarkdown(container, text) {
  let html;
  try {
    html = MD().parse(text, { gfm: true, breaks: true });
  } catch {
    html = `<p>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>')}</p>`;
  }
  container.innerHTML = PURIFY().sanitize(html, {
    ADD_ATTR: ['target'],
    // Streamed answers are untrusted: model output plus text fetched from
    // arbitrary web pages. DOMPurify's default allowlist keeps <style>, and CSS
    // can fetch (`@import url(...)`) — a payload placed after any prose is parsed
    // into <body> and survives, so a hostile answer could leak the reader's
    // address to a third party and restyle the app around the answer. Markdown
    // answers never need it: highlighting is class-based, layout lives in
    // styles.css. Remote <img>/<video>/<audio> sources and the inline `style`
    // attribute stay allowed on purpose — media is a legitimate answer content,
    // and forbidding inline styles is a broader product decision (recorded in the
    // campaign report, not taken here).
    FORBID_TAGS: ['style'],
  });
}

/** Highlight code blocks; during streaming throttle to 500ms per element. */
export function highlightCode(container, { final = false } = {}) {
  const blocks = container.querySelectorAll('pre code');
  const now = performance.now();
  for (const b of blocks) {
    if (b.dataset.hl === 'done') continue;
    const last = hljsTimers.get(b) || 0;
    if (!final && now - last < 500) continue;
    hljsTimers.set(b, now);
    try { window.hljs.highlightElement(b); } catch {}
    if (final) b.dataset.hl = 'done';
  }
}

/** Append a COPY button to every <pre> (idempotent). */
export function addCopyButtons(container) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'COPY';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.innerText.replace(/^COPY\n?/, ''));
      btn.textContent = 'COPIED';
      setTimeout(() => (btn.textContent = 'COPY'), 1200);
    });
    pre.prepend(btn);
  }
}

/** One-shot render for completed messages. */
export function renderFinal(container, text) {
  renderMarkdown(container, text);
  highlightCode(container, { final: true });
  addCopyButtons(container);
}
