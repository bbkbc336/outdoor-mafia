// 서비스 워커: (1) 앱 화면·파일을 휴대폰에 저장해 전파가 약해도 화면이 열리게, (2) 회의 소집 알림(푸시)을 띄웁니다.
// 파일은 항상 인터넷에서 먼저 받고(최신 유지), 실패할 때만 저장본을 씁니다. 게임 데이터(/api)는 저장하지 않습니다.
const CACHE = 'mafia-v1';
const SHELL = ['/', '/index.html', '/host.html', '/practice.html', '/screen.html', '/guide.html', '/style.css', '/common.js', '/app.js', '/games.js',
  '/scanner.js', '/host.js', '/screen.js', '/kakao.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/print' || url.pathname === '/qr.svg') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('/', { ignoreSearch: true })) || Response.error();
      return Response.error();
    }
  })());
});

// 회의 소집 알림: 서버는 내용 없는 푸시만 보내고, 문구는 여기서 띄웁니다.
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('🔔 회의 소집!', {
    body: '집결 장소로 모이세요. 눌러서 앱을 여세요.',
    tag: 'meeting', renotify: true, requireInteraction: true,
    vibrate: [500, 150, 500, 150, 800],
    icon: '/icon-192.png', badge: '/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = list.find(c => new URL(c.url).pathname === '/' || new URL(c.url).pathname === '/index.html');
    if (win) return win.focus();
    return self.clients.openWindow('/');
  })());
});
