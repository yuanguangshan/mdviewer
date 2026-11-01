'use strict';
/**
 * share-guard 单测：把「谁能写、写多大、写什么类型」的策略钉死。
 *   node --test "tests/*.test.js"
 * 被测文件是 ESM（lib/share-guard.mjs，Worker 侧用），因此在 CJS 测试里用动态 import。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let G;
test.before(async () => { G = await import('../lib/share-guard.mjs'); });

const okWrite = {
  method: 'POST',
  contentType: 'text/markdown;charset=utf-8',
  contentEncoding: null,
  contentLength: '6159',
  mdviewer: '1',
};

test('合法写入请求放行', () => {
  assert.deepEqual(G.checkWriteRequest(okWrite), { ok: true });
  assert.deepEqual(G.checkWriteRequest({ ...okWrite, method: 'PUT' }), { ok: true });
});

test('Content-Type 必须是 text/markdown（大小写/参数容忍）', () => {
  assert.equal(G.isMarkdownContentType('text/markdown'), true);
  assert.equal(G.isMarkdownContentType('TEXT/MARKDOWN; charset=utf-8'), true);
  assert.equal(G.isMarkdownContentType('text/markdown;charset=utf-8'), true);
  assert.equal(G.isMarkdownContentType('text/markdownx'), false);
  assert.equal(G.isMarkdownContentType('multipart/form-data; boundary=----WebKitFormBoundary'), false);
  assert.equal(G.isMarkdownContentType('application/x-www-form-urlencoded'), false);
  assert.equal(G.isMarkdownContentType('application/json'), false);
  assert.equal(G.isMarkdownContentType(''), false);
  assert.equal(G.isMarkdownContentType(null), false);

  const r = G.checkWriteRequest({ ...okWrite, contentType: 'multipart/form-data; boundary=x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
  assert.equal(r.reason, 'unsupported-media-type');
});

test('拒绝 Content-Encoding（实测的攻击载荷全部带 gzip）', () => {
  for (const enc of ['gzip', 'br', 'deflate', 'identity-ish']) {
    const r = G.checkWriteRequest({ ...okWrite, contentEncoding: enc });
    assert.equal(r.ok, false, enc);
    assert.equal(r.status, 415, enc);
    assert.equal(r.reason, 'content-encoding-not-allowed', enc);
  }
  assert.equal(G.checkWriteRequest({ ...okWrite, contentEncoding: '' }).ok, true);   // 空串视为未设置
});

test('体积上限 2MB（沿用现网既有上限），边界值精确', () => {
  assert.equal(G.MAX_WRITE_BYTES, 2 * 1024 * 1024);
  assert.equal(G.checkWriteRequest({ ...okWrite, contentLength: String(G.MAX_WRITE_BYTES) }).ok, true);
  const r = G.checkWriteRequest({ ...okWrite, contentLength: String(G.MAX_WRITE_BYTES + 1) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.reason, 'payload-too-large');

  // content-length 缺失（chunked）时不在头部阶段拦截，交给 checkBodySize 二次校验
  assert.equal(G.checkWriteRequest({ ...okWrite, contentLength: null }).ok, true);
  assert.equal(G.checkBodySize(G.MAX_WRITE_BYTES).ok, true);
  assert.equal(G.checkBodySize(G.MAX_WRITE_BYTES + 1).status, 413);
});

test('缺少/错误的客户端头一律 403', () => {
  for (const v of [undefined, null, '', '0', 'true', '2']) {
    const r = G.checkWriteRequest({ ...okWrite, mdviewer: v });
    assert.equal(r.ok, false, String(v));
    assert.equal(r.status, 403, String(v));
    assert.equal(r.reason, 'missing-client-header', String(v));
  }
});

test('灰度开关：requireClientHeader=false 时暂不校验该头（其余规则照样生效）', () => {
  // 第 1 步上线：老前端不带头也能写
  assert.deepEqual(G.checkWriteRequest({ ...okWrite, mdviewer: null }, { requireClientHeader: false }), { ok: true });
  // 但过滤规则不能被顺带关掉
  assert.equal(G.checkWriteRequest({ ...okWrite, mdviewer: null, contentEncoding: 'gzip' }, { requireClientHeader: false }).status, 415);
  assert.equal(G.checkWriteRequest({ ...okWrite, mdviewer: null, contentType: 'multipart/form-data' }, { requireClientHeader: false }).status, 415);
  assert.equal(G.checkWriteRequest({ ...okWrite, mdviewer: null, contentLength: 3e6 }, { requireClientHeader: false }).status, 413);
});

test('非 POST/PUT 方法 405', () => {
  for (const m of ['GET', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = G.checkWriteRequest({ ...okWrite, method: m });
    assert.equal(r.status, 405, m);
    assert.equal(r.reason, 'method-not-allowed', m);
  }
});

test('校验顺序：先编码、再类型、再大小、最后客户端头', () => {
  // 全都不合法时，应报最前面的那条（便于日志定位）
  const r = G.checkWriteRequest({
    method: 'POST', contentType: 'application/json',
    contentEncoding: 'gzip', contentLength: '99999999', mdviewer: null,
  });
  assert.equal(r.reason, 'content-encoding-not-allowed');
});

test('分享 id：现有全部对象格式均通过，异常形态一律拒绝', () => {
  // 真实存在的对象
  for (const id of ['0d998f67.md', '0da12a7b.md', '2786cb9a.md', 'da21cb50.md', 'ffffffff.md', '00000000.md']) {
    assert.equal(G.isValidShareId(id), true, id);
    assert.equal(G.checkReadRequest(id).ok, true, id);
  }
  // 攻击面：路径穿越 / 大小写 / 长度不对 / 扩展名不对 / 桶前缀
  for (const id of [
    '../etc/passwd', 'share/0d998f67.md', '0D998F67.md', '0d998f6.md',
    '0d998f67.md.bak', '0d998f67', '', null, undefined, 'x'.repeat(300),
    '00000000.md/', '..%2f..%2fetc.md', '0d998f67.md\n',
  ]) {
    assert.equal(G.isValidShareId(id), false, String(id));
  }
  const r = G.checkReadRequest('../etc/passwd');
  assert.equal(r.status, 400);
  assert.equal(r.reason, 'bad-id');
});

test('shareIdFromPath：兼容 / 与 /share/ 前缀，忽略查询串', () => {
  assert.equal(G.shareIdFromPath('/0d998f67.md'), '0d998f67.md');
  assert.equal(G.shareIdFromPath('/share/0d998f67.md'), '0d998f67.md');
  assert.equal(G.shareIdFromPath('0d998f67.md'), '0d998f67.md');
  assert.equal(G.shareIdFromPath('/0d998f67.md?x=1'), '0d998f67.md');
  assert.equal(G.shareIdFromPath('/'), '');
  assert.equal(G.shareIdFromPath(''), '');
  assert.equal(G.shareIdFromPath(null), '');
});
