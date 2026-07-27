'use strict';

// 应用外壳缓存（含本地化的第三方库），决定离线是否可用
const CACHE_NAME = 'md-editor-v3.0.2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './vendor/highlight.min.js',
  // 注：mermaid.min.js / html2pdf.bundle.min.js 体积大且非首屏必需，
  // 改为运行时按需懒加载（见 app.js loadScript），不纳入预缓存，避免安装即下载 4MB+。
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

/* ---------- 请求拦截：缓存优先（cache-first）+ 后台更新 ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 仅对 http/https 资源做缓存拦截。浏览器扩展注入的 chrome-extension://
  // 等非常规 scheme 请求，Cache API 不支持（put 会抛 'Request scheme unsupported'），
  // 直接透传、不缓存。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 缓存优先：命中缓存即直接返回（首屏快、离线可用），
  // 同时后台用网络响应刷新缓存（stale-while-revalidate）；
  // 未命中再走网络并写入缓存，供下次秒开/离线使用。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) {
      const revalidate = async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && (fresh.ok || fresh.type === 'opaque')) {
            try { await cache.put(req, fresh.clone()); } catch (_) {}
          }
        } catch (_) {}
      };
      revalidate();
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        try { await cache.put(req, fresh.clone()); } catch (_) {}
      }
      return fresh;
    } catch {
      // 离线且未命中：导航回退缓存 index.html；图片回退默认图标
      if (req.mode === 'navigate') {
        const fb = (await cache.match('./index.html')) || (await cache.match('./'));
        if (fb) return fb;
      }
      if (url.pathname.endsWith('.png')) {
        const fb = await cache.match('./icons/icon-192.png');
        if (fb) return fb;
      }
      return Response.error();
    }
  })());
});
