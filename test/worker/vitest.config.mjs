// test/worker/vitest.config.mjs — worker-class suite: worker/api-chat.js tested in the real Worker runtime.
//
// Runtime: @cloudflare/vitest-pool-workers 0.22.0 (with vitest 4.1.11, miniflare 5.20260815.0-alpha,
// wrangler 4.131.2 — the versions pinned in package-lock.json). The pool runs each test file inside a
// workerd isolate, i.e. the same runtime the Worker is deployed to, rather than a Node mock.
//
// * `wrangler.configPath` makes the pool load the entry point (`main = worker/api-chat.js`) and the
//   repository's intended compatibility settings from wrangler.toml — the compatibility date is NOT
//   overridden for tests.
// * Outbound fetch mocking: the tests must prove that rejected paid requests never reach OpenRouter and
//   must drive a controlled upstream stream. The pool exposes Miniflare's `outboundService` worker
//   option (`cloudflareTest({ miniflare })` → `WorkersPoolOptions.miniflare: SourcelessWorkerOptions`,
//   see node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.d.mts; the accepted designators are
//   `V4ServiceDesignator` in node_modules/miniflare/dist/src/index.d.ts, whose forms include a name of
//   another Worker — used here). `outboundService: "mock-upstream"` routes every outbound fetch() of
//   the Worker under test to the auxiliary Worker in ./mock-upstream.worker.mjs, which runs in the same
//   workerd process. No process-global fetch stub is involved.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Hermeticity: wrangler would load variables from a developer's .env (this repo has one) and merge them
// into the runtime env. The dummy binding below takes precedence for OPENROUTER_KEY (verified), but
// disabling the .env fallback keeps the runtime env independent of whatever local files exist, so a
// developer run and CI see exactly the same configuration and no real secret is ever in scope.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig({
  root: repoRoot,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(repoRoot, "wrangler.toml") },
      miniflare: {
        // Placeholder only — the mock upstream records the Authorization header, and the suite asserts
        // it is this dummy value, never a real operator key.
        bindings: { OPENROUTER_KEY: "sk-or-v1-test-dummy-key-not-real" },
        workers: [
          {
            name: "mock-upstream",
            // Auxiliary Workers do not inherit the main Worker's compatibility settings. The controlled
            // SSE stream uses the ReadableStream constructor, which needs modern streams behaviour.
            compatibilityDate: "2024-11-01",
            modules: [{ type: "ESModule", path: path.join(here, "mock-upstream.worker.mjs") }],
          },
        ],
        outboundService: "mock-upstream",
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.mjs"],
    testTimeout: 10_000,
    // Keep the evidence lines (SSE timeline, mock upstream call log) visible in the plain
    // `npx vitest run --config test/worker/vitest.config.mjs` output instead of only under --reporter=verbose.
    disableConsoleIntercept: true,
  },
});
