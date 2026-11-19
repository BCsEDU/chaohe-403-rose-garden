const CACHE_NAME = "rose-garden-403-v1";
const PRECACHE_URLS = ["./", "./index.html", "./teacher.html", "./qrcode.png"];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("rose-garden-403-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);

      event.waitUntil(networkPromise);

      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
      });

      const fastRes = await Promise.race([networkPromise, timeoutPromise]);
      if (fastRes && fastRes.ok) {
        return fastRes;
      }

      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;

      if (req.mode === "navigate") {
        const fallbackUrl = url.pathname.endsWith("teacher.html") ? "./teacher.html" : "./index.html";
        const navCached = await cache.match(fallbackUrl, { ignoreSearch: true });
        if (navCached) return navCached;
      }

      const lateNet = await networkPromise;
      if (lateNet) return lateNet;
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })()
  );
});
