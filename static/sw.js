/* Family tree service worker.
   Network-first for HTML navigations, then cached index.html, then offline.html.
   Never caches Firebase Auth, Firestore, Hosting reserved /__/ paths, /config.js, sw.js, or Storage photo URLs (including tokenised download URLs). */
const CACHE_VERSION = 'osr-pwa-v6';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/app.css',
  '/theme-boot.js',
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
  'accounts.google.com',
  'firebasestorage.googleapis.com'
];

function isAuthOrDataUrl(url) {
  const host = url.hostname;
  if (AUTH_OR_DATA_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
  if (host.endsWith('.firebaseio.com') || host.endsWith('.firebasestorage.app') || host.endsWith('.firebaseapp.com')) return true;
  if (host.endsWith('.googleapis.com')) return true;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return true;
  if (url.pathname === '/__/' || url.pathname.startsWith('/__/')) return true;
  if ((host.includes('firebasestorage') || host.endsWith('.googleapis.com')) && (url.searchParams.has('token') || /[?&]token=/.test(url.search))) return true;
  return false;
}

// Same-origin files that must always come from the network and never be
// stored in Cache Storage. /config.js is generated per deployment (Firebase
// config, Super Admin, archive IDs) and Hosting serves it no-store; sw.js is
// the worker itself. /__/ paths are already excluded by isAuthOrDataUrl.
const NEVER_CACHE_PATHS = ['/config.js', '/sw.js'];

function isNeverCachePath(url) {
  return NEVER_CACHE_PATHS.includes(url.pathname) || url.pathname.startsWith('/__/');
}

function isHtmlRequest(request, url) {
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  const path = url.pathname;
  if (path === '/' || path.endsWith('.html')) return true;
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html') && request.destination !== 'style' && request.destination !== 'script' && request.destination !== 'image';
}

async function cachedIndexOrOffline(cache) {
  const index = await cache.match('/index.html') || await cache.match('/');
  if (index) return index;
  const offline = await cache.match('/offline.html');
  if (offline) return offline;
  return null;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && request.method === 'GET') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cachedExact = await cache.match(request);
    if (cachedExact) return cachedExact;
    const fallback = await cachedIndexOrOffline(cache);
    if (fallback) return fallback;
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
  if (isNeverCachePath(url)) return; // network only; respects Hosting no-store
  if (isHtmlRequest(request, url)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
