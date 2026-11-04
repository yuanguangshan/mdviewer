#!/usr/bin/env node
/**
 * serve-web.js —— 极简静态文件服务（零依赖），用于把工作目录通过浏览器访问
 *
 * 为什么不用 python3 -m http.server：
 *   · 它会把整个目录树（含隐藏文件）原样吐出，直接暴露 .ssh / .pi / .git 等；
 *   · 本服务用**白名单根目录**映射，只开放你指定的一两个目录，且默认隐藏点号文件。
 *
 * 用法：
 *   node serve-web.js [--host 0.0.0.0] [--port 8080] [--root /some/dir] [--mount /x]
 *   环境变量 SERVE_PASS=xxx 时启用 HTTP Basic 认证（用户名任意）。
 *
 * 安全设计：
 *   · 只在白名单根内解析路径，realpath 后再校验前缀，杜绝 ../ 穿越
 *   · 隐藏以 . 开头的文件/目录（.git 不可浏览）
 *   · 默认只读（GET/HEAD）；不提供上传/删除
 *
 * 附加端点（v4.10）：GET /__fetch?url=<encoded> —— 替浏览器去取一个远端 Markdown。
 *   存在理由：浏览器直接 fetch 第三方地址会被 CORS 拦掉，而 mdviewer 是纯静态页；
 *   由本服务代取，mdviewer 就能「按网址阅读」别人托管在任意站点的 .md。
 *   风险与现实：这等于对外提供一个「取任意网址」的能力，必须按 SSRF 端点来防。
 *   规则集中在 lib/fetch-guard.js（三端共用、有单测），本文件只负责执行：
 *     · 只 https、只 443、不做 IP 字面量/内网段/本机名、每一跳跳转都重新复查
 *     · 不转发任何凭据（credentials:omit，不发 Cookie/Authorization/Referer）
 *     · 10 秒超时、2MB 上限（边读边数，不信 Content-Length）、内容必须是文本
 *     · 每 IP 每分钟 30 次；CORS 只回给白名单 Origin
 *     · guard 文件缺失 → 整个端点返回 501（fail closed，宁可不可用也不裸奔）
 *   开关：SERVE_FETCH=0 关闭；SERVE_FETCH_ORIGINS=https://a,https://b 配 CORS 白名单；
 *         SERVE_FETCH_RATE=30 改限流；SERVE_FETCH_GUARD=/path/to/fetch-guard.js 指定规则文件。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');

/* ---------- 参数 ---------- */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const HOST = arg('host', '0.0.0.0');
const PORT = Number(arg('port', 8080));
const PASS = process.env.SERVE_PASS || '';
const SHOW_HIDDEN = process.env.SERVE_HIDDEN === '1';

// 挂载点 → 真实目录（白名单）
/* ---------- 取文端点（/__fetch）的配置 ---------- */
const FETCH_ENABLED = process.env.SERVE_FETCH !== '0';
const FETCH_ORIGINS = (process.env.SERVE_FETCH_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FETCH_RATE_PER_MIN = Math.max(1, Number(process.env.SERVE_FETCH_RATE) || 30);

// 规则文件（lib/fetch-guard.js）定位：serve-web.js 可能被单独拷到别的机器上运行，
// 所以按候选列表查找；一个都找不到就关掉端点（fail closed），绝不退化成「自己实现一套弱检查」。
let guard = null;
let guardErr = '';
(function loadGuard() {
  const cands = [
    process.env.SERVE_FETCH_GUARD,
    path.join(__dirname, 'fetch-guard.js'),
    path.join(__dirname, 'mdviewer', 'lib', 'fetch-guard.js'),
    '/root/mdviewer/lib/fetch-guard.js',
    '/workspace/ops/fetch-guard.js',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const g = require(c);
      if (g && typeof g.checkFetchUrl === 'function') { guard = g; return; }
    } catch (_) { /* 换下一个候选 */ }
  }
  guard = null;
  guardErr = 'fetch-guard.js 未找到，已尝试：' + cands.join(' | ');
})();

const MOUNTS = [];
function addMount(mount, dir) {
  try {
    const real = fs.realpathSync(dir);
    if (fs.statSync(real).isDirectory()) MOUNTS.push({ mount, dir: real });
  } catch (_) { /* 目录不存在就跳过 */ }
}
addMount('/mdviewer', '/root/mdviewer');
addMount('/workspace', '/workspace');

/* ---------- MIME ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.wasm': 'application/wasm',
};
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function human(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(d) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 把 URL 路径解析成白名单内的真实文件路径；越界返回 null */
function resolveTarget(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (_) { return null; }
  if (p.includes('\0')) return null;
  // 找到命中的挂载点（最长前缀优先）
  const hit = MOUNTS
    .filter((m) => p === m.mount || p.startsWith(m.mount + '/'))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  if (!hit) return null;
  const rel = p.slice(hit.mount.length).replace(/^\/+/, '');
  const target = path.resolve(hit.dir, rel);
  // realpath 后再校验前缀（防符号链接外逃）
  let real;
  try { real = fs.realpathSync(target); } catch (_) { return { hit, target, missing: true }; }
  if (real !== hit.dir && !real.startsWith(hit.dir + path.sep)) return null;
  return { hit, target: real };
}

function isHidden(rel) {
  return !SHOW_HIDDEN && rel.split('/').some((seg) => seg.startsWith('.'));
}

/* ---------- /__fetch 的实现 ---------- */

// 每 IP 每分钟的滑动窗口计数（内存态，够用；重启即清零）
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + 60000 }; rateBuckets.set(ip, b); }
  b.n++;
  if (rateBuckets.size > 4096) {                     // 防内存膨胀：顺手清理过期桶
    for (const [k, v] of rateBuckets) if (v.reset <= now) rateBuckets.delete(k);
  }
  return b.n > FETCH_RATE_PER_MIN;
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  if (!origin || FETCH_ORIGINS.indexOf(origin) < 0) return {};   // 不在白名单：不发 CORS 头（浏览器自己会拦）
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Mdviewer',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendFetchJson(res, status, body, extra) {
  const json = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, extra || {}));
  res.end(json);
}

/**
 * 真正去取一个远端 Markdown。所有判断都调 guard，本函数不自定义安全规则。
 * 返回 { ok:true, text, bytes, host } 或 { ok:false, status, reason, message }
 */
async function fetchRemoteMarkdown(rawUrl) {
  let cur = guard.checkFetchUrl(rawUrl);
  if (!cur.ok) return cur;

  for (let hop = 0; hop <= guard.MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), guard.FETCH_TIMEOUT_MS);
    try {
      let resp;
      try {
        resp = await fetch(cur.href, {
          method: 'GET',
          redirect: 'manual',            // 手动跟跳转：每一跳都要重新过安检
          credentials: 'omit',           // 绝不带 Cookie/HTTP 认证
          referrerPolicy: 'no-referrer',
          headers: {
            'User-Agent': 'mdviewer-fetch/1 (+https://md.want.biz)',
            Accept: 'text/markdown, text/x-markdown, text/plain;q=0.9, */*;q=0.1',
          },
          signal: ctrl.signal,
        });
      } catch (e) {
        const aborted = ctrl.signal.aborted;
        return { ok: false, status: aborted ? 504 : 502, reason: aborted ? 'timeout' : 'network', message: String((e && e.message) || e) };
      }

      // 跳转
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return { ok: false, status: 502, reason: 'redirect', message: '跳转响应缺少 Location' };
        if (hop === guard.MAX_REDIRECTS) return { ok: false, status: 400, reason: 'redirect', message: '跳转次数过多' };
        const next = guard.checkRedirect(cur.href, loc);
        if (!next.ok) return { ok: false, status: 400, reason: 'redirect', message: '跳转目标被拒绝：' + next.message };
        cur = next;
        continue;
      }

      if (!resp.ok) return { ok: false, status: 502, reason: 'http-status', message: 'HTTP ' + resp.status };

      const kind = guard.contentTypeKind(resp.headers.get('content-type'));
      if (kind !== 'ok') {
        return { ok: false, status: 415, reason: kind === 'missing' ? 'missing-type' : kind, message: 'content-type: ' + (resp.headers.get('content-type') || '-') };
      }

      // 边读边数：Content-Length 可以是假的，甚至可以是 chunked
      const chunks = [];
      let total = 0;
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (guard.exceedsLimit(total)) {
          try { await reader.cancel(); } catch (_) { /* 忽略 */ }
          return { ok: false, status: 413, reason: 'too-large', message: '超过 ' + guard.MAX_FETCH_BYTES + ' 字节' };
        }
        chunks.push(Buffer.from(value));
      }
      const buf = Buffer.concat(chunks, total);
      const sample = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.length, 8192));
      if (!guard.looksLikeText(sample)) return { ok: false, status: 415, reason: 'binary', message: '内容不是文本' };
      return { ok: true, text: buf.toString('utf8'), bytes: total, host: cur.host };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 400, reason: 'redirect', message: '跳转次数过多' };
}

/**
 * 处理 /__fetch。注意：本端点自带方法/CORS 处理，因此要在全局的「只允许 GET/HEAD」之前分流。
 */
async function handleFetch(req, res, log) {  // eslint-disable-line no-unused-vars
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {                 // 预检：白名单外不发 CORS 头，浏览器侧自然拒绝
    res.writeHead(Object.keys(cors).length ? 204 : 403, Object.assign({ 'Content-Length': 0 }, cors));
    res.end();
    return log(Object.keys(cors).length ? 204 : 403);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendFetchJson(res, 405, { ok: false, reason: 'method', message: '只支持 GET' }, Object.assign({ Allow: 'GET, HEAD, OPTIONS' }, cors));
    return log(405);
  }
  if (!FETCH_ENABLED) {
    sendFetchJson(res, 501, { ok: false, reason: 'disabled', message: '服务端已关闭取文端点（SERVE_FETCH=0）' }, cors);
    return log(501);
  }
  if (!guard) {
    sendFetchJson(res, 501, { ok: false, reason: 'disabled', message: guardErr }, cors);
    return log(501);
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    sendFetchJson(res, 429, { ok: false, reason: 'rate-limit', message: '请求过于频繁' }, cors);
    return log(429);
  }

  let target = '';
  try { target = new URL(req.url, 'http://placeholder').searchParams.get('url') || ''; } catch (_) { target = ''; }

  const out = await fetchRemoteMarkdown(target);
  if (!out.ok) {
    console.log(`  fetch-reject host=${safeHost(target)} reason=${out.reason}`);   // 只记主机名，不记完整 URL（query 里可能带 token）
    sendFetchJson(res, out.status || 400, { ok: false, reason: out.reason, message: out.message }, cors);
    return log(out.status || 400);
  }

  const text = out.text;
  console.log(`  fetch-ok host=${out.host} bytes=${out.bytes}`);
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }, cors));
  res.end(req.method === 'HEAD' ? undefined : text);
  log(200);
}

/** 日志用的主机名（解析失败就返回 '-'，绝不回显原始输入） */
function safeHost(raw) {
  try { return new URL(String(raw)).hostname || '-'; } catch (_) { return '-'; }
}

/* ---------- 目录列表 ---------- */
async function renderListing(hit, dirPath, urlPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const rows = [];
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    if (isHidden(e.name)) continue;
    const full = path.join(dirPath, e.name);
    let st = null;
    try { st = await fsp.stat(full); } catch (_) { continue; }
    const isDir = st.isDirectory();
    const name = e.name + (isDir ? '/' : '');
    const href = urlPath.replace(/\/$/, '') + '/' + encodeURIComponent(e.name) + (isDir ? '/' : '');
    const isMd = !isDir && /\.(md|markdown)$/i.test(e.name);
    rows.push({ name, href, isDir, isMd, size: isDir ? -1 : st.size, mtime: st.mtime });
  }
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const parent = urlPath === '/' ? null : urlPath.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/';
  const body = rows.map((r) => `
      <tr>
        <td>${r.isDir ? '📁' : '📄'} <a href="${r.href}">${esc(r.name)}</a>${
          r.isMd ? ' · <a href="/mdviewer/index.html?open=' + encodeURIComponent(r.href) + '" title="用 mdviewer 排版阅读">📖 阅读</a>' : ''}</td>
        <td class="n">${r.isDir ? '—' : human(r.size)}</td>
        <td class="n">${fmtTime(r.mtime)}</td>
      </tr>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(urlPath)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
 h1{font-size:16px;font-weight:600;margin:0 0 4px}
 .meta{color:#8b93a1;font-size:12px;margin-bottom:16px}
 table{border-collapse:collapse;width:100%;max-width:1000px}
 th,td{padding:7px 10px;border-bottom:1px solid #23262d;text-align:left;vertical-align:top}
 th{color:#8b93a1;font-weight:500;font-size:12px}
 td.n{white-space:nowrap;color:#8b93a1;font-variant-numeric:tabular-nums;width:1%}
 a{color:#7aa2f7;text-decoration:none} a:hover{text-decoration:underline}
 code{background:#1b1e24;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>${esc(urlPath)}</h1>
<div class="meta">挂载 <code>${esc(hit.mount)}</code> → <code>${esc(hit.dir)}</code>
 ${parent ? '· <a href="' + esc(parent) + '/">↑ 上级</a>' : ''}
 · 只读 · 隐藏点号文件</div>
<table><thead><tr><th>名称</th><th class="n">大小</th><th class="n">修改时间</th></tr></thead>
<tbody>${body || '<tr><td colspan="3" style="color:#8b93a1">（空目录）</td></tr>'}</tbody></table>
</body></html>`;
}

/* ---------- 首页：挂载点导航 ---------- */
function renderHome() {
  const items = MOUNTS.map((m) => `<li><a href="${m.mount}/">${esc(m.mount)}/</a> → <code>${esc(m.dir)}</code></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>workspace</title>
<style>body{font:14px/1.7 -apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:28px;background:#0f1115;color:#e6e6e6}
a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
code{background:#1b1e24;padding:1px 5px;border-radius:4px;color:#9ece6a}li{margin:6px 0}
.meta{color:#8b93a1;font-size:12px;margin-top:18px}</style></head><body>
<h2>📂 可浏览目录</h2><ul>${items || '<li style="color:#8b93a1">没有可用挂载点</li>'}</ul>
<p class="meta">只读静态服务 · <a href="/mdviewer/index.html">打开 mdviewer 编辑器</a></p>
</body></html>`;
}

/* ---------- 请求处理 ---------- */
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  const log = (code) => console.log(`${new Date().toISOString()} ${req.method} ${pathname} ${code} ${Date.now() - t0}ms`);

  if (PASS) {
    const auth = req.headers.authorization || '';
    const ok = auth.startsWith('Basic ') &&
      Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') === PASS;
    if (!ok) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="workspace"', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('需要密码');
      return log(401);
    }
  }

  // 取文端点：自带方法/CORS 处理，必须在「只允许 GET/HEAD」之前分流
  if (pathname === '/__fetch') return handleFetch(req, res, log);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只支持 GET / HEAD');
    return log(405);
  }

  if (pathname === '/') {
    const html = renderHome();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return log(200);
  }

  const r = resolveTarget(pathname);
  if (!r) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found（不在白名单内）');
    return log(404);
  }
  if (r.missing) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return log(404);
  }

  const rel = path.relative(r.hit.dir, r.target).split(path.sep).join('/');
  if (rel && isHidden(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return log(404);
  }

  let st;
  try { st = await fsp.stat(r.target); } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return log(404);
  }

  // 目录：不带斜杠则重定向，带斜杠则列表
  if (st.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' });
      res.end();
      return log(301);
    }
    const html = await renderListing(r.hit, r.target, pathname);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return log(200);
  }

  // 文件：支持 Range（方便看视频/大文件）
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return log(304);
  }

  const type = mimeOf(r.target);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null) { start = Math.max(0, st.size - (end || 0)); end = st.size - 1; }
      else if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return log(416);
      }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes', 'ETag': etag, 'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(r.target, { start, end }).on('error', () => res.destroy()).pipe(res);
      return log(206);
    }
  }

  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes',
    'ETag': etag, 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(r.target).on('error', () => res.destroy()).pipe(res);
  log(200);
});

server.listen(PORT, HOST, () => {
  console.log(`静态服务已启动：http://${HOST}:${PORT}/`);
  for (const m of MOUNTS) console.log(`  ${m.mount}/  →  ${m.dir}`);
  if (PASS) console.log('  （已启用 Basic 认证）');
  if (!FETCH_ENABLED) console.log('  取文端点 /__fetch：已关闭（SERVE_FETCH=0）');
  else if (!guard) console.log('  取文端点 /__fetch：不可用 → ' + guardErr);
  else console.log(`  取文端点 /__fetch：开启（${FETCH_RATE_PER_MIN} 次/分钟/IP，CORS 白名单 ${FETCH_ORIGINS.length ? FETCH_ORIGINS.join(',') : '仅同源'}）`);
});
