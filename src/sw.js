/* Family tree service worker.
   Network-first for HTML. Never caches Firebase Auth or Firestore. */
const CACHE_VERSION = 'osr-pwa-v1';
const PRECACHE_URLS = [
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png'
];

const AUTH_OR_DATA_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'apis.google.com',
  'accounts.google.com'
];

function isAuthOrDataUrl(url) {
  const host = url.hostname;
  if (AUTH_OR_DATA_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
  if (host.endsWith('.firebaseio.com') || host.endsWith('.firebasestorage.app') || host.endsWith('.firebaseapp.com')) return true;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return true;
  return false;
}

function isHtmlRequest(request, url) {
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  const path = url.pathname;
  if (path === '/' || path.endsWith('.html')) return true;
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html') && request.destination !== 'style' && request.destination !== 'script' && request.destination !== 'image';
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && request.method === 'GET') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const pending = fetch(request).then((fresh) => {
    if (fresh && fresh.ok && request.method === 'GET') cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => cached);
  return cached || pending;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (isAuthOrDataUrl(url)) return; // network only; do not cache
  if (url.origin !== self.location.origin) return;
  if (isHtmlRequest(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
