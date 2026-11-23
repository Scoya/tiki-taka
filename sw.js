// 앱을 수정해서 올릴 때마다 이 버전 이름을 바꿔 주세요 (예: couple-v6)
const CACHE = 'couple-v10';
const ASSETS = [
  './',
  './index.html',
  './config.js',
  './sync.js',
  './chat.js',
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

// 알림 받기
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '우리 디데이', body: e.data ? e.data.text() : '' }; }
  const opts = { body: d.body || '', icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url: d.url || './' } };
  if (d.tag) opts.tag = d.tag;
  const jobs = [self.registration.showNotification(d.title || '우리 디데이', opts)];
  // 채팅 알림이면 앱 아이콘에 안 읽은 수 표시
  if (Number.isFinite(d.badge) && self.navigator && self.navigator.setAppBadge) jobs.push(self.navigator.setAppBadge(d.badge).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});

// 알림을 누르면 앱 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const toChat = url.includes('#chat');
      for (const c of list) {
        if ('focus' in c) { if (toChat) c.postMessage({ open: 'chat' }); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
