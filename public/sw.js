// AeroSocial service worker — push notifications, plus just enough
// app-shell caching to make the site installable as a PWA and usable
// offline. Anything dynamic (API calls, WebSocket, uploaded images) is
// left completely alone: only the static shell listed in SHELL_ASSETS is
// ever cached, so normal network behavior for everything else is
// untouched.
const CACHE_VERSION = "aerosocial-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {
        /* offline-precache is a nice-to-have, never block install on it */
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
      ),
    ])
  );
});

// Cache-first for the static shell only (same-origin GET requests for the
// exact assets above). Every other request — /api/*, WebSocket upgrades,
// user images, third-party fonts/tiles — falls straight through to the
// network exactly as if this handler didn't exist.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isShellAsset =
    url.origin === self.location.origin && (SHELL_ASSETS.includes(url.pathname) || url.pathname === "/index.html");
  if (!isShellAsset) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
    )
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload: fall back to defaults below */
  }

  const isEew = data.type === "eew";
  const title = data.title || "AeroSocial";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    // Replaces an older notification with the same tag instead of stacking
    // (e.g. repeated likes/comments on the same post) — harmless if unset.
    renotify: !!data.tag,
    data: { url: data.url || "/" },
    // 緊急地震速報は他の通知（いいね・コメントなど）と違い、揺れる前に
    // 確実に気づいてもらう必要がある。requireInteraction を立てることで
    // OSが自動的に消してしまわないようにし、対応端末では振動も付ける。
    ...(isEew ? { requireInteraction: true, vibrate: [200, 100, 200, 100, 200] } : {}),
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // すでに開いているタブがあれば、生のpayloadをそのまま渡す — app.js
      // 側のnavigator.serviceWorker "message" リスナーがshowEewPopup()を
      // 呼び、OS通知よりリッチなアプリ内スライドインポップアップを
      // 表示できる。OS通知と二重に出ても構わない（安全側に倒す）。
      isEew
        ? self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            clientList.forEach((client) => client.postMessage(data));
          })
        : Promise.resolve(),
    ])
  );
});

// Focuses an already-open AeroSocial tab and navigates it, or opens a new
// one if none is open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          if ("navigate" in client) client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
