const CACHE_NAME = "family-ludo-v3";

const SHELL_URLS = ["/", "/offline"];

/** @param {string} html */
function extractNextAssetPaths(html) {
  const paths = new Set();
  const re = /(?:src|href)="(\/_next\/[^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    paths.add(match[1]);
  }
  return [...paths];
}

/**
 * Cache a document and the /_next static assets referenced in its HTML.
 * @param {string} path
 */
async function precachePathWithAssets(path) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(path, { credentials: "same-origin" });
    if (!res.ok) return;
    await cache.put(path, res.clone());
    const html = await res.text();
    const assets = extractNextAssetPaths(html);
    await Promise.allSettled(
      assets.map(async (assetPath) => {
        if (await cache.match(assetPath)) return;
        const assetRes = await fetch(assetPath, { credentials: "same-origin" });
        if (assetRes.ok) await cache.put(assetPath, assetRes.clone());
      }),
    );
  } catch {
    /* network unavailable during install / precache */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all(SHELL_URLS.map(precachePathWithAssets)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  const path = event.data?.path;
  if (event.data?.type === "PRECACHE_PATH" && typeof path === "string") {
    event.waitUntil(precachePathWithAssets(path));
  }
});

/** @param {URL} url */
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.json" ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".woff2")
  );
}

/** @param {Request} req */
async function navigateFallback(req) {
  const url = new URL(req.url);
  const cached =
    (await caches.match(req)) ??
    (await caches.match(url.pathname)) ??
    (await caches.match(url.pathname, { ignoreSearch: true }));
  if (cached) return cached;
  const offlineShell = await caches.match("/offline");
  if (offlineShell) return offlineShell;
  const home = await caches.match("/");
  if (home) return home;
  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            void precachePathWithAssets(url.pathname || "/");
          }
          return res;
        })
        .catch(() => navigateFallback(req)),
    );
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE_NAME).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => caches.match(req));
      }),
    );
    return;
  }

  // RSC / soft-navigation payloads and other same-origin GETs
  if (req.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit =
            (await caches.match(req)) ??
            (await caches.match(url.pathname, { ignoreSearch: true }));
          return hit ?? navigateFallback(req);
        }),
    );
  }
});
