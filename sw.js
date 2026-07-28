'use strict';

// 应用外壳缓存（含本地化的第三方库），决定离线是否可用
const CACHE_NAME = 'md-editor-v3.0.14';

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

/* ---------- 安装：预缓存完整应用外壳（best-effort，单文件失败不阻断） ----------
   ⚠ 此处【不】调用 skipWaiting()：新版本 SW 安装后停留在 waiting，等用户点击
   「立即刷新」时由页面 postMessage('SKIP_WAITING') 显式激活（见下方 message 事件）。
   若在 install 里自动 skipWaiting，会与新 SW 的 clients.claim() 产生竞争——页面
   仍在旧 SW 控制下 reload，导致「更新条点击无反应、刷新后反复弹出」。 */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:'reload' 绕过 HTTP 缓存，确保预缓存的是部署时的新鲜文件
    await Promise.all(SHELL.map(async (u) => {
      try {
        const res = await fetch(u, { cache: 'reload' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res);
      } catch (_) { /* 单文件失败忽略，运行时仍可降级 */ }
    }));
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

/* 收到页面「立即接管」消息时，跳过等待直接激活（覆盖 iOS 等 claim 不及时场景） */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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

  // 应用外壳（index.html / app.js / styles.css / sw.js / manifest）：网络优先。
  // 关键：部署新版本后用户点「立即刷新」，必须能从网络拿到最新外壳，否则在
  // 缓存优先 + claim 未及时接管（尤其 iOS Safari）时会一直回退旧版本，
  // 表现为「点了刷新没反应、更新条反复弹」。网络优先保证刷新即最新，离线再回退缓存。
  const p = url.pathname;
  const isShell = p === '/' || p.endsWith('/index.html') || p.endsWith('/app.js') ||
                  p.endsWith('/styles.css') || p.endsWith('/manifest.webmanifest') || p.endsWith('/sw.js');

  if (isShell) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(req);
        if (fresh && (fresh.ok || fresh.type === 'opaque')) {
          try { await cache.put(req, fresh.clone()); } catch (_) {}
        }
        return fresh;
      } catch (_) {
        const cached = await cache.match(req) ||
          (req.mode === 'navigate' ? (await cache.match('./index.html')) : null);
        return cached || Response.error();
      }
    })());
    return;
  }

  // 其余静态资源（vendor 库 / 图标 / 图片）：缓存优先（cache-first）+ 后台更新，
  // 首屏快、离线可用；命中即返回，同时后台用网络响应刷新缓存（stale-while-revalidate）。
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
