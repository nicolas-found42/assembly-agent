# MattPocock Skills Friction in omp vs Claude Code

**Date:** 2026-08-24  
**Repo:** `assembly-agent`  
**Scope:** All 37 `mattpocock-skills` linked into both harnesses; `~/.omp/agent/managed-skills` (15) excluded per contract.  
**Author:** FrictionResearch (sub-agent, primary sources only)

---

## 1. Method

Primary sources only; every claim cites a file path + line or a URL/command output.

### 1.1 Skill corpus

All `SKILL.md` files under `~/Documents/github/mattpocock-skills/skills/` were read via `find … -name SKILL.md | sort` (37 files, verified `wc -l` = 37). Buckets walked:

- `skills/engineering/*/SKILL.md` (18)
- `skills/productivity/*/SKILL.md` (7)
- `skills/in-progress/*/SKILL.md` (8)
- `skills/misc/*/SKILL.md` (4)

Each file's frontmatter (`name`, `description`, `disable-model-invocation`) and body were scanned for `CLAUDE.md`, `AGENTS.md`, `/plugin`, `claude config`, `claude hooks`, `.claude/skills`, `.claude/settings`, `worktree`, `Skill tool`, `.omp/`, and `managed-skills`. Line numbers below were captured with `nl -ba` / `grep -n`.

### 1.2 omp discovery — canonical paths

- `~/.omp/agent/config.yml` — inspected with `cat` / `grep -n skills`. No `skills.*` block present; file declares `providers`, `modelRoles`, `task`, `lsp`, etc. Absence means default discovery (no `skills.customDirectories` / `skills.ignoredSkills` override) — default discovery is authoritative. Source: `~/.omp/agent/config.yml` (read 2026-08-24, zero `skills.` lines; `grep -n skills` empty).
- `strings /opt/homebrew/Cellar/omp/18.0.4/bin/omp | grep -i skills` — binary strings dump. Evidence lines:
  - `~/.omp/agent/skills` and `~/.omp/agent/managed-skills` as user-authored vs isolated managed stores — `strings` lines: `~/.omp/agent/managed-skills` (×3) and embedded prompt `Managed skills: SKILL.md in isolated ~/.omp/agent/managed-skills; surfaced in future sessions like other skills.` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `~/.omp/agent/managed-skills`]
  - `skills.enableClaudeUser` / `skills.enableClaudeProject` / `skills.enableCodexUser` / `skills.enablePiUser` / `skills.enableAgentsUser` etc. — default-true loaders for each ecosystem's skill dirs. [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `skills.enableClaudeUser`]
  - Skill loaders list: `Load skills from .agent/skills`, `Load skills from .claude/skills/*/SKILL.md`, `Load skills from Claude Code marketplace plugins (~/.claude/plugins/cache/)`, `Auto-generated managed skills from ~/.omp/agent/managed-skills`. [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `Load skills from` prefix]
  - Frontmatter hide gate: `hide: i.frontmatter?.hide === true || i.frontmatter?.disableModelInvocation === true` applied to every skill dir scan. [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, line-group `734753: hide: i.frontmatter?.hide === true …`]
  - Worktree support: `icon.worktree`, `"worktree.base": { description: "Base directory for agent-managed worktrees — … Unset uses ~/.omp/wt.` and `getWorktreeDir` / `getWorktreesDir`. [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `worktree.base`]
- `omp --help | grep -i skills` — flags `--no-skills` and `--skills=<glob>` plus `tasks: ["Modes","Subagents","Isolation","Commands & Skills"]`. [`omp --help` 2026-08-24]
- `ls -l ~/.omp/agent/skills | wc -l` → 37 symlinks, each `→ ~/Documents/github/mattpocock-skills/skills/<bucket>/<name>`. [`~/.omp/agent/skills` ls 2026-08-24, 37]
- `ls -1 ~/.omp/agent/managed-skills | wc -l` → 15 managed skills (ignored per contract). [`~/.omp/agent/managed-skills` ls 2026-08-24, 15]

### 1.3 Claude Code — canonical paths

- `~/.claude/settings.json` — `cat` 2026-08-24: `{"model":"opus[1m]", "enableWorkflows":false, "enabledPlugins":{}, …}`. No skill-specific block; skills arrive via marketplace + `~/.claude/skills`. [`~/.claude/settings.json:1-12`]
- `claude --help | head -n 100` — shows `--plugin-dir`, `--disable-slash-commands` ("Disable all skills"), skill invocation via `/skill-name`, agent persistence options. [`claude --help` 2026-08-24]
- `~/.claude/plugins/marketplaces/claude-plugins-official` — directory tree read with `ls -R`. Marketplace lives here; skills under `plugins/*/skills/*` and `external_plugins/*/skills/*` (e.g. `discord/skills/access/SKILL.md`). Confirms Claude marketplace layout distinct from flat `~/.claude/skills` symlinks. [`~/.claude/plugins/marketplaces/claude-plugins-official` ls 2026-08-24]
- `ls -1 ~/.claude/skills | wc -l` → 37 symlinks, same 37 names as `~/.omp/agent/skills`. [`~/.claude/skills` ls 2026-08-24, 37]

### 1.4 Verification before citation

Every cited path was verified with `ls` or `read` returning non-empty content before its line number was recorded (re-checked with `nl -ba` for exact lines in the five high-friction files). No secondary write-ups. Skill paths cited relative to `~/Documents/github/mattpocock-skills/skills/` with the engineering/productivity/in-progress/misc bucket preserved, e.g. `skills/engineering/code-review/SKILL.md:3`.

### 1.5 Friction rubric

| Rating | Meaning |
|---|---|
| **None** | No harness reference. Runs identically in omp (`task`/`read`/`bash`/`hub`) and Claude Code (`Skill`/`Task`/`Bash`). |
| **Low** | Mentions `CLAUDE.md`/`AGENTS.md` generically or wrappers that delegate; both harnesses honour the same files (omp `skills.enableClaudeUser:true` + `enableAgentsUser:true`). Needs awareness, no rewrite. |
| **Medium** | Claude-flavoured convention baked into steps (e.g. `CLAUDE.md`-first file selection, `worktree + branch` per subagent, `Skill tool` phrasing, or dependency on the tracker doc produced by `setup-matt-pocock-skills`). Works in omp but needs path/tool translation or produces a non-idiomatic artifact. |
| **High** | Mechanically Claude-only: Claude hooks, `claude --bg` / `claude agents`, `.claude/settings.json` PreToolUse schema with no omp equivalent. No drop-in omp mapping. |

---

## 2. Summary counts

| Friction | Count | Skills |
|---|---|---|
| **High** | 2 | `claude-handoff`, `git-guardrails-claude-code` |
| **Medium** | 4 | `implement-spec`, `setup-matt-pocock-skills`, `setup-ts-deep-modules`, `wayfinder` |
| **Low** | 18 | `ask-matt`, `grill-with-docs`, `grill-me`, `handoff`, `implement`, `improve-codebase-architecture`, `loop-me`, `retro`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `writing-for-agents`, `writing-beats`, `writing-fragments`, `writing-shape`, `teach`, `to-questionnaire` |
| **None** | 13 | `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grilling`, `migrate-to-shoehorn`, `prototype`, `research`, `resolving-merge-conflicts`, `scaffold-exercises`, `setup-pre-commit`, `tdd`, `wizard` |
| **Total** | **37** | all symlinks in `~/.omp/agent/skills` and `~/.claude/skills` |

Discovery split:

- **Claude Code:** 37 skills via `~/.claude/skills` (flat symlinks) + marketplace plugins under `~/.claude/plugins/marketplaces/claude-plugins-official`. Verified `ls ~/.claude/skills` = 37. [`~/.claude/skills`]
- **omp:** 37 user-authored skills via `~/.omp/agent/skills` (same 37 symlinks) **plus** 15 isolated managed skills via `~/.omp/agent/managed-skills` (ignored per contract; never edited by user-authored-skill tool). Verified `ls ~/.omp/agent/skills` = 37, `ls ~/.omp/agent/managed-skills` = 15. [`~/.omp/agent/skills`, `~/.omp/agent/managed-skills`] The managed store is omp-only and does not exist in Claude.

Invocation split across all 37 (both harnesses identical — omp correctly preserves the flag):

- **Model-invoked** (`disable-model-invocation` absent, description ⇒ always-loaded pointer): 15 skills — `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `prototype`, `research`, `resolving-merge-conflicts`, `tdd`, `wizard`, `grilling`, `writing-for-agents`, `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`. Each exposes a `description` context pointer every turn (e.g. `skills/engineering/code-review/SKILL.md:3` description). Omp gate: `hide !== true` check; see `hide: i.frontmatter?.hide … || disableModelInvocation` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `734753`].
- **User-invoked** (`disable-model-invocation: true` ⇒ `hide: true`, explicit-only, zero context load unless `/skill:name` or `--skills` filter): 22 skills — `ask-matt`, `grill-with-docs`, `implement`, `improve-codebase-architecture`, `setup-matt-pocock-skills`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `claude-handoff`, `implement-spec`, `loop-me`, `retro`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`, `grill-me`, `handoff`, `teach`, `to-questionnaire`, `wait-what`. Example: `skills/engineering/ask-matt/SKILL.md:4` `disable-model-invocation: true`.

---

## 3. Full table — every skill

| Skill | Bucket | Friction | Why (quote) | Source citation |
|---|---|---|---|---|
| `ask-matt` | engineering | **Low** | Router that names slash commands like `/grill-with-docs` and references `writing-for-agents`/`AGENTS.md` only transitively; no file-write hooks, no harness-specific command. | `skills/engineering/ask-matt/SKILL.md:4` `disable-model-invocation: true`; `skills/engineering/ask-matt/SKILL.md:86` mentions `AGENTS.md` via `writing-for-agents` |
| `code-review` | engineering | **None** | Two-axis diff review (`git diff <fixed>...HEAD` + smell baseline). No mention of `CLAUDE.md`, `AGENTS.md`, hooks, or worktrees. | `skills/engineering/code-review/SKILL.md:3` description; body `grep -n CLAUDE` empty |
| `codebase-design` | engineering | **None** | Pure vocabulary (module/interface/seam/depth/adapter). No harness coupling. | `skills/engineering/codebase-design/SKILL.md:3` description |
| `diagnosing-bugs` | engineering | **None** | Tight feedback-loop discipline (failing test / curl / browser / bisection). Mentions `CONTEXT.md` only, not harness files. | `skills/engineering/diagnosing-bugs/SKILL.md:3` description |
| `domain-modeling` | engineering | **None** | Edits `CONTEXT.md` / `docs/adr/` / `CONTEXT-MAP.md`. No Claude/omp file writes. | `skills/engineering/domain-modeling/SKILL.md:3` description |
| `grill-with-docs` | engineering | **Low** | One-line wrapper `Call the Skill tool twice, for "grilling" and "domain-modeling"` — generic Skill tool phrasing, works via omp `task` or Claude `Skill`. | `skills/engineering/grill-with-docs/SKILL.md:4` `disable-model-invocation: true`; `skills/engineering/grill-with-docs/SKILL.md:7` Skill tool call |
| `implement` | engineering | **Low** | `Use /tdd where possible… then /code-review… Commit your work to the current branch.` No hooks, no worktree, no CLAUDE.md write. Depends only on tracker doc if spec-backed. | `skills/engineering/implement/SKILL.md:4` `disable-model-invocation: true`; `skills/engineering/implement/SKILL.md:9-13` body |
| `improve-codebase-architecture` | engineering | **Low** | Scans for deepening opportunities, calls `codebase-design` for vocabulary, reads `CONTEXT.md`/`docs/adr/`. No harness-specific path. | `skills/engineering/improve-codebase-architecture/SKILL.md:4` `disable-model-invocation: true` |
| `prototype` | engineering | **None** | Throwaway prototype loop (state/UI/logic). Reads optional `CONTEXT.md`, writes prototype dir only. | `skills/engineering/prototype/SKILL.md:3` description |
| `research` | engineering | **None** | Delegates investigation to background agent, writes single `docs/research/*.md`. No harness files. | `skills/engineering/research/SKILL.md:3` description |
| `resolving-merge-conflicts` | engineering | **None** | `Use when you need to resolve an in-progress git merge/rebase conflict.` Pure git. | `skills/engineering/resolving-merge-conflicts/SKILL.md:3` description |
| `setup-matt-pocock-skills` | engineering | **Medium** | Asks `AGENTS.md and CLAUDE.md at the repo root: does either exist?` [`skills/engineering/setup-matt-pocock-skills/SKILL.md:24`], then `If CLAUDE.md exists, edit it. Else if AGENTS.md exists… Never create AGENTS.md when CLAUDE.md already exists` [`skills/engineering/setup-matt-pocock-skills/SKILL.md:76-80`] and writes `## Agent skills` block pointing at `docs/agents/*.md` [`skills/engineering/setup-matt-pocock-skills/SKILL.md:67`]. Claude-first selection is non-idiomatic in omp where `AGENTS.md` (and `.omp/skills`) is primary, though omp loads both via `skills.enableClaudeUser:true` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings]. Also configures issue tracker under `docs/agents/issue-tracker.md` consumed by `to-spec`/`to-tickets`/`triage`/`wayfinder`. | `skills/engineering/setup-matt-pocock-skills/SKILL.md:24`, `:67`, `:76-80`; omp loader `skills.enableClaudeUser` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings] |
| `tdd` | engineering | **None** | `tdd` loop (red-green-refactor) at pre-agreed seams. No harness coupling. | `skills/engineering/tdd/SKILL.md:3` description |
| `to-spec` | engineering | **Low** | `The issue tracker and triage label vocabulary should have been provided to you. If not, tell the user to run /setup-matt-pocock-skills.` — depends on `setup-matt-pocock-skills` output, but writes only a GitHub/local issue, not a harness file. | `skills/engineering/to-spec/SKILL.md:4` `disable-model-invocation: true`; body tracker preamble |
| `to-tickets` | engineering | **Low** | Same tracker preamble as `to-spec`; tracer-bullet slices with `Blocked by` edges. Local tracker writes `.scratch/<feature>/issues/*.md`, GitHub tracker uses native blocking links. No `CLAUDE.md` edits. | `skills/engineering/to-tickets/SKILL.md:4` `disable-model-invocation: true` |
| `triage` | engineering | **Low** | State machine over `needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`. Same tracker preamble. Only writes issue comments/labels and optional `.out-of-scope/*.md`. | `skills/engineering/triage/SKILL.md:4` `disable-model-invocation: true` |
| `wayfinder` | engineering | **Medium** | `Plan a huge chunk of work … as a shared map of decision tickets on your issue tracker` [`skills/engineering/wayfinder/SKILL.md:3`]. Map body stores `Destination / Notes / Decisions so far / Not yet specified / Out of scope`. Tickets carry `wayfinder:<type>` labels (`research`/`prototype`/`grilling`/`task`) [`skills/engineering/wayfinder/SKILL.md:65`]; blocking via native `dependencies/blocked_by` or body fallback [`skills/engineering/wayfinder/SKILL.md:69`]; research tickets `call the Skill tool with "research"` [`skills/engineering/wayfinder/SKILL.md:77`]. Physical layout is tracker-specific (`Consult the tracker doc's "Wayfinding operations" section` [`skills/engineering/wayfinder/SKILL.md:25`]) and resolution fans subagents + `research/<name>` throwaway branches [`skills/engineering/wayfinder/SKILL.md:115`]. In omp this maps to `task` subagents + `~/.omp/wt` worktrees and `gh` sub-issue/dependency API (see `docs/agents/issue-tracker.md Wayfinding operations` and omp's `worktree.base` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings]), but the skill's prose is `Skill tool`-fluent and assumes prompt-driven orchestration; needs translation to omp's `task` tool + `hub`-managed worktrees. | `skills/engineering/wayfinder/SKILL.md:3`, `:25`, `:65`, `:69`, `:77`, `:115`; omp `worktree.base` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings]; `docs/agents/issue-tracker.md` Wayfinding operations |
| `wizard` | engineering | **None** | Generates ephemeral `bash` wizard from `template.sh` (URL-open, secret capture, `.env`/`gh secret` writes). Verifies with `bash -n` + `shellcheck`. No harness files. | `skills/engineering/wizard/SKILL.md:3` description |
| `claude-handoff` | in-progress | **High** | Hard-codes Claude CLI launch: `` launch a background agent …: `claude --bg --name "<descriptive name>" "<handoff summary>"` `` [`skills/in-progress/claude-handoff/SKILL.md:8`] and `the user manages it with `claude agents`` [`skills/in-progress/claude-handoff/SKILL.md:8`], with mandatory `-n/--name` [`skills/in-progress/claude-handoff/SKILL.md:10`]. No omp `task`/`hub` mapping in the text; the omp equivalent is the `task` tool + `hub` process supervision, not `claude --bg`. | `skills/in-progress/claude-handoff/SKILL.md:8`, `:10` |
| `implement-spec` | in-progress | **Medium** | Implements spec as PR on single branch via frontier task graph. Step 3 `Create a branch, and a draft PR` [`skills/in-progress/implement-spec/SKILL.md:23`]; step 4 `Each implementer subagent should work in its own worktree, on its own branch` [`skills/in-progress/implement-spec/SKILL.md:25`]; steps 5–6 merger/frontier, step 9 `Clean up all implementer subagent worktrees` [`skills/in-progress/implement-spec/SKILL.md:35`]. Worktree+branch-per-subagent + `Skill tool` invocation pattern assumes Claude marketplace/plugin task model. In omp the analog is `task` subagents with `isolation: worktree` into `~/.omp/wt` (`worktree.base` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings]) + `gh pr create`; the shape maps but the spellings differ, so prompt-driven agents will call the wrong CLI without adaptation. | `skills/in-progress/implement-spec/SKILL.md:23`, `:25`, `:35`; omp `worktree.base` |
| `loop-me` | in-progress | **Low** | `Grill me about specs for the workflows I want to build, within this workspace` [`skills/in-progress/loop-me/SKILL.md:3`]. Stateful grilling that writes `workflows/*.md` + `NOTES.md`. No `CLAUDE.md` writes or hooks. | `skills/in-progress/loop-me/SKILL.md:3-4` |
| `retro` | in-progress | **Low** | Retrospective that `Call the Skill tool with writing-for-agents` [`skills/in-progress/retro/SKILL.md:11`] and audits `Global AGENTS.md` [`skills/in-progress/retro/SKILL.md:20`] and `CLAUDE.md`/`AGENTS.md` as `pushed to the context window` navigation pointers [`skills/in-progress/retro/SKILL.md:41`]. Both files are honoured in omp (loads `AGENTS.md` always, `CLAUDE.md` via `enableClaudeUser`), so the audit language is portable; the only nudge is that omp's "global AGENTS" lives at `~/.omp/agent/AGENTS.md`-equivalent / `~/.config` while Claude's is `~/.claude/CLAUDE.md`. | `skills/in-progress/retro/SKILL.md:11`, `:20`, `:41` |
| `setup-ts-deep-modules` | in-progress | **Medium** | Deep-module enforcement via `dependency-cruiser` (4 rules + `PACKAGES_ROOT`). Self-contained except final step: `Then add a context pointer to it from the repo's agent-instructions file (CLAUDE.md if present, else AGENTS.md, creating AGENTS.md if neither exists)` [`skills/in-progress/setup-ts-deep-modules/SKILL.md:93`] with completion `Done when: … and the repo's CLAUDE.md/AGENTS.md links to it` [`skills/in-progress/setup-ts-deep-modules/SKILL.md:95`]. Same CLAUDE-first selection as `setup-matt-pocock-skills`; portable because omp honours both pointers, but doc will be CLAUDE-preferring unless overridden. | `skills/in-progress/setup-ts-deep-modules/SKILL.md:93`, `:95` |
| `writing-beats` | in-progress | **Low** | Writing exploit assembling `beats` into a journey; prerequisite/grounding loop. No harness paths. | `skills/in-progress/writing-beats/SKILL.md:4` `disable-model-invocation: true` |
| `writing-fragments` | in-progress | **Low** | Writing explore — appends `fragments` to single markdown file. No harness coupling. | `skills/in-progress/writing-fragments/SKILL.md:4` `disable-model-invocation: true` |
| `writing-shape` | in-progress | **Low** | Writing exploit shaping raw `fragments` into article paragraphs. No harness coupling. | `skills/in-progress/writing-shape/SKILL.md:4` `disable-model-invocation: true` |
| `git-guardrails-claude-code` | misc | **High** | `Set up Claude Code hooks to block dangerous git commands` [`skills/misc/git-guardrails-claude-code/SKILL.md:3`]; asks `install for this project only (.claude/settings.json) or all projects (~/.claude/settings.json)?` [`skills/misc/git-guardrails-claude-code/SKILL.md:24`]; copies to `.claude/hooks/block-dangerous-git.sh` [`skills/misc/git-guardrails-claude-code/SKILL.md:32-33`] and writes `hooks.PreToolUse` `matcher: Bash` into `.claude/settings.json` [`skills/misc/git-guardrails-claude-code/SKILL.md:41-52`] / `~/.claude/settings.json` [`skills/misc/git-guardrails-claude-code/SKILL.md:61-72`]. omp has no `PreToolUse` hooks — safety is via explicit approval mode (`--auto-approve` / `approvalMode`) and `lsp`/`bash` tooling, not a persisted hook file. No omp translation of `block-dangerous-git.sh` is invoked anywhere. | `skills/misc/git-guardrails-claude-code/SKILL.md:3`, `:24`, `:32-33`, `:41-52`, `:61-72`; `~/.claude/settings.json` structure; omp lacks `PreToolUse` (no `hooks.PreToolUse` in `~/.omp/agent/config.yml` or binary strings beyond marketplace description) |
| `migrate-to-shoehorn` | misc | **None** | Replaces `as` with `@total-typescript/shoehorn` in test files only. No harness coupling. | `skills/misc/migrate-to-shoehorn/SKILL.md:3` description |
| `scaffold-exercises` | misc | **None** | Creates `XX-section-name/XX.YY-exercise-name/{problem,solution,explainer}/readme.md` + lint gate `pnpm ai-hero-cli internal lint`. No harness files. | `skills/misc/scaffold-exercises/SKILL.md:3` description |
| `setup-pre-commit` | misc | **None** | Installs Husky + lint-staged + Prettier (`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`/`bun.lockb` detection). Writes `.husky/pre-commit` and `.lintstagedrc`. No `CLAUDE.md` writes; "hooks" here means git hooks, not Claude hooks. | `skills/misc/setup-pre-commit/SKILL.md:3` description |
| `grill-me` | productivity | **Low** | Single line `Call the Skill tool with "grilling".` Wrapper; generic Skill tool phrasing. | `skills/productivity/grill-me/SKILL.md:4` `disable-model-invocation: true`; `:7` body |
| `grilling` | productivity | **None** | Relentless design-tree interview (frontier rounds). No file writes. | `skills/productivity/grilling/SKILL.md:3` description |
| `handoff` | productivity | **Low** | Compacts conversation into temp-dir handoff doc with `suggested skills` section, `reference by path/URL, redact secrets` — harness-agnostic companion to `claude-handoff`. No `claude --bg` in body. | `skills/productivity/handoff/SKILL.md:5` `disable-model-invocation: true`; `:9` suggested skills |
| `teach` | productivity | **Low** | Teaching workspace (`MISSION.md`, `reference/*.html`, `lessons/*.html`, `learning-records/*.md`). No `CLAUDE.md`/`AGENTS.md` writes; instructs to ground teaching in `RESOURCES.md`. | `skills/productivity/teach/SKILL.md:4` `disable-model-invocation: true` |
| `to-questionnaire` | productivity | **Low** | Turns gap into `to-questionnaire-<slug>.md` for async recipient. Three-step grill-the-send loop. No harness coupling. | `skills/productivity/to-questionnaire/SKILL.md:4` `disable-model-invocation: true` |
| `wait-what` | productivity | **Low** | `Re-pitch … in ASD-STE100 … use the ubiquitous language from CONTEXT.md (follow CONTEXT-MAP.md …)` — CONTEXT-aware rephrase, no file writes or harness commands. | `skills/productivity/wait-what/SKILL.md:4` `disable-model-invocation: true` |
| `writing-for-agents` | productivity | **Low** | Reference for `a skill, an AGENTS.md / CLAUDE.md, a doc reached by a pointer` [`skills/productivity/writing-for-agents/SKILL.md:6`]; defines `context pointer` as `a line in AGENTS.md naming a doc` [`skills/productivity/writing-for-agents/SKILL.md:12`] and `Context load is the cost of always-loaded material on the agent's window: an AGENTS.md line, a skill description` [`skills/productivity/writing-for-agents/SKILL.md:24`]. Mentions both files, but the lever (`context load vs cognitive load`, `information hierarchy`, `progressive disclosure`) is harness-agnostic; omp implements the same via `AGENTS.md` (primary) + `CLAUDE.md` compatibility (`skills.enableClaudeUser:true`). Included `SKILL-MECHANICS.md` explains `disable-model-invocation` split. | `skills/productivity/writing-for-agents/SKILL.md:3` description `modifying AGENTS.md or CLAUDE.md`; `:6`, `:12`, `:24` |

---

## 4. Per-skill detailed notes

Grouped by `disable-model-invocation` (explicit-only) then model-invoked, so the context-load budget is visible.

### 4.1 User-invoked (`disable-model-invocation: true` — hide:true in omp)

All 22 skills in this group are `hide: true` in omp (`hide: … || disableModelInvocation` in loader at `strings … 734753/734853`). They do **not** contribute to the always-loaded system prompt; the user (or an explicit `--skills` filter) must invoke them. Behaviour is identical in Claude Code (`/skill:name`). No extra friction from the flag itself — the earlier reporting bug `Fixed /context counting hidden, explicit-only skills (hide: true / disable-model-invocation)` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings `1320893`] confirms the accounting fix shipped in omp 18.0.4.

- **ask-matt** (`skills/engineering/ask-matt/SKILL.md:1-5` frontmatter). Pure router; enumerates the idea→ship flow and when to detour via `prototype`+`handoff`. Only transitive `AGENTS.md` mention via the recommended `writing-for-agents` skill. In omp the same `/ask-matt` dispatch works; `task` handles subagent exploration (theSkill:71+74+77).
- **grill-with-docs** (`skills/engineering/grill-with-docs/SKILL.md:1-7`). Two-line delegator. No body beyond `Call the Skill tool twice…`. The generic Skill tool phrase is the only coupling; in omp that spells `task` with `agent: grilling` / `agent: domain-modeling` or inline `skill` invocation — semantically identical, syntactically one-word translation.
- **implement** (`skills/engineering/implement/SKILL.md:1-15`). 9 lines of policy: "Use /tdd … Run typechecking … use /code-review … Commit … to the current branch." Verbatim portable. The `/clear`-between-tickets pattern from `ask-matt:23` (`/clearing context`) is an available omp slash command as well.
- **improve-codebase-architecture** (`skills/engineering/improve-codebase-architecture/SKILL.md:1-71`). Produces `HTML-REPORT.md` deepening report, then grills. No `CLAUDE.md` write.
- **setup-matt-pocock-skills** — see table Medium. Full audit in §5 Recommendation 1.
- **to-spec / to-tickets / triage** (`skills/engineering/to-spec/SKILL.md:4`, `skills/engineering/to-tickets/SKILL.md:4`, `skills/engineering/triage/SKILL.md:4`). Each opens with `The issue tracker … should have been provided. If not, tell the user to run /setup-matt-pocock-skills.` They emit GitHub issues (or `.scratch` files) using `gh issue create` / `gh issue edit --add-label`. Nothing writes `CLAUDE.md`; the tracker path indirection is the only link to the Medium setup skill.
- **wayfinder** — see table Medium. Lifecycle: chart map (`wayfinder:map` label), create `wayfinder:<type>` children, wire `blocked_by`, fire research subagents, claim via `gh issue edit --add-assignee @me`, resolve via comment+close+append Decisions-so-far. The `wayfinder:map` label and dependency math are tracker-native, not harness-native, so portable once `docs/agents/issue-tracker.md :: Wayfinding operations` is honoured (in `assembly-agent` it already is: `gh api repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by —F issue_id=<db-id>`).
- **claude-handoff** — see table High. The skill's entire second sentence is a literal `claude` CLI invocation. No fallback branch for `task`/`hub`.
- **implement-spec** — see table Medium. The frontier graph model (`Task graph`, `frontier`, `context pointers`) is harness-agnostic; the worktree-per-implementer spellings are not. The mitigation is to run under omp's `task` with `isolation: worktree` (default `auto`) which places copies in `~/.omp/wt`.
- **loop-me** (`skills/in-progress/loop-me/SKILL.md:1-32`). Trigger/checkpoint/brief/push-right vocabulary; writes `workflows/*.md` + `NOTES.md`. No harness writes.
- **retro** — see table Low. Category list explicitly includes `Global AGENTS.md` and the `CLAUDE.md`/`AGENTS.md` pointer-budget lever; omp honours both pointers but global lives at `~/.omp/agent/` rather than `~/.claude/`.
- **setup-ts-deep-modules** — see table Medium.
- **writing-beats / writing-fragments / writing-shape** (`skills/in-progress/writing-*/SKILL.md:4`). All Low; pure writing pipelines (explore→shape→beats). Input is a markdown file, output an article/HTML; no agent instructions file is touched except the fragment appen.
- **grill-me** (`skills/productivity/grill-me/SKILL.md:1-7`). One-line alias to `grilling`.
- **handoff** (`skills/productivity/handoff/SKILL.md:1-16`). Portable cousin of `claude-handoff`: `Save to the temporary directory of the user's OS — not the current workspace.` Includes `suggested skills` section naming `Skill tool` targets generically.
- **teach** (`skills/productivity/teach/SKILL.md:1-140`). Full teaching workspace spec (MISSION, reference, lessons, learning-records, assets). No harness-specific path.
- **to-questionnaire** (`skills/productivity/to-questionnaire/SKILL.md:1-54`). Outputs `to-questionnaire-<slug>.md`.
- **wait-what** (`skills/productivity/wait-what/SKILL.md:1-7`). Rephrase directive only.
- **writing-for-agents** — actually model-invoked (see §4.2) but listed here by the assignment's "pay special attention" bucket; handled below.

### 4.2 Model-invoked (description ⇒ discoverable pointer, no hide)

15 skills omit `disable-model-invocation`. Their `description` is rendered into the system prompt as a context pointer (context load). Omp and Claude both support this; omp renders them under `Skills` and skips `hide:true` ones unless explicitly filtered.

- **code-review / codebase-design / diagnosing-bugs / domain-modeling / grilling / prototype / research / resolving-merge-conflicts / tdd / wizard** — none mention `CLAUDE.md` or hooks. Each is a self-contained recipe (e.g. `tdd: Test-driven development … mentions "red-green-refactor"` at `skills/engineering/tdd/SKILL.md:3`). Verbatim portable.
- **writing-for-agents** (`skills/productivity/writing-for-agents/SKILL.md:1-81` plus `SKILL-MECHANICS.md`). The reference explicitly names both `AGENTS.md / CLAUDE.md` (`:6` Description, `:12` pointer definition). The mechanism it teaches (`context load`, `cognitive load`, `information hierarchy`, `progressive disclosure`, `leading words`, `pruning`) is harness-agnostic. The only friction is the example spellings using `CLAUDE.md` first; in omp prefer `AGENTS.md` first when giving examples (policy already: `skills.enableAgentsUser:true` plus `enableClaudeUser:true` for compat). The companion `SKILL-MECHANICS.md` explains the `disable-model-invocation` split and router skills — directly relevant to the 22/15 split above. Friction Low.
- **git-guardrails-claude-code** — High (Claude hooks only).
- **migrate-to-shoehorn / scaffold-exercises / setup-pre-commit** — None (see table). Note: `setup-pre-commit` writes git `pre-commit` hooks, not Claude `PreToolUse` hooks; no clash with the High skill despite similar name.

---

## 5. Recommendations for omp use

### 5.1 Do

1. **Run `setup-matt-pocock-skills` once and prefer `AGENTS.md`.** The skill writes the same `docs/agents/*.md` trio (issue-tracker, domain, triage-labels) in both harnesses. When it offers the `## Agent skills` block, point it at `AGENTS.md` if both files exist (or let it ask which to create when neither exists — `skills/engineering/setup-matt-pocock-skills/SKILL.md:78`). Omp loads both, but `AGENTS.md` is the idiomatic omp pointer file; `CLAUDE.md` remains a compat alias via `skills.enableClaudeUser:true`. Tie the decision back to `docs/agents/domain.md` navigation pointers.
2. **Use `task` subagents + `hub` worktrees for `implement-spec`/`wayfinder`.** Replace the literal `claude --bg` / "work in its own worktree, on its own branch" spellings with omp's managed isolation (`task` tool, `isolation.mode:auto`, `~/.omp/wt` at `worktree.base` [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings]). The frontier + `blocked_by` math is unchanged; only the CLI changes (`gh api … dependencies/blocked_by` for blocking, `gh pr create` for the draft PR).
3. **Treat `handoff` as the omp counterpart to `claude-handoff`.** When a prompt says "hand off to a fresh background agent," invoke `skills/productivity/handoff/SKILL.md` (saves to OS temp) or `task` with a handoff summary + `suggested skills`. Do not call `claude --bg`.
4. **Keep `writing-for-agents` as the style guide for every docs edit.** Its `context load / cognitive load` and `information hierarchy` checks catch the common mistake of inlining `CLAUDE.md` when a `docs/agents/*.md` pointer would do.
5. **Lean on the 15 model-invoked skills freely; invoke the 22 user-invoked ones explicitly.** The 15 descriptions are always visible to the model; the 22 require `/skill:name` or `--skills <glob>` (`--skills git-*,wayfinder` pattern from `omp --help`). `ask-matt` is the intended router when you don't recall which user-invoked skill fits.

### 5.2 Don't

1. **Don't use `git-guardrails-claude-code` in omp.** It writes `.claude/settings.json` `hooks.PreToolUse` and `.claude/hooks/block-dangerous-git.sh` — neither path is read by omp. Omp's safety boundary is `approvalMode` / `--auto-approve` and the tool allowlist, not a persisted PreToolUse hook. Remove or ignore the skill from `--skills` in omp sessions.
2. **Don't use `claude-handoff` in omp.** Same reason — hard-coded `claude --bg` + `claude agents` management has no omp analog. Prefer `handoff`.
3. **Don't duplicate `AGENTS.md` when `CLAUDE.md` already exists (or vice versa).** Both skills enforce `Never create AGENTS.md when CLAUDE.md already exists (or vice versa); always edit the one that's already there` (`skills/engineering/setup-matt-pocock-skills/SKILL.md:80`). Respect it; duplicate pointers double context load.
4. **Don't edit skills under `~/.omp/agent/skills`.** Those 37 symlinks are user-authored read-only replicas of `~/Documents/github/mattpocock-skills/skills/`. Writable procedure capture belongs in `~/.omp/agent/managed-skills` (`manage_skill` tool) which surfaces as normal skills next session without polluting the 37. [`/opt/homebrew/Cellar/omp/18.0.4/bin/omp` strings, `Managed skills: SKILL.md in isolated ~/.omp/agent/managed-skills`]

### 5.3 Minimal omp invocation

```bash
# run explicitly user-invoked skills (22 are hide:true)
omp --skills "implement,wayfinder,to-spec,to-tickets,triage,setup-matt-pocock-skills" "Continue /implement for #42"

# or inside a session
/skill:setup-matt-pocock-skills
/skill:triage
```

Model-invoked skills (`code-review`, `diagnosing-bugs`, `research`, `prototype`, `tdd`, `grilling`, `writing-for-agents`, …) need no flag — their `description` pointer already fires when the prompt matches.

---

## 6. Primary-source index

| Source | How read | Lines/pages cited |
|---|---|---|
| `~/Documents/github/mattpocock-skills/skills/engineering/ask-matt/SKILL.md` | `read` + `nl -ba` + `grep -n` | `1-90`, `:4`, `:86` |
| `~/Documents/github/mattpocock-skills/skills/engineering/code-review/SKILL.md` | `read` + `grep -n CLAUDE` | `1-87`, `grep` empty |
| `~/Documents/github/mattpocock-skills/skills/engineering/codebase-design/SKILL.md` | `read` | `1-114` |
| `~/Documents/github/mattpocock-skills/skills/engineering/diagnosing-bugs/SKILL.md` | `read` | `1-138` |
| `~/Documents/github/mattpocock-skills/skills/engineering/domain-modeling/SKILL.md` | `read` | `1-74` |
| `~/Documents/github/mattpocock-skills/skills/engineering/grill-with-docs/SKILL.md` | `read` | `1-7`, `:4`, `:7` |
| `~/Documents/github/mattpocock-skills/skills/engineering/implement/SKILL.md` | `read` + `grep -n` | `1-15` |
| `~/Documents/github/mattpocock-skills/skills/engineering/improve-codebase-architecture/SKILL.md` | `read` | `1-71`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/engineering/prototype/SKILL.md` | `read` | `1-26` |
| `~/Documents/github/mattpocock-skills/skills/engineering/research/SKILL.md` | `read` | `1-12` |
| `~/Documents/github/mattpocock-skills/skills/engineering/resolving-merge-conflicts/SKILL.md` | `read` | `1-14` |
| `~/Documents/github/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/SKILL.md` | `read` + `nl -ba` | `1-116`, `:24`, `:67`, `:76-80` |
| `~/Documents/github/mattpocock-skills/skills/engineering/tdd/SKILL.md` | `read` | `1-38` |
| `~/Documents/github/mattpocock-skills/skills/engineering/to-spec/SKILL.md` | `read` | `1-75`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/engineering/to-tickets/SKILL.md` | `read` | `1-105`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/engineering/triage/SKILL.md` | `read` | `1-112`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/engineering/wayfinder/SKILL.md` | `read` + `nl -ba` | `1-128`, `:3`, `:25`, `:65`, `:69`, `:77`, `:115` |
| `~/Documents/github/mattpocock-skills/skills/engineering/wizard/SKILL.md` | `read` | `1-44` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/claude-handoff/SKILL.md` | `read` + `nl -ba` | `1-18`, `:8`, `:10` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/implement-spec/SKILL.md` | `read` + `nl -ba` | `1-35`, `:23`, `:25`, `:35` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/loop-me/SKILL.md` | `read` | `1-32` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/retro/SKILL.md` | `read` + `nl -ba` | `1-44`, `:11`, `:20`, `:41` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/setup-ts-deep-modules/SKILL.md` | `read` + `nl -ba` | `1-102`, `:93`, `:95` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/writing-beats/SKILL.md` | `read` | `1-67`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/writing-fragments/SKILL.md` | `read` | `1-79`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/in-progress/writing-shape/SKILL.md` | `read` | `1-79`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/misc/git-guardrails-claude-code/SKILL.md` | `read` + `nl -ba` + `grep -n` | `1-95`, `:3`, `:24`, `:32-33`, `:41-52`, `:61-72` |
| `~/Documents/github/mattpocock-skills/skills/misc/migrate-to-shoehorn/SKILL.md` | `read` | `1-118` |
| `~/Documents/github/mattpocock-skills/skills/misc/scaffold-exercises/SKILL.md` | `read` | `1-106` |
| `~/Documents/github/mattpocock-skills/skills/misc/setup-pre-commit/SKILL.md` | `read` + `grep -n` | `1-91` |
| `~/Documents/github/mattpocock-skills/skills/productivity/grill-me/SKILL.md` | `read` | `1-7`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/productivity/grilling/SKILL.md` | `read` | `1-28` |
| `~/Documents/github/mattpocock-skills/skills/productivity/handoff/SKILL.md` | `read` | `1-16`, `:5` |
| `~/Documents/github/mattpocock-skills/skills/productivity/teach/SKILL.md` | `read` | `1-140`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/productivity/to-questionnaire/SKILL.md` | `read` | `1-54`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/productivity/wait-what/SKILL.md` | `read` | `1-7`, `:4` |
| `~/Documents/github/mattpocock-skills/skills/productivity/writing-for-agents/SKILL.md` | `read` + `nl -ba` | `1-81`, `:3`, `:6`, `:12`, `:24`; `SKILL-MECHANICS.md` invocation split |
| `~/.omp/agent/config.yml` | `cat` + `grep -n skills` 2026-08-24 | full file; `skills` absence = default discovery |
| `/opt/homebrew/Cellar/omp/18.0.4/bin/omp` | `strings … \| grep -i skills` | `~/.omp/agent/managed-skills` (×3); `skills.enableClaudeUser`/`enableAgentsUser`/`enableClaudeProject`; `Load skills from …` 5 loaders; `hide: … disableModelInvocation` (734753/734853); `worktree.base` / `getWorktreeDir` |
| `omp --help` | `omp --help \| grep -i skills` 2026-08-24 | `--no-skills`, `--skills=<glob>` |
| `~/.omp/agent/skills` | `ls -l … \| wc -l` 2026-08-24 | 37 symlinks → `~/Documents/github/mattpocock-skills/skills/*/*` |
| `~/.omp/agent/managed-skills` | `ls -1 … \| wc -l` 2026-08-24 | 15 (ignored per contract) |
| `~/.claude/settings.json` | `cat` 2026-08-24 | `1-12` |
| `claude --help` | `claude --help \| head -n 100` 2026-08-24 | `--plugin-dir`, `--disable-slash-commands` |
| `~/.claude/plugins/marketplaces/claude-plugins-official` | `ls -R` 2026-08-24 | marketplace layout `plugins/*`, `external_plugins/*/skills/*` |
| `~/.claude/skills` | `ls -1 … \| wc -l` 2026-08-24 | 37 symlinks |

No secondary sources. All paths verified with `ls`/`read` before citation (per acceptance criterion). Any skill not listed above was verified absent of `CLAUDE.md`/`AGENTS.md`/hook/worktree strings via `grep -n` returning empty.

---

## 7. Acceptance checklist

- [x] File exists at `docs/research/mattpocock-omp-friction-2026-08-24.md` under `assembly-agent` repo.
- [x] Table covers all 37 skills with per-row citations (`[skills/.../SKILL.md:<line>]`).
- [x] Distinguishes omp 37+15 vs Claude Code 37 (discovery split, managed store ignored, symlinks counted with `ls`).
- [x] Every row cites primary source file path + line or command output.
- [x] No fabricated paths; each file verified with `ls`/`read` before cite.

---

*Follow-ups:* if `implement-spec`/`wayfinder` worktree friction is to be eliminated rather than documented, patch those two SKILL.md bodies to spell the omp `task`+`hub`/`~/.omp/wt` analog beside the `claude --bg` spelling (keep Claude path as alt). `git-guardrails-claude-code` and `claude-handoff` should remain Claude-only — no sensible omp port.
