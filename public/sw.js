// VHS Vault service worker.
//
// Strategy: NETWORK-FIRST for everything same-origin. That is the update
// story — whenever the user is online they get the freshest deploy, no
// version juggling, no stale home-screen app. The cache only steps in when
// the network fails (offline at a swap meet), serving the last good copy.
// API calls are never cached.

const CACHE = "vhsvault-shell-v2";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Google Fonts (icons + Inter) are immutable: cache-first so the tab bar
    // icons survive offline swap meets after the first visit.
    if (FONT_HOSTS.includes(url.hostname)) {
      event.respondWith(
        caches.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok || res.type === "opaque") {
                const copy = res.clone();
                caches.open(CACHE).then((cache) => cache.put(req, copy));
              }
              return res;
            })
        )
      );
    }
    return; // other cross-origin (posters, etc.) — browser default
  }
  if (url.pathname.startsWith("/api/")) return; // live data, never cached

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
