// JARVIS service worker.
//
// It caches the app shell so the page still opens when the agent is
// unreachable, and it focuses the window when a local notification is tapped.
// It contains no push subscription and no remote endpoint: every notification
// JARVIS shows is created by the page itself, from an event that arrived over
// your own Wi-Fi from your own computer. There is no push service to
// subscribe to, so there is nothing here that could reach the internet.

const CACHE = "jarvis-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./favicon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache the API or the event stream: stale agent state would be a lie.
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/preview/")) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("./index.html").then((idx) => idx ?? Response.error()))),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    }),
  );
});
