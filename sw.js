// 最小化 service worker：讓 PWA 可安裝，並在離線時用快取開啟 App 外殼。
// 同源檔案採「網路優先、失敗用快取」，部署新版後重新整理即可更新。
// 語音模型（models/）很大，交給瀏覽器 HTTP 快取，不放進這裡。
const CACHE = 'overseas-trans-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.headers.has('range') || url.pathname.includes('/models/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: false }).then((hit) => hit || caches.match('./'))),
  );
});
