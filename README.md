# ASM::AGENT — amber CRT chat agent

## What it is

ASM::AGENT is a single-page chat that talks to OpenRouter models through a WAT
engine. Every accepted request gets a fresh web search before the model writes an
answer.

- **One built-in assistant** — ASM::AGENT speaks with a calm, precise computer
  voice. A library holds custom assistants that you can create, edit, duplicate,
  delete, import, and export.
- **Research first** — every request runs a fresh web search before any model
  call, for every assistant. A keyless fan-out of 28 sources feeds the answer.
  Search states are honest: the answer footer says when sources were unreachable
  or when the search was not available.
- **Wording check** — answers from the built-in assistant pass mechanical
  ASD-STE100-style checks. A violation can trigger one corrective rewrite. The
  rewrite must keep every link, code block, number, and quotation. A failed
  rewrite is dropped and the original answer stays.
- **WAT engine** — `src/agent.wat` → `dist/agent.wasm` (zero imports,
  linear-memory I/O) owns streaming, history, and catalog sort/filter. The engine
  is unchanged. Its internals are no longer part of the product surface.
- **Keys are optional for free models** — without a key, free models run through
  the free proxy. Paid models need your OpenRouter key. A new key lasts for the
  browser session by default.

## Quick start

```bash
./build.sh              # wat2wasm src/agent.wat -o dist/agent.wasm  (needs `wabt`)
python3 -m http.server 8000
# open http://localhost:8000
```

1. The first chat starts with the built-in assistant and the automatic model
   ("Automatic — newest free"). Free models run without a key through the proxy.
2. To use paid models, open **Settings**, paste an OpenRouter key (`sk-or-...`),
   and save it. After that, choose the model from the **Model** dialog.
3. Type a question and press **ENTER**. The assistant searches the web first,
   then writes the answer and shows the sources below it.

No install beyond `wabt`. The site is static. `dist/agent.wasm` is the only build
artifact.

## Features

- **Chats** — one transcript, a **New chat** button, and a Chats dialog to open,
  rename, export (`.md` or `.json`), and delete chats. Each chat keeps its own
  model choice and a copy of the assistant instructions it started with. A new
  chat always starts with the built-in assistant; choosing a different assistant
  starts a new chat.
- **Assistant library** — create, edit, duplicate, and delete custom assistants.
  The built-in record is protected. Import and export use
  `{format:'asm-agent.assistants',version:1}`. Import never overwrites the
  built-in assistant or an existing name: a clash becomes a copy, and the file
  size is capped at 256 KB. Custom instructions cannot turn the web search off.
- **Fresh research per request** — a deterministic planner (`js/research.js`)
  builds each search query from local code only, before any bytes leave the
  browser. A greeting gets a harmless generic query. "Continue" or "make it
  shorter" derives its topic from earlier user messages. Private writing and
  translation material never reaches a search. Credentials, email addresses, and
  long quoted spans are stripped at every search boundary. The first lookup runs
  before the first model call and bypasses the session caches.
- **Search budget** — at most 5 research rounds per request, including the first
  mandatory one. When the budget is spent, one final tools-disabled pass forces
  an answer from the results already in the conversation.
- **Honest search states** — a failed source does not block the answer. The
  footer shows "Some sources were unreachable." or "Web search was not available
  for this answer." when those states occur.
- **Stop and retry** — Stop cancels the research and the generation. Retry runs
  the research again and does not duplicate your message.
- **Wording check** — after a built-in answer settles, `js/ste.js` checks the
  prose. The implemented checks are: sentence length over 20 words (rule 5.1),
  a paragraph over six sentences (rule 6.6), a passive-voice heuristic (rule
  3.6), a progressive `-ing` heuristic (rules 3.5 and 3.2), a double negative
  (no Issue 9 rule number; mapped from Global English rule 3.12 by TechScribe),
  and more than one command per sentence (rule 5.2). The check is a partial
  approximation. The licensed ASD-STE100 Issue 9 approved-word dictionary is not
  bundled, so dictionary and word-form checks are not implemented. No certified
  STE compliance is claimed.
- **Model catalog** — the full OpenRouter catalog is always listed, newest
  first. Paid models stay visible without a key but locked ("Your API key
  required"). The automatic mode ("Automatic — newest free") resolves the newest
  free text model once, when the chat is created, and pins it. A catalog refresh
  never changes an existing chat. A manual choice persists per chat. There is no
  automatic fallback on error: use Retry or change the model. The catalog never
  selects a paid model when the free pool is empty.
- **Keys** — a new key is session-only (`sessionStorage asm.openrouter.key`).
  "Remember on this device" persists it to `asm.settings.key`. "Remove key"
  clears both copies and stops further paid rounds in the running turn. A search
  query never carries a key.
- **Storage** — chats, assistants, and settings stay in the browser
  (`asm.chats.v2`, `asm.assistants.v2`, `asm.settings`). A one-time migration
  converts older data, writes a backup, and never deletes the legacy keys.
- **CRT** — amber phosphor theme with scanline, curvature, flicker, and sound
  toggles in Settings.

## Project structure

```
index.html          # chat shell: header, transcript, composer, status line
styles.css          # amber phosphor theme, scanlines/vignette/flicker
js/
  main.js           # boot, turn loop, dialogs, transcript rendering
  bridge.js         # WASM instantiate + turn pipeline (research, rounds, wording pass)
  research.js       # deterministic query planning + privacy minimization
  search.js         # parallel keyless source fan-out
  models.js         # catalog fetch + TLV + sort/filter + newest-free query
  store.js          # v2 persistence: assistants, chats, settings, keys, migration
  persona.js        # built-in assistant instructions + policy preamble
  ste.js            # ASD-STE100-style prose checks + rewrite integrity gate
  guard.js          # hedge pass, budget nudge, tool-argument repair
  markdown.js       # marked + DOMPurify + highlight.js
  a11y.js           # status announcements
src/agent.wat       # hand-written engine (SSE scanner, history arena, catalog)
dist/agent.wasm     # build output (wat2wasm)
worker/api-chat.js  # free-model proxy (Cloudflare Worker)
wrangler.toml       # proxy deploy config
```

## Testing

```bash
./build.sh
node --test test/sources.test.mjs test/guard.test.mjs test/tool-loop.mjs test/research.test.mjs test/store.test.mjs test/migration.test.mjs test/models.test.mjs test/ste.test.mjs
node test/smoke.mjs   # engine smoke: MAGIC, heap, history, TLV, SSE, tool pending
node test/a11y.mjs    # static a11y contract (WCAG 2.2 AA done-bar)
```

`test/a11y.browser.mjs` is the manual browser harness (needs puppeteer and
axe-core). CI (`.github/workflows/ci.yml`) and the Pages deploy run the eight
`node --test` files plus `smoke.mjs` and `a11y.mjs`.

## Notes

- **Deploy** — GitHub Pages serves the repository root as a static site
  (`.github/workflows/deploy.yml`). There is no build step on the host and no
  server-side application.
- **Free proxy** — the Cloudflare Worker in `worker/api-chat.js` forwards
  `:free` model requests to OpenRouter with the Operator Key. It refuses every
  other model (`403 NOT_FREE`). The key is set with
  `wrangler secret put OPENROUTER_KEY`. The Worker allows the GitHub Pages
  origin, `*.pages.dev`, and localhost. See
  `docs/adr/0001-proxy-for-free-models.md`.
- **Paid models** — your own OpenRouter key, read before every request round. A
  key that is changed or removed stops the turn with an honest message.
- **Docs** — product decisions live in `docs/adr/`. The glossary is
  `CONTEXT.md`. CI and deploy run the node-safe suites listed above.
