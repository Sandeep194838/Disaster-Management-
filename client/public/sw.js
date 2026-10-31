/**
 * SahyogAI Service Worker
 * -----------------------
 * Caches ONLY static application shell assets (HTML, CSS CDN URLs, FA icons).
 * NEVER caches API responses, incident data, or user sessions.
 * Offline: serves the cached shell so the UI loads; API calls fail gracefully.
 */

const CACHE_NAME = 'sahyogai-shell-v2';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// CDN resources to cache for offline shell
const CDN_URLS = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NEVER cache API calls
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/api')) {
    return; // Let the browser handle normally (fail fast when offline)
  }

  // Cache-first for shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache only successful GET requests for shell assets
        if (event.request.method === 'GET' && response.ok && response.status < 400) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: serve index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
