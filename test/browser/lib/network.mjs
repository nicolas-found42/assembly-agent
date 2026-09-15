// lib/network.mjs — network control for the browser suite.
//
// Two halves, both required for a hermetic run:
//
//   installNetwork(page)  routes every request the page makes. The staged site
//                         and the fixture server pass straight through; any other
//                         origin is rewritten onto the fixture server's
//                         /__upstream/<host>/… endpoint. An origin with no
//                         fixture is ABORTED and recorded, so a spec can assert
//                         the list is empty — and it fails even when the app
//                         swallows the network error, because the record lives
//                         here, in the test process, not in the page.
//
//   fixtureClient()       talks to the fixture server's control surface from the
//                         test process (no page involvement, no CORS).

import { UPSTREAM_HOSTS } from '../fixtures/upstream.mjs';
import { FIXTURE_ORIGIN, SITE_ORIGIN } from './ports.mjs';

export const SITE = SITE_ORIGIN;
export const FIXTURE = FIXTURE_ORIGIN;

const isLocal = (url) => url.origin === SITE_ORIGIN || url.origin === FIXTURE_ORIGIN;

/**
 * Route all browser traffic for one page.
 * @returns {Promise<Network>} controller with what actually happened.
 */
export async function installNetwork(page, { fixtureOrigin = FIXTURE_ORIGIN } = {}) {
  const net = new Network(fixtureOrigin);
  // A predicate (not a glob) so local traffic is never intercepted at all.
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && !isLocal(url),
    (route, request) => net.handle(route, request),
  );
  return net;
}

export class Network {
  constructor(fixtureOrigin = FIXTURE_ORIGIN) {
    this.fixtureOrigin = fixtureOrigin;
    this.blocked = [];     // attempted requests to an origin with no fixture
    this.proxied = [];     // fulfilled from a fixture
  }

  async handle(route, request) {
    const url = new URL(request.url());
    const entry = { method: request.method(), url: request.url(), origin: url.origin };
    if (!UPSTREAM_HOSTS.includes(url.host)) {
      this.blocked.push(entry);
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    this.proxied.push(entry);
    const target = new URL(`/__upstream/${url.host}${url.pathname}`, this.fixtureOrigin);
    target.search = url.search;
    // route.fetch + fulfill, not continue({url}): the origin is https and the
    // fixture server is http, and continue() refuses a protocol change. The
    // fixture answers with `access-control-allow-origin: *`, which the browser
    // still enforces because the request itself stays cross-origin.
    const response = await route.fetch({ url: target.href });
    await route.fulfill({ response });
  }

  /** Requests the app made to an origin the fixture map does not cover. */
  origins() {
    return [...new Set(this.blocked.map((b) => b.origin))].sort();
  }

  /** Readable one-liner per blocked request, for an assertion message. */
  describeBlocked() {
    if (!this.blocked.length) return 'no unexpected external requests';
    return `${this.blocked.length} unexpected external request(s) — add a fixture or stop the app calling out:\n`
      + this.blocked.map((b) => `  ${b.method} ${b.url}`).join('\n');
  }
}

/**
 * Control client for the fixture server (see test/browser/fixture-server.mjs).
 * Every method is a plain POST/GET from the test process.
 */
export function fixtureClient(origin = FIXTURE_ORIGIN) {
  const call = async (path, body) => {
    const res = await fetch(`${origin}${path}`, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`fixture ${path} -> ${res.status} ${text}`);
    return payload;
  };
  return {
    origin,
    health: () => call('/__fixture/health'),
    reset: () => call('/__fixture/reset', {}),
    /** Replace the synthetic OpenRouter catalog (array of /models records). */
    setCatalog: (models, sort) => call('/__fixture/catalog', { models, ...(sort ? { sort } : {}) }),
    /** Override one upstream origin: status / body / contentType / delayMs. */
    setSource: (host, options = {}) => call('/__fixture/source', { host, ...options }),
    /** Configure the SSE answer; mode 'manual' holds frames until release(). */
    setChat: (options = {}) => call('/__fixture/chat', options),
    /** Release the next `count` held SSE frames (default: all). */
    release: (count) => call('/__fixture/chat/release', count === undefined ? {} : { count }),
    requests: () => call('/__fixture/requests'),
  };
}
