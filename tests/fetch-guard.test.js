'use strict';
/**
 * tests/fetch-guard.test.js —— 「按网址取文」安检规则的单测
 *
 * 这组用例是安全边界的说明书：每条 fail 都对应一种真实的滥用方式。
 * 若将来有人想放宽规则，必须先改这里，改动会留在 diff 里，不会被顺手改掉。
 */
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/fetch-guard.js');

const ok = (u) => G.checkFetchUrl(u);

test('checkFetchUrl：正常 https 文档地址通过', () => {
  for (const u of [
    'https://raw.githubusercontent.com/user/repo/main/README.md',
    'https://gist.githubusercontent.com/u/abc/raw/x.md',
    'https://blog.example.com/posts/2026/hello.md',
  ]) {
    const r = ok(u);
    assert.equal(r.ok, true, u + ' 应通过：' + JSON.stringify(r));
    assert.equal(r.host, new URL(u).hostname);
  }
});

test('checkFetchUrl：非 https 一律拒绝（http / file / data / ftp）', () => {
  for (const u of ['http://example.com/a.md', 'file:///etc/passwd', 'data:text/markdown,x', 'ftp://example.com/a.md']) {
    const r = ok(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, 'https-only');
    assert.equal(r.status, 400);
  }
});

test('checkFetchUrl：空 / 畸形 / 超长地址被挡住', () => {
  assert.equal(ok('').reason, 'empty');
  assert.equal(ok('   ').reason, 'empty');
  assert.equal(ok(null).reason, 'empty');
  assert.equal(ok('not a url').reason, 'bad-url');
  assert.equal(ok('https://').reason, 'bad-url');
  assert.equal(ok('https://a.com/' + 'x'.repeat(3000)).reason, 'url-too-long');
});

test('checkFetchUrl：URL 里带账号密码被拒绝（防钓鱼 + 防凭据进日志）', () => {
  const r = ok('https://user:pass@evil.example.com/a.md');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'userinfo');
});

test('checkFetchUrl：只允许 443，非标端口拒绝', () => {
  assert.equal(ok('https://example.com:443/a.md').ok, true);
  for (const u of ['https://example.com:8443/a.md', 'https://example.com:80/a.md', 'https://example.com:22/a.md']) {
    assert.equal(ok(u).reason, 'port', u);
  }
});

test('checkFetchUrl：任何 IP 字面量都拒绝（不做网段枚举，避免漏判）', () => {
  for (const u of [
    'https://10.0.0.10/a.md',
    'https://192.168.1.1/a.md',
    'https://172.16.0.1/a.md',
    'https://127.0.0.1/a.md',
    'https://169.254.169.254/latest/meta-data/',
    'https://1.1.1.1/a.md',
    'https://[::1]/a.md',
    'https://[fd00::1]/a.md',
  ]) {
    const r = ok(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, 'ip-literal', u);
  }
});

test('checkFetchUrl：本机 / 内网 / 保留域名拒绝', () => {
  for (const u of [
    'https://localhost/a.md',
    'https://intranet/a.md',
    'https://myrouter/a.md',
    'https://printer.local/a.md',
    'https://metadata.internal/a.md',
    'https://nas.lan/a.md',
    'https://x.home.arpa/a.md',
  ]) {
    const r = ok(u);
    assert.equal(r.ok, false, u);
    assert.ok(r.reason === 'no-dot-host' || r.reason === 'private-host', u + ' → ' + r.reason);
  }
});

test('checkFetchUrl：主机名形态非法被拒（下划线 / 空 label / 超长）', () => {
  for (const u of ['https://bad_host.example.com/a.md', 'https://a..b.com/a.md', 'https://-x.example.com/a.md']) {
    assert.equal(ok(u).reason, 'bad-host', u);
  }
});

test('checkRedirect：每一跳都重新检查，公网跳内网会被拦', () => {
  const from = 'https://example.com/a.md';
  assert.equal(G.checkRedirect(from, 'https://cdn.example.com/b.md').ok, true);
  assert.equal(G.checkRedirect(from, '/relative/b.md').ok, true);        // 相对地址按基准解析
  assert.equal(G.checkRedirect(from, 'http://example.com/b.md').reason, 'https-only');
  assert.equal(G.checkRedirect(from, 'https://169.254.169.254/x').reason, 'ip-literal');
  assert.equal(G.checkRedirect(from, 'https://localhost/x').reason, 'no-dot-host');
  // 相对地址永远可解析 → 放行；但基准地址坏掉时必须失败
  assert.equal(G.checkRedirect('not-a-url', 'https://example.com/a.md').ok, false);
});

test('contentTypeKind：只有文本类放行，HTML 单独归类', () => {
  assert.equal(G.contentTypeKind('text/markdown'), 'ok');
  assert.equal(G.contentTypeKind('text/markdown; charset=utf-8'), 'ok');
  assert.equal(G.contentTypeKind('TEXT/PLAIN;charset=UTF-8'), 'ok');
  assert.equal(G.contentTypeKind('application/octet-stream'), 'ok');
  assert.equal(G.contentTypeKind('text/html; charset=utf-8'), 'html');
  assert.equal(G.contentTypeKind('application/xhtml+xml'), 'html');
  assert.equal(G.contentTypeKind('image/png'), 'unsupported');
  assert.equal(G.contentTypeKind('application/json'), 'unsupported');
  assert.equal(G.contentTypeKind(''), 'missing');
  assert.equal(G.contentTypeKind(null), 'missing');
  assert.equal(G.isAllowedContentType('text/markdown'), true);
  assert.equal(G.isAllowedContentType('text/html'), false);
});

test('exceedsLimit：按字节数判断，上限可覆盖', () => {
  assert.equal(G.exceedsLimit(G.MAX_FETCH_BYTES), false);
  assert.equal(G.exceedsLimit(G.MAX_FETCH_BYTES + 1), true);
  assert.equal(G.exceedsLimit(10, 9), true);
  assert.equal(G.exceedsLimit(9, 9), false);
});

test('looksLikeText：文本通过，二进制与图片被挡', () => {
  const enc = new TextEncoder();
  assert.equal(G.looksLikeText(new Uint8Array(0)), true);
  assert.equal(G.looksLikeText(enc.encode('# 标题\n\n正文 hello world\n')), true);
  assert.equal(G.looksLikeText(enc.encode('a'.repeat(4096))), true);
  // NUL 字节 → 二进制
  assert.equal(G.looksLikeText(new Uint8Array([0x61, 0x00, 0x62])), false);
  // 常见魔数
  assert.equal(G.looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);   // PNG
  assert.equal(G.looksLikeText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), false);               // PDF
  assert.equal(G.looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), false);               // ZIP
  // 控制字符比例过高 → 二进制
  const noisy = new Uint8Array(1000).fill(0x01);
  assert.equal(G.looksLikeText(noisy), false);
  // 非字节数组
  assert.equal(G.looksLikeText(null), false);
  assert.equal(G.looksLikeText('abc'), false);
});

test('fileNameFromUrl：从路径取标题，压掉危险字符', () => {
  assert.equal(G.fileNameFromUrl('https://a.com/x/y/hello.md'), 'hello.md');
  assert.equal(G.fileNameFromUrl('https://a.com/x/%E4%B8%AD%E6%96%87.md'), '中文.md');
  assert.equal(G.fileNameFromUrl('https://a.com/readme'), 'readme.md');
  assert.equal(G.fileNameFromUrl('https://a.com/'), 'remote.md');
  assert.equal(G.fileNameFromUrl('https://a.com/a/b/..%2F..%2Fetc%2Fpasswd.md'), '.._.._etc_passwd.md');
  assert.equal(G.fileNameFromUrl('https://a.com/x/a\u0000b.md'), 'a_b.md');
});

test('describeFailure：每个失败理由都有中文说明', () => {
  for (const reason of [
    'empty', 'url-too-long', 'bad-url', 'https-only', 'userinfo', 'port', 'bad-host',
    'ip-literal', 'no-dot-host', 'private-host', 'html', 'unsupported', 'missing-type',
    'too-large', 'binary', 'timeout', 'redirect', 'network', 'http-status', 'disabled', 'bad-response',
  ]) {
    const msg = G.describeFailure(reason);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0);
    assert.ok(!msg.includes('未知原因'), reason + ' 缺少说明');
  }
  assert.ok(G.describeFailure('something-new').includes('未知原因'));   // 未知理由有兜底
});
