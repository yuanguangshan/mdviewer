/**
 * lib/share-guard.mjs —— 分享接口（share.want.biz）的写入闸门
 *
 * 为什么单独成文件：
 *   - 这些判断是「安全策略」，必须能被单测覆盖（tests/share-guard.test.js）；
 *   - 它同时被 Cloudflare Worker（ESM，wrangler 打包）使用，所以用 .mjs 写 ESM；
 *   - 浏览器端不需要它，因此**不要**加进 sw.js 的 SHELL 预缓存列表。
 *
 * 背景（2026-11 实测）：R2 桶里出现了 3 份 `fast_recon_v6` 云凭据窃取载荷
 * （multipart + gzip + Next.js RSC 外壳），以及 `1=1`、`{"requests":[]}`、
 * `need_fuck=yes` 等扫描器探测串。它们全都「投递成功、执行失败」，但说明
 * 这个接口是公开可写的。本文件的作用就是把「谁能写、写多大、写什么类型」钉死。
 *
 * 设计原则：只挡「应用永远不会发出的请求」，零误伤。
 *   · 本应用上传的永远是 text/markdown（见 app.js 的 shareViaR2）
 *   · 浏览器根本无法设置 Content-Encoding
 *   · 正文分享上限 2MB（沿用现网既有上限，不引入行为回退）
 *   · 带一个自定义头，让无脑扫描器连门槛都摸不到（不是安全边界，是降噪）
 */

/**
 * 单次写入体积上限：2MB。
 * 与现网 Worker 原有的 MAX_BYTES（2 * 1024 * 1024）保持一致——本次只做「收紧请求形态」，
 * 不顺带把体积上限调小，避免把历史上能分享的 1~2MB 文档挡在门外。
 * （现有最大的真实文档 602KB，远低于此。）
 */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/** 合法的分享 id：8 位小写十六进制 + .md（与现有全部对象一致） */
export const SHARE_ID_RE = /^[0-9a-f]{8}\.md$/;

/** 允许的写入方法 */
export const WRITE_METHODS = ['POST', 'PUT'];

/**
 * 路径 → 分享 id。
 * 兼容 `/xxxx.md` 与桶内前缀 `/share/xxxx.md` 两种形式；不含 id 时返回 ''。
 */
export function shareIdFromPath(pathname) {
  let p = String(pathname == null ? '' : pathname).split('?')[0].split('#')[0];
  p = p.replace(/^\/+/, '');
  if (p.startsWith('share/')) p = p.slice('share/'.length);
  return p;
}

export function isValidShareId(id) {
  return SHARE_ID_RE.test(String(id == null ? '' : id));
}

/** Content-Type 必须是 text/markdown（允许带 charset 等参数） */
export function isMarkdownContentType(ct) {
  return /^text\/markdown\s*(;|$)/i.test(String(ct == null ? '' : ct).trim());
}

/**
 * 写入请求闸门。
 * @param {{method?:string, contentType?:string|null, contentEncoding?:string|null,
 *          contentLength?:string|number|null, mdviewer?:string|null}} req
 * @param {{requireClientHeader?:boolean}} [opts]
 *        requireClientHeader=false 用于「灰度期」：Worker 先上线过滤规则，
 *        等前端（带 X-Mdviewer 头的新版本）铺开后再把这个检查打开。
 *        否则无论先发哪一端，都会有一段「生成分享链接失败」的窗口。
 * @returns {{ok:true} | {ok:false, status:number, reason:string, message:string}}
 */
export function checkWriteRequest(req, opts) {
  const r = req || {};
  const requireClientHeader = !(opts && opts.requireClientHeader === false);
  const method = String(r.method || 'POST').toUpperCase();

  if (!WRITE_METHODS.includes(method)) {
    return fail(405, 'method-not-allowed', 'method not allowed');
  }
  // 浏览器无法设置 Content-Encoding；出现它基本等于非浏览器客户端（实测的攻击载荷全部带 gzip）
  if (r.contentEncoding) {
    return fail(415, 'content-encoding-not-allowed', 'content-encoding not allowed');
  }
  if (!isMarkdownContentType(r.contentType)) {
    return fail(415, 'unsupported-media-type', 'unsupported media type: expected text/markdown');
  }
  // content-length 可能缺失（chunked），所以调用方还要在实际读取后再校验一次字节数
  const len = Number(r.contentLength);
  if (Number.isFinite(len) && len > MAX_WRITE_BYTES) {
    return fail(413, 'payload-too-large', 'payload too large: limit ' + MAX_WRITE_BYTES + ' bytes');
  }
  if (requireClientHeader && String(r.mdviewer == null ? '' : r.mdviewer) !== '1') {
    return fail(403, 'missing-client-header', 'forbidden: missing X-Mdviewer header');
  }
  return { ok: true };
}

/** 实际字节数二次校验（应对 chunked 传输 / 伪造 content-length） */
export function checkBodySize(byteLength) {
  const n = Number(byteLength) || 0;
  if (n > MAX_WRITE_BYTES) {
    return fail(413, 'payload-too-large', 'payload too large: limit ' + MAX_WRITE_BYTES + ' bytes');
  }
  return { ok: true };
}

/** 读取请求闸门：只放行形如 8hex.md 的 key，防奇怪路径与桶内乱写 */
export function checkReadRequest(id) {
  if (!isValidShareId(id)) {
    return fail(400, 'bad-id', 'bad share id');
  }
  return { ok: true };
}

function fail(status, reason, message) {
  return { ok: false, status, reason, message };
}
