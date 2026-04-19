// Te Ta AI — Service Worker
// Handles: offline cache, push notifications for new reservations

const CACHE_NAME   = 'teta-ai-v1';
const OFFLINE_URL  = '/dashboard';

// Assets to pre-cache on install
const PRECACHE = [
  '/dashboard',
  '/login',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first, fallback to cache ───────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin pages
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // API calls: network only, no caching
  if (url.pathname.startsWith('/owner/') ||
      url.pathname.startsWith('/api/')   ||
      url.pathname.startsWith('/auth/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match(OFFLINE_URL)))
  );
});

// ── Push Notifications ────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (_) {}

  const title   = data.title   || 'Te Ta AI';
  const body    = data.body    || 'Njoftim i ri';
  const icon    = data.icon    || '/icons/icon-192.png';
  const badge   = data.badge   || '/icons/icon-192.png';
  const tag     = data.tag     || 'teta-notification';
  const url     = data.url     || '/dashboard';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url },
      actions: [
        { action: 'open',    title: 'Hap Dashboard' },
        { action: 'dismiss', title: 'Mbyll' },
      ],
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
