// 앱을 수정해서 올릴 때마다 이 버전 이름을 바꿔 주세요 (예: couple-v6)
const CACHE = 'couple-v5';
const ASSETS = [
  './',
  './index.html',
  './config.js',
  './sync.js',
  './vendor/supabase.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 사이트 파일만: 온라인이면 최신 파일, 오프라인이면 저장된 파일
// (Supabase 서버 요청은 건드리지 않음)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          const key = e.request.mode === 'navigate' ? './index.html' : e.request;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? './index.html' : e.request, { ignoreSearch: true }))
  );
});
