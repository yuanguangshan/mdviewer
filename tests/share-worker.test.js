'use strict';
/**
 * Worker 端到端（进程内）测试：用假的 R2 桶把 worker/share-worker.mjs 真正跑一遍。
 *
 *   node --test "tests/*.test.js"
 *
 * ⚠ worker/ 目录被 .gitignore 排除（项目约定：Worker 源码仅本地维护）。
 *   因此在没有该目录的环境（如 CI checkout）里，本测试自动 skip，而不是报错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const WORKER = join(__dirname, '..', 'worker', 'share-worker.mjs');
const HAS_WORKER = existsSync(WORKER);

let worker = null;
test.before(async () => {
  if (!HAS_WORKER) return;
  worker = (await import(WORKER)).default;
});

/* ---------- 假的 R2 桶 ---------- */
function makeEnv(extra) {
  const store = new Map();
  return {
    store,
    env: {
      ...(extra || {}),
      R2_BUCKET: {
        async get(key) {
          const rec = store.get(key);
          if (!rec) return null;
          return { body: rec.data, httpEtag: '"fake-etag"' };
        },
        async put(key, data, opts) {
          store.set(key, { data, opts });
        },
      },
    },
  };
}

const BASE = 'https://share.want.biz';
const req = (path, init) => new Request(BASE + path, init);

const goodHeaders = {
  'Content-Type': 'text/markdown;charset=utf-8',
  'X-Mdviewer': '1',
};

const t = (name, fn) => test(name, { skip: HAS_WORKER ? false : 'worker/ 不存在（未纳入 git）' }, fn);

/* ---------- 用例 ---------- */

t('OPTIONS 预检放行，且允许 X-Mdviewer 头', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/x.md', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 200);          // 与现网实现一致（返回头 + 空体）
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /X-Mdviewer/i);
  assert.match(res.headers.get('access-control-allow-methods'), /PUT/);
});

t('POST 创建 → 返回 8 位 hex id，并落进桶', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(req('/', {
    method: 'POST', headers: goodHeaders, body: '# 你好\n',
  }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.match(j.id, /^[0-9a-f]{8}\.md$/);
  assert.ok(store.has(j.id));
  assert.equal(store.get(j.id).opts.httpMetadata.contentType, 'text/markdown; charset=utf-8');
});

t('GET 回读：正文与响应头正确', async () => {
  const { env } = makeEnv();
  const created = await (await worker.fetch(req('/', {
    method: 'POST', headers: goodHeaders, body: '# 标题\n\n正文\n',
  }), env)).json();

  const res = await worker.fetch(req('/' + created.id), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '# 标题\n\n正文\n');
});

t('PUT 覆盖同一个 id', async () => {
  const { env, store } = makeEnv();
  const { id } = await (await worker.fetch(req('/', {
    method: 'POST', headers: goodHeaders, body: 'v1',
  }), env)).json();

  const res = await worker.fetch(req('/' + id, {
    method: 'PUT', headers: goodHeaders, body: 'v2-覆盖',
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, id);

  const back = await (await worker.fetch(req('/' + id), env)).text();
  assert.equal(back, 'v2-覆盖');
  assert.equal(store.size, 1, '覆盖不应产生新对象');
});

t('GET 不存在 → 404；非法 id → 400', async () => {
  const { env } = makeEnv();
  assert.equal((await worker.fetch(req('/deadbeef.md'), env)).status, 404);
  assert.equal((await worker.fetch(req('/etc/passwd'), env)).status, 400);
  assert.equal((await worker.fetch(req('/ABC12345.md'), env)).status, 400);
});

t('HEAD 返回头但不返回体', async () => {
  const { env } = makeEnv();
  const { id } = await (await worker.fetch(req('/', {
    method: 'POST', headers: goodHeaders, body: 'x',
  }), env)).json();
  const res = await worker.fetch(req('/' + id, { method: 'HEAD' }), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

/* ---- 第 1 层加固：每一条都对应一个真实出现过的垃圾样本 ---- */

t('拦截：缺 X-Mdviewer（对应 need_fuck=yes 那类手工探测）', async () => {
  const { env, store } = makeEnv({ REQUIRE_CLIENT_HEADER: '1' });   // 头校验属第 3 步才打开
  const res = await worker.fetch(req('/', {
    method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: 'need_fuck=yes',
  }), env);
  assert.equal(res.status, 403);
  assert.equal(store.size, 0);
});

t('拦截：multipart（对应 WebKitFormBoundary 攻击载荷）', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(req('/', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundary1c88aca5', 'X-Mdviewer': '1' },
    body: '------WebKitFormBoundary1c88aca5\r\n',
  }), env);
  assert.equal(res.status, 415);
  assert.equal(store.size, 0);
});

t('拦截：Content-Encoding: gzip（3 份 fast_recon_v6 载荷均带此头）', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(req('/', {
    method: 'POST',
    headers: { ...goodHeaders, 'Content-Encoding': 'gzip' },
    body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
  }), env);
  assert.equal(res.status, 415);
  assert.equal(store.size, 0);
});

t('拦截：正文超过 2MB', async () => {
  const { env, store } = makeEnv();
  const big = 'a'.repeat(2 * 1024 * 1024 + 1);
  const res = await worker.fetch(req('/', { method: 'POST', headers: goodHeaders, body: big }), env);
  assert.equal(res.status, 413);
  assert.equal(store.size, 0);
});

t('拦截：PUT 到非法 id（防桶内乱写 / 路径穿越）', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(req('/../secret.md', { method: 'PUT', headers: goodHeaders, body: 'x' }), env);
  assert.ok([400, 404].includes(res.status), 'status=' + res.status);
  assert.equal(store.size, 0);
});

t('拦截：DELETE 等未支持方法 → 405（说明对象无法经此接口删除）', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/0d998f67.md', { method: 'DELETE' }), env);
  assert.equal(res.status, 405);
});

t('被拦请求也带 CORS 头（否则浏览器侧只会看到网络错误）', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  assert.equal(res.status, 415);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

t('1~2MB 的合法文档仍可用（回归：不把历史上能分享的文档挡在门外）', async () => {
  const { env } = makeEnv();
  const doc = '# 长文\n\n' + '正文段落。'.repeat(40000);   // ~ 700KB 左右
  assert.ok(doc.length < 1024 * 1024);
  const res = await worker.fetch(req('/', { method: 'POST', headers: goodHeaders, body: doc }), env);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.equal(await (await worker.fetch(req('/' + id), env)).text(), doc);
});

/* ---- 灰度开关（三步上线用） ---- */

t('灰度期：REQUIRE_CLIENT_HEADER 未设时，不带 X-Mdviewer 的老前端仍能写', async () => {
  const { env, store } = makeEnv();            // 未设 REQUIRE_CLIENT_HEADER
  const res = await worker.fetch(req('/', {
    method: 'POST', headers: { 'Content-Type': 'text/markdown;charset=utf-8' }, body: '老前端',
  }), env);
  assert.equal(res.status, 200);
  assert.equal(store.size, 1);
});

t('灰度期也不能放行 gzip / multipart / 超限（过滤规则无条件生效）', async () => {
  const { env, store } = makeEnv();
  const mk = (headers, body) => req('/', { method: 'POST', headers, body });

  assert.equal((await worker.fetch(mk(
    { 'Content-Type': 'text/markdown', 'Content-Encoding': 'gzip' }, new Uint8Array([31, 139])), env)).status, 415);
  assert.equal((await worker.fetch(mk(
    { 'Content-Type': 'multipart/form-data; boundary=x' }, '--x'), env)).status, 415);
  assert.equal((await worker.fetch(mk(
    { 'Content-Type': 'text/markdown' }, 'a'.repeat(2 * 1024 * 1024 + 1)), env)).status, 413);
  assert.equal(store.size, 0);
});

t('开关打开（REQUIRE_CLIENT_HEADER=1）后强制校验头', async () => {
  const { env, store } = makeEnv({ REQUIRE_CLIENT_HEADER: '1' });
  const blockedRes = await worker.fetch(req('/', {
    method: 'POST', headers: { 'Content-Type': 'text/markdown;charset=utf-8' }, body: '扫描器',
  }), env);
  assert.equal(blockedRes.status, 403);
  assert.equal(store.size, 0);

  const okRes = await worker.fetch(req('/', { method: 'POST', headers: goodHeaders, body: '正常' }), env);
  assert.equal(okRes.status, 200);
  assert.equal(store.size, 1);
});

/* ---- 保留现网既有行为，别在加固时改坏 ---- */

t('GET / 仍是健康检查（原行为保留）', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'md-share-worker' });
});

t('POST / 自动生成 8 位短码 id（与原实现一致）', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/', { method: 'POST', headers: goodHeaders, body: 'x' }), env);
  assert.match((await res.json()).id, /^[0-9a-f]{8}\.md$/);
});

t('被拦请求返回带 reason 的 JSON（便于排查）', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(res.status, 415);
  const j = await res.json();
  assert.equal(j.reason, 'unsupported-media-type');
});
