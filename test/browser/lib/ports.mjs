// ports.mjs — the one place the harness resolves its two local ports.
// SITE_PORT/FIXTURE_PORT override; the defaults are the contract the Playwright
// config, the fixture server CLI and the specs all share.

export const SITE_PORT = Number(process.env.SITE_PORT || 4319);
export const FIXTURE_PORT = Number(process.env.FIXTURE_PORT || 4320);

export const SITE_ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

/** The staged site's base URL — matches playwright.config.mjs `use.baseURL`. */
export const BASE_URL = `${SITE_ORIGIN}/assembly-agent/`;
