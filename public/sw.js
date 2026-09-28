// AeroSocial service worker — push notifications, plus just enough
// app-shell caching to make the site installable as a PWA and usable
// offline. Anything dynamic (API calls, WebSocket, uploaded images) is
// left completely alone: only the static shell listed in SHELL_ASSETS is
// ever cached, so normal network behavior for everything else is
// untouched.
//
// IMPORTANT: bump CACHE_VERSION whenever this file's *caching behavior*
// itself changes (rare) — it does NOT need bumping for ordinary app.js /
// styles.css deploys, since the network-first strategy below already
// picks those up on the very next request without relying on this
// string at all. It only exists so activate() can drop a genuinely
// obsolete cache format if this file's own logic changes shape.
const CACHE_VERSION = "aerosocial-shell-v2";
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

// Network-first for the static shell (same-origin GET requests for the
// exact assets above), falling back to the cached copy only when the
// network request itself fails (actually offline). Every other request —
// /api/*, WebSocket upgrades, user images, third-party fonts/tiles —
// falls straight through to the network exactly as if this handler
// didn't exist.
//
// This used to be cache-first (serve the cached copy immediately, only
// falling back to network for a cache miss), which is why a server-side
// deploy of app.js/styles.css never reached anyone who already had the
// PWA installed: once a shell asset was cached, it stayed cached
// indefinitely regardless of what the server actually had, and the only
// way to evict it was to change CACHE_VERSION (an easy thing to forget)
// or manually clear the browser's data — a "hard refresh" gesture mobile
// browsers don't really offer. Network-first means every load simply
// gets whatever the server currently has, same as if this file weren't
// caching anything at all — the cache here now purely exists as an
// offline fallback, not as the normal path.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isShellAsset =
    url.origin === self.location.origin && (SHELL_ASSETS.includes(url.pathname) || url.pathname === "/index.html");
  if (!isShellAsset) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
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
  // 気象警報も、EEWほどの緊急度ではないにせよ「タブを開いている人には
  // OS通知と二重にでもアプリ内バナーで気づいてほしい」という点は同じ
  // なので、以下のpostMessageリレーはEEWと同じ扱いにしている
  // (requireInteraction/vibrateはEEW限定のまま — 頻度も高くなりうる
  // 気象警報まで毎回バイブさせると煩わしいため)。
  const isWarning = data.type === "warning";
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
      // 側のnavigator.serviceWorker "message" リスナーがshowEewPopup()/
      // showWarningBar()を呼び、OS通知よりリッチなアプリ内スライドイン
      // ポップアップを表示できる。OS通知と二重に出ても構わない（安全側
      // に倒す）。
      isEew || isWarning
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
