# ADR 0012: Adopt the chat product (assistant, research first, wording check)

Date: 2026-09-14
Status: Accepted

## Context

ADR 0011 adopted the Command Line shell for a product built on presets and
sessions: colon commands, a shell prompt, command suggestions, MEM/WAT/status
inspectors, and a status line with SESSION, PRESET, MEM, MSG, and TOK/S
telemetry. The shell worked as an operator console, but it shaped the product
around its own machinery.

The product direction changed to a chat assistant that answers with sources.
Three problems made the old shape wrong:

- Presets were global and copied into sessions at creation. Editing a preset had
  no defined effect on existing sessions, and no record showed which preset a
  session had started with.
- `localStorage` held the API key by default together with sessions and the
  active model. There was no record shape that could bind a conversation to an
  assistant.
- Search ran inside the model tool loop. Nothing guaranteed that a search
  happened at all, and the shell exposed the loop as product surface (tool
  cards, MEM, TOK/S). The answer path had no wording contract.

The v2 work also had to keep the shipped static deployment, the free-model
proxy, and the WAT engine unchanged.

## Decision

Replace the Command Line shell with a chat product. The pivot, the research
guarantee, the wording policy, storage v2, selection semantics, and the
credential rules are one decision because they interlock.

**Product pivot.** The surface is a chat: header, scrolling transcript,
composer, and four native dialogs (Chats, Assistant, Model, Settings). Colon
prefixes, the shell prompt, command suggestions, and the memory/WAT/status
inspectors are removed; colon-prefixed text is ordinary chat content. The
MEM/MSG/TOK/S telemetry is removed. UI copy says chat and assistant. This
supersedes the Command Line shell of ADR 0011.

**Assistants and chats.** One built-in assistant, `ASM::AGENT`, always exists
and cannot be edited or deleted. A library holds custom assistants; the user can
create, edit, duplicate, delete, import, and export them. Export is
`{format:'asm-agent.assistants',version:1}` and contains persona data only.
Import validates the format, caps the file at 256 KB, skips duplicates, never
overwrites the built-in record, and turns a name clash into a copy. Every chat
bakes a snapshot `{assistantId, assistantRev, assistantName, instructions}` and
a model choice. A new chat always starts with the built-in assistant; choosing
a different assistant starts a new chat. Editing an assistant affects future
chats only. An older chat can take a newer rev of the same assistant through
"Update instructions". Deleting an assistant keeps its chats usable on their
snapshots. Custom instructions cannot disable the research step.

**Mandatory fresh research.** Every accepted user request runs a fresh external
web search before any model call, for every assistant. The first lookup calls
the `js/search.js` fan-out with `fresh: true`, so the `sessionStorage` caches do
not apply to it. Query planning is deterministic local code
(`js/research.js` `planQuery`): a greeting gets a harmless generic query, a
"continue" or "shorten" message derives its topic from earlier user messages,
and private writing or translation material never reaches a query.
`minimizeQuery` strips credentials, email addresses, and long quoted spans at
every search boundary. `MAX_RESEARCH_ROUNDS` is 5 and counts the initial lookup
inside the same cap. When the budget is spent, one tools-disabled final pass
nudged by `BUDGET_NUDGE` forces an answer from the results already in the
conversation. Search failure, an empty result, and a partial result stay honest:
the answer footer shows "Some sources were unreachable." or "Web search was not
available for this answer." Stop cancels the research and the generation with no
late requests and no fabricated answer. Retry runs the research again and does
not duplicate the user message.

**Wording check.** After a built-in answer settles, `js/ste.js` `checkProse`
runs rule-linked ASD-STE100 checks. A violation can trigger at most one
tools-disabled corrective rewrite by the same model (bridge `opts.correct`).
`integrityPreserved` gates acceptance: every link target, code block body,
digit token, and quoted span must survive. A failed, aborted, or rejected
rewrite keeps the original answer, and a superseded draft never enters the model
context. Custom assistants are exempt. Interface copy is checked in development
and tests, not at runtime. The implemented checks are:

- sentence length over 20 words (rule 5.1; the descriptive limit of 25 words,
  rule 6.3, is not used);
- a paragraph over six sentences (rule 6.6);
- a passive-voice heuristic, be-verb plus past participle (rule 3.6);
- a progressive `-ing` heuristic (rule 3.5 with rule 3.2);
- a double negative (Issue 9 has no rule number for this; attributed through
  the TechScribe mapping of Global English rule 3.12);
- more than one command per sentence, from a fixed verb list (rule 5.2).

The checks are a partial approximation, not a certification. The licensed
ASD-STE100 Issue 9 approved-word dictionary is not bundled: ASD offers a free
copy on request, but the module does not redistribute the standard. Therefore
the dictionary checks (rule 1.1), part-of-speech and verb-form approvals (rules
1.2, 3.1), the technical noun and verb categories (rules 1.5 to 1.13), and the
word-count rules 8.4 to 8.7 are only partially approximated or not implemented.
The edition consulted is Issue 9 (January 2025) through the public
asd-ste100.org pages. No document in this repository claims certified STE
compliance.

**Storage v2 and migration.** The store owns every read and write of the
`asm.*` keys. Storage keys: `asm.chats.v2`, `asm.activeChat.v2`,
`asm.assistants.v2`, `asm.settings` (`{crt, rememberKey, key}`),
`asm.migration.v2`, `asm.legacy.backup.v1`, and sessionStorage
`asm.openrouter.key`. A message is
`{role:'user'|'assistant', content, sources?:[{title,url,snippet}], modelUsed?,
wording?:'checked'|'original'}`. `js/store.js` `migrateIfNeeded` runs once when
a legacy key exists and the marker is absent. It is idempotent and writes the
marker last. The backup `asm.legacy.backup.v1` is written first and has the
settings key stripped; the assistants, chats, and settings follow. Legacy
preset templates are matched by content, not by name: an
unchanged BASIC AGENT becomes the built-in assistant, with a one-time notice;
unchanged RESEARCH ANALYST, ASSEMBLY GURU, and TERSE CODER are retired, their
chats keep the inline instructions, and they are not added to the library; an
edited or unknown prompt becomes a custom "(imported)" assistant, deduplicated
by text. Migration drops role-0 records, turns tool results into sources on the
adjacent answer, keeps user and assistant text verbatim, and preserves
conversation ids, titles, and timestamps. A chat takes the legacy
`asm.activeModel` with `provenance:'legacy'`; an empty value leaves the chat
without a model, and the UI asks the user to choose. Malformed records are
skipped and counted. A quota failure leaves the legacy data untouched.

**Selection semantics.** The full catalog is always listed, newest first
(`LATEST` descending). Paid models stay visible to anonymous users but locked
with "Your API key required" and an Add key action; `checkAccess` enforces the
gate at request construction, not only in the UI. The automatic mode
("Automatic — newest free") resolves `newestFreeModelId()` once, when the chat
is created, and pins it. Candidates must be free, priced `:free`, and produce
text; the greatest `created` wins, with a deterministic id tie-break. A catalog
refresh never changes an existing chat, and a manual choice persists per chat.
There is no automatic fallback on error: the user gets Retry and Change model
controls. The catalog never selects a paid model when the free pool is empty.

**Credential policy.** A new key is session-only and lives in sessionStorage
(`asm.openrouter.key`). "Remember on this device" is an explicit opt-in that
persists the key to `asm.settings.key`. Removing a key clears both copies and
aborts further paid rounds in the running turn: the bridge re-reads the key
before every round, and a changed or removed key stops the turn with an honest
message. A search query never carries a key. Legacy persisted keys migrate to a
session-only key once, with a notice. Keys never enter chats, assistants,
exports, or the migration backup.

**Engine and tests.** `src/agent.wat` and `dist/agent.wasm` are retained
unchanged: the streaming SSE scanner, the history arena, and the catalog
sort/filter. WAT internals are no longer product surface. `js/sessions.js` is
removed; `js/store.js` (persistence + migration), `js/persona.js` (built-in
instructions + policy preamble), `js/research.js` (query planning +
minimization), and `js/ste.js` (prose checks + rewrite integrity) are new. CI
and the Pages deploy run all eight `node --test` suites (`sources`, `guard`,
`tool-loop`, `research`, `store`, `migration`, `models`, `ste`) plus
`node test/smoke.mjs` and `node test/a11y.mjs`; `test/a11y.browser.mjs` stays a
manual browser harness.
_Update (2026-09-15): the required gate is `npm run verify` and its membership is
declared in `test/manifest.json`, not in a hand-written file list. The manual
browser harness is superseded by the required Playwright suite in `test/browser/`
(chromium, staging `_site/` against fixtures); `test/a11y.browser.mjs` remains only
as a `live`-class probe that can never gate a pull request (ADR 0013)._

_Also 2026-09-15: rendering is a security boundary, not a formatting detail. The
required browser suite proved that DOMPurify's defaults kept a `<style>` element
when it followed any prose, and that the browser then fetched the remote
stylesheet it named — a hostile answer could leak the reader's address to a third
party and restyle the app around itself. `renderMarkdown` in `js/markdown.js` now
passes `FORBID_TAGS: ['style']`. Remote `img`/`video`/`audio` sources and the
inline `style` attribute are deliberately still allowed and remain a recorded
product decision (see the campaign report's known risks): the inline attribute
can still name a remote `url()`, and forbidding it is a broader content decision
than this campaign took._

## Consequences

- The Command Line shell of ADR 0011 is superseded: `:` commands, the shell
  prompt, command suggestions, MEM/WAT/status inspectors, and TOK/S telemetry
  are gone. Colon-prefixed text is ordinary chat content.
- ADR 0006's accessibility bars still hold. The static harness
  (`test/a11y.mjs`) and the required Playwright accessibility suite
  (`test/browser/a11y.spec.mjs`, staging `_site/` against fixtures) target the
  chat DOM: transcript `role="log"`, the status announcer, the composer, native
  `<dialog>` overlays, coarse-pointer targets, and reduced-motion rules. The old
  manual `test/a11y.browser.mjs` harness remains only as a `live`-class probe and
  can never gate a pull request (ADR 0013).
- The static deployment stays static. The free-model Worker from ADR 0001 keeps
  serving `:free` requests with the Operator Key and refuses every other model.
  Search stays keyless and client-side (ADR 0004, 0008, 0009); no new Proxy
  route ships.
- The research guarantee removes the old failure mode where a model could answer
  without searching. Custom assistants cannot opt out.
- The wording policy creates an explicit coverage gap: the licensed Issue 9
  dictionary is not bundled, so the check is an approximation. Documentation
  states the gap and claims no certification.
- The v1 keys are never deleted: a user can inspect the backup
  (`asm.legacy.backup.v1`), and a failed migration retries on the next boot.
- Product documentation changes with the pivot: README, CONTEXT, and this ADR
  describe the chat behavior. The WAT memory map and the command surface are no
  longer product documentation.
- The wired-in guards from the shell product survive: the Hedge Pass, tool
  argument repair, and the per-round key check.
