'use strict';
/**
 * tests/worker-fetch.test.js —— Worker 的 /fetch-md（取文端点）集成测试
 *
 * 为什么要单独测：这个端点跑在 Cloudflare 上，本地单测是唯一能在部署前发现问题的机会。
 * 而 worker/ 目录被 .gitignore 排除（项目约定：Worker 源码仅本地维护），
 * 所以在 CI 里「目录不存在 → 跳过」，本地有 worker/ 时才严格跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = path.join(__dirname, '..', 'worker', 'share-worker.mjs');
const hasWorker = fs.existsSync(WORKER);
const opts = hasWorker ? {} : { skip: 'worker/ 不存在（未纳入 git），跳过 Worker 取文端点测试' };

// 把一个 URL 包装成 Worker 收到的 Request
const req = (url, init) => new Request('https://share.want.biz/fetch-md?url=' + encodeURIComponent(url), init);
const env = (extra) => Object.assign({ FETCH_ENABLED: '1', FETCH_ALLOWED_ORIGINS: 'https://md.want.biz' }, extra || {});

async function loadWorker() {
  const mod = await import(require('node:url').pathToFileURL(WORKER).href);
  return mod.default;
}

/** 桩掉 globalThis.fetch，记录真实发出的每个请求参数 */
function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return handler(String(url), init || {}); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('Worker /fetch-md：未开启时 501（默认姿态必须是关的）', opts, async () => {
  const w = await loadWorker();
  const res = await w.fetch(req('https://example.com/a.md'), env({ FETCH_ENABLED: '' }));
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'disabled');
});

test('Worker /fetch-md：IP 字面量 / 内网名 / http 一律拒绝，且不发任何外部请求', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => { throw new Error('不应该发出请求'); });
  try {
    for (const [u, reason] of [
      ['https://169.254.169.254/latest/meta-data/', 'ip-literal'],
      ['https://10.0.0.5/a.md', 'ip-literal'],
      ['https://localhost/a.md', 'no-dot-host'],
      ['http://example.com/a.md', 'https-only'],
    ]) {
      const res = await w.fetch(req(u), env());
      assert.equal(res.status, 400, u);
      assert.equal((await res.json()).reason, reason, u);
    }
    assert.equal(s.calls.length, 0, '拦下来的请求不应该真的出去');
  } finally { s.restore(); }
});

test('Worker /fetch-md：跳转逐跳复查，公网 302 到内网被拦', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch((url) => {
    if (url.startsWith('https://evil.example.com/start')) {
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/secret' } });
    }
    throw new Error('不应该请求 ' + url);
  });
  try {
    const res = await w.fetch(req('https://evil.example.com/start.md'), env());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'redirect');
    assert.equal(s.calls.length, 1, '只应请求第一跳，第二跳在发出前就被拦下');
  } finally { s.restore(); }
});

test('Worker /fetch-md：正常取文 200，且请求带 redirect:manual', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => new Response('# 标题\n正文', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }));
  try {
    const res = await w.fetch(req('https://raw.githubusercontent.com/u/r/main/README.md'), env());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    assert.equal(await res.text(), '# 标题\n正文');
    assert.equal(s.calls[0].init.redirect, 'manual', '必须手动跟跳转，否则自动跟跳转会绕过逐跳复查');
  } finally { s.restore(); }
});

test('Worker /fetch-md：超 2MB 中断并 413', opts, async () => {
  const w = await loadWorker();
  const big = 'x'.repeat(3 * 1024 * 1024);
  const s = stubFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
  try {
    const res = await w.fetch(req('https://example.com/big.md'), env());
    assert.equal(res.status, 413);
    assert.equal((await res.json()).reason, 'too-large');
  } finally { s.restore(); }
});

test('Worker /fetch-md：HTML / 二进制 / 错误状态码分别归类', opts, async () => {
  const w = await loadWorker();
  let mode = 'html';
  const s = stubFetch(() => {
    if (mode === 'html') return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (mode === 'bin') return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    return new Response('nope', { status: 404 });
  });
  try {
    let res = await w.fetch(req('https://example.com/a'), env());
    assert.equal(res.status, 415);
    assert.equal((await res.json()).reason, 'html');

    mode = 'bin';
    res = await w.fetch(req('https://example.com/b'), env());
    assert.equal(res.status, 415);
    assert.equal((await res.json()).reason, 'binary');

    mode = '404';
    res = await w.fetch(req('https://example.com/c'), env());
    assert.equal(res.status, 502);
    assert.equal((await res.json()).reason, 'http-status');
  } finally { s.restore(); }
});

test('Worker /fetch-md：CORS 只回白名单 Origin', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => new Response('# x', { status: 200, headers: { 'content-type': 'text/markdown' } }));
  try {
    const okRes = await w.fetch(req('https://example.com/a.md', { headers: { origin: 'https://md.want.biz' } }), env());
    assert.equal(okRes.headers.get('access-control-allow-origin'), 'https://md.want.biz');

    const badRes = await w.fetch(req('https://example.com/a.md', { headers: { origin: 'https://evil.example.com' } }), env());
    assert.equal(badRes.headers.get('access-control-allow-origin'), null, '白名单外不回 ACAO');

    const badPre = await w.fetch(req('https://example.com/a.md', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }), env());
    assert.equal(badPre.status, 403, '白名单外的预检直接 403');

    const okPre = await w.fetch(req('https://example.com/a.md', { method: 'OPTIONS', headers: { origin: 'https://md.want.biz' } }), env());
    assert.equal(okPre.status, 204);
  } finally { s.restore(); }
});

test('Worker /fetch-md：进程内限流挡突发（第 31 次 429）', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => new Response('# x', { status: 200, headers: { 'content-type': 'text/markdown' } }));
  try {
    let last = null;
    for (let i = 0; i < 31; i++) {
      const res = await w.fetch(req('https://example.com/a.md', { headers: { 'cf-connecting-ip': '9.9.9.9' } }), env());
      if (i < 30) assert.equal(res.status, 200, '第 ' + (i + 1) + ' 次应放行');
      else { last = { status: res.status, body: await res.json() }; }
    }
    assert.equal(last.status, 429, '第 31 次应 429');
    assert.match(last.body.message, /Process/, '应由进程内计数器拦下');
  } finally { s.restore(); }
});

test('Worker /fetch-md：KV 兜底计数已满时也拦（跨 isolate 的慢刷）', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => new Response('# x', { status: 200, headers: { 'content-type': 'text/markdown' } }));
  // 模拟「另一个 isolate 已把这个 IP 记到 30 次」
  const RATE_KV = { async get() { return '30'; }, async put() { throw new Error('不应再写'); } };
  try {
    const res = await w.fetch(req('https://example.com/a.md', { headers: { 'cf-connecting-ip': '8.8.8.8' } }), env({ RATE_KV }));
    assert.equal(res.status, 429);
    assert.match((await res.json()).message, /KV/);
  } finally { s.restore(); }
});

test('Worker /fetch-md：KV 故障不影响正常取文（尽力而为，不 fail closed）', opts, async () => {
  const w = await loadWorker();
  const s = stubFetch(() => new Response('# x', { status: 200, headers: { 'content-type': 'text/markdown' } }));
  const RATE_KV = { async get() { throw new Error('KV down'); }, async put() { throw new Error('KV down'); } };
  try {
    const res = await w.fetch(req('https://example.com/a.md', { headers: { 'cf-connecting-ip': '7.7.7.7' } }), env({ RATE_KV }));
    assert.equal(res.status, 200);
  } finally { s.restore(); }
});
