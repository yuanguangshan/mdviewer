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
});
