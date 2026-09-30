/* Sidadiya service worker: one job only. If a page cannot load because the
 * visitor is offline or the server is down (Railway 502/503/504), show the
 * animated "shop is closed" page instead of a browser or hosting error.
 * It never caches pages, API calls or files, so nothing can go stale. */
var VERSION = '__VERSION__';
var CACHE = 'sidadiya-closed-' + VERSION;
var PAGE = '/closed';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add(new Request(PAGE, { cache: 'reload' })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('sidadiya-closed-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function closedPage(res) {
  return caches.match(PAGE).then(function (c) {
    if (!c) return res || new Response('The shop is closed for a moment. Please try again soon.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return c.text().then(function (html) { return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/api/') === 0) return;
  e.respondWith(fetch(req).then(function (res) {
    // Our own maintenance page (503) is already the right page: show it as is.
    if ((res.status === 502 || res.status === 503 || res.status === 504) && !res.headers.get('X-Sidadiya-Maintenance')) return closedPage(res);
    return res;
  }).catch(function () { return closedPage(); }));
});
