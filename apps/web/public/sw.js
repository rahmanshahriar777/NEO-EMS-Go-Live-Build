/* NEO EMS service worker — Phase 3 item 7: basic offline shell.
 *
 * Strategy: cache the static app shell (logo, fonts, offline page) on install,
 * network-first for navigations with an offline fallback. API calls are NEVER
 * cached — payroll/attendance data must always come from the server, never a
 * stale cache entry. This worker does not fabricate content: when the network
 * is down the user gets an explicit offline page, not invented data.
 */

const CACHE_VERSION = 'neo-ems-shell-v1';
const SHELL_ASSETS = ['/logo.png', '/favicon.ico', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS.filter((u) => u !== '/offline')))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API traffic — data must always be live from the server.
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: cache-first, then network.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.match(/\.(png|jpg|ico|webp|svg|woff2)$/)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network-first, offline fallback page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/offline').then(
          (offline) =>
            offline ||
            new Response('You are offline. NEO EMS needs a network connection.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            }),
        ),
      ),
    );
  }
});

// Web-push: show the notification the backend pushed; tapping opens the app.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'NEO EMS';
  const options = {
    body: payload.body || payload.message || 'You have a new notification.',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: payload.url || payload.linkUrl || '/dashboard' },
    tag: payload.tag || 'neo-ems',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
