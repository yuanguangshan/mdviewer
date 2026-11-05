/*!
 * md-core.js —— mdviewer 的「纯函数内核」
 *
 * 设计约束（与项目一贯的零构建原则一致）：
 *   1. 不依赖 DOM、不依赖浏览器 API（唯一例外：TextEncoder/TextDecoder/CompressionStream，
 *      它们在浏览器与 Node 18+ 中都是全局的）。
 *   2. 同时支持两种加载方式：
 *        - 浏览器：<script src="./lib/md-core.js"></script> → window.MdCore
 *        - Node：require('./lib/md-core.js') → module.exports
 *      因此可以直接用 `node --test` 单测，不需要 jsdom / 打包器。
 *   3. app.js 里凡是「纯逻辑」都从本文件取，避免同一算法在 UI 层再写一遍。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MdCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================================================
   * 一、文本基础工具
   * ============================================================ */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 归一化颜色：仅接受 #rgb / #rrggbb，统一转小写 6 位；其余（含空串）视为「跟随主题」。
  function normalizeTextColor(v) {
    if (typeof v !== 'string') return '';
    let s = v.trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
  }

  function humanBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // 「版本号比较」：a<b → -1，相等 → 0，a>b → 1。用于离线缓存与页面版本一致性自检。
  function compareVersion(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /* ============================================================
   * 二、标题 slug / 唯一化 / 源码行映射
   *
   * 历史缺陷：DOM 侧 `h.id = slugify(text)` 不去重，两个同名标题会产生重复 id，
   * 目录只能跳到第一个；且源码侧 buildHeadingMap 用另一套规则算 slug，
   * 遇到 `## **粗**体` 这类行内标记时与 DOM textContent 不一致 → 锚点错位。
   * 现在两侧共用 createSlugger + stripInlineMd，顺序一致、编号一致。
   * ============================================================ */

  // 去掉行内 Markdown 标记，得到「渲染后 textContent 大致等价」的纯文本
  function stripInlineMd(s) {
    return String(s == null ? '' : s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')            // 图片渲染后无文本
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')            // 链接 → 链接文字
      .replace(/`+([^`]*)`+/g, '$1')                      // 行内代码
      .replace(/(\*\*|__)(.*?)\1/g, '$2')                 // 粗体
      .replace(/(\*|_)(.*?)\1/g, '$2')                    // 斜体
      .replace(/~~(.*?)~~/g, '$1')                        // 删除线
      .replace(/<[^>]*>/g, '')                            // 行内 HTML
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => (
        { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]
      ))
      .trim();
  }

  // 保留：所有语言的字母 / 数字 / 组合符（覆盖中文、日文假名、韩文、西里尔…）、下划线、空格、连字符
  function slugify(text) {
    return String(text == null ? '' : text)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // 有状态的 slug 生成器：同名标题依次得到 foo / foo-2 / foo-3
  function createSlugger() {
    const seen = new Map();
    return function next(text) {
      const base = slugify(text);
      if (!base) return '';
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n === 0 ? base : base + '-' + (n + 1);
    };
  }

  /**
   * 建立「标题 slug → 源码行号（0 基）」映射。
   * 与 DOM 侧共用同一 slugger 与同一顺序，因此二者一一对应。
   * 会跳过围栏代码块内的 `# ...`（否则代码注释会被误判为标题，导致锚点行号偏移）。
   */
  function buildHeadingLineMap(src) {
    const map = new Map();
    const slugger = createSlugger();
    const lines = String(src == null ? '' : src).split('\n');
    let fenceChar = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        const ch = fence[1][0];
        if (!fenceChar) fenceChar = ch;
        else if (ch === fenceChar) fenceChar = '';
        continue;
      }
      if (fenceChar) continue;
      const m = line.match(/^ {0,3}#{1,6}\s+(.*)$/);
      if (!m) continue;
      const slug = slugger(stripInlineMd(m[1]));
      if (slug) map.set(slug, i);
    }
    return map;
  }

  /* ============================================================
   * 三、行偏移缓存（把「全文 split('\n')」从热路径里去掉）
   * ============================================================ */

  // offsets[i] = 第 i 行（0 基）的起始字符位；offsets.length = 行数（末行以 \n 结尾时含一个空行）
  function lineOffsets(text) {
    const s = String(text == null ? '' : text);
    const out = [0];
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 10) out.push(i + 1);
    }
    return out;
  }

  // 字符位 → { line（1 基）, col（1 基） }
  function posToLineCol(offsets, pos) {
    const p = Math.max(0, Number(pos) || 0);
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= p) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: p - offsets[lo] + 1 };
  }

  /* ============================================================
   * 四、统计
   * ============================================================ */

  // 与原实现保持一致的字数口径：中日韩逐字计数，其余按「连续的字母数字串」计词
  const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

  function countWords(text, opts) {
    const t = String(text == null ? '' : text);
    const cjk = (t.match(CJK_RE) || []).length;
    const enWords = (t.replace(CJK_RE, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    const words = cjk + enWords;
    const perMin = (opts && opts.perMin) || 300;
    return { cjk, enWords, words, readMin: Math.max(1, Math.round(words / perMin)) };
  }

  /* ============================================================
   * 五、正则安全执行（防 ReDoS 把页面冻死）
   *
   * 用户可以在「查找与替换」里输入任意正则，直接 new RegExp 后对 1MB 正文跑 match，
   * 一个 (a+)+$ 就能让标签页无响应。这里给匹配加「时间预算 + 次数上限」。
   * ============================================================ */

  const MAX_PATTERN_LEN = 200;

  function validatePattern(src) {
    if (typeof src !== 'string' || !src) return { ok: false, reason: 'empty' };
    if (src.length > MAX_PATTERN_LEN) return { ok: false, reason: 'too-long', limit: MAX_PATTERN_LEN };
    return { ok: true };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * 带预算的匹配计数。返回 { count, truncated, ms }。
   *
   * ⚠ 能力边界（重要）：浏览器/Node 都无法在【单次 exec() 内部】打断正则执行。
   * 因此本函数只能拦住「匹配次数极多导致总耗时过长」，拦不住「一个灾难性回溯的
   * 单次匹配就把主线程挂住」。真正的兜底是 runRegexJob + Web Worker + terminate()
   * （见 lib/md-regex-worker.js），同步路径仅在 Worker 不可用时降级使用。
   */
  function safeMatchCount(text, re, opts) {
    opts = opts || {};
    const budgetMs = opts.budgetMs == null ? 120 : opts.budgetMs;
    const maxMatches = opts.maxMatches == null ? 50000 : opts.maxMatches;
    const src = String(text == null ? '' : text);
    const flags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';
    const g = new RegExp(re.source, flags);
    const t0 = now();
    let count = 0, truncated = false, m;
    while ((m = g.exec(src)) !== null) {
      count++;
      if (m[0] === '') g.lastIndex++;          // 零宽断言：手动前进，防死循环
      if ((count & 0x3ff) === 0 && now() - t0 > budgetMs) { truncated = true; break; }
      if (count >= maxMatches) { truncated = true; break; }
      if (g.lastIndex > src.length) break;
    }
    return { count, truncated, ms: now() - t0 };
  }

  /**
   * 正则任务执行器（纯函数，供 Worker 与降级路径共用）。
   *
   * @param {{mode:'count'|'replaceAll'|'find', src:string, pattern:string, flags?:string,
   *          replacement?:string, from?:number, budgetMs?:number, maxMatches?:number}} job
   * @returns {{count?:number, truncated?:boolean, text?:string, index?:number, length?:number, wrapped?:boolean}}
   * 抛错时 err.code 为 'BAD_REGEX' / 'EMPTY_PATTERN' / 'PATTERN_TOO_LONG'，便于 UI 区分文案。
   */
  function runRegexJob(job) {
    job = job || {};
    const mode = job.mode || 'count';
    const src = String(job.src == null ? '' : job.src);

    const v = validatePattern(job.pattern);
    if (!v.ok) {
      const e = new Error(v.reason === 'too-long'
        ? '查找内容过长（上限 ' + MAX_PATTERN_LEN + ' 字符）'
        : '查找内容为空');
      e.code = v.reason === 'too-long' ? 'PATTERN_TOO_LONG' : 'EMPTY_PATTERN';
      throw e;
    }

    let re;
    try {
      re = new RegExp(job.pattern, job.flags || '');
    } catch (e) {
      const err = new Error('正则无效：' + e.message);
      err.code = 'BAD_REGEX';
      throw err;
    }
    const gFlags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';

    if (mode === 'count') {
      const r = safeMatchCount(src, re, job);
      return { count: r.count, truncated: r.truncated };
    }

    if (mode === 'replaceAll') {
      const r = safeMatchCount(src, re, job);
      if (r.truncated) return { count: r.count, truncated: true, text: src };
      return {
        count: r.count,
        truncated: false,
        text: src.replace(new RegExp(re.source, gFlags), String(job.replacement == null ? '' : job.replacement)),
      };
    }

    if (mode === 'find') {
      const g = new RegExp(re.source, gFlags);
      g.lastIndex = Math.max(0, Number(job.from) || 0);
      let m = g.exec(src);
      let wrapped = false;
      if (!m) { g.lastIndex = 0; m = g.exec(src); wrapped = true; }
      if (!m) return { index: -1, length: 0, wrapped: false, groups: [] };
      // 零宽匹配：告知调用方需要 +1 前进，避免上层原地死循环。
      // groups 用于上层解析 $1/$& 反向引用（把 match 数组整体回传）。
      return { index: m.index, length: m[0].length, text: m[0], wrapped, groups: Array.from(m) };
    }

    throw new Error('未知正则任务类型：' + mode);
  }

  /* ============================================================
   * 六、查找替换的「替换串」语义
   * \$ → 字面 $，\\ → 字面反斜杠，\n\t\r\f\v → 控制字符，$1/$& 保留为反向引用
   * ============================================================ */

  function processReplacement(s) {
    s = String(s == null ? '' : s);
    s = s.split('\\$').join('$$');
    s = s.split('\\\\').join('@@__BS__@@');
    s = s.split('\\n').join('\n').split('\\t').join('\t')
      .split('\\r').join('\r').split('\\f').join('\f').split('\\v').join('\v');
    return s.split('@@__BS__@@').join('\\');
  }

  // 单处替换：把 $1/$2/$&/$$ 按当前 match 数组求出真实文本（原生 replace 对「无捕获组的字面正则」会当成字面量）
  function evaluateMatchReplacement(replStr, matchArray) {
    return String(replStr == null ? '' : replStr).replace(/\$(\$|&|\d+)/g, (ref, p) => {
      if (p === '$') return '$';
      if (p === '&') return matchArray[0];
      const idx = parseInt(p, 10);
      if (idx > 0 && idx < matchArray.length) {
        return matchArray[idx] !== undefined ? matchArray[idx] : '';
      }
      return ref;
    });
  }

  /* ============================================================
   * 七、中英排版
   * ============================================================ */

  // 中文（Han 全字符集，含扩展 A/B）与拉丁字母/数字之间补空格
  function formatSpacing(text) {
    return String(text == null ? '' : text)
      .replace(/(\p{Script=Han})([A-Za-z0-9])/gu, '$1 $2')
      .replace(/([A-Za-z0-9])(\p{Script=Han})/gu, '$1 $2');
  }

  /* ============================================================
   * 八、AI 流式响应解析（SSE / 非流式 JSON 双兼容）
   * ============================================================ */

  // 解析单行 SSE：返回本次增量文本（keepalive / [DONE] / 非 JSON → ''）
  function parseSseLine(line) {
    const l = String(line == null ? '' : line).trim();
    if (!l.startsWith('data:')) return '';
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') return '';
    try {
      const j = JSON.parse(payload);
      const ch = j.choices && j.choices[0];
      return (ch && ((ch.delta && ch.delta.content) || (ch.message && ch.message.content))) || '';
    } catch (_) {
      return '';
    }
  }

  // 整段响应兜底解析：既能吃 SSE 流，也能吃普通 JSON（老接口 / 不守规矩的代理）
  function parseAiContent(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('data:')) {
      let out = '';
      for (const rawLine of trimmed.split('\n')) out += parseSseLine(rawLine);
      return out.trim();
    }
    try {
      const data = JSON.parse(trimmed);
      return String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    } catch (_) {
      return '';
    }
  }

  /* ============================================================
   * 九、书籍写作：章节解析 / 字数目标解析
   * ============================================================ */

  function cnChapterNum(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const d = { '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '两': 2, '贰': 2, '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9 };
    let n = 0;
    const b = s.search(/[百佰]/);
    if (b !== -1) { n += (d[s[b - 1]] || 1) * 100; s = s.slice(b + 1).replace(/^[零〇]/, ''); }
    const t = s.search(/[十拾]/);
    if (t !== -1) { n += (d[s[t - 1]] || 1) * 10; s = s.slice(t + 1); }
    if (s) n += d[s] || 0;
    return n > 0 ? n : null;
  }

  // 从大纲文本解析章节列表：匹配「第X章」行（容忍 ##/-/1. 等前缀与 **粗体** 装饰），按章号去重排序
  function parseChapterList(text) {
    const re = /^[^\n]{0,24}?第([零〇一二两三四五六七八九十百\d壹贰叁肆伍陆柒捌玖拾佰]+)章[\s:：·、.．\-—]*([^\n]*)$/gm;
    const seen = new Set(); const list = [];
    let m;
    while ((m = re.exec(String(text == null ? '' : text)))) {
      const num = cnChapterNum(m[1]);
      if (!num || seen.has(num)) continue;
      seen.add(num);
      const title = (m[2] || '').replace(/[*_`#]/g, '').replace(/[（(][^）)]*[）)]/g, '').trim();
      list.push({ num, title, at: m.index });
    }
    return list.sort((a, b) => a.num - b.num);
  }

  // 已写章节进度：靠生成时插入的 <!-- ai-chapter:N --> 隐形标记判断
  function writtenChapterNums(text) {
    const nums = new Set();
    const re = /<!--\s*ai-chapter:(\d+)\s*-->/g;
    let m;
    while ((m = re.exec(String(text == null ? '' : text)))) nums.add(parseInt(m[1], 10));
    return nums;
  }

  // 中文数字小值解析（≤99999，支持 千/百/十 组合）
  function cnSmall(s) {
    const d = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    let n = 0;
    if (s.includes('千')) { const p = s.split('千'); n += (p[0] ? cnSmall(p[0]) : 1) * 1000; s = p[1] || ''; }
    if (s.includes('百')) { const p = s.split('百'); n += (p[0] ? cnSmall(p[0]) : 1) * 100; s = p[1] || ''; }
    if (s.includes('十')) { const p = s.split('十'); n += (p[0] ? cnSmall(p[0]) : 1) * 10; s = p[1] || ''; }
    if (s) n += d[s] || 0;
    return n;
  }

  // 「X字/X万字/X千字」（阿拉伯或中文、小数、链式如 1万五千）→ 具体字数
  function parseCountValue(seg) {
    const unit = { '亿': 1e8, '万': 1e4, '千': 1e3, '百': 1e2, '十': 10 };
    let total = 0, matched = false;
    const re = /(\d+(?:\.\d+)?)\s*(亿|万|千|百|十)?|([一二两三四五六七八九十百零]+)(亿|万|千|百|十)/g;
    let m;
    while ((m = re.exec(String(seg == null ? '' : seg)))) {
      let num, u = '';
      if (m[1] !== undefined && m[1] !== '') { num = parseFloat(m[1]); u = m[2] || ''; }
      else if (m[3] !== undefined && m[3] !== '') { num = cnSmall(m[3]); u = m[4] || ''; }
      else continue;
      if (!num || isNaN(num)) continue;
      total += num * (unit[u] || 1);
      matched = true;
    }
    return matched ? Math.round(total) : null;
  }

  function parseWordCount(text) {
    if (!text) return null;
    let m = text.match(/字数[目标要求约]*\s*[:：]?\s*([^\n，。；,.;]{0,20}?字)/);
    let seg = m ? m[1] : null;
    if (!seg) {
      m = text.match(/(?:不少于|至少|≥|大于等于|以上|约|大约)?\s*[0-9一二两三四五六七八九十百千万零]+(?:\.[0-9]+)?\s*[万千]?\s*字/);
      seg = m ? m[0] : null;
    }
    if (!seg) return null;
    const cmp = /(不少于|至少|≥|大于等于|以上|最少|目标)/.test(text) ? 'min' : 'approx';
    const count = parseCountValue(seg);
    if (!count || count < 200) return null;
    return { count, cmp };
  }

  /* ============================================================
   * 九·五、公式保护（渲染前抽出，消毒后回填）
   *
   * 为什么需要这一层：把 markdown 交给 marked 之前，公式必须先"抢"出来。
   *   · marked 配了 breaks:true，行间 $$ 块里的换行会被变成 <br>，
   *     于是 DOM 里成了多段文本，KaTeX 的定界符匹配跨不过去 → 整块不渲染（现状 bug）；
   *   · marked 把 `\,` `\{` `\%` 这类反斜杠当 CommonMark 转义，反斜杠被吃掉，
   *     `x^{2}\,dx` 渲染出来成了 `x^{2},dx`；
   *   · 围栏代码块里的 $$ 与行内代码里的 $x$ 必须原样保留，不能当公式。
   * 做法：扫描时把公式换成纯字母数字的占位符（xMDVMATHx0x），
   *      DOM 消毒后再用 katex.render 填回去 —— 公式内容全程不经过 marked。
   * 纯函数、无 DOM，可在 node --test 里直接覆盖（tests/math-protect.test.js）。
   * ============================================================ */

  /** 按围栏代码块把源文切成 [{code, text}]，围栏内容原样保留 */
  function splitByFences(src) {
    const lines = String(src == null ? '' : src).split('\n');
    const segs = [];
    let buf = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    const flush = (isCode) => {
      if (buf.length) segs.push({ code: isCode, text: buf.join('\n') });
      buf = [];
    };
    for (const line of lines) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!inFence && m) {
        flush(false);
        inFence = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        buf.push(line);
        continue;
      }
      if (inFence) {
        buf.push(line);
        const close = new RegExp('^ {0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
        if (close.test(line)) { inFence = false; flush(true); }
        continue;
      }
      buf.push(line);
    }
    flush(inFence);   // 未闭合的围栏整体当代码
    return segs;
  }

  /* ⚠ 踩过的坑（2026-11-05）：不要用同一个 /g 正则既做 exec 又做 replace。
   *   String.replace 用完该正则会把它内部的 lastIndex 重置为 0，于是
   *   `while ((m = re.exec(line)) !== null) { line.replace(re, ' ') }` 会永远命中同一条 → 死循环。
   *   这段当时挂在「每条消息渲染」的路径上，页面一加载就冻死（点什么都没反应，
   *   看着像"界面显示异常"，实际是主线程空转）。
   *   约束：exec 用的 /g 正则不要在循环体里被 replace/split 复用；需要就用独立副本
   *   `new RegExp(re.source, re.flags)`。下面的 protectMath 已按此约束实现。
   */

  /**
   * 处理一段「非代码」文本里的行内公式（$...$）。
   * 规则与 KaTeX auto-render 对齐：开 $ 后不能是空白、闭 $ 前不能是空白、闭 $ 后不能紧跟数字
   * （否则「价格 $5 到 $10」会被误判成公式）；反斜杠转义（\$）不当分隔符。
   */
  function protectInlineInSegment(seg, blocks, tokenBase) {
    let out = '';
    let i = 0;
    while (i < seg.length) {
      const ch = seg[i];
      if (ch === '\\') { out += seg.slice(i, i + 2); i += 2; continue; }   // 跳过转义对
      if (ch !== '$') { out += ch; i++; continue; }
      if (seg[i + 1] === '$') { out += '$'; i++; continue; }               // 行内里出现的 $$ 交给行间处理
      let j = i + 1;
      while (j < seg.length) {
        if (seg[j] === '\\') { j += 2; continue; }
        if (seg[j] === '$') break;
        j++;
      }
      if (j >= seg.length) { out += ch; i++; continue; }                    // 没闭合，原样保留
      const tex = seg.slice(i + 1, j);
      const bad = !tex.length || /^\s/.test(tex) || /\s$/.test(tex) || /^[0-9]/.test(seg[j + 1] || '');
      if (bad) { out += ch; i++; continue; }
      const id = blocks.length;
      blocks.push({ id, tex, display: false });
      out += tokenBase + id + 'x';
      i = j + 1;
    }
    return out;
  }

  /**
   * 把 Markdown 源里的公式抽成占位符。
   * @returns {{text:string, blocks:Array<{id:number,tex:string,display:boolean}>, tokenBase:string}}
   *   渲染时：marked.parse(result.text) → 消毒 → 按 tokenBase 找文本节点 → katex.render(blocks[i])。
   */
  function protectMath(src, opts) {
    const source = String(src == null ? '' : src);
    // 占位符必须是「纯字母数字」：marked 不会动它，DOMPurify 也不会剥它。
    let tokenBase = (opts && opts.tokenBase) || 'xMDVMATHx';
    while (source.indexOf(tokenBase) >= 0) tokenBase += 'z';   // 极端情况：源文里已有同名串
    const blocks = [];
    const segs = splitByFences(source);
    const out = [];

    for (const seg of segs) {
      if (seg.code) { out.push(seg.text); continue; }
      // 行间公式：$$ ... $$（可跨行）。要求前面的 $$ 不被反斜杠转义。
      let text = seg.text;
      let acc = '';
      let rest = text;
      for (;;) {
        const m = /(^|[^\\])\$\$([\s\S]+?)\$\$/.exec(rest);
        if (!m) { acc += rest; break; }
        const before = m.index + m[1].length;
        acc += rest.slice(0, before);
        const id = blocks.length;
        blocks.push({ id, tex: m[2], display: true });
        // 前后补空行：让 marked 单独成段，回填时替换整段更干净
        acc += '\n\n' + tokenBase + id + 'x\n\n';
        rest = rest.slice(m.index + m[0].length);
      }
      // 行内公式：按行内代码切开，代码段原样保留。
      // ⚠ 这里必须用 '' 拼回去（2026-11-05 修）：早先用 out.push 逐段塞进数组、
      // 最后 join('\n')，等于在每一处行内代码两侧插入了换行。段落里换行只是多一个空格，
      // 但表格行里的换行会把一行拆成多行 —— 渲染出来表格被切碎、段落变成多行，
      // 看起来像"格式全乱了"。公式保护不该改变除公式以外的任何字符。
      let rebuilt = '';
      const pieces = acc.split(/(`+[^`]*`+)/);
      for (const piece of pieces) {
        rebuilt += /^`+[\s\S]*`+$/.test(piece) ? piece : protectInlineInSegment(piece, blocks, tokenBase);
      }
      out.push(rebuilt);
    }

    // 各段之间用一个换行还原围栏边界（splitByFences 切割时吃掉了那个换行）
    return { text: out.join('\n'), blocks, tokenBase };
  }

  /** 回填失败时的降级：把占位符还原成源码，至少内容不丢 */
  function restoreMathSource(blocks, tokenBase) {
    return (text) => String(text == null ? '' : text).replace(
      new RegExp(tokenBase + '(\\d+)x', 'g'),
      (all, i) => {
        const b = blocks[Number(i)];
        if (!b) return all;
        return (b.display ? '$$' : '$') + b.tex + (b.display ? '$$' : '$');
      }
    );
  }

  /* ============================================================
   * 十、博客发布：标题 / Front Matter / 纯文本
   * ============================================================ */

  const BLOG_TITLE_MAX_LEN = 40;

  function blogSmartCut(str, maxLen) {
    const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
    const idx = [
      s.indexOf('。'), s.indexOf('！'), s.indexOf('？'),
      s.indexOf('. '), s.indexOf('! '), s.indexOf('? '), s.indexOf('\n')
    ].filter((i) => i >= 0);
    const punct = idx.length ? Math.min(...idx) : -1;
    let cut = punct >= 0 ? s.slice(0, punct) : s;
    if (cut.length > maxLen) cut = cut.slice(0, maxLen);
    return cut || 'Untitled';
  }

  function parseBlogMeta(markdown) {
    markdown = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
    const meta = {};
    let body = markdown;
    const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      body = markdown.slice(fm[0].length);
      fm[1].split(/\r?\n/).forEach((line) => {
        const m = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
        if (m) {
          const k = m[1].trim().toLowerCase();
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          if (k === 'tags') {
            try { meta.tags = v.startsWith('[') ? JSON.parse(v.replace(/'/g, '"')) : v.split(',').map((s) => s.trim()).filter(Boolean); }
            catch (_) {
              const raw = v.trim();
              meta.tags = (raw.startsWith('[') && raw.endsWith(']'))
                ? raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
                : v.split(',').map((s) => s.trim()).filter(Boolean);
            }
          } else { meta[k] = v; }
        }
      });
    }
    let title = meta.title;
    if (!title) {
      const h1 = body.match(/^\s{0,3}#\s+(.+?)\s*$/m);
      if (h1) title = h1[1].trim();
    }
    if (!title) {
      const firstNonEmptyLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
      title = blogSmartCut(firstNonEmptyLine, BLOG_TITLE_MAX_LEN);
    } else if (title.length > BLOG_TITLE_MAX_LEN) {
      title = blogSmartCut(title, BLOG_TITLE_MAX_LEN);
    }
    return { title: title || 'Untitled', tags: Array.isArray(meta.tags) ? meta.tags : [], body };
  }

  function blogMdToPlain(markdown) {
    return String(markdown == null ? '' : markdown)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`+/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/(\*\*|__|\*|_)/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ============================================================
   * 十一、历史快照策略
   *
   * 历史缺陷：每次停手 800ms 就 push 一条完整快照，20 条封顶 →
   * 写下第 21 段文字后，最早的版本就被挤掉，等于「最近几分钟的 20 份近似副本」。
   * 现在改为「距上次 ≥ minInterval，或长度变化 ≥ minRatio」才留档。
   * ============================================================ */

  function shouldSnapshot(o) {
    o = o || {};
    const minInterval = o.minInterval == null ? 5 * 60 * 1000 : o.minInterval;
    const minRatio = o.minRatio == null ? 0.05 : o.minRatio;
    const t = o.now == null ? Date.now() : o.now;
    if (!o.lastAt) return true;
    if (t - o.lastAt >= minInterval) return true;
    const prevLen = Number(o.prevLen) || 0;
    const newLen = Number(o.newLen) || 0;
    if (!prevLen) return newLen > 0;
    return Math.abs(newLen - prevLen) / prevLen >= minRatio;
  }

  /* ============================================================
   * 十二、ZIP（store 模式写，store/deflate 读）
   *
   * 用途：「一键备份全库」——文库只存在 IndexedDB 里，清站点数据即全丢。
   * 不用第三方库（JSZip ~100KB），自己写 ZIP 结构的读写，纯函数、可单测。
   * ============================================================ */

  let _crcTable = null;
  function crc32(u8) {
    if (!_crcTable) {
      _crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function dosDateTime(d) {
    d = d || new Date();
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time, date };
  }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data && data.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    return new Uint8Array(0);
  }

  /**
   * @param {{name:string, data:Uint8Array|string, date?:Date}[]} files
   * @returns {Uint8Array} zip 字节流（method=0 存储，UTF-8 文件名）
   */
  function zipStore(files) {
    const list = (files || []).map((f) => ({
      name: String(f.name),
      bytes: toU8(f.data),
      date: f.date || new Date(),
    }));
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const f of list) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.bytes);
      const { time, date } = dosDateTime(f.date);

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);      // 本地文件头签名
      lv.setUint16(4, 20, true);              // version needed
      lv.setUint16(6, 0x0800, true);          // 通用标志：UTF-8 文件名
      lv.setUint16(8, 0, true);               // method = store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, f.bytes.length, true); // 压缩后大小
      lv.setUint32(22, f.bytes.length, true); // 原始大小
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);              // extra len
      lh.set(nameBytes, 30);
      locals.push(lh, f.bytes);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);      // 中央目录头签名
      cv.setUint16(4, 20, true);              // version made by
      cv.setUint16(6, 20, true);              // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.bytes.length, true);
      cv.setUint32(24, f.bytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);              // extra
      cv.setUint16(32, 0, true);              // comment
      cv.setUint16(34, 0, true);              // disk
      cv.setUint16(36, 0, true);              // internal attrs
      cv.setUint32(38, 0, true);              // external attrs
      cv.setUint32(42, offset, true);         // 本地头偏移
      ch.set(nameBytes, 46);
      centrals.push(ch);

      offset += lh.length + f.bytes.length;
    }

    const cdSize = centrals.reduce((a, b) => a + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, list.length, true);
    ev.setUint16(10, list.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const total = offset + cdSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of locals) { out.set(part, p); p += part.length; }
    for (const part of centrals) { out.set(part, p); p += part.length; }
    out.set(eocd, p);
    return out;
  }

  /**
   * 读取 zip（支持 store 与 deflate；deflate 依赖 DecompressionStream）。
   * @returns {Promise<{name:string, data:Uint8Array}[]>}
   */
  async function unzipStore(bytes) {
    const u8 = toU8(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // 从尾部找 EOCD（PK\x05\x06）
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');

    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    let p = cdOffset;

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 中央目录损坏');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(dataStart, dataStart + compSize);

      let data;
      if (method === 0) {
        data = raw.slice();
      } else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压 deflate 压缩的 zip');
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error('不支持的压缩方式：' + method);
      }
      out.push({ name, data });
    }
    return out;
  }

  // === 命令面板模糊匹配 ===
  // 规则：包含子串直接给高分（越靠前越高）；否则按子序列命中，连续命中额外加分。
  // 下沉到内核是为了能单测——面板"搜不到东西"是最难靠肉眼发现的故障。
  function fuzzyScore(query, label) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return 1;
    const L = String(label || '').toLowerCase();
    const Q = q.toLowerCase();
    const at0 = L.indexOf(Q);
    if (at0 >= 0) return 1000 - at0;
    let i = 0, score = 0, streak = 0;
    for (const ch of Q) {
      const at = L.indexOf(ch, i);
      if (at < 0) return 0;
      streak = at === i ? streak + 1 : 1;
      score += 10 + streak * 5;
      i = at + 1;
    }
    return score;
  }

  // === 编辑区「源码高亮」 ===
  // 为什么不直接用 hljs 的 markdown 语法：那套语法是给「渲染后的 markdown」写的，
  // 拿它高亮源码会出三类错，且都是真实发生过的：
  //   ① front matter 里的下划线被配成强调：`sync_time … content_hash` 跨行配成 <em>，
  //      于是整块文字变紫变斜（用户截图里"有些字变成斜体、颜色也变了"就是这个）；
  //   ② 强调 / 标题被加粗或倾斜 → 字宽变了，覆盖层与 textarea 的字符位置对不上，整行错位；
  //   ③ 代码围栏里的内容被当正文解析（`# 注释` 变成标题）。
  // 所以这里自己按行扫：只上颜色，绝不改 font-style / font-weight / font-size。
  const SRC_KEY = 'src-key', SRC_STR = 'src-str', SRC_NUM = 'src-num',
    SRC_BOOL = 'src-bool', SRC_COMMENT = 'src-comment', SRC_CODE = 'src-code',
    SRC_H = 'src-h', SRC_BULLET = 'src-bullet', SRC_QUOTE = 'src-quote',
    SRC_HR = 'src-hr', SRC_FENCE = 'src-fence', SRC_STRONG = 'src-strong',
    SRC_EM = 'src-em', SRC_URL = 'src-url', SRC_TABLE = 'src-table',
    SRC_MARKER = 'src-marker', SRC_LANG = 'src-lang';

  function span(cls, text) { return '<span class="' + cls + '">' + escapeHtml(text) + '</span>'; }

  // 行内：代码 > 加粗 > 斜体 > 链接，逐层切开，避免嵌套打架
  function highlightSrcInline(text) {
    let out = '';
    const parts = String(text).split(/(`+[^`\n]*`+)/);
    for (const part of parts) {
      if (/^`+[\s\S]*`+$/.test(part)) {
        const tick = part.match(/^`+/)[0];
        out += '<span class="' + SRC_CODE + '">' + span(SRC_MARKER, tick) +
          escapeHtml(part.slice(tick.length, part.length - tick.length)) +
          span(SRC_MARKER, tick) + '</span>';
        continue;
      }
      out += highlightSrcPlain(part);
    }
    return out;
  }
  function highlightSrcPlain(seg) {
    let out = '';
    // 一次扫描：加粗 / 斜体 / 链接，按出现顺序处理，未命中的部分原样转义。
    // 语法标记（** * [ ]( ) ）单独包一层 src-marker 只调透明度 —— 不删字符、不改字宽，
    // 这样"看起来像渲染过"，但覆盖层与 textarea 仍逐字对齐（这是覆盖层方案的红线）。
    const re = /(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\[[^\]\n]*\]\([^)\n]*\))|(\*[^*\n]+\*)/g;
    let last = 0, m;
    while (m = re.exec(seg)) {
      out += escapeHtml(seg.slice(last, m.index));
      const tok = m[0];
      if (m[1]) {
        const inner = tok.slice(2, -2);
        out += '<span class="' + SRC_STRONG + '">' + span(SRC_MARKER, tok.slice(0, 2)) +
          highlightSrcPlain(inner) + span(SRC_MARKER, tok.slice(-2)) + '</span>';
      } else if (m[2]) {
        const mm = tok.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
        out += span(SRC_MARKER, '[') + highlightSrcPlain(mm[1]) + span(SRC_MARKER, '](') +
          span(SRC_URL, mm[2]) + span(SRC_MARKER, ')');
      } else if (m[3]) {
        // 单个 * 的斜体：两侧不能紧邻字母数字，否则 3*4*5 这类算式会被误判
        const before = seg[m.index - 1] || '', after = seg[m.index + tok.length] || '';
        if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) out += escapeHtml(tok);
        else out += '<span class="' + SRC_EM + '">' + span(SRC_MARKER, '*') +
          highlightSrcPlain(tok.slice(1, -1)) + span(SRC_MARKER, '*') + '</span>';
      }
      last = m.index + tok.length;
    }
    out += escapeHtml(seg.slice(last));
    return out;
  }

  // YAML front matter 的一行
  function highlightSrcYaml(line) {
    if (/^\s*#/.test(line)) return span(SRC_COMMENT, line);
    const m = line.match(/^(\s*)([A-Za-z0-9_.\-\u4e00-\u9fa5]+)(\s*:)(\s*)(.*)$/);
    if (!m) {
      const li = line.match(/^(\s*)(-\s+)(.*)$/);
      if (li) return escapeHtml(li[1]) + span(SRC_BULLET, li[2]) + highlightSrcInline(li[3]);
      return highlightSrcInline(line);
    }
    const [, ind, key, colon, sp, val] = m;
    let v;
    const t = val.trim();
    if (!t) v = '';
    else if (/^["'].*["']$/.test(t)) v = span(SRC_STR, val);
    else if (/^-?\d+(\.\d+)?$/.test(t)) v = span(SRC_NUM, val);
    else if (/^(true|false|null|yes|no|~)$/i.test(t)) v = span(SRC_BOOL, val);
    else if (/^#/.test(t)) v = span(SRC_COMMENT, val);
    else if (/^[\[{]/.test(t)) v = span(SRC_STR, val);
    else v = highlightSrcInline(val);
    return escapeHtml(ind) + span(SRC_KEY, key) + escapeHtml(colon + sp) + v;
  }

  /**
   * 把 markdown 源码转成「只上色」的高亮 HTML。
   * 硬性约束：去掉所有标签后必须与原文逐字相同（tests 里有断言），
   * 且输出里不允许出现任何 font-* 样式（那是覆盖层错位的根源）。
   */
  function highlightMarkdownSource(src) {
    const lines = String(src == null ? '' : src).split('\n');
    const out = [];
    let i = 0;
    // ① front matter：仅当首行是 --- 且 40 行内能闭合
    if (lines.length && /^---\s*$/.test(lines[0])) {
      let close = -1;
      for (let k = 1; k < Math.min(lines.length, 40); k++) {
        if (/^(---|\.\.\.)\s*$/.test(lines[k])) { close = k; break; }
      }
      if (close > 0) {
        out.push(span(SRC_HR, lines[0]));
        for (let k = 1; k < close; k++) out.push(highlightSrcYaml(lines[k]));
        out.push(span(SRC_HR, lines[close]));
        i = close + 1;
      }
    }
    // ② 正文：按行判定块级结构，围栏内部整块不上行内高亮
    let fence = null;
    for (; i < lines.length; i++) {
      const line = lines[i];
      const fm = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) {
          out.push(span(SRC_FENCE, line)); fence = null;
        } else {
          out.push(span(SRC_FENCE, line));
        }
        continue;
      }
      if (fm) {
        fence = fm[1];
        out.push('<span class="' + SRC_FENCE + '">' + span(SRC_MARKER, fm[1]) +
          (fm[2].trim() ? span(SRC_LANG, fm[2]) : escapeHtml(fm[2])) + '</span>');
        continue;
      }
      const h = line.match(/^( {0,3})(#{1,6})(\s+)(.*)$/);
      if (h) {
        out.push(escapeHtml(h[1]) + '<span class="' + SRC_H + ' src-h' + h[2].length + '">' +
          span(SRC_MARKER, h[2]) + escapeHtml(h[3]) + highlightSrcInline(h[4]) + '</span>');
        continue;
      }
      // 只有 # 没有内容的空标题行（正在输入时很常见）也要上色
      if (/^ {0,3}#{1,6}\s*$/.test(line)) { out.push(span(SRC_H, line)); continue; }
      if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(span(SRC_HR, line)); continue; }
      const q = line.match(/^(\s*)(>\s?)(.*)$/);
      if (q) { out.push(escapeHtml(q[1]) + span(SRC_QUOTE, q[2]) + highlightSrcInline(q[3])); continue; }
      // 任务清单：- [ ] / - [x] 的方括号按"状态"上色
      const task = line.match(/^(\s*)([-*+])(\s+)\[([ xX])\](\s*)(.*)$/);
      if (task) {
        out.push(escapeHtml(task[1]) + span(SRC_BULLET, task[2]) + escapeHtml(task[3]) +
          '<span class="' + (task[4] === ' ' ? SRC_BOOL : SRC_STR) + '">[' + escapeHtml(task[4]) + ']</span>' +
          escapeHtml(task[5]) + highlightSrcInline(task[6]));
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
      if (li) { out.push(escapeHtml(li[1]) + span(SRC_BULLET, li[2]) + escapeHtml(li[3]) + highlightSrcInline(li[4])); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        // 表格：竖线淡成"框线"，单元格文字照常（整行不上单一色，否则看起来像注释）
        const cells = line.split(/(\|)/);
        out.push('<span class="' + SRC_TABLE + '">' + cells.map((c) => (
          c === '|' ? span(SRC_MARKER, c) : highlightSrcInline(c)
        )).join('') + '</span>');
        continue;
      }
      out.push(highlightSrcInline(line));
    }
    return out.join('\n');
  }

  return {
    // 文本
    escapeHtml, normalizeTextColor, humanBytes, compareVersion, stripInlineMd,
    // 标题
    slugify, createSlugger, buildHeadingLineMap,
    // 行偏移
    lineOffsets, posToLineCol,
    // 统计
    countWords,
    // 正则安全
    MAX_PATTERN_LEN, validatePattern, safeMatchCount, runRegexJob,
    // 替换串
    processReplacement, evaluateMatchReplacement,
    // 排版
    formatSpacing,
    // AI
    parseSseLine, parseAiContent,
    // 书籍写作
    cnChapterNum, parseChapterList, writtenChapterNums, cnSmall, parseCountValue, parseWordCount,
    // 博客
    BLOG_TITLE_MAX_LEN, blogSmartCut, parseBlogMeta, blogMdToPlain,
    // 编辑区源码高亮
    highlightMarkdownSource,
    // 命令面板
    fuzzyScore,
    // 公式保护
    splitByFences, protectMath, restoreMathSource,
    // 历史
    shouldSnapshot,
    // 压缩包
    crc32, zipStore, unzipStore,
  };
});
