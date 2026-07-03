/* service worker: network-first เพื่อให้ได้ไฟล์เวอร์ชันล่าสุดเสมอ
   และ fallback เป็น cache เมื่อออฟไลน์ */
const CACHE = 'leave-app-v1';
const SHELL = ['.', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // cache เฉพาะไฟล์หน้าเว็บของเราเอง — คำขอไป API (script.google.com) ปล่อยผ่านตามปกติ
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
