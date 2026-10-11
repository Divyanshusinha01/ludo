import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const SW_PATH = path.resolve(__dirname, "../public/sw.js");
const ORIGIN = "https://ludo.test";

/**
 * Hash of sw.js with the CACHE_NAME line removed, keyed by the cache name it shipped
 * under. Changing the worker without bumping CACHE_NAME would leave clients on stale
 * caches, so the two must change together.
 */
const RELEASED_WORKERS: Record<string, string> = {
  "family-ludo-v6": "e5adc55abbc1d9da",
};

type FakeRequest = { method: string; url: string; mode: string; headers: Headers };
type Key = string | FakeRequest;
type Handler = (event: Record<string, unknown>) => void;

function keyOf(key: Key, ignoreSearch = false): string {
  const url = new URL(typeof key === "string" ? key : key.url, ORIGIN);
  return ignoreSearch ? url.pathname : url.pathname + url.search;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  async put(key: Key, res: Response) {
    this.entries.set(keyOf(key), res);
  }
  async match(key: Key, opts: { ignoreSearch?: boolean } = {}) {
    if (!opts.ignoreSearch) return this.entries.get(keyOf(key));
    const want = keyOf(key, true);
    for (const [k, v] of this.entries) if (keyOf(k, true) === want) return v;
    return undefined;
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(key: Key, opts: { ignoreSearch?: boolean } = {}) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(key, opts);
      if (hit) return hit;
    }
    return undefined;
  }
}

const source = readFileSync(SW_PATH, "utf8");
const CACHE_NAME = /const CACHE_NAME = "([^"]+)";/.exec(source)?.[1];

function loadWorker(network: (path: string) => Response | Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const caches = new FakeCacheStorage();
  const fetched: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    Response,
    Headers,
    fetch: async (key: Key) => {
      const p = keyOf(key);
      fetched.push(p);
      return await network(p);
    },
  });
  vm.runInContext(source, context, { filename: SW_PATH });

  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)!({
      ...extra,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<Response>) => (response = p),
    });
    await Promise.all(waits);
    return response ? await response : undefined;
  }

  return {
    caches,
    fetched,
    dispatch,
    extractNextAssetPaths: context.extractNextAssetPaths as (html: string) => string[],
  };
}

function request(url: string, init: Partial<Omit<FakeRequest, "url">> = {}): FakeRequest {
  return { method: "GET", mode: "cors", headers: new Headers(), ...init, url: new URL(url, ORIGIN).href };
}

const SHELL_HTML =
  '<html><head><link href="/_next/static/css/app.css" rel="stylesheet"></head>' +
  '<body><script src="/_next/static/chunks/main.js"></script>' +
  '<script src="/_next/static/chunks/main.js"></script>' +
  '<img src="/images/logo.png"><a href="https://cdn.example/_next/x.js">x</a></body></html>';

function siteNetwork(p: string): Response {
  if (p === "/" || p === "/offline") return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
  return new Response(`asset ${p}`);
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("service worker", () => {
  let sw: ReturnType<typeof loadWorker>;

  beforeEach(() => {
    sw = loadWorker(siteNetwork);
  });

  it("extractNextAssetPaths returns each same-origin /_next asset once", () => {
    expect(sw.extractNextAssetPaths(SHELL_HTML).sort()).toEqual([
      "/_next/static/chunks/main.js",
      "/_next/static/css/app.css",
    ]);
    expect(sw.extractNextAssetPaths("<p>no assets</p>")).toEqual([]);
  });

  it("install precaches the shell pages, their /_next assets and the board images", async () => {
    await sw.dispatch("install");
    const cache = sw.caches.stores.get(CACHE_NAME!)!;
    expect([...cache.entries.keys()].sort()).toEqual([
      "/",
      "/_next/static/chunks/main.js",
      "/_next/static/css/app.css",
      "/images/folk-ludo-board.png",
      "/images/folk-ludo-board.webp",
      "/offline",
    ]);
  });

  it("install survives being offline", async () => {
    const down = loadWorker(offline);
    await expect(down.dispatch("install")).resolves.toBeUndefined();
  });

  it("activate deletes every cache except the current one", async () => {
    await sw.caches.open("family-ludo-v1");
    await sw.caches.open("family-ludo-v5");
    await sw.caches.open(CACHE_NAME!);
    await sw.dispatch("activate");
    expect(await sw.caches.keys()).toEqual([CACHE_NAME]);
  });

  it("offline navigation falls back to the cached page, then /offline", async () => {
    await sw.dispatch("install");
    const down = loadWorker(offline);
    for (const [name, cache] of sw.caches.stores) down.caches.stores.set(name, cache);

    const home = await down.dispatch("fetch", { request: request("/?utm=x", { mode: "navigate" }) });
    expect(await home!.text()).toBe(SHELL_HTML);

    const room = await down.dispatch("fetch", { request: request("/room/ABC234", { mode: "navigate" }) });
    expect(room).toBe(await down.caches.match("/offline"));
  });

  it("serves cached assets without the network and caches new ones on first fetch", async () => {
    const first = await sw.dispatch("fetch", { request: request("/icons/icon-192.png") });
    expect(await first!.text()).toBe("asset /icons/icon-192.png");
    expect(sw.fetched).toEqual(["/icons/icon-192.png"]);

    await new Promise((r) => setTimeout(r, 0));
    const again = await sw.dispatch("fetch", { request: request("/icons/icon-192.png") });
    expect(again).toBeDefined();
    expect(sw.fetched).toEqual(["/icons/icon-192.png"]);
  });

  it("leaves non-GET, cross-origin and Convex traffic to the browser", async () => {
    expect(await sw.dispatch("fetch", { request: request("/api/auth", { method: "POST" }) })).toBeUndefined();
    expect(await sw.dispatch("fetch", { request: request("https://x.convex.cloud/api/query") })).toBeUndefined();
    expect(await sw.dispatch("fetch", { request: request("/api/session") })).toBeUndefined();
    expect(sw.fetched).toEqual([]);
  });

  it("CACHE_NAME is bumped whenever the worker changes", () => {
    expect(CACHE_NAME).toBeDefined();
    const body = source.replace(/^const CACHE_NAME = .*$/m, "");
    const hash = createHash("sha256").update(body.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    expect(
      RELEASED_WORKERS[CACHE_NAME!],
      `public/sw.js changed: bump CACHE_NAME and record ${hash} under the new name in RELEASED_WORKERS`,
    ).toBe(hash);
  });
});
