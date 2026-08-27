/* openGym service worker — PWA-grade.
 *
 * Strategy:
 *   - PRECACHE on install: the app shell (index.html + manifest + icons) so the
 *     app boots offline. JS/CSS chunks are NOT precached — they are content-
 *     hashed by Vite and discovered at runtime.
 *   - RUNTIME CACHE on fetch:
 *     - /img/ and /gif/ (exercise media, ~140MB, rarely change): cache-first.
 *     - hashed JS/CSS chunks (vite emits them under /assets/): stale-while-
 *       revalidate, so a slow connection does not block paint and a refresh
 *       picks up new bundles.
 *     - everything else same-origin: network-first, fall back to cache.
 *     - /api/: NEVER cached. Auth and per-user data must always be live.
 *   - VERSIONING: __BUILD_ID__ is replaced at build time. On activate, every
 *     old cache name is wiped, so a new SW takes over cleanly and the new
 *     precache lands in one go.
 *   - UPDATE FLOW: skipWaiting + clients.claim fire on activate so a freshly
 *     installed SW immediately controls open tabs. The "new version" toast
 *     in main.jsx is shown via postMessage from this SW (controllerchange).
 */

const BUILD_ID = '__BUILD_ID__'
const PRECACHE = 'opengym-precache-' + BUILD_ID
const RUNTIME = 'opengym-runtime-' + BUILD_ID
const ASSETS = 'opengym-assets-' + BUILD_ID

// Filled at build time by a small post-processing script (see scripts/inject-sw-version.mjs).
// Keep this list small and stable: anything that should boot the app offline.
const PRECACHE_URLS = [
  './',
  './manifest.json',
  './favicon.ico',
  './favicon-32.png',
  './favicon-16.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './icon-180.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(PRECACHE).then((c) =>
      // addAll fails the whole install on any network miss, so we go one-by-one
      // and tolerate individual failures: a slow icon must not block the SW.
      Promise.all(PRECACHE_URLS.map((u) => c.add(u).catch(() => null)))
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== PRECACHE && k !== RUNTIME && k !== ASSETS)
            .map((k) => caches.delete(k))
      ))
      // Take control of every open tab so the new SW handles the very next fetch.
      // Without this, tabs keep using the old SW until reloaded.
      .then(() => self.clients.claim())
      // Notify any open tabs that a new version is live. main.jsx posts back to
      // itself and shows a "reload for new version" toast.
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => clients.forEach((c) => c.postMessage({ type: 'SW_UPDATED', build: BUILD_ID })))
      )
  )
})

self.addEventListener('message', (e) => {
  // The page can ask the SW to skip waiting on its own — useful for the
  // "reload for new version" button without an automatic takeover.
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {}
  e.waitUntil(self.registration.showNotification(data.title || 'openGym', {
    body: data.body || '',
    icon: './icon-512.png',
    badge: './icon-180.png',
    tag: data.tag || 'opengym',
    renotify: true,
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = e.notification.data && e.notification.data.url
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    const existing = clients.find((c) => 'focus' in c)
    if (target) return existing ? existing.focus().then(() => existing.navigate(target)) : self.clients.openWindow(target)
    return existing ? existing.focus() : self.clients.openWindow('./')
  }))
})

// --- fetch routing ---

const isMedia = (url) => url.pathname.includes('/img/') || url.pathname.includes('/gif/')
const isHashedAsset = (url) => url.pathname.startsWith('/assets/') && /\.[a-f0-9]{6,}\.(js|css)$/.test(url.pathname)

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // Only own origin; cross-origin (CDN images, etc.) is left to the browser.
  if (url.origin !== self.location.origin) return
  // /api/ must NEVER be cached — auth, state, presence. A stale cached body
  // would break passkey login on a flaky network in a way that is hard to
  // diagnose ("sign in succeeded locally, server has no record").
  if (url.pathname.startsWith('/api/')) return

  if (isMedia(url)) {
    // Exercise media is huge and almost never changes. Cache-first.
    e.respondWith(cacheFirst(req, RUNTIME))
    return
  }

  if (isHashedAsset(url)) {
    // Vite content-hashed bundles: serve from cache instantly, refresh in the
    // background. A 404 on the network is fine — the file simply doesn't
    // exist in this build (e.g. a removed chunk).
    e.respondWith(staleWhileRevalidate(req, ASSETS))
    return
  }

  // Everything else: network-first with cache fallback. HTML falls back to
  // the precached root so navigation works offline.
  e.respondWith(
    fetch(req).then((res) => {
      // Cache successful basic responses only — opaque / cross-origin / non-2xx
      // responses would poison the cache and cause 0-byte responses on offline.
      if (res.ok && res.type === 'basic') {
        const copy = res.clone()
        caches.open(RUNTIME).then((c) => c.put(req, copy))
      }
      return res
    }).catch(() =>
      caches.match(req).then((hit) => hit || caches.match('./'))
    )
  )
})

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') cache.put(req, res.clone())
  return res
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  // Kick off the refresh in the background either way. If it fails, the cached
  // version (or a fresh 404) is still served.
  const network = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(req, res.clone())
    return res
  }).catch(() => null)
  return hit || (await network) || new Response('', { status: 504, statusText: 'offline' })
}