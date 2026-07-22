'use strict';

// 应用外壳缓存（含本地化的第三方库），决定离线是否可用
const CACHE_NAME = 'md-editor-v1.9.3';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './vendor/highlight.min.js',
  './vendor/html2pdf.bundle.min.js',
];

/* ---------- 安装：预缓存完整应用外壳（任一失败即抛） ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);          // 本地资源必须完整缓存，否则离线不可用
    await self.skipWaiting();
  })());
});

/* ---------- 激活：清理旧缓存，立即接管 ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- 请求拦截 ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 导航请求（打开页面）：网络优先，失败回退到缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  // 静态资源：网络优先（保证 HTML / JS / CSS 版本一致，避免 SW 更新过渡期新旧错配导致脚本崩溃），离线再回退缓存
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      if (url.pathname.endsWith('.png')) {
        const fallback = await cache.match('./icons/icon-192.png');
        if (fallback) return fallback;
      }
      return Response.error();
    }
  })());
});
