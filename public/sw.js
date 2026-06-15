// Hand-written service worker — replaces the next-pwa generated one.
//
// Key decisions:
// - NO skipWaiting: the new SW waits until all tabs using the old SW are
//   closed before taking over. This prevents the "blank PWA after deploy"
//   bug (new SW deletes old cached chunks the currently running page still
//   references — a silent crash in standalone mode with no visible error).
// - Next.js static chunks (/_next/static/) are cache-first with content-
//   hashed names — safe to cache forever since the hash changes on deploy.
// - API routes, Firebase/Firestore, and ALL cross-origin requests bypass
//   the service worker entirely. Caching auth tokens or API responses
//   would break the live app.
// - All other same-origin requests (pages, manifest, icons) go to the
//   network so pages always reflect the latest deploy.

const STATIC_CACHE = 'fcc-static-v2'

self.addEventListener('install', () => {
  // Intentionally NOT calling self.skipWaiting().
  // The new SW waits for the old one to be idle (all PWA windows closed).
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only intercept GET requests.
  if (request.method !== 'GET') return

  // Never intercept cross-origin — Firebase, Google APIs, Firestore, etc.
  if (url.origin !== self.location.origin) return

  // Never cache API routes.
  if (url.pathname.startsWith('/api/')) return

  // Cache-first for hashed Next.js static assets (safe to cache indefinitely).
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request)
        if (hit) return hit
        const res = await fetch(request)
        if (res.ok) cache.put(request, res.clone())
        return res
      })
    )
  }
  // All other requests (pages, manifest, icons) — let fall through to network.
})
