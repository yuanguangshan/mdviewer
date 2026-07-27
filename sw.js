'use strict';

// 应用外壳缓存（含本地化的第三方库），决定离线是否可用
const CACHE_NAME = 'md-editor-v2.3.21';

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

/* ---------- 请求拦截 ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 仅对 http/https 资源做缓存拦截。浏览器扩展注入的 chrome-extension://
  // 等非常规 scheme 请求，Cache API 不支持（put 会抛 'Request scheme unsupported'），
  // 直接透传、不缓存。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 导航请求（打开页面）：网络优先，失败回退到缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        try { await cache.put('./index.html', fresh.clone()); } catch (_) {}
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

  // 静态资源：网络优先 + 缓存回退（network-first）。
  // 关键：app.js / styles.css 等必须与 index.html（网络优先）保持同源最新，
  // 否则 SW 更新过渡期会出现“HTML 新鲜显示新按钮、却运行旧 app.js 逻辑”的版本错配
  // （本项目高频踩坑：自动续写等新增功能在旧缓存下“点了没反应/框消失”）。
  // 改为网络优先：发布后首次打开即拉到最新；离线时回退到已缓存副本（首装后离线可用）。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const fresh = await fetch(req);
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        try { await cache.put(req, fresh.clone()); } catch (_) {}
      }
      return fresh;
    } catch {
      // 离线或网络失败：回退到缓存
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
