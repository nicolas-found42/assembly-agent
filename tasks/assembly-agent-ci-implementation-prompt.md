# Implementation brief: Assembly Agent CI, GitHub Actions, and release verification

You are the implementing coding agent for:

https://github.com/nicolas-found42/assembly-agent

Implement the complete CI and GitHub Actions improvement campaign described below. This is an implementation assignment, not another audit, a proposal, or a set of recommendations. Inspect the current repository, make the changes, run the checks, investigate failures, and deliver reviewable code with evidence.

The goal is that a passing required check proves the packaged chat application works, protects the WAT/WASM engine and free-model proxy, and authorizes deployment of only the artifact actually verified.

## 1. Execution contract and authority

Work autonomously on repository-side implementation. Resolve ordinary engineering decisions from the code, documented product contracts, and current primary-source documentation. State necessary assumptions and continue rather than stopping for preference questions.

Read the applicable AGENTS.md instructions first. Use the repository's existing issue, branch, testing, and documentation conventions. Use available research, TDD, implementation, and code-review skills when appropriate; their absence is not a reason to stop. Install justified development dependencies instead of compromising the test design to avoid dependencies.

Preserve unrelated working-tree changes. Work on a feature branch or isolated worktree. Commit cohesive changes and, where the existing workflow authorizes it and access permits, open a pull request. Keep integration and PR creation under one coordinating agent. Never push directly to main, bypass branch protection, force-push unrelated work, merge your own campaign automatically, or manually deploy to production without separate authorization. Preserve the existing normal Pages deployment after an authorized merge.

Repository-side implementation includes working configuration and scripts for administration-dependent features. Read live GitHub and Cloudflare settings when access permits. If an operation needs unavailable credentials, repository-owner permissions, billing changes, or protected-environment approval, finish every independent part and provide exact, minimal activation instructions. Mark that operation as pending, not complete. Do not request secret values in chat, invent credentials, or weaken a protection to get past it.

For settings changes, prefer an idempotent, inspectable script with dry-run as its default. Preserve unrelated settings. A denied settings API call means "not verified," not "disabled" or "absent."

If subagents are available, parallelize bounded work such as browser tests, Worker tests, dependency review, and workflow analysis in separate worktrees. Assign file ownership, share the agreed test/artifact interfaces, and serialize integration. The coordinating agent owns final validation and completeness. Do not let multiple agents independently modify the lockfile, required-check names, or deployment graph.

Keep a compact requirements/evidence checklist using R01 through R09 below. For each requirement, record implementation paths, acceptance evidence, remaining risk, and one status: implemented and verified; implemented but externally unverified; or blocked with an exact prerequisite. A plan, empty workflow, placeholder assertion, or permanently skipped test does not satisfy a requirement.

## 2. Starting context: verify before editing

A previous source/configuration review examined main at:

332ed511e3fbecce22d89032cc4b9ec9fc499339

That review did not execute the tests. Treat its observations as leads, not proof of the current repository state or live settings. Work from current main; do not reset to the reviewed commit.

The reviewed snapshot had:

- A static browser application, with src/agent.wat compiled by build.sh into dist/agent.wasm, browser JavaScript under js/, and a separate Cloudflare Worker at worker/api-chat.js.
- A PR workflow and a Pages workflow, both maintaining their own list of eight Node test files plus smoke.mjs and static a11y.mjs.
- Three existing regression scripts missing from those lists: test/decode-escapes.mjs, test/parallel-toolcalls.mjs, and test/free-proxy.mjs.
- A substantial manual test/a11y.browser.mjs harness that could exit successfully when browser prerequisites were missing, look in developer-local directories, and use live network-dependent outcomes.
- Browser dependencies loaded through hard-coded CDN URLs, while Dependabot monitored only GitHub Actions.
- A build step that compiled WASM but did not assemble a clean production site; Pages uploaded the repository root with path: .
- Moving runner/tool defaults and major-version Action tags, deployment write permissions on a combined build/test/deploy job, and no explicit deployment timeout.
- An ADR describing a protected main branch and a required build-and-test check. Inspect effective rules and check contexts; do not infer that every documented protection remains configured.
- Pages deployment automation but no Worker deployment workflow in the inspected workflow directory. External Cloudflare deployment automation was not established.
- A Worker /api/health route that reported basic liveness, not successful authenticated upstream generation.

Read current workflows, dependency files, build scripts, all test entry points, the browser harness, runtime dependency loading, Worker configuration, README, applicable CONTEXT.md sections, and relevant ADRs. The earlier review may be supplied as ci-actions-review-2026-09-14.md; read it when available, but do not assume that downloadable report was committed to the repository. This brief is self-contained.

Inspect recent successful and failed Actions runs, effective branch/ruleset requirements, Pages configuration, environments, Actions permissions, dependency/security settings, and existing deployment integration where readable. Record the exact starting commit and distinguish observations, inferences, and inaccessible settings.

Before changing test infrastructure, run the existing documented checks and each omitted regression script separately. Capture commands, versions, exit codes, and failures. Establish whether failures are product bugs, obsolete fixtures, missing prerequisites, or genuine external dependencies. Never make an assertion weaker merely because the baseline is red.

Verify current versions, compatibility, advisories, Action SHAs, and platform syntax using official documentation, release repositories, and first-party APIs. Do not copy version guesses or supposedly current action references from this brief. Record only consequential research and decisions, not a transcript of every lookup.

Completion: a reproducible baseline and a concrete implementation sequence exist, with no ambiguity about what was actually executed.

## 3. Product and scope boundaries

Keep the application deployable as a GitHub Pages static site under /assembly-agent/. Preserve the WAT engine and the separate Worker architecture. Adding package.json, a lockfile, build helpers, testing tools, and locally served browser libraries is allowed. A framework migration, production Node server, new hosting platform, or unrelated redesign is outside this campaign.

Preserve the current non-programmer chat product, including its amber CRT identity. CI diagnostics belong in reports and artifacts, not the product interface. Keep obsolete command syntax, Assembly internals, memory inspectors, and developer telemetry out of the user experience.

Use current accepted product documents to confirm these contracts:

- Each accepted request attempts fresh, privacy-minimized research before any model call, including requests using a custom assistant. Failures and partial results receive honest states.
- Private writing/translation material, keys, credentials, and other protected spans are excluded from search requests according to the implemented privacy policy.
- Research budgets, final tools-disabled answers, Stop, Retry, and no-duplicate-message behavior remain intact.
- Paid models stay visible but locked without a user key. Automatic selection chooses the intended newest free model and pins the choice to the chat, without silently falling back to paid models.
- Session-only keys remain the default; persistence requires explicit opt-in. Removing a key clears the intended stores and prevents subsequent paid rounds.
- The built-in assistant remains protected. Custom assistants, import/export restrictions, chat instruction snapshots, chat management, and storage migration retain their documented behavior.
- The built-in wording check remains the documented partial ASD-STE100-style approximation. Preserve its bounded rewrite and integrity checks; do not claim certified compliance or require a licensed dictionary this repository does not possess.
- Markdown rendering remains sanitized, and the proxy continues enforcing its free-only contract with the intended streaming behavior.

Fix actual product defects exposed by the new tests with focused regression tests. Explain behavior-changing security fixes explicitly. Do not silently redesign origin policy, model routing, storage, or conversation behavior under the label of test maintenance.

## 4. R01 - Complete and centrally define required regression coverage

Create a single authoritative local verification interface used by developers and Actions. Prefer package scripts backed by small repository-owned runners. Keep workflow YAML declarative; test membership and test logic should not be duplicated across workflows.

Include all current required Node suites, engine smoke tests, static accessibility checks, and these omitted regressions or their clearly mapped successors:

- test/decode-escapes.mjs
- test/parallel-toolcalls.mjs
- test/free-proxy.mjs

Read their assertions before changing them. Preserve the captured-stream regressions and proxy boundary checks. If a fixture contradicts an accepted product decision, document the conflict and repair it against that decision rather than merely changing the expected result.

Implement enforceable test classification. Either use predictable, validated naming conventions or a small manifest separating required offline tests, required browser tests, Worker-runtime tests, scheduled cross-browser tests, and live operational probes. Identify helpers/fixtures separately. Every runnable test entry point must belong to a class. Newly added unclassified tests, missing manifest entries, duplicate entries, nonexistent paths, and accidental inclusion of live probes in offline discovery must fail validation.

Maintain process isolation where suites mutate browser globals or mock fetch. Avoid order-dependent success caused by importing all legacy scripts into one process. Preserve failures through subprocesses, pipelines, reporters, and shell wrappers. Use the Node test runner where it fits, but do not require a wholesale rewrite of useful standalone assertions just to standardize their appearance.

Required test classes must report executed tests and skips. Missing dependencies, zero tests, accidental .only, unintended .skip/.todo, and retry-only success must be detectable. Any deliberate exception needs a narrowly scoped reason, owner, and expiration or review condition. Do not hard-code an old total that prevents adding tests; validate expected suite coverage and justified minimum execution instead.

Acceptance evidence: demonstrate that a new unclassified dummy test is rejected; each formerly omitted regression executes; an intentional assertion failure causes nonzero verification; required tests cannot accidentally call live providers. Remove deliberate faults after the proof.

## 5. R02 - Required, deterministic browser and accessibility verification

### 5.1 Bring existing coverage into CI first

Install project-local, lockfile-controlled browser and accessibility tooling. Eliminate dependence on /tmp/pptr, sibling projects, a personally installed Chrome executable, or runtime CDN retrieval of axe.

Make the existing browser harness a real required check before removing it. In required mode, missing browser binaries, missing axe, server startup failure, absent required checks, and unexpected network calls must fail. A separate explicit local diagnostic mode may allow skips, but CI must never select it accidentally.

For the growing suite, prefer Playwright Test unless inspection reveals a concrete compatibility reason not to. A direct migration is acceptable when an assertion-by-assertion mapping proves that existing coverage survives. Retain equivalent accessibility, keyboard, viewport, composer, and obsolete-UI assertions. Do not leave two competing browser stacks indefinitely without a documented need.

Pin compatible browser-test and browser versions through the chosen supported installation mechanism. Install only required browsers in PR jobs. Implement scheduled Firefox and WebKit coverage as part of this campaign, not an unspecified future task.

### 5.2 Exercise the packaged app and control its network

Serve the staged production artifact under /assembly-agent/, not just the repository root or /. Build/test server startup must use an owned process, bounded readiness checks, explicit ports or controlled dynamic allocation, correct MIME types, and cleanup. Never silently reuse an unrelated local server.

Use synthetic fixtures for catalog responses, search providers, streamed model answers, errors, and storage. Fail unexpected external requests, including requests that the application catches internally. Test success, partial-search, search-unavailable, rate-limited, and offline outcomes as separate deterministic cases.

Preserve the real application integration: the browser loads its actual JS, WASM, rendering, and storage paths. Prefer network interception or a local fixture server over replacing product modules with test doubles. Required tests should not need real API keys, a real model, or available external search services.

Use an actual controllable streaming mock where streaming order, cancellation, or chunk delivery is under test. A buffered canned response is not evidence that incremental rendering or mid-stream cancellation works. Control chunk release with events rather than fragile arbitrary sleeps.

Keep production artifacts free of test-only routes, fixture payloads, bypass flags, debug endpoints, or conditional code that makes the product behave differently merely to pass CI.

### 5.3 Cover observable product journeys

Add or retain meaningful end-to-end cases for:

1. Initial load: engine initializes; the catalog appears; the expected free model is selected; the composer works; no uncaught errors, unhandled rejections, broken imports, or missing assets occur.
2. Request ordering: a fresh search starts before the first model call. Repeat a question, use Retry, switch assistants, and exercise follow-up requests so caches cannot silently bypass the mandatory search.
3. Search privacy: distinctive synthetic sensitive markers never appear in outgoing search URLs, request bodies, headers, or fixture-server logs. Test private writing and translation inputs without using real personal information.
4. Search results: successful, partial, empty, and unavailable outcomes render their documented source/footer states. Avoid allowing either success or error to satisfy the same test.
5. Budgets and wording: verify the search-round limit, tools-disabled final pass, bounded corrective rewrite, and preservation of links, code, numbers, and quotations through the real integration, with detailed combinatorics kept in unit tests.
6. Stop/Retry: cancel during search and streaming; prevent late updates from the old turn; re-enable the composer; retry with fresh research; keep exactly one relevant user message. Check switching chats during an interrupted turn where supported.
7. Models/keys: paid choices remain visible and locked without a key; free routing uses the intended proxy; a dummy user key enables direct routing; removal prevents subsequent paid requests. Verify session-default and explicit remember behavior without exposing keys in output.
8. Assistant library: built-in protection; create/edit/duplicate/delete; valid import/export; invalid schema and oversized import handling; duplicate-name behavior; and existing-chat instruction snapshots after library edits.
9. Chats/storage: new/open/rename/delete/export; independent model choices; migration of supported legacy storage; repeated migration safety; and no key leakage into exports or migration backups.
10. Rendering/security: formatted prose, links, long code blocks, copying, hostile markup, and incomplete streamed Markdown, without script execution or layout failures.

Choose representative browser cases at integration boundaries rather than reproducing every unit test through the UI. Keep a coverage map linking these contracts to the tests that prove them.

### 5.4 Accessibility and visual checks

Retain axe scans for the main view and each dialog, keyboard navigation, focus containment and restoration according to the intended contract, Escape behavior, composer Enter/Shift+Enter, status announcements, narrow viewports, zoom-equivalent layouts, usable targets, reduced motion, and horizontal-overflow checks.

Fail critical/serious accessibility violations and all explicitly required contract violations. Triage lower-impact findings with a reviewed baseline; prevent newly introduced unapproved findings rather than silently ignoring them. Automated checks are not a claim of complete accessibility compliance.

Create screenshot baselines for desktop chat, narrow mobile chat, each major dialog, a long answer/code block, and representative error/search states. Fix fonts, browser, OS environment, viewport, data, clock, and animations. Preserve CRT styling; control animation timing rather than deleting the visual identity.

Establish and inspect initial baselines. Keep baseline updates explicit, committed, and reviewable. CI must never run an automatic "accept all screenshots" path. Capture expected/actual/diff artifacts for failures. Default retries to zero in deterministic PR tests; any diagnostic retry must remain visible as a flake and follow an explicit gating policy.

Acceptance evidence: missing browser/axe and unexpected external traffic fail; every required browser class executes against the staged base path; critical journeys pass; a deliberate visual or accessibility defect is detected; the deterministic suite passes repeated clean runs.

## 6. R03 - Lock, update, and verify the actual browser dependencies

Introduce or refine package.json and the package-manager lockfile. Use reproducible installation in CI. Separate runtime libraries from development tooling, and ensure the runtime libraries deployed are derived from that lockfile.

The reviewed HTML referenced Marked 12.0.2, DOMPurify 3.1.6, and highlight.js CDN assets 11.9.0. Those are historical observations, not recommended versions. Recheck the current HTML and current upstream releases. The previous review identified DOMPurify advisory GHSA-v2wj-7wpq-c8vv; verify it and other relevant advisories before selecting maintained, compatible versions. An affected version is not proof of an application-specific exploit, and a version bump alone is not proof of safe integration.

Prefer copying the required browser-ready library files into the staged site's vendor/ directory, preserving notices and licenses. Update HTML and the actual rendering integration to use those copies. Avoid bundling all development dependencies or introducing a framework simply to manage three libraries. Verify current library distribution formats and APIs rather than assuming that a newer package retains the old UMD path or global.

For fonts and any other runtime CDN asset, choose a deterministic approach consistent with licensing and the production design. Prefer self-hosted, licensed assets when practical. Inventory deliberate remaining external assets and their fallback behavior. Visual tests must use a reproducible font source that represents the intended product rendering.

Enable Dependabot for npm and GitHub Actions. Keep update groups small enough to review: distinguish runtime libraries, development tooling, and Actions when beneficial; avoid one unreviewable group for unrelated major upgrades. Retain security updates and a documented schedule. Do not add unconditional auto-merge or bypass the required checks.

Add dependency checks that connect the lockfile, staged vendor files, and generated HTML references. Detect a stale CDN URL, an independently hard-coded version, a missing vendor file, an unexpected runtime dependency, and vendored bytes inconsistent with the installed package.

Add hostile-markup fixtures through the actual rendering/sanitization path: event handlers, script-like content, dangerous URL schemes, malformed HTML/Markdown, SVG/MathML cases relevant to upstream advisories, and incomplete streamed content. Assert that dangerous behavior is absent and ordinary links/code still work. Use inert local fixtures, not external exploit hosts.

Introduce a vulnerability policy that identifies the finding, affected version, fix or mitigation, and disposition. Block unacceptable newly introduced vulnerabilities; address the known affected runtime dependencies. Any exception must be specific, justified, owned, and dated. Registry/advisory service failure must be reported as an unavailable scan, not as zero vulnerabilities. Avoid blanket exclusions and force-upgrading unrelated dependencies without compatibility tests.

If the manifest changes Node module interpretation, inspect every affected .js/.mjs/.cjs script and Worker import. Confirm that tooling changes do not silently alter runtime module behavior.

Acceptance evidence: a clean install builds a site whose libraries match the lockfile; Dependabot recognizes both dependency surfaces; sanitized rendering tests pass; a deliberately stale dependency reference is rejected; licenses/notices are present.

## 7. R04 - Assemble, verify, and promote an immutable site artifact

Keep the WAT compilation step, but add a clean production staging step. A reasonable output is:

```text
_site/
  index.html
  styles.css
  js/
  dist/agent.wasm
  vendor/
  assets/                 # only when needed
  THIRD_PARTY_NOTICES.*
  build-info.json
```

Adapt names to the existing repository, but use an explicit allowlist of runtime assets. The output must contain everything needed by the static site and nothing included merely because it lives in the repository.

Exclude tests, fixtures, scripts, research/agent documentation, Worker source/configuration, .git, .github, node_modules, environment files, credentials, development reports, and unexpected symlinks. Treat source maps as a deliberate reviewed choice. Preserve .nojekyll or other required Pages files where needed. Do not change the upload directory to dist/ alone: the HTML, CSS, and browser JavaScript must also be packaged.

Clean only the generated directories owned by these scripts. Make path handling safe against traversal and escaping symlinks. A build must not accidentally delete unrelated work or copy host-local files into the artifact.

Generate build information including the actual source commit, selected toolchain versions, dependency/lockfile identity, and WASM checksum. Use deterministic metadata where practical; keep run timestamps in the CI report when they would unnecessarily make identical builds differ. Define the manifest/hash scheme explicitly so it has no self-referential checksum.

Compute a sorted file inventory with per-file digests and a tree/content digest. Verify required files, imports/references, MIME handling, WASM loadability, production base-path compatibility, and absence of unexpected assets. Record total site size and WASM size; establish justified warning/failure budgets from the baseline rather than inventing an arbitrary percentage target.

Build the production site once for a given verification run. Browser jobs consume that immutable artifact; their reports are written elsewhere. After testing, recompute and compare its inventory/digest. Promote the same payload into the GitHub Pages artifact format. Rewrapping an unchanged payload is acceptable; regenerating or rebuilding it after tests is not.

Choose the simplest artifact flow that enforces this rule. One build/test job is acceptable at this scale. If jobs run in parallel, upload a uniquely identified site-under-test artifact and have consumers download that exact artifact from that exact run/attempt. Compare content digests after download. Never select an artifact by a mutable "latest" label or from another PR/run.

The production publisher must be able to show which commit and content digest it deployed. Keep test output, reports, and browser-installed files outside the immutable site. Do not mutate or inject build metadata during the privileged deployment job.

Acceptance evidence: verification works from a clean checkout; the site loads at /assembly-agent/; required files and WASM have the expected MIME behavior; an injected forbidden file and a missing runtime asset fail packaging; modifying one artifact byte after tests prevents promotion.

## 8. R05 - Consolidate workflows and preserve an honest required gate

### 8.1 Preferred graph

Implement a small graph equivalent to:

```text
pull_request / push to main / supported manual verification
    -> deterministic dependency/tool setup and build
    -> complete offline Node/WASM/proxy coverage
    -> browser/accessibility/visual coverage on the staged site
    -> workflow, source, packaging, and required security checks
    -> stable required build-and-test result
    -> main-only promotion/deployment of the verified artifact
    -> deployed-site smoke verification

separate trusted scheduled/manual workflows
    -> Firefox/WebKit compatibility verification
    -> operational live-service checks
    -> explicitly enabled Worker deployment
```

Use one workflow with a conditional deployment job, or thin callers of a reusable verification workflow. Choose after inspecting the existing check names and artifact flow. The requirement is one source of verification logic and a fresh check of the actual main commit before publication. Do not replace merged-commit verification with trust in an earlier PR artifact.

### 8.2 Required-check behavior

Preserve the effective build-and-test check context unless a deliberate, authorized migration is necessary. Inspect both job IDs and displayed check names. Exactly one authoritative required result should represent the complete required suite; avoid ambiguous duplicate names across workflows.

If build-and-test becomes an aggregate job, it must inspect every required prerequisite result and fail for failed, cancelled, missing, or unexpectedly skipped prerequisites. Use the appropriate always-run semantics, but recognize that a completely cancelled workflow may not execute another job: cancellation must remain non-passing, not be converted to success.

Optional live checks and production deployment itself do not belong in the PR aggregate. Define intentionally excluded jobs explicitly. Do not make a generic "skipped is okay" rule to accommodate them.

Keep required workflows present on every relevant PR. Avoid workflow-level path filters that strand a required check as pending or omit verification. If you add change-based optimization, the always-present gate must validate the decision and the exact required work. Start without this optimization unless measurements justify its complexity.

Support merge_group if the repository uses a merge queue. Preserve existing solo-maintainer approval policy rather than adding a required second reviewer. Inspect administrator enforcement and bypass rules, but do not claim control over inaccessible settings.

Validate contribution contexts: same-repository PR, fork PR, Dependabot PR, push to main, and manual verification on a feature branch. Untrusted contexts run the required checks without production secrets and cannot reach a deployment path. Manual dispatch does not automatically make an arbitrary ref trusted.

### 8.3 Deployment permissions and freshness

Use a deployment-only job with only the permissions needed for publication. Ordinary build, tests, and artifact preparation use read-only repository access. The publisher should not execute application tests, package lifecycle scripts, or PR-controlled shell code while holding production permissions. Prefer no source checkout in the publisher.

Restrict production Pages publishing to verified main in the protected github-pages environment. Verify the current platform requirements for permissions, artifacts, environments, and deployment branch policies.

Reject superseded deployment candidates before publication: serialization alone does not stop an older, slower verification run from publishing after a newer one. Check candidate identity against the intended current main/release policy under the deployment lock. Record a superseded deployment as an explicit no-op, not a deployed release. Account for a new commit arriving while a deployment is already active.

A rollback must be an explicit, authorized operation involving a known previously verified artifact or a newly reverified old source revision. Ordinary branch/manual inputs must not be able to masquerade as rollback authorization. Document the path; do not execute a production rollback as a test.

### 8.4 Concurrency and migration

Cancel obsolete PR verification runs using a PR-scoped key. Give production publishing a shared per-environment concurrency group with active publishing not cancelled. Ensure no outer workflow-level cancellation can override that policy. Do not assume concurrency queues are FIFO; verify current platform behavior and implement freshness independently.

Add explicit timeouts to every job, plus bounded network/readiness waits. Keep values reasonable for measured work. Do not use unbounded loops, blanket retries, or continue-on-error around required checks.

Migrate the existing gate without creating an unprotected interval. Preserve the old required context until the replacement is proven; update settings only when authorized and inspect the effective result afterward. Do not merge workflow changes whose renamed checks would deadlock or silently weaken branch requirements.

Acceptance evidence: actual check names match the required context; negative prerequisite states cannot yield a passing gate; fork/Dependabot verification needs no production secret; feature-branch manual runs cannot deploy; a main commit receives fresh verification; stale publication is prevented.

## 9. R06 - Explicit toolchains, pinned Actions, and narrow trust boundaries

Choose a currently supported Ubuntu runner image, an explicit supported Node release, and a specific WABT version. Document the choices and how they are updated. Install Node explicitly rather than using whichever executable happens to exist on the runner.

Pin WABT through a maintained reproducible mechanism: for example, an upstream release with a verified digest or a lockfile-managed distribution whose provenance and CLI behavior you verify. Do not download an unverified binary, use curl-to-shell installers, or rely silently on an unversioned apt package. Confirm architecture compatibility and fail clearly when an unsupported environment is used.

Print actual Node, package-manager, WABT, browser-test, browser, and relevant Worker-tool versions. Centralize version choices rather than repeating contradictory values in scripts, docs, and workflows. Document any remaining hosted-runner variability honestly; a named Ubuntu image is not a complete immutable system image.

Pin every external Action and reusable workflow to a verified full commit SHA, with readable release/version comments. Verify each SHA against the intended upstream release. Local repository actions remain local references; container-based dependencies should use an appropriate immutable digest. Keep Dependabot responsible for supported Action updates and provide a reviewed update path for pins outside its coverage.

Default GITHUB_TOKEN permissions to the minimum. Disable persisted checkout credentials where unnecessary. Give Pages publication pages:write and id-token:write only where required. Give security reporting or incident creation their own narrowly scoped jobs rather than granting those permissions to the entire pipeline.

Keep PR execution on pull_request with restricted permissions. Avoid pull_request_target execution of untrusted code and avoid adding a privileged workflow_run chain when the simpler same-run design suffices. Never interpolate PR titles, branch names, issue text, provider errors, or other untrusted strings directly into shell commands. Pass data through safe environment variables or structured APIs and quote it correctly.

Production credentials must be environment-scoped and absent from PR jobs. Audit workflow inputs, artifact selection, local composite actions, dependency install scripts, and reporting steps as part of the trust boundary. Verify current platform behavior for fork and Dependabot tokens rather than weakening the pipeline when their permissions differ.

Introduce caching only for measured benefit. Package-download caching keyed by OS/toolchain/lockfile may be enough. Avoid caching node_modules, trusted production artifacts, broad home directories, or unchecked executable/tool caches. Verify cached tool content before trusting it. Keep cache and artifact trust separate.

Acceptance evidence: version output matches the chosen pins; every external Action reference is immutable; required verification works with read-only repository permissions; credential-bearing jobs cannot be reached by untrusted contributions; timeouts and concurrency are explicit.

## 10. R07 - Useful, privacy-safe evidence and diagnostics

Give build, offline tests, browser tests, accessibility checks, Worker tests, packaging, security checks, and deployment distinct named steps or jobs. Favor clear failure attribution over a single enormous shell command.

Produce a machine-readable results summary and a concise Markdown job summary showing:

- Source commit and event context; for PRs, distinguish the tested merge ref from the PR head when applicable.
- Actual tool/browser versions and the exact verification commands.
- Suites/tests executed, passed, failed, skipped, and retried; identify flaky retry-only passes.
- Browser/device coverage, accessibility results, and visual comparison results.
- Site/WASM sizes, artifact identity and content digest, and dependency/lockfile identity.
- Test-report artifact names and, when applicable, deployment URL, deployment result, and deployed commit identity.

Publish test reports in a standard machine-readable format where the tooling supports it. Keep a short human-readable summary even when a suite fails before producing a complete report. A reporter failure, empty report, or missing required report must not disguise a test failure.

Preserve browser traces, screenshots, expected/actual/diff images, console errors, request failures, server logs, and relevant engine/Worker diagnostics on failure. Configure trace collection so evidence exists for the first failing attempt, not only after a successful retry. Include an inspection command for local trace/report viewing.

Use cleanup/finalization conditions appropriately: diagnostic upload should still happen after a test failure when possible, but an upload failure must not overwrite the original cause. Use unique artifact names for matrix jobs and bounded retention consistent with repository policy. Keep potentially larger videos optional when traces/screenshots provide sufficient evidence.

Use only synthetic conversations and dummy keys in PR/test artifacts. Review traces, headers, screenshots, serialized storage, console output, and exception text for leakage. Include a synthetic-secret sentinel test that fails if that sentinel reaches a retained log/report or release artifact. Live-service reports must be intentionally minimal and redacted; do not retain full requests, model responses, browser storage, or real authorization headers merely for convenience.

Test/report tooling must preserve the distinction between product regression, infrastructure/setup failure, provider outage, security-scan unavailability, and intentionally unconfigured optional operations. Do not report all of them as "tests passed" or collapse them into an indistinguishable "CI failed."

Acceptance evidence: introduce a controlled failure and inspect the actual report, trace, and screenshot artifacts; confirm useful failure context and preserved exit status; verify the synthetic-secret sentinel is absent from retained outputs.

## 11. R08 - Focused lint/security checks and engine-specific verification

### 11.1 Workflow and source checks

Add actionlint for workflow correctness and zizmor for Actions security, installed through pinned, verified mechanisms. Run them locally through documented commands and in required verification. Fix findings relevant to this campaign rather than broadly suppressing them. Any suppression must be narrow, explain the trust argument, and identify a review condition.

Add focused JavaScript, shell, and HTML validation suited to this repository. Reuse existing tools where appropriate. Validate shell safety and new build/test scripts. Keep formatting changes limited to touched code unless an existing convention demands otherwise; this campaign is not an excuse to rewrite every file's style.

Include executable checks for important workflow invariants where practical: required test discovery, immutable external Action references, allowed permissions, production-ref guards, artifact identity, required gate behavior, and absence of production credentials from PR paths. Static parsing is useful, but do not claim it proves GitHub scheduling or permission behavior that requires an actual run.

### 11.2 CodeQL, dependency findings, and secrets

Inspect whether CodeQL is already enabled through default setup or an existing workflow. Preserve working coverage; avoid duplicate scans. Configure or refine supported JavaScript/TypeScript and Actions analysis according to current official support and repository eligibility. Keep WAT/WASM coverage claims separate: compile/validation and behavioral tests, not a green JavaScript scan, prove engine properties.

Validate CodeQL behavior on PRs, forks, Dependabot changes, and scheduled/default-branch runs. Restrict security-event reporting permissions to the relevant job. If enabling an account-level feature requires owner access, deliver the repository-side configuration and exact remaining activation steps without pretending the feature is active.

Inspect secret scanning and push protection where supported. Enable/configure only within granted authority; otherwise provide exact owner steps. Keep fake test-key allowlists specific to intentional fixtures rather than ignoring the entire test directory. Verify that newly generated artifacts, logs, examples, and environment templates cannot publish real secrets.

Use one coherent vulnerability policy from R03. Avoid redundant scanners producing overlapping noise. Classify existing findings, remediation, and any exceptions in a compact security note. Never disable a relevant security check just because a new dependency or workflow exposes an existing finding.

### 11.3 WAT/WASM contracts and bounded stream testing

Run wasm-validate after compilation. Add an executable engine contract check for the expected imports/exports, zero-import design, memory shape/limits, and other genuinely relied-upon ABI properties. Derive expected values from source and accepted contracts; do not invent them or freeze incidental values unnecessarily.

Retain the existing engine smoke and captured-stream regressions. Expand deterministic tests for:

- UTF-8 characters split across byte boundaries.
- Partial SSE lines/events and all relevant line-ending/termination variants.
- JSON escape boundaries, escaped quotes, backslashes, and truncated Unicode escapes.
- Interleaved and parallel tool calls with distinct IDs, names, and arguments.
- Equivalent logical streams split into different chunk sequences.
- Empty input, malformed input, incomplete final input, interruption, and restart.
- Existing documented capacity/overflow boundaries and history/render isolation.

Where appropriate, add seeded generative/property tests with a deterministic seed and a straightforward replay command. Log the minimal failing fixture, seed, and chunk boundaries. Keep runtime bounded by input sizes, case limits, and process-level timeouts where a synchronous engine hang would defeat an in-process timer.

The core property is that equivalent valid streams yield equivalent logical results regardless of chunking. Malformed or excessive input must have documented bounded behavior; distinguish intended errors/traps from hangs or unexplained corruption. Do not fuzz real providers or let a PR test launch unbounded work.

Acceptance evidence: invalid WASM and ABI drift fail; existing stream fixtures still pass; chunking properties are reproducible; an intentional relevant parser/fixture fault is detected; scanner output and any unresolved findings have honest dispositions.

## 12. R09 - Worker verification, controlled deployment, and live-service checks

### 12.1 Required Worker coverage without live upstream calls

Include the existing mocked free-proxy tests in the central required suite. Add a real local Worker-runtime test using currently supported Cloudflare tooling, such as its test integration or a supported local runtime. Node-only import tests are useful but do not establish compatibility with the deployed Worker runtime.

Use a locked toolchain and the repository's intended compatibility settings. Do not update compatibility_date solely because it looks old; review any runtime-behavior change and prove compatibility first.

Exercise the exported runtime entry point, not just helpers. Cover allowed routes, OPTIONS, unsupported methods, malformed JSON, missing configuration, free-only enforcement, upstream failures/statuses, streaming, and documented CORS behavior. Verify required response headers and error shapes consumed by the browser. Assert that rejected paid requests do not reach upstream.

Consider relevant request-routing fields and fallback mechanisms against current upstream API documentation. A test should prove the actual free-only boundary, not only that one helper recognizes a suffix. Fix a verified bypass with a focused regression; do not invent an exploit from an unverified assumption.

Mock upstream inside the actual runtime boundary using the supported mechanism. Demonstrate that no real generation or production endpoint is contacted. A process-global fetch stub outside the Worker runtime is not enough unless it truly intercepts the runtime's requests.

Prove incremental SSE forwarding using a controlled stream whose later chunks are released separately. Cover upstream errors before headers and, where the contract supports it, interruptions during a stream. Preserve appropriate status/header semantics without leaking operator keys, messages, raw private identifiers, or sensitive exception details.

Inspect the actual origin policy. The historical implementation used wildcard fallback in some cases; do not pretend that was a strict allowlist. Characterize current behavior, distinguish CORS from authentication/abuse prevention, and explicitly document any policy change required by a demonstrated security defect.

### 12.2 Worker deployment workflow

First inspect whether Cloudflare already deploys the Worker through an external integration. Avoid creating two independent production publishers. Either integrate with the existing authoritative path or establish a clearly documented single publisher.

Implement a separate trusted, explicitly enabled Worker deployment workflow. Require the appropriate protected environment, approved source ref, successful required verification, and narrowly scoped Cloudflare credentials. Keep this new production deployment path disabled until its owner-controlled prerequisites are configured; ordinary PR verification must not depend on those credentials.

Support a local packaging/dry-run check and, where supported, a verified Worker artifact promotion path. Verify current Wrangler semantics rather than inventing command flags. Use the same tested source/configuration and record the resulting Worker deployment/version identifier. Account for Worker-specific packaging separately from the static Pages payload.

Keep the OpenRouter operator key as a Worker secret rather than moving it into frontend files, PR jobs, artifacts, or general repository variables. Provisioning instructions must name secret locations and permissions without printing secret values. Never run a secret-write command automatically against production merely to make a smoke test pass.

Document frontend/Worker API compatibility, independent deployment ordering, and rollback. Prefer backward-compatible releases; test the contract with fixtures on both sides. Publishing Pages must never imply that a Worker change was also deployed.

After an authorized Worker deployment, perform bounded non-generating health/version checks. Add an optional separately controlled generation probe only under the live-test budget below. Preserve the previous deployment identity and provide an explicit rollback procedure. Do not automatically roll back an application because an unrelated upstream provider is temporarily unavailable.

### 12.3 Deployed-site smoke checks

After Pages publication, verify the deployed base path, expected commit identity/build metadata, critical assets, MIME behavior, JS boot, and WASM initialization. Use bounded retries for CDN propagation and distinguish "old artifact still served" from "new artifact broken."

Make this a meaningful release verification step, not just an HTTP 200 on index.html. Use fixtures/network control for any post-deployment browser behavior that should not depend on real generation. Also provide a scheduled check of deliberate external runtime dependencies, where any remain.

Surface a post-deployment failure clearly with the deployment/run/artifact identity and rollback instructions. Do not rewrite a successful publication as if no deployment occurred, and do not conceal a failed smoke check behind continue-on-error.

### 12.4 Separate operational live-health workflow

Implement a scheduled/manual workflow distinct from required PR correctness. It should check the deployed site, asset/WASM availability, model-catalog shape, Worker liveness, and optional selected provider behavior.

Model generation probes must be explicitly enabled, use synthetic prompts, and have hard limits for requests, tokens, duration, and concurrency. A suitable initial policy is at most one real generation request per enabled run, no automatic generation retries, a small explicit output-token cap, and only a catalog-verified free model. Make limits centrally configured and validate them. Do not run the entire capability sweep by default or silently fall back to a paid model.

Keep live generation disabled until configured; report that optional probe as "not configured," not as a passing generation test. Non-generating public health checks should still operate. Do not make every PR depend on provider uptime or consume the operator's quota.

Choose a modest, documented schedule at a non-round minute and verify the platform's current timezone behavior. Scheduled jobs are health observations, not a guaranteed real-time monitoring SLA. Check actual run timestamps and do not assume cron execution is exact.

Distinguish Worker liveness, safe configuration/readiness signals where available, upstream availability, and end-to-end chat success. An unconditional /api/health 200 proves only its narrow liveness property. Expose at most safe version/readiness metadata; never return a secret, a partial key, or a credential-bearing upstream error.

Label a single upstream generation probe as upstream verification, not end-to-end proof of a multi-round browser chat. If an explicitly enabled live browser probe is added, count all model requests, including tool continuations and corrective rewrites, against its hard budget; budget exhaustion is a visible probe outcome, not permission to exceed the limit.

Use bounded retries only for appropriate non-generating transient checks. Classify failures into deployment/artifact, application, catalog/provider, Worker configuration, and infrastructure categories. Persist only sanitized status, latency, version, and diagnostic codes.

Implement deduplicated incident reporting with a stable identity, appropriate severity, repeat-failure handling, and recovery updates. Prefer one active incident per service/failure class over a new issue every run. Give only the trusted reporter the needed issues permission. Test notification logic with fixtures without creating real incidents during CI; treat external error text as untrusted data, not shell or workflow instructions. Make reporting explicitly configurable where repo permissions are absent.

Acceptance evidence: Worker tests execute in the intended runtime with mocked upstream; production credentials are absent from PR execution; deployment configuration/dry-run works; frontend and Worker version/contract checks exist; live probes enforce their budget; incident deduplication/recovery is tested. List any owner activation still pending.

## 13. Required commands, configuration, and documentation

Expose clear local commands for clean installation/bootstrap, WASM compilation and validation, site packaging, offline tests, Worker-runtime tests, browser/accessibility tests, visual comparisons, lint/security checks, and the complete required verification path. Names may follow repository conventions; there must be one obvious command corresponding to the required CI gate.

Keep provisioning separate from verification. The verification command should use installed, pinned tools and fail with actionable prerequisite errors rather than silently downloading arbitrary latest packages. A developer should be able to reproduce a CI failure without deciphering long YAML fragments.

Retain convenient existing build behavior where practical. Document the new dependency/bootstrap step and how to serve the packaged app. Provide commands for replaying a generated stream failure, inspecting traces, reviewing visual baseline updates, and testing a Worker locally.

Use existing documentation locations. Add or update an ADR only for real architectural/security decisions: artifact promotion, test tiers, required-check semantics, or deployment trust boundaries. Update README and stale comments, including any claim that Actions are the only dependencies or that browser tests are only manual.

Document the real operational contract: required checks, optional scheduled checks, protected environments, required secret names and locations, opt-in variables, retention, incident behavior, artifact identity, deployment order, and rollback. Pull repeatable command/version information from configuration where possible rather than maintaining several conflicting copies.

Do not claim settings, protections, deployments, baselines, or hosted results are verified merely because a YAML file or setup document exists.

## 14. Implementation sequence and delivery discipline

Use small vertical slices and keep the required gate meaningful throughout:

1. Inspect and measure the baseline; restore omitted regressions and centralize test classification.
2. Lock the toolchain/dependencies; remediate runtime dependency findings; bring existing browser coverage into required execution.
3. Assemble the clean site artifact and prove deterministic browser testing against its production base path.
4. Consolidate workflows; preserve the required check; isolate privileges; pin Actions; enforce artifact identity, freshness, timeouts, and safe concurrency.
5. Complete browser/product journeys, visual/accessibility gates, diagnostics, lint/security, and bounded engine stream coverage.
6. Complete real Worker-runtime coverage, controlled Worker deployment, post-deployment verification, scheduled cross-browser/live checks, and incident handling.
7. Run adversarial verification of the CI itself, review the integrated diff, and produce the final evidence report.

This sequence prioritizes risk; it does not make later requirements optional. Complete all nine requirement groups that can be implemented in the repository. When external activation is blocked, finish its code, validate offline/dry-run behavior, and clearly separate pending activation from completed work.

Use test-first changes at meaningful seams: demonstrate the missing coverage or failure, implement the smallest correct change, and then refactor. Investigate failures rather than increasing timeouts or adding retries without evidence. Prefer fixing races and leaked state over hiding them.

Keep the pipeline proportional to this project. Start with one supported Linux/Node combination and Chromium on PRs, with scheduled Firefox/WebKit. Avoid self-hosted runners, huge OS matrices, broad infrastructure migrations, or caching everything. Measure runtime and critical-path changes, but never trade a required correctness/security check for an unsubstantiated speed claim.

## 15. Prove that the new CI detects failures

A green run alone is insufficient. Use isolated temporary changes, fixture-driven harness tests, or a disposable branch/worktree to verify these failure paths. Restore all deliberate faults before committing the finished implementation. Never damage production or weaken branch rules for this exercise.

| Deliberate condition | Required outcome |
| --- | --- |
| An existing regression assertion fails | Required verification fails with the original assertion visible. |
| A new runnable test is unclassified | Discovery/classification fails and names the file. |
| A required suite is missing, empty, or unintentionally skipped | The gate does not pass. |
| Browser, axe, or fixture server is unavailable | Required browser verification fails with an actionable cause. |
| The app attempts an unexpected external request | The deterministic test fails even if the app swallows the network error. |
| A critical accessibility or visual regression is introduced | The relevant check fails and retains diagnostic evidence. |
| WASM fails validation or violates a relied-upon ABI contract | Engine verification fails before release. |
| A required asset is absent or a forbidden file enters _site/ | Packaging validation fails. |
| A tested artifact's bytes change before promotion | Digest verification rejects publication. |
| A required prerequisite fails, cancels, or unexpectedly skips | build-and-test cannot report success. |
| A fork/Dependabot/feature-ref run reaches publication logic | Authorization/ref policy denies production publishing. |
| An older verified candidate finishes after a newer candidate | Freshness policy prevents accidental rollback. |
| A test/log contains the synthetic secret sentinel | Retained-output validation detects the leak. |
| Worker receives a forbidden paid request | It is rejected without contacting upstream. |
| A live probe exceeds its configured request/token/time budget | The probe stops; it does not retry or switch to paid service. |
| The same live-service incident repeats and then recovers | Reporting deduplicates the incident and records recovery. |

Use local simulation for pure decision logic and real Actions runs for platform-dependent claims where access allows. State which evidence is simulated, local, hosted, or unavailable. Static YAML checks cannot establish every real permission, branch-protection, artifact, or concurrency property.

Perform at least repeated clean runs of deterministic suites to expose order dependence and flakes. Run the full verification from a fresh dependency installation, not only a warmed developer directory. Inspect actual browser images/traces when the environment supports it; record any limitation instead of claiming a visual review that never happened.

Review the final diff for secrets, unintended production changes, weakened assertions, broad suppressions, missing files, stale docs, unsafe shell interpolation, wrong check names, and artifact rebuilds. Verify that the repository is clean apart from intentional changes and that generated reports/installations are not accidentally tracked.

## 16. Definition of done and final response

Deliver code, configuration, tests, and documentation, not another recommendation list. The completion report must be concise enough to review but backed by concrete evidence.

Include:

1. Starting/final commit or branch identity and a grouped summary of changes.
2. An R01-R09 table mapping requirements to implementation paths, test evidence, and exact status.
3. Commands actually executed, relevant results/counts, hosted run links where available, tool/browser versions, and artifact identity.
4. Negative-test evidence from section 15, including any cases not validated on GitHub itself.
5. Security findings fixed, narrowly scoped exceptions, known flakes, and remaining product/operational risks.
6. Exact owner-only activation steps for inaccessible settings, environments, credentials, Cloudflare integration, or security features. Include prerequisites, verification steps, and rollback; never include secret values.
7. PR/commit references where created and the recommended safe merge/activation order. Do not claim a PR was opened or a production deployment occurred without an actual result.

Separate "implemented" from "verified in GitHub" and "activated in production." Passing local tests is valuable evidence but is not proof that environment protection or repository settings are effective. Likewise, unavailable credentials do not excuse unfinished independent tests, packaging, or workflows.

Finish by stating whether all nine groups are implemented, which are externally unverified or blocked, and whether the repository changes are ready for review. Do not call the campaign complete while required checks are placeholders, missing suites still pass silently, deployed dependencies differ from the lockfile, or publication can bypass artifact verification.

## 17. Primary-source references to consult when relevant

Use current primary sources and follow redirects. These are starting points, not frozen guarantees of today's APIs or versions:

- GitHub Actions security: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub reusable workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub concurrency: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- GitHub status checks: https://docs.github.com/en/pull-requests/reference/status-checks
- GitHub Pages workflows: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- Dependabot reference: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- GitHub code scanning: https://docs.github.com/en/code-security/code-scanning
- Playwright CI: https://playwright.dev/docs/ci
- Playwright traces: https://playwright.dev/docs/trace-viewer
- Playwright visual comparisons: https://playwright.dev/docs/test-snapshots
- Cloudflare Workers testing: https://developers.cloudflare.com/workers/testing/
- Cloudflare Wrangler commands: https://developers.cloudflare.com/workers/wrangler/commands/
- WABT: https://github.com/WebAssembly/wabt
- actionlint: https://github.com/rhysd/actionlint
- zizmor: https://docs.zizmor.sh/
- DOMPurify: https://github.com/cure53/DOMPurify
- Referenced sanitizer advisory: https://github.com/advisories/GHSA-v2wj-7wpq-c8vv

Begin by inspecting the repository and establishing the baseline. Then implement, verify, and deliver the campaign.
