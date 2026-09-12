// Service Worker for HSP Offline App
const CACHE_NAME = 'hsp-app-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './data.json',
  './tree.json',
  './favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For data.json and tree.json, use network-first to sync, falling back to cache
  if (url.pathname.endsWith('data.json') || url.pathname.endsWith('tree.json')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Google Drive downloads or external file requests - do not cache in CacheStorage (handled via IndexedDB)
  if (url.hostname.includes('drive.google.com') || url.hostname.includes('googleusercontent.com')) {
    return;
  }

  // App shell and assets: Stale-While-Revalidate or Cache-First
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch in background to update cache
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const respClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
        }
        return response;
      });
    })
  );
});
