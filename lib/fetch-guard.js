/*!
 * fetch-guard.js —— 「从任意 URL 取 Markdown」的安检规则（纯函数，三端共用）
 *
 * 为什么单独成文件：
 *   同一份规则要被三处使用，写三遍必然漂移：
 *     1. 浏览器（mdviewer 前端）：点「从 URL 打开」时先做本地预检，不合规立刻给出人话提示，
 *        不必白跑一次网络请求；加载后还用它描述服务端返回的错误；
 *     2. 取文代理（ops/serve-web.js 的 /__fetch）：真正的执行侧，所有判断在这里必须再生效一遍
 *        （前端的预检只是 UX，不是安全边界）；
 *     3. Cloudflare Worker（worker/share-worker.mjs 的 /fetch-md）：公网侧同一份规则。
 *   纯函数、不碰 DOM、不碰网络 → 可以直接 `node --test` 覆盖。
 *
 * 加载方式（与 lib/md-core.js 同一套路）：
 *   浏览器：<script src="./lib/fetch-guard.js"></script> → window.FetchGuard
 *   Node：require('./lib/fetch-guard.js') → module.exports
 *   Worker（ESM）：import guard from '../lib/fetch-guard.js' → 默认导出即 module.exports
 *
 * 威胁模型（写清楚，避免以后有人「顺手放宽」）：
 *   取文代理本质是「别人能指挥我们的服务器去访问任意地址」。若不加限制，它就是个公开的
 *   SSRF / 开放反代：可探内网（169.254.169.254 云元数据、10.x 服务）、可当刷别人站点的跳板、
 *   可回连攻击者的 C2。所以规则的核心不是「能不能取到」，而是「绝不去取我们不该碰的地方」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FetchGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================================================
   * 一、常量（所有上限集中在这里，改数值只改这一处）
   * ============================================================ */

  /** 单次取文体积上限：2MB。与分享接口的 MAX_WRITE_BYTES 对齐，不引入第二套口径。 */
  const MAX_FETCH_BYTES = 2 * 1024 * 1024;

  /** 取文超时：对方站点拖住连接会占住代理的并发，10 秒够慢站勉强返回，又不至于被拖死。 */
  const FETCH_TIMEOUT_MS = 10000;

  /** URL 长度上限：正常 md 链接几百字符，2048 只用来挡畸形/放大的输入。 */
  const MAX_URL_LEN = 2048;

  /** 最多跟随几次跳转。每一跳都要重新过检查（否则「公网 → 内网」可绕过）。 */
  const MAX_REDIRECTS = 2;

  /** 允许的响应类型（去掉 charset 等参数后比较）。text/html 故意不在其中。 */
  const ALLOWED_CONTENT_TYPES = [
    'text/markdown',
    'text/x-markdown',
    'application/markdown',
    'text/plain',
    'application/octet-stream',   // 不少静态托管对 .md 就吐这个，靠 looksLikeText() 兜底
  ];

  /** 禁止使用的主机名后缀（内网 / 本机 / 特殊域）。 */
  const BLOCKED_HOST_SUFFIXES = [
    '.local', '.localhost', '.internal', '.intranet', '.lan', '.home.arpa',
    '.corp', '.private', '.test', '.example', '.invalid',
  ];

  /** 主机名每一段（label）的合法形态：字母数字开头结尾，中间允许连字符。 */
  const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

  /** 常见的「这是二进制」魔数，命中即拒绝（比逐字节判 UTF-8 更直观、更好测）。 */
  const BINARY_MAGIC = [
    [0x89, 0x50, 0x4e, 0x47],       // PNG
    [0xff, 0xd8, 0xff],             // JPEG
    [0x25, 0x50, 0x44, 0x46],       // %PDF
    [0x50, 0x4b, 0x03, 0x04],       // ZIP（docx/xlsx 也走这个）
    [0x1f, 0x8b],                   // gzip
    [0x47, 0x49, 0x46, 0x38],       // GIF8
  ];

  /* ============================================================
   * 二、结果对象
   * ============================================================ */

  function fail(status, reason, message) {
    return { ok: false, status: status || 400, reason: reason || 'invalid', message: message || reason || 'invalid' };
  }

  /** 给用户看的中文说明。前端只负责把它塞进 toast/状态栏。 */
  const FAIL_REASONS = {
    empty: '没有填网址',
    'url-too-long': '网址太长（超过 2048 字符）',
    'bad-url': '这不是一个合法的网址',
    'https-only': '只支持 https:// 开头的网址',
    userinfo: '网址里不允许带账号密码（形如 https://user:pass@…）',
    port: '只允许标准端口 443',
    'bad-host': '网址的主机名不合法',
    'ip-literal': '不直接用 IP 地址访问，请用域名',
    'no-dot-host': '这是本机/内网主机名，出于安全不允许',
    'private-host': '这是内网或保留域名，出于安全不允许',
    html: '这个网址返回的是网页（HTML），不是 Markdown',
    unsupported: '这个网址返回的不是文本文件',
    'missing-type': '对方没有声明文件类型，无法确认是 Markdown',
    'too-large': '文件超过 2MB 上限',
    binary: '内容看起来是二进制文件，不是文本',
    timeout: '对方网站 10 秒内没有响应',
    redirect: '跳转次数过多，或被跳到了不允许的地址',
    network: '网络不通，或对方拒绝访问',
    'http-status': '对方返回了错误状态码',
    disabled: '取文服务未部署或未开启（serve-web 的 /__fetch · Worker 的 FETCH_ENABLED=1）',
    'bad-response': '取文服务返回了无法识别的内容',
  };

  function describeFailure(reason) {
    return FAIL_REASONS[reason] || '取文失败（未知原因：' + (reason || '-') + '）';
  }

  /* ============================================================
   * 三、URL 检查（核心安全边界）
   * ============================================================ */

  /**
   * 校验一个待取文地址。
   * 只做「形状与目标」检查，不判断内容（内容交给 contentType* / looksLikeText）。
   * @param {string} raw 用户/调用方给的原始地址
   * @returns {{ok:true, url:URL, href:string, host:string} | {ok:false, status:number, reason:string, message:string}}
   */
  function checkFetchUrl(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return fail(400, 'empty');
    if (s.length > MAX_URL_LEN) return fail(414, 'url-too-long');

    let u;
    try { u = new URL(s); } catch (_) { return fail(400, 'bad-url'); }

    // 只 https：http 明文、file:、data:、blob:、javascript: 一律不取。
    if (u.protocol !== 'https:') return fail(400, 'https-only');

    // user:pass@host 形式：既可能用来钓鱼，也会把凭据写进日志。
    if (u.username || u.password) return fail(400, 'userinfo');

    // 只允许标准端口，避免拿代理去打非标端口上的服务。
    if (u.port && u.port !== '443') return fail(400, 'port');

    const h = String(u.hostname || '').toLowerCase();
    if (!h) return fail(400, 'bad-host');

    // IPv6 字面量（URL 解析后是 [::1] 这种形态）
    if (h.charAt(0) === '[') return fail(400, 'ip-literal');
    // IPv4 字面量：不接受任何裸 IP。看起来粗暴，但省掉了「内网网段漏判一个」这类经典事故，
    // 而正常文档托管都有域名（github raw、gist、各家博客）。
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return fail(400, 'ip-literal');
    // 单段主机名（localhost、intranet、myrouter…）：DNS 里这类名字通常由内网解析。
    if (h.indexOf('.') < 0) return fail(400, 'no-dot-host');
    if (h.length > 253) return fail(400, 'bad-host');

    for (let i = 0; i < BLOCKED_HOST_SUFFIXES.length; i++) {
      if (h.endsWith(BLOCKED_HOST_SUFFIXES[i])) return fail(400, 'private-host');
    }
    const labels = h.split('.');
    for (let i = 0; i < labels.length; i++) {
      if (!LABEL_RE.test(labels[i])) return fail(400, 'bad-host');
    }

    return { ok: true, url: u, href: u.href, host: h };
  }

  /**
   * 跳转目标检查：以「上一跳的地址」为基准。
   * 只有 https、且新地址自身合法才算通过；不做「同域限制」——
   * 同域限制挡不住 SSRF（攻击者可以在自己域名下 302 到内网），真正的防线是重新跑一遍 checkFetchUrl。
   * @param {string} fromHref 上一跳地址
   * @param {string} toRaw 响应头 Location 里的原始值（可能是相对路径）
   */
  function checkRedirect(fromHref, toRaw) {
    let base;
    try { base = new URL(fromHref); } catch (_) { return fail(400, 'bad-url'); }
    let next;
    try { next = new URL(String(toRaw == null ? '' : toRaw), base); } catch (_) { return fail(400, 'bad-url'); }
    return checkFetchUrl(next.href);   // 关键：跳转后的地址必须从零复查，不能继承上一跳的信任
  }

  /* ============================================================
   * 四、内容检查
   * ============================================================ */

  /**
   * Content-Type 归类。
   * @returns {'ok'|'html'|'unsupported'|'missing'}
   */
  function contentTypeKind(ct) {
    const base = String(ct == null ? '' : ct).split(';')[0].trim().toLowerCase();
    if (!base) return 'missing';
    if (base === 'text/html' || base === 'application/xhtml+xml') return 'html';   // 单独给一个理由，提示更准确
    return ALLOWED_CONTENT_TYPES.indexOf(base) >= 0 ? 'ok' : 'unsupported';
  }

  function isAllowedContentType(ct) {
    return contentTypeKind(ct) === 'ok';
  }

  /** 响应体字节数是否超限（调用方应在「边读边数」时用它，不要只信 Content-Length）。 */
  function exceedsLimit(byteLength, maxBytes) {
    return Number(byteLength) > (maxBytes == null ? MAX_FETCH_BYTES : maxBytes);
  }

  /**
   * 粗判一段字节是不是文本。
   * 目的只有一个：拦住「把 zip/png 当 md 塞进编辑器」这种明显不是文本的情况。
   * 不是严格的编码校验——过了它的内容仍会被前端 DOMPurify 再洗一遍。
   * @param {Uint8Array|number[]} bytes
   * @returns {boolean}
   */
  function looksLikeText(bytes) {
    // 只接受字节数组/视图：字符串的 length 也是数字，若放进来会把每个字符当字节比较
    if (!bytes || typeof bytes !== 'object' || typeof bytes.length !== 'number') return false;
    if (typeof bytes[0] !== 'number' && bytes.length > 0) return false;
    const n = bytes.length;
    if (n === 0) return true;                       // 空文件：合法（空的 md）
    // 魔数
    for (let m = 0; m < BINARY_MAGIC.length; m++) {
      const sig = BINARY_MAGIC[m];
      if (n < sig.length) continue;
      let hit = true;
      for (let i = 0; i < sig.length; i++) { if (bytes[i] !== sig[i]) { hit = false; break; } }
      if (hit) return false;
    }
    // 采样前 8KB：NUL 直接判二进制；控制字符比例过高也判二进制
    const span = Math.min(n, 8192);
    let ctrl = 0;
    for (let i = 0; i < span; i++) {
      const b = bytes[i];
      if (b === 0) return false;
      if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
    }
    return ctrl / span <= 0.02;
  }

  /**
   * 从 URL 猜一个文件名（仅用于编辑器标题，不做任何路径拼接）。
   * @param {string} href
   */
  function fileNameFromUrl(href) {
    let pathname = '';
    try { pathname = new URL(href).pathname || ''; } catch (_) { pathname = String(href || ''); }
    let base = pathname.split('/').filter(Boolean).pop() || '';
    try { base = decodeURIComponent(base); } catch (_) { /* 保留原文 */ }
    base = base.split('?')[0].split('#')[0];
    if (!base) return 'remote.md';
    if (!/\.(md|markdown|txt)$/i.test(base)) base += '.md';
    // 只留安全字符：标题会进状态栏/文件名建议，压掉控制字符与路径分隔符
    return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'remote.md';
  }

  return {
    MAX_FETCH_BYTES, FETCH_TIMEOUT_MS, MAX_URL_LEN, MAX_REDIRECTS,
    ALLOWED_CONTENT_TYPES, BLOCKED_HOST_SUFFIXES,
    checkFetchUrl, checkRedirect,
    contentTypeKind, isAllowedContentType, exceedsLimit,
    looksLikeText, fileNameFromUrl,
    describeFailure,
  };
});
