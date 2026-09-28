const CACHE_NAME = 'vtuber-tv-shell-v2';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/privacy.html',
  '/terms.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIや認証はネットワーク優先(番組情報・ログイン状態は常に最新を取りに行く)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // ページ遷移(ナビゲーション)はオフライン時にアプリシェル(index.html)へフォールバックする
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () => caches.match(event.request).then((cached) => cached || caches.match('/index.html'))
      )
    );
    return;
  }

  // アプリシェルはキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// 配信開始通知をタップしたら、既に開いているタブがあればそれにフォーカスし、
// なければ新しくアプリを開く。
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
