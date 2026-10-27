/* Service worker di Azzurro: shell offline + notifiche push. */
const VERSION = 'azzurro-v3';
const SHELL = ['/offline', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // dati delle API: mai in cache
  if (url.pathname.startsWith('/api/')) return;
  // asset statici versionati di Next: cache-first
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }
  // navigazione: rete, con pagina offline come ripiego
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline').then((r) => r || new Response('Offline', { status: 503 }))));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Azzurro', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Azzurro';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      timestamp: Date.now(),
      data: { url: data.url || '/', id: data.id },
    }).then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: 'azzurro:notification', payload: data }))),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
