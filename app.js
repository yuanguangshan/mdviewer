'use strict';

const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const preview = $('#preview');
const previewPane = $('#previewPane');
const gutter = $('#gutter');
const editorHighlight = $('#editorHighlight');
const fileInput = $('#fileInput');
const readingProgress = $('#readingProgress');

// ============ 版本更新：手动模式 ============
// 检测到新 SW 后仅弹出「更新条」提示，由用户点击「立即刷新」主动重载；
// 不自动 location.reload()，回到部署体验更好、无刷新死循环的手动模式。
// 配套 SW 策略为「缓存优先 + 后台更新」（见 sw.js），离线/秒开友好，
// 用户主动刷新即拉取并应用新版本。

/* ===================== SECTION INDEX ===================== */
// 机器可解析分区标记统一格式： // === SECTION: <标题> ===
// 提取正则： ^// === SECTION: (.+) ===$
//   小工具
//   DOMPurify：放行自定义图片方案 libimg://（Blob 入库后引用）
//   主题：auto / light / dark，auto 跟随系统
//   预览主题：github / onedark / solarized / nord（独立于 app 主题）
//   正文外观：字号 / 字色（仅预览，本机持久化）
//   渲染 + 代码高亮
//   KaTeX 数学公式（按需懒加载，与 mermaid 同策略）
//   锚点同步滚动辅助
//   Blob 图片：入库 + 解析
//   编辑器源码高亮：textarea 之上叠一层 <pre>，复用 hljs 自带 markdown 语法
//   编辑器换行：开=软换行（无横向滚动、隐藏行号）；关=不换行（保留行号逐行对齐）
//   统计 / 行号 / 光标位置
//   视图：双栏 / 编辑 / 预览
//   全屏：隐藏工具栏/状态栏（+ 尝试浏览器原生全屏），右上角 ✕ 退出
//   同步滚动（编辑 ↔ 预览，仅双栏）
//   草稿自动保存（去抖 + 静默 + 容错）
//   文件名 / 草稿载入 / 内容变更统一刷新
//   打开文件
//   保存
//   未命名文档：保存时从首行自动派生标题
//   新建 / 重命名
//   复制 HTML（复用预览结果）
//   导出 HTML / 打印 PDF
//   文本宏命令（Micro-Plugin / Text Pipeline）
//   选区包裹 / 行前缀（格式化快捷键的底层原语）
//   AI 智能助理（BYOK：自带 Key，纯前端直连，零后端）
//   AI 流式打字机浮层
//   选中文字后的浮动 AI 气泡菜单（Floating Toolbar）
//   格式刷：选中文字浮出的 WPS 风格工具条
//   NAS 同步：上传 / 下载
//   文库静默增量同步（本地→NAS，单向）
//   拖拽 / 粘贴图片（转 base64 插入光标处）
//   Tab 插入两空格
//   全局快捷键（Map 化：组合键归一化为 "mod+alt+shift+key"）
//   菜单快捷键提示（自动渲染，无需手写每处）
//   注册 Service Worker（PWA 离线 / 可安装）
//   响应式：窄屏启用软换行（手机可换行），宽屏 wrap=off 保持行号对齐
//   文库（本地文档库，IndexedDB 持久化；打开文档后编辑自动回写）
//   初始化
//   微信协作分享：基于 Cloudflare R2 + Worker 的中转站
//   布局：左右交换 + 可拖拽分隔线
//   Vanilla JS 微型 Vim 引擎 (Micro-Vim Engine)
/* ======================================================== */

let currentFileHandle = null;   // FileSystemFileHandle（支持时用于原地保存）
let currentName = '未命名.md';
let currentNameIsAuto = false;   // 当前标题是否由「首行自动派生」而来（手动改名/打开文件则置 false）
let currentShareId = null;       // 当前协作分享的 R2 文件名（null = 非协作文档）
// 外部网址只读模式（v4.10）：非空 = 当前正文来自别人的网址，而不是「我的文档」。
// 一旦置位，所有自动写入（草稿 / 文库回写 / 分享 / 发布 / 上传）必须被拦下。
let remoteOrigin = null;         // 来源主机名，如 'raw.githubusercontent.com'
let remoteHref = '';             // 完整来源地址（仅本会话，不落盘）
let remoteLoading = false;
// ============================================================
// 配置契约：R2_WORKER_URL（微信协作分享中转端点）
// - 这是【唯一】与后端/部署耦合的常量，修改前请确认以下三处保持一致：
//   1) Cloudflare Worker 路由 / 自定义域：share.want.biz 需为独立子域，
//      勿与 R2 存储桶「公开访问」自定义域冲突，否则 DNS/CNAME 会互相覆盖；
//   2) 微信内打开走自定义域比 *.workers.dev 国内更稳，建议保持 share.want.biz；
//   3) 前端仅持有此【公开端点】，R2 凭据只写在 Worker 绑定的 R2_BUCKET 里，
//      绝不下发、不入 git（密钥永不进会被提交的代码）。
// - 若需切换分享后端，仅需改这一行 + 同步上面三项，前端其余逻辑不用动。
// ============================================================
const R2_WORKER_URL = 'https://share.want.biz';

// === SECTION: 小工具 ===
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// === SECTION: 纯函数内核（lib/md-core.js，可在 Node 里单测） ===
// 约定：凡是「不碰 DOM 的算法」一律放内核，UI 层只做取值 / 渲染 / 反馈。
// 这样同一份逻辑既能在浏览器跑，也能 `node --test` 直接测，不再靠手测覆盖。
const Core = window.MdCore;
if (!Core) {
  // 内核加载失败（缓存缺文件 / 部署不完整）必须立刻暴露，不能静默降级成半残应用
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="padding:20px;font:14px/1.7 system-ui;color:#e06c75;background:#1b1e24">' +
    '⚠️ 核心模块 lib/md-core.js 加载失败，编辑器无法启动。请强制刷新（Ctrl+Shift+R）后重试。</div>');
  throw new Error('MdCore 未加载：lib/md-core.js');
}

const {
  escapeHtml, normalizeTextColor, humanBytes, compareVersion, stripInlineMd, fuzzyScore, rankFreq,
  slugify, createSlugger, buildHeadingLineMap,
  lineOffsets, posToLineCol,
  countWords,
  MAX_PATTERN_LEN, validatePattern, safeMatchCount, runRegexJob,
  processReplacement, evaluateMatchReplacement,
  formatSpacing: formatSpacingText,
  parseSseLine, parseAiContent,
  cnChapterNum, parseChapterList, writtenChapterNums, cnSmall, parseCountValue, parseWordCount,
  BLOG_TITLE_MAX_LEN, blogSmartCut, parseBlogMeta, blogMdToPlain,
  splitByFences: _splitFences, protectMath, restoreMathSource,
  shouldSnapshot,
  zipStore, unzipStore,
} = Core;

// === SECTION: 取文安检（lib/fetch-guard.js，与 serve-web / Worker 同一份规则） ===
// 前端用到它只有两个目的：①点「从网址打开」时先做本地预检，不合规立刻给人话提示，
// 不白跑一次网络；②把服务端返回的 reason 翻译成中文。
// 声明：**前端的检查不是安全边界**，真正的拦截发生在取文代理里（同一份规则会再跑一遍）。
const FetchGuard = window.FetchGuard || null;

// 取文代理地址（唯一后端耦合点，与 R2_WORKER_URL / BLOG_PUBLISH_URL 同一定约）。
// 同源部署（serve-web 提供 /mdviewer/ 时）直接用同源 /__fetch；
// GitHub Pages 这类纯静态托管没有后端，走 share.want.biz 的 Worker 端点。
const FETCH_PROXY_LOCAL = '/__fetch';
const FETCH_PROXY_PUBLIC = 'https://share.want.biz/fetch-md';
function resolveFetchProxy() {
  const h = location.hostname || '';
  if (h === 'md.want.biz' || /\.github\.io$/i.test(h) || location.protocol === 'file:') return FETCH_PROXY_PUBLIC;
  return FETCH_PROXY_LOCAL;
}

// 应用版本：单一来源（scripts/sync-version.mjs 会同步 index.html / styles.css / sw.js）。
// 运行时与 SW 缓存名比对，不一致时提示刷新，避免「页面是新的、脚本是旧的」这种经典事故。
const APP_VERSION = '4.31';

// 版本自检：index.html 与 app.js 必须同版（SW 缓存错位会造成「页面是新的、脚本是旧的」，
// 表现为菜单里明明有的功能点了没反应）。发现不一致时提示强刷，而不是让人瞎猜。
(function verifyVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const pageVer = meta && meta.getAttribute('content');
  if (!pageVer) return;
  if (compareVersion(pageVer, APP_VERSION) !== 0) {
    console.warn('[mdviewer] 版本不一致：页面 ' + pageVer + ' / 脚本 ' + APP_VERSION);
    setTimeout(() => {
      toast('⚠️ 检测到新旧混合缓存（页面 ' + pageVer + ' / 脚本 ' + APP_VERSION + '），正在自动修复…', 'warn', 6000);
      setTimeout(() => hardResetApp(), 1200);
    }, 800);
  }
})();

// === SECTION: 正则任务执行（Worker + 硬超时，防 ReDoS 冻死页面） ===
// 浏览器正则无法在 exec() 中途被打断，只能整体放到 Worker 里跑，超时即 terminate()。
let _regexWorker = null;
let _regexSeq = 0;
const _regexPending = new Map();

function getRegexWorker() {
  if (_regexWorker) return _regexWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    _regexWorker = new Worker('./lib/md-regex-worker.js');
  } catch (_) {
    return null;
  }
  _regexWorker.onmessage = (e) => {
    const msg = e.data || {};
    const p = _regexPending.get(msg.id);
    if (!p) return;
    _regexPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.out);
    else { const err = new Error(msg.error || '正则执行失败'); err.code = msg.code; p.reject(err); }
  };
  _regexWorker.onerror = () => { killRegexWorker(); };
  return _regexWorker;
}

function killRegexWorker() {
  if (_regexWorker) { try { _regexWorker.terminate(); } catch (_) {} }
  _regexWorker = null;
  _regexPending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('超时')); });
  _regexPending.clear();
}

/**
 * 在 Worker 中跑一个正则任务；超时/不可用则降级为同步执行。
 * @returns {Promise<object>}
 */
function runRegex(job, timeoutMs) {
  const w = getRegexWorker();
  if (!w) return Promise.resolve(runRegexJob(job));   // 降级：无 Worker（极老浏览器）直接同步跑
  const id = ++_regexSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _regexPending.delete(id);
      killRegexWorker();           // 卡死的线程无法复用，必须整个销毁重建
      const err = new Error('正则执行超时（已中断，避免页面卡死）——请简化表达式或缩小范围');
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs || 3000);
    _regexPending.set(id, { resolve, reject, timer });
    try { w.postMessage({ id, job }); }
    catch (e) { clearTimeout(timer); _regexPending.delete(id); reject(e); }
  });
}

// === SECTION: DOMPurify：放行自定义图片方案 libimg://（Blob 入库后引用） ===
// libimg://<id> 不是浏览器认识的 scheme，若把它原样写进 <img src>，浏览器会真的去请求，
// 控制台就会刷出 ERR_UNKNOWN_URL_SCHEME。所以：
//   DOM 里保留 data-libimg="<id>"，src 先放 1×1 透明占位，真正加载由 resolveImages() 换成 blob: URL。
//   导出时由 snapshotPreviewHtml() 把 src 还原成 libimg://<id>，再内联成 data URL。
const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

if (window.DOMPurify) {
  DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (src.startsWith('libimg://')) {
        node.setAttribute('data-libimg', src.slice('libimg://'.length));
        node.removeAttribute('src');
      }
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG' && node.hasAttribute('data-libimg')) {
      node.setAttribute('src', IMG_PLACEHOLDER);
    }
    // === 以下仅对「外部网址」内容生效（remoteOrigin 非空），自家文档不受影响 ===
    if (!remoteOrigin) return;
    if (node.tagName === 'A') {
      // 外链一律新窗口 + 断掉 opener：防钓鱼链接把当前页替换掉、也防反向 tabnabbing
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      node.removeAttribute('srcset');                 // srcset 可绕过单一地址检查
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.setAttribute('loading', 'lazy');
      if (/^https?:/i.test(src)) {
        // 远程图片默认【不加载】：先占位，用户点一下才真的发请求。
        // 理由：图片是最阴的探针——对方能看出你什么时候读了文、你的出口 IP，
        // 还能写 http://10.0.0.5:8080/x.png 来探你的内网服务（你看不见任何提示）。
        node.setAttribute('data-remote-src', src);
        node.setAttribute('src', IMG_PLACEHOLDER);
        node.setAttribute('class', (((node.getAttribute('class') || '') + ' remote-img').trim()));
        node.setAttribute('title', '外部图片（点击加载）');
      }
    }
    // 行内 style 里藏 url() 就删掉：否则 style="background:url(http://…)" 又是一次探针
    if (node.hasAttribute('style')) {
      const st = node.getAttribute('style') || '';
      if (/url\s*\(|expression\s*\(|@import/i.test(st)) node.removeAttribute('style');
    }
  });
}

// 两套消毒参数：自家文档沿用旧配置（要 audio/autoplay）；外部内容用宽禁档。
// 为什么不用同一套：自家文档里 .mp3 链接自动变播放器是特性，对外部文档就是「一打开就出声」。
const LOCAL_SANITIZE = {
  ADD_TAGS: ['audio', 'source'],
  ADD_ATTR: ['controls', 'preload', 'autoplay', 'loop'],
};
const REMOTE_SANITIZE = {
  // 主动去掉一切「能自己发请求 / 能自己执行」的标签
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea',
                'iframe', 'object', 'embed', 'audio', 'video', 'source', 'track', 'noscript'],
  FORBID_ATTR: ['autoplay', 'srcset', 'ping', 'formaction', 'id', 'data-libimg', 'onerror', 'onload'],
  ALLOW_DATA_ATTR: false,
  // 只放行 http(s) / mailto / 页内锚点 / 内联位图；javascript: 与其它 data: 一律剔掉
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp);)/i,
};

// === SECTION: 音频播放器（mp3 等链接自动渲染为 <audio> + 底部常驻小窗）===
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)(\?|#|$)/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;
function filenameFromSrc(src) {
  try {
    const clean = decodeURIComponent(String(src).split('?')[0].split('#')[0]);
    const name = clean.split('/').pop();
    return name || String(src);
  } catch (_) { return String(src); }
}
function fmtClock(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}
// 把预览里的音频链接 / 音频图片，转换为原生 <audio controls>（在 DOMPurify 之后，故不会被清洗）
function renderAudioPlayers() {
  if (activeAudio && !document.contains(activeAudio)) {
    activeAudio = null;
    if (audioDock) audioDock.hidden = true;
  }
  if (!preview) return;
  preview.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (AUDIO_EXT_RE.test(href) && !a.querySelector('audio')) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = href;
      const linkText = (a.textContent || '').trim();
      audio.dataset.title = (linkText && linkText !== href) ? linkText : filenameFromSrc(href);
      a.replaceWith(audio);
    }
  });
  preview.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (AUDIO_EXT_RE.test(src) && !src.startsWith('libimg://')) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = src;
      audio.dataset.title = (img.getAttribute('alt') || '').trim() || filenameFromSrc(src);
      img.replaceWith(audio);
    }
  });
}
// 裸图片链接自动渲染为 <img>：用户直接粘贴 `https://x.com/a.png`（未写成 ![](...)）
// 时，marked 会把它当普通链接；这里在渲染后把图片扩展名的 <a> 就地换成 <img>，
// 与 renderAudioPlayers 同一模式（扫描已渲染 DOM，不改编辑器文本、不动解析器）。
function renderImageEmbeds() {
  if (!preview) return;
  preview.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('libimg://')) return;       // 本地库图片走原生 ![](libimg://) 渲染，勿动
    if (!IMAGE_EXT_RE.test(href)) return;
    if (a.querySelector('img') || a.querySelector('audio')) return;  // 已含媒体的链接不重复处理
    const img = document.createElement('img');
    img.src = href;
    img.alt = ((a.textContent || '').trim() && (a.textContent || '').trim() !== href)
      ? (a.textContent || '').trim()
      : filenameFromSrc(href);
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    a.replaceWith(img);
  });
}
let activeAudio = null;
let audioDock = null;
// 注意时序：本函数用「事件委托」把 play/pause/timeupdate 以捕获模式挂在 preview 容器上，
// 不持有任何 <audio> 的 DOM 引用。因此即使 renderMarkdown/renderAudioPlayers 先于本函数
// 执行（或之后反复重绘替换 <audio> 节点），事件依然能被捕获——初始化顺序不敏感。
function setupAudioDock() {
  if (audioDock || !preview) return;
  const dock = document.createElement('div');
  dock.id = 'audioDock';
  dock.hidden = true;
  dock.innerHTML =
    '<button class="ad-toggle" title="播放/暂停">▶</button>'
    + '<span class="ad-title">♪</span>'
    + '<input class="ad-seek" type="range" min="0" max="1000" value="0" step="1">'
    + '<span class="ad-time">0:00</span>'
    + '<button class="ad-close" title="关闭">✕</button>';
  document.body.appendChild(dock);
  audioDock = dock;
  const toggle = dock.querySelector('.ad-toggle');
  const seek = dock.querySelector('.ad-seek');
  const timeEl = dock.querySelector('.ad-time');
  const titleEl = dock.querySelector('.ad-title');
  const close = dock.querySelector('.ad-close');

  const syncToggle = () => { toggle.textContent = (activeAudio && !activeAudio.paused) ? '⏸' : '▶'; };
  const syncSeek = () => {
    if (!activeAudio) return;
    const d = activeAudio.duration || 0, c = activeAudio.currentTime || 0;
    seek.value = d ? String(Math.round((c / d) * 1000)) : '0';
    timeEl.textContent = fmtClock(c) + (d ? ' / ' + fmtClock(d) : '');
  };
  const setActive = (a) => {
    preview.querySelectorAll('audio').forEach((o) => { if (o !== a) o.pause(); });
    activeAudio = a;
    dock.hidden = false;
    titleEl.textContent = '♪ ' + (a.dataset.title || '音频');
    syncToggle(); syncSeek();
  };

  toggle.addEventListener('click', () => {
    if (!activeAudio) return;
    if (activeAudio.paused) activeAudio.play().catch(() => {}); else activeAudio.pause();
  });
  seek.addEventListener('input', () => {
    if (!activeAudio || !activeAudio.duration) return;
    activeAudio.currentTime = (Number(seek.value) / 1000) * activeAudio.duration;
  });
  close.addEventListener('click', () => {
    if (activeAudio) activeAudio.pause();
    dock.hidden = true;
  });

  // 事件委托：任意 <audio> 播放/暂停/进度变化都同步到底部小窗（无第二个媒体元素，不会双声）
  preview.addEventListener('play', (e) => { if (e.target && e.target.tagName === 'AUDIO') setActive(e.target); }, true);
  preview.addEventListener('pause', () => syncToggle(), true);
  preview.addEventListener('ended', () => syncToggle(), true);
  preview.addEventListener('timeupdate', (e) => { if (e.target === activeAudio) syncSeek(); }, true);
  preview.addEventListener('loadedmetadata', (e) => { if (e.target === activeAudio) syncSeek(); }, true);
}

// === SECTION: 播客 feed 匹配（解析 podcast.xml，打开文章时自动在顶部插入对应播客播放器）===
// 前提：pic.want.biz 需对 podcast.xml 响应加 Access-Control-Allow-Origin，否则浏览器 CORS 拦截抓取。
const PODCAST_FEED_URL = 'https://pic.want.biz/podcast.xml';
let _podcastFeed = null;   // 内存缓存：一次抓取多次复用
let _podcastPollTimer = null;   // 轮询定时器（生成播客需几分钟，打开未命中时启动）
let _podcastPollCount = 0;

// 规范化标题：去掉 [Read]/[Podcast]NNN/(...) 等前导方括号标签与 .mp3 后缀，统一空白后转小写
function normTitle(s) {
  if (!s) return '';
  return String(s)
    .replace(/^\[[^\]]*\]\s*/g, '')   // 去 [Read] / [Podcast]918 等前导方括号标签
    .replace(/\.mp3$/i, '')             // 去 .mp3 后缀（feed 文件名里带）
    .replace(/^#+\s*/, '')              // 去 markdown 标题 #
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
// 两标题是否匹配：相等，或其一为另一者前缀（兼容 feed 标题被截断的情况，如长文只取前 N 字）
function titlesMatch(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}
// 当前文档核心标题：优先首个 H1，回退到文件名（去扩展名）
function currentDocTitle() {
  const m = editor.value.match(/^#\s+(.+)$/m);
  if (m && m[1].trim()) return m[1].trim();
  return (currentName || '').replace(/\.(md|markdown|txt)$/i, '').trim();
}
// 解析 feed：返回 [{ title, url, pubDate }]，失败返回 []（不抛，避免打断编辑）
async function getPodcastFeed() {
  if (_podcastFeed) return _podcastFeed;
  try {
    const resp = await fetch(PODCAST_FEED_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const xml = new DOMParser().parseFromString(await resp.text(), 'text/xml');
    const items = Array.from(xml.querySelectorAll('item'));
    _podcastFeed = items.map((it) => {
      const title = ((it.querySelector('title') || {}).textContent) || '';
      const enc = it.querySelector('enclosure');
      const url = enc ? (enc.getAttribute('url') || '') : (((it.querySelector('guid') || {}).textContent) || '');
      const pubDate = ((it.querySelector('pubDate') || {}).textContent) || '';
      return { title, url, pubDate };
    }).filter((e) => e.url && /\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(e.url));
    return _podcastFeed;
  } catch (e) {
    console.warn('[podcast] feed 加载失败（可能未配置 CORS）：', e && e.message);
    return [];
  }
}
// 在文档顶部（front matter 之后）插入一行播客链接；幂等：URL 已存在则不重复插入
function insertPodcastAtTop(url, label) {
  if (editor.value.indexOf(url) !== -1) return false;   // 已含该播客 → 跳过
  const line = '[🎧 播客版](' + url + ')';
  let body = editor.value;
  const fm = body.match(/^---\n[\s\S]*?\n---\n?/);   // 兼容 YAML front matter：插在前面之后
  if (fm) body = fm[0] + '\n' + line + '\n\n' + body.slice(fm[0].length);
  else body = line + '\n\n' + body;
  editor.value = body;
  afterChange();
  return true;
}
// 在光标处（独立成行）插入播客链接，用于手动触发
function insertPodcastAtCursor(url) {
  if (editor.value.indexOf(url) !== -1) { flash('本文已包含该播客'); return false; }
  const s = editor.selectionStart, e = editor.selectionEnd;
  const text = '\n[🎧 播客版](' + url + ')\n';
  editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
  editor.selectionStart = editor.selectionEnd = s + text.length;
  afterChange();
  return true;
}
// 取消进行中的轮询（切文档/改名/关闭时调用，避免误插到别的文档）
function stopPodcastPoll() {
  if (_podcastPollTimer) { clearTimeout(_podcastPollTimer); _podcastPollTimer = null; }
}
// 打开未命中时启动轻量轮询：每 ~25s 重新抓 feed+匹配，最多 10 次（≈4 分钟），命中即自动插入。
// 若文档身份（currentName + 首行 H1）变化则立即取消，防止误插到已切换的文档。
function startPodcastPoll(docTitle) {
  stopPodcastPoll();
  _podcastPollCount = 0;
  const INTERVAL = 25000, MAX = 10;
  const fp = () => currentName + '\u0000' + (editor.value.match(/^#\s+(.+)$/m) || [,''])[1];
  const anchor = fp();
  const tick = async () => {
    if (++_podcastPollCount > MAX) { stopPodcastPoll(); return; }
    if (fp() !== anchor) { stopPodcastPoll(); return; }   // 文档身份变了 → 取消，防误插
    try {
      _podcastFeed = null;   // 强制重抓（feed 可能因生成完成而更新）
      const feed = await getPodcastFeed();
      const hit = feed.find((it) => titlesMatch(it.title, docTitle));
      if (hit) {
        if (insertPodcastAtTop(hit.url, hit.title)) flash('🎧 已为本文自动插入播客播放器');
        stopPodcastPoll();
      } else {
        _podcastPollTimer = setTimeout(tick, INTERVAL);
      }
    } catch (_) {
      _podcastPollTimer = setTimeout(tick, INTERVAL);
    }
  };
  _podcastPollTimer = setTimeout(tick, INTERVAL);
}
// 文档「打开/载入」时调用：匹配 feed 集，命中则在顶部插入播放器；未命中则启动轮询（生成中的播客稍后自动匹配）
async function syncPodcastOnLoad() {
  try {
    stopPodcastPoll();   // 切文档时先取消上一次轮询
    if (currentName === '未命名.md' && !/^#\s/m.test(editor.value)) return;
    const docTitle = currentDocTitle();
    if (!docTitle) return;
    const feed = await getPodcastFeed();
    if (!feed.length) return;
    const hit = feed.find((it) => titlesMatch(it.title, docTitle));
    if (hit) {
      if (insertPodcastAtTop(hit.url, hit.title)) flash('🎧 已为本文插入播客播放器');
      return;
    }
    startPodcastPoll(docTitle);   // 未命中 → 轮询（生成播客要几分钟）
  } catch (_) {}
}
// 未命中时的兜底选择器：列出 feed 最新 5 篇，用户点选后在光标处插入（复用 .modal 样式体系）
function showPodcastPicker(feed) {
  const old = document.getElementById('podcastPickerModal');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.id = 'podcastPickerModal';
  const items = feed.slice(0, 5);
  const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate(); };
  wrap.innerHTML =
    '<div class="modal-box" role="dialog" aria-modal="true" aria-label="选择播客">' +
      '<div class="modal-title">🎧 选择要插入的播客</div>' +
      '<p class="modal-desc">未自动匹配到本文标题，从最新 ' + items.length + ' 期中手动选一个：</p>' +
      '<div class="podcast-pick-list">' +
        items.map((it, i) =>
          '<button type="button" class="podcast-pick-item" data-i="' + i + '">' +
            '<span class="pp-title">' + escapeHtml(it.title || '（无标题）') + '</span>' +
            (it.pubDate ? '<span class="pp-date">' + fmtDate(it.pubDate) + '</span>' : '') +
          '</button>'
        ).join('') +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="pp-cancel">取消</button></div>' +
    '</div>';
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) { close(); return; }
    if (e.target.closest('.pp-cancel')) { close(); return; }
    const btn = e.target.closest('.podcast-pick-item');
    if (btn) {
      const it = items[Number(btn.dataset.i)];
      close();
      if (it && insertPodcastAtCursor(it.url)) flash('🎧 已插入播客播放器');
    }
  });
}
// 手动触发（⋯ 菜单）：在当前光标处插入匹配到的播客；无匹配则弹选择器让用户从最新 5 期里挑
async function matchPodcastManual() {
  _podcastFeed = null;   // 手动触发时强制重抓，拿最新 feed
  const feed = await getPodcastFeed();
  if (!feed.length) { flash('播客 feed 加载失败（检查 pic.want.biz 的 CORS 配置）'); return; }
  const docTitle = currentDocTitle();
  const hit = feed.find((it) => titlesMatch(it.title, docTitle));
  if (hit) {
    if (insertPodcastAtCursor(hit.url)) flash('🎧 已插入播客播放器');
  } else {
    showPodcastPicker(feed);
  }
}

// === SECTION: 主题：auto / light / dark，auto 跟随系统 ===
const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };
const THEME_LABEL = { auto: '自动', light: '亮色', dark: '暗色' };
const mql = matchMedia('(prefers-color-scheme: dark)');
let themeMode = localStorage.getItem('md-theme') || 'auto';
if (!THEME_CYCLE.includes(themeMode)) themeMode = 'auto';

function resolveTheme(m) { return m === 'auto' ? (mql.matches ? 'dark' : 'light') : m; }
function applyTheme(mode) {
  themeMode = mode;
  const r = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', r);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', r === 'dark' ? '#0f1115' : '#f5f7fa');
  localStorage.setItem('md-theme', mode);
  const mt = $('#menuTheme');
  if (mt) mt.textContent = THEME_ICON[mode] + ' 主题：' + THEME_LABEL[mode] + (mode === 'auto' ? '（' + (mql.matches ? '暗' : '亮') + '）' : '');
}
mql.addEventListener('change', () => { if (themeMode === 'auto') applyTheme('auto'); });
applyTheme(themeMode);

// === SECTION: 预览主题：github / onedark / solarized / nord / gruvbox / dracula / monokai / ayu / catppuccin / sepia（独立于 app 主题） ===
const MD_THEME_CYCLE = ['github', 'onedark', 'solarized', 'nord', 'gruvbox', 'dracula', 'monokai', 'ayu', 'catppuccin', 'sepia'];
const MD_THEME_LABEL = { github: 'GitHub', onedark: 'One Dark', solarized: 'Solarized', nord: 'Nord', gruvbox: 'Gruvbox', dracula: 'Dracula', monokai: 'Monokai', ayu: 'Ayu', catppuccin: 'Catppuccin', sepia: 'Sepia' };
let mdThemeMode = localStorage.getItem('md-mdtheme') || 'github';
if (!MD_THEME_CYCLE.includes(mdThemeMode)) mdThemeMode = 'github';
function applyMdTheme(mode) {
  mdThemeMode = mode;
  document.documentElement.setAttribute('data-md-theme', mode);
  localStorage.setItem('md-mdtheme', mode);
  document.querySelectorAll('[data-act="mdtheme"]').forEach((b) => {
    const key = b.dataset.val || '';
    // 标签优先取自按钮自身的 HTML 文本（首次调用时缓存到 dataset.label），
    // 这样即使 JS 常量缺失或 SW 缓存了旧 app.js，标签也始终跟随 HTML，绝不为 undefined。
    if (!b.dataset.label) b.dataset.label = (b.textContent || '').replace(/^✓\s*/, '');
    const base = b.dataset.label || MD_THEME_LABEL[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');
    b.textContent = (key === mode ? '✓ ' : '') + base;
  });
}

// === SECTION: 正文外观：字号 / 字色（仅预览，持久化到本机） ===
// 设计：直接给 #preview 写内联样式，天然压过预览主题里 [data-md-theme] .markdown-body
// 的颜色规则；标题 / 链接 / 代码块等自带配色的元素不受影响，只改「正文」。
const TEXT_STYLE_KEY = 'md-text-style';
const TS_SIZE_MIN = 12, TS_SIZE_MAX = 32, TS_SIZE_DEFAULT = 16;

// normalizeTextColor 已下沉到 lib/md-core.js（见顶部解构），此处不再重复实现。

function readTextStyle() {
  const def = { size: TS_SIZE_DEFAULT, color: '' };
  try {
    const raw = JSON.parse(localStorage.getItem(TEXT_STYLE_KEY) || '{}');
    const n = Math.round(Number(raw.size));
    if (Number.isFinite(n)) def.size = Math.min(TS_SIZE_MAX, Math.max(TS_SIZE_MIN, n));
    def.color = normalizeTextColor(raw.color);
  } catch (_) {}
  return def;
}

function saveTextStyle(style) {
  try { localStorage.setItem(TEXT_STYLE_KEY, JSON.stringify({ size: style.size, color: style.color })); } catch (_) {}
}

// 取当前预览主题的正文色（用于「跟随主题」时让取色器显示一个合理的初始值）
function previewThemeColorHex() {
  if (!preview) return '#1f2328';
  const parts = (getComputedStyle(preview).color || '').match(/\d+(?:\.\d+)?/g);
  if (!parts || parts.length < 3) return '#1f2328';
  return '#' + parts.slice(0, 3).map((n) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(n))));
    return v.toString(16).padStart(2, '0');
  }).join('');
}

// 同步弹窗控件状态（字号显示 / 预设高亮 / 取色器与色块）
function syncTextStyleUI(style) {
  const sizeEl = document.getElementById('tsSize');
  const valEl = document.getElementById('tsSizeVal');
  if (sizeEl) sizeEl.value = String(style.size);
  if (valEl) valEl.textContent = style.size + ' px';
  document.querySelectorAll('#tsSizePresets [data-size]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.size) === style.size);
  });
  const colorEl = document.getElementById('tsColor');
  if (colorEl) colorEl.value = style.color || previewThemeColorHex();
  document.querySelectorAll('#tsSwatches [data-color]').forEach((b) => {
    b.classList.toggle('active', normalizeTextColor(b.dataset.color) === style.color);
  });
  const resetBtn = document.getElementById('tsColorReset');
  if (resetBtn) resetBtn.classList.toggle('active', !style.color);
}

// 应用样式到预览正文（并在弹窗打开时同步其中示例）
function applyTextStyle(style) {
  style = style || readTextStyle();
  const size = style.size + 'px';
  if (preview) {
    preview.style.fontSize = size;
    if (style.color) preview.style.setProperty('--md-text-color', style.color);
    else preview.style.removeProperty('--md-text-color');
  }
  const box = document.getElementById('tsPreview');
  if (box) {
    box.style.fontSize = size;
    if (style.color) box.style.setProperty('color', style.color);
    else box.style.removeProperty('color');
  }
  syncTextStyleUI(style);
}

// 局部更新（只传要改的字段）
function updateTextStyle(patch) {
  const cur = readTextStyle();
  const next = { size: cur.size, color: cur.color };
  if (patch.size !== undefined && patch.size !== null) {
    const n = Math.round(Number(patch.size));
    if (Number.isFinite(n)) next.size = Math.min(TS_SIZE_MAX, Math.max(TS_SIZE_MIN, n));
  }
  if (patch.color !== undefined) next.color = normalizeTextColor(patch.color);
  saveTextStyle(next);
  applyTextStyle(next);
}

function resetTextStyle() {
  try { localStorage.removeItem(TEXT_STYLE_KEY); } catch (_) {}
  applyTextStyle({ size: TS_SIZE_DEFAULT, color: '' });
  flash('已恢复默认正文样式');
}

function openTextStyleDialog() {
  const m = document.getElementById('textStyleModal');
  if (!m) return;
  applyTextStyle(readTextStyle());
  m.hidden = false;
}

// === SECTION: 渲染 + 代码高亮 ===
let renderTimer = null;
let currentSearchHit = null;   // { start, end }：当前查找/替换匹配项在 editor.value 中的字节范围；用于覆盖层高亮
// 懒加载大体积第三方库（避免首屏同步下载数 MB）
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lazy="' + src + '"]');
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('加载失败: ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.lazy = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}
let mermaidReady = false;
let mermaidLoading = null;
async function ensureMermaid() {
  if (window.mermaid) {
    if (!mermaidReady) {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
      mermaidReady = true;
    }
    return true;
  }
  if (!mermaidLoading) {
    mermaidLoading = loadScript('./vendor/mermaid.min.js').catch((e) => { console.warn(e); mermaidLoading = null; return false; });
  }
  const ok = await mermaidLoading;
  if (ok && window.mermaid && !mermaidReady) {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
    mermaidReady = true;
  }
  return !!window.mermaid;
}
// mermaid 渲染缓存：图表源码 hash -> 已渲染 SVG HTML。
// preview.innerHTML 每次全量重建，mermaid 生成的 SVG 会随 DOM 重置丢失，
// 命中缓存时直接复用 SVG，避免输入停顿期间反复全量重跑 mermaid.run。
const mermaidCache = new Map();
const MERMAID_CACHE_MAX = 20;
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
// 渲染流程图（仅在文档含 mermaid 代码块且库尚未加载时，才去懒加载 mermaid）
// mermaid 主题由 app 主题(data-theme)决定:主题切换后旧主题 SVG 缓存必须作废,
// 否则复用缓存会导致图表不跟随新主题(在函数内检查,避免 const 定义位置的 TDZ)
let lastMermaidTheme = null;
async function renderMermaidDiagrams() {
  if (!preview.querySelector('pre code.language-mermaid')) return;
  const themeKey = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  if (themeKey !== lastMermaidTheme) { mermaidCache.clear(); lastMermaidTheme = themeKey; }
  const ok = await ensureMermaid();
  if (!ok) return;
  try {
    const mermaidEls = preview.querySelectorAll('pre code.language-mermaid');
    const toRender = [];   // 仅未命中缓存、需要 mermaid.run 的节点
    mermaidEls.forEach((el, idx) => {
      const parent = el.parentElement;
      const key = hashStr(el.textContent);
      const cached = mermaidCache.get(key);
      const wrapper = document.createElement('div');
      wrapper.dataset.key = key;   // 渲染完成后凭此写回缓存（此时 textContent 已变 SVG，不能再算 hash）
      if (cached) {
        wrapper.className = 'mermaid-wrapper mermaid-rendered';
        wrapper.innerHTML = cached;
      } else {
        wrapper.className = 'mermaid-wrapper';
        wrapper.id = 'mermaid-' + Date.now() + '-' + idx;
        wrapper.textContent = el.textContent;
        toRender.push(wrapper);
      }
      parent.replaceWith(wrapper);
    });
    if (toRender.length) {
      await window.mermaid.run({ nodes: toRender });
      for (const w of toRender) {
        if (w.dataset.key && w.querySelector('svg')) {
          mermaidCache.set(w.dataset.key, w.innerHTML);
          if (mermaidCache.size > MERMAID_CACHE_MAX) {
            const firstKey = mermaidCache.keys().next().value;   // 近似 LRU：淘汰最早插入
            mermaidCache.delete(firstKey);
          }
        }
      }
    }
  } catch (e) {
    console.warn('Mermaid 渲染失败:', e);
  }
}
// === SECTION: KaTeX 数学公式（按需懒加载，与 mermaid 同策略） ===
let katexCssInjected = false;
let katexLoading = null;
function injectKatexCss() {
  if (katexCssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './vendor/katex.min.css';   // 字体经 fonts/ 相对路径解析
  document.head.appendChild(link);
  katexCssInjected = true;
}
async function ensureKatex() {
  if (window.katex && window.renderMathInElement) return true;
  if (!katexLoading) {
    injectKatexCss();
    katexLoading = loadScript('./vendor/katex.min.js')
      .then(() => loadScript('./vendor/katex-auto-render.min.js'))
      .then(() => true)
      .catch((e) => { console.warn(e); katexLoading = null; return false; });
  }
  return katexLoading;
}
// 仅当文档确有公式定界符（$$…$$ / $…$ / \(…\) / \[…\]）时才懒加载 KaTeX。
// 注意：preview.innerHTML 每次都会全量重建，已渲染的 <span class="katex"> 会被重置回
// 定界符源码，因此这里必须每次重建后都调用 renderMathInElement——不能像 mermaid 那样
// 用指纹短路跳过（否则公式会一直停留在未渲染的源码形态，见 v3.7 review 缺陷修复）。
async function renderMathFormulas() {
  const text = preview.textContent || '';
  const hasMath = /\$\$[\s\S]+?\$\$/.test(text)
    || /(^|[^\\$])\$[^$\n]+\$/.test(text)
    || /\\\(|\\\[/.test(text);
  if (!hasMath) return;
  const ok = await ensureKatex();
  if (!ok || !window.renderMathInElement) return;
  try {
    window.renderMathInElement(preview, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false,
      // 已经渲染过的 .katex 不参与二次扫描：它内嵌的 MathML annotation 里存着 TeX 源码，
      // 再次 auto-render 会把注释里的内容当成新公式重复渲染。
      ignoredClasses: ['katex', 'katex-display', 'katex-mathml'],
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    });
  } catch (e) {
    console.warn('KaTeX 渲染失败:', e);
  }
}
/**
 * 把 protectMath 抽出的公式「填回」预览 DOM。
 *
 * 流程：marked 渲染时公式是占位符（xMDVMATHx0x）→ 消毒不会动它 → 这里找到含占位符的
 * 文本节点，切成 [文本][公式][文本] 三段，公式节点用 katex.render 渲染。
 * 好处：公式内容全程不经过 marked，`\,` 这类转义不会被当 CommonMark 转义吃掉；
 *      行间 $$ 块也不会被 breaks:true 塞进 <br> 而失效。
 * 兜底：KaTeX 加载失败时把占位符还原成 $…$ 源码，内容不会丢。
 */
async function fillMathPlaceholders(pm) {
  if (!pm || !pm.blocks || !pm.blocks.length) return;
  const ok = await ensureKatex();
  const re = new RegExp(pm.tokenBase + '(\\d+)x', 'g');
  const nodes = [];
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null, false);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.indexOf(pm.tokenBase) >= 0) nodes.push(n);
  }
  const src = (b) => (b.display ? '$$' : '$') + b.tex + (b.display ? '$$' : '$');
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const b = pm.blocks[Number(m[1])];
      if (!b) { frag.appendChild(document.createTextNode(m[0])); last = m.index + m[0].length; continue; }
      if (!ok || !window.katex) {
        frag.appendChild(document.createTextNode(src(b)));
      } else {
        // 和 KaTeX auto-render 一致：容器一律用 <span>，displayMode 由 KaTeX 自己包 .katex-display
        const holder = document.createElement('span');
        try { window.katex.render(b.tex, holder, { displayMode: !!b.display, throwOnError: false }); }
        catch (_) { holder.textContent = src(b); }
        frag.appendChild(holder);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// 让下划线 _ / __ 不再作为强调分隔符（技术写作里 snake_case、变量名常被误判成斜体）。
// 注意：marked 的内建 em/strong 优先级高于自定义 inline 扩展，扩展永远抢不过 _，
// 所以这里直接改 marked 内部的右分隔符正则 emStrongRDelimUnd：换成永不匹配的正则，
// 使 _..._ / __...__ 永远找不到右边界、被当字面文本；* / ** 的斜体/粗体完全不受影响。
if (window.marked && marked.Lexer && marked.Lexer.rules && marked.Lexer.rules.inline) {
  const NEVER = /x^never_match_x/;   // 任何正常文本都不会包含，使 _ 的右分隔符永不命中
  for (const mode of ['normal', 'gfm', 'breaks']) {
    const rules = marked.Lexer.rules.inline[mode];
    if (rules && rules.emStrongRDelimUnd) rules.emStrongRDelimUnd = NEVER;
  }
}
// 渲染入口。
// opts.force：内容未变时也重渲（主题切换 / 手动刷新等场景）。
// 默认内容相同则直接返回——避免 resize / 滚动 / 切视图等「无关事件」触发整链重渲。
let lastRenderedSrc = null;
let mermaidRendering = Promise.resolve();   // 追踪 mermaid 异步渲染，供导出前 await
let mathRendering = Promise.resolve();      // 追踪 KaTeX 异步渲染：不 await 就会导出到公式源码
let lastMath = { blocks: [], tokenBase: '' };   // 本次渲染抽出的公式（占位符 → 回填用）

function renderMarkdown(opts) {
  const src = editor.value || '';
  if (!(opts && opts.force) && src === lastRenderedSrc && preview.childElementCount) return;
  lastRenderedSrc = src;
  // 大文档保护：超 1MB 或 5000 行时跳过开销大的后处理（代码高亮 / mermaid），
  // 保证输入停顿不把主线程卡死；预览正文仍正常渲染。行数用偏移缓存，不再全文 split。
  const heavyDoc = src.length > 1000000 || getLineOffsets(src).length > 5000;
  let html;
  // --- 空状态：展示欢迎卡片，而非斜体占位符 ---
  if (!src.trim()) {
    html = '<div class="welcome-card">'
      + '<div class="welcome-emoji">✍️</div>'
      + '<h2>开始创作</h2>'
      + '<p class="welcome-sub">支持 <kbd>Ctrl+S</kbd> 保存 · <kbd>Ctrl+O</kbd> 打开</p>'
      + '<p class="welcome-note">拖拽/粘贴图片 · 语法高亮 · 多主题预览 · 🗄️ 文库自动回写</p>'
      + '</div>';
  } else {
    try {
      // 公式必须在 marked 之前抽出来：marked 会把 `\,` 当 CommonMark 转义吃掉，
      // 也会把 $$ 块内的换行变成 <br>，导致 KaTeX 的定界符匹配失败、整块不渲染。
      lastMath = protectMath(src);
      html = window.marked
        ? marked.parse(lastMath.text, { breaks: true, gfm: true })
        : '<pre>' + escapeHtml(src) + '</pre>';
      if (!window.marked) lastMath = { blocks: [], tokenBase: '' };
    } catch (e) {
      html = '<p style="color:#e06c75">渲染错误：' + escapeHtml(e.message) + '</p>';
    }
  }
  // 关键：必须在 sanitize **之前**把 libimg:// 从 src 里摘掉。
  // DOMPurify 内部会先把字符串解析成 DOM 再消毒，而 <img src="libimg://..."> 一进 DOM
  // 浏览器就会发起请求 → 控制台刷 ERR_UNKNOWN_URL_SCHEME（hook 已经来不及了）。
  html = html.replace(/src=(["'])libimg:\/\/([a-z0-9]+)\1/gi,
    (m, q, id) => 'src=' + q + IMG_PLACEHOLDER + q + ' data-libimg=' + q + id + q);
  if (!window.DOMPurify) {
    // 无消毒器时：外部内容宁可不渲染（只给提示），自家文档保持旧行为
    preview.innerHTML = remoteOrigin
      ? '<p style="color:#e06c75">DOMPurify 未加载，出于安全已拒绝渲染外部文档。请强刷（Ctrl+Shift+R）后重试。</p>'
      : html;
  } else {
    preview.innerHTML = DOMPurify.sanitize(html, remoteOrigin ? REMOTE_SANITIZE : LOCAL_SANITIZE);
  }
  // 后处理高亮：对任何 marked 版本都稳，且不依赖已废弃的 setOptions({highlight})
  if (window.hljs && !heavyDoc) {
    preview.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (_) {}
    });
  }
  // --- Mermaid 图表渲染（按需懒加载 mermaid 库，见 renderMermaidDiagrams）---
  // 大文档跳过：mermaid 每次全量重跑成本高（另有渲染缓存）；外部文档也跳过：
  // 图定义是「可执行描述语言」，渲染进 SVG 后属于额外攻击面，读别人的文章不需要它。
  if (!heavyDoc && !remoteOrigin) {
    try {
      mermaidRendering = Promise.resolve(renderMermaidDiagrams())
        .then(() => { lastSanitizedHtml = snapshotPreviewHtml(); })   // 图渲染完刷新快照，导出才带图
        .catch(() => {});
    } catch (_) { mermaidRendering = Promise.resolve(); }
  }
  // --- KaTeX 数学公式渲染（按需懒加载 katex 库，见 renderMathFormulas）---
  // 保留给外部文档：KaTeX 只产出文本级排版，trust 默认 false（\href 等命令不生效）
  // 必须把 Promise 存下来：导出 HTML 要等它画完再取快照，否则导出里只剩 $$ 源码
  mathRendering = Promise.resolve()
    .then(() => fillMathPlaceholders(lastMath))   // 主路径：占位符 → katex.render
    .then(() => renderMathFormulas())             // 兜底：保护层没覆盖到的残留 $…$
    .then(() => { if (preview.querySelector('.katex')) lastSanitizedHtml = snapshotPreviewHtml(); })
    .catch(() => {});
  // --- 音频播放器：mp3 等链接自动渲染为 <audio>（见 renderAudioPlayers）---
  if (!remoteOrigin) renderAudioPlayers();     // 外部文档：不给自动播放的能力
  // --- 裸图片链接自动渲染为 <img>（见 renderImageEmbeds）---
  if (!remoteOrigin) renderImageEmbeds();       // 外部文档：不把裸链接变成自动请求
  // --- 标题加 id（支持页内锚点跳转），并建立「标题 slug → 源码行」映射，用于锚点同步滚动 ---
  // 两侧共用同一个 slugger + 同一遍历顺序：同名标题依次得到「标题」「标题-2」…
  // 修复：旧实现直接 h.id = slugify(text)，两节「## 总结」会产生重复 id，目录只能跳到第一个。
  const slugger = createSlugger();
  preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const id = slugger(h.textContent);
    if (id) h.id = id;
  });
  headingLineMap = buildHeadingLineMap(editor.value);   // 同为 createSlugger + stripInlineMd，一一对应
  buildToc();   // 同步重建右侧目录大纲（标题已就绪，含 id）
  lastSanitizedHtml = snapshotPreviewHtml();   // 快照（保留 libimg:// 引用，供导出时内联为 data URL）
  // --- 解析 Blob 图片引用（libimg://）→ 临时 object URL 渲染 ---
  resolveImages();
}

// === SECTION: 时光胶囊（剪贴板同步，明文存 NAS）===
// 2026-11-09 按用户决定改为明文：都是自己的 NAS，加密反而让索引套娃、同步慢。
// 现在的模型：
//   · 配对码 = 分组标识（不再是密钥），决定文件名前缀，多台设备填同一个码即同一条时间线；
//   · 胶囊 = cap_<CODE>_c_<设备>_<序号>.json（明文 JSON：{at, dev, text}）；
//   · 索引 = cap_<CODE>_idx.json（明文 JSON：{v, items:[{id, at, dev}]}），同步只读它 → 秒级；
//   · 用 .json 而不是 .md/.txt：NAS 对 .md/.txt 会触发 AI 归档流程，胶囊不该进知识库。
// 代价（写在面板上也写在注释里）：任何能拿到 NAS 凭据的人都能读到内容，别放密码/密钥。
const CAP_CODE_KEY = 'cap_code';
const CAP_DEV_KEY = 'cap_dev';
const CAP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉 0/O/1/I
const CAP_LIST_TTL = 10 * 60 * 1000;

let capCode = '';
let capItems = [];
let capListCache = { at: 0, ns: '', items: [] };
let capLastSyncAt = 0;
let capPollTimer = 0;

function capDevId() {
  let d = '';
  try { d = localStorage.getItem(CAP_DEV_KEY) || ''; } catch (_) {}
  if (!/^[0-9a-z]{6}$/.test(d)) {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    d = Array.from(a).map((b) => (b % 36).toString(36)).join('').slice(0, 6);
    try { localStorage.setItem(CAP_DEV_KEY, d); } catch (_) {}
  }
  return d;
}
function capGenCode(n) {
  const a = new Uint8Array(n || 10);
  crypto.getRandomValues(a);
  let out = '';
  for (const b of a) out += CAP_ALPHABET[b % CAP_ALPHABET.length];
  return out.slice(0, 5) + '-' + out.slice(5);
}
// 配对码规范化：只留大写字母数字，去连字符 → 直接当文件名片段
function capNormCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function capFmtCode(code) {
  const n = capNormCode(code);
  return n.length > 5 ? n.slice(0, 5) + '-' + n.slice(5) : n;
}
function capClipboardOk() { return !!(window.isSecureContext && navigator.clipboard && navigator.clipboard.readText); }

function capCopy(txt) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(txt).catch(() => fallbackCopy(txt));
  }
  fallbackCopy(txt);
  return Promise.resolve();
}

async function capAuthHeader() {
  const auth = await ensureNasAuth('时光胶囊');
  if (!auth) return null;
  try { return 'Basic ' + btoa(auth); } catch (_) { return null; }
}

// —— 传输层：JSON 明文，直接进 NAS 的 uploads/ ——
// 上传带重试：NAS 的 /api/upload 在并发/负载高时会间歇性 502 或直接不回响应
// （服务端日志里能看到 SSH 归档步骤失败 + panic）。同一文件重试几乎必成功，
// 所以这里做 3 次、退避 600/1500ms，全部失败才抛错。
async function capPutJson(name, obj, authHeader, tries) {
  const max = tries || 3;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    const fd = new FormData();
    fd.append('file', new Blob([JSON.stringify(obj)], { type: 'application/json' }), name);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const r = await fetch(NAS_UPLOAD_URL, {
        method: 'POST', headers: { Authorization: authHeader }, body: fd,
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (r.ok) { capListCache.at = 0; return r.json().catch(() => ({})); }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = new Error(/abort/i.test(e.message) ? '响应超时' : e.message);
    }
    if (i < max - 1) await new Promise((r2) => setTimeout(r2, 600 * Math.pow(2.5, i)));
  }
  throw lastErr || new Error('上传失败');
}
async function capGetJson(name, authHeader) {
  // 注意：NAS 在"文件不存在"时返回 503，而且错误响应不带 CORS 头 →
  // 浏览器会把它报成 TypeError: Failed to fetch（看起来像网络坏了）。
  // 所以这里整段包 try/catch，统一按"没有这个文件"处理。
  try {
    const r = await fetch(NAS_DOWNLOAD_URL + '?filename=' + encodeURIComponent(name), { headers: { Authorization: authHeader } });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch (_) { return null; }
}

function capIdxName() { return 'cap_' + capCode + '_idx.json'; }

async function capReadIndex(auth) {
  const j = await capGetJson(capIdxName(), auth);
  return (j && Array.isArray(j.items)) ? j.items : null;
}
// 索引项的字段：{ id, at, dev, del? }。del=1 是「墓碑」——表示这条已被某台设备删除。
// 为什么要墓碑而不是直接删文件：NAS 没有删除接口（探测过 /api/archive/delete 等全 404），
// 所以只能靠索引里的标记让所有设备都忽略它。代价是 NAS 上会留几十字节的孤儿文件。
function capIdxPick(it, prev) {
  const base = prev || {};
  const r = { id: it.id, at: it.at || base.at || 0, dev: it.dev || base.dev || '' };
  if (it.del || base.del) r.del = 1;      // 墓碑一旦写下就不会被后来的「新增」覆盖
  return r;
}
async function capWriteIndex(items, auth) {
  const uniq = new Map();
  for (const it of items) if (it && it.id) uniq.set(it.id, capIdxPick(it, uniq.get(it.id)));
  const list = Array.from(uniq.values()).sort((a, b) => a.at - b.at).slice(-800);
  await capPutJson(capIdxName(), { v: 1, items: list }, auth);
}
async function capMergeIndex(newItems, auth) {
  const cur = (await capReadIndex(auth)) || [];
  const map = new Map();
  for (const it of cur.concat(newItems)) if (it && it.id) map.set(it.id, capIdxPick(it, map.get(it.id)));
  await capWriteIndex(Array.from(map.values()), auth);
}

// 兜底：索引丢了就扫目录（uploads 是平铺两万多个文件、2.7MB，5~8 秒，只在深度同步时用）
async function capListNs(authHeader, force) {
  if (!force && capListCache.at && capListCache.ns === capCode && Date.now() - capListCache.at < CAP_LIST_TTL) {
    return capListCache.items;
  }
  const r = await fetch(NAS_ARCHIVE_HOST + '/api/archive/list?path=uploads', { headers: { Authorization: authHeader } });
  if (!r.ok) throw new Error('列目录失败 HTTP ' + r.status);
  const all = await r.json();
  const prefix = 'cap_' + capCode + '_c_';
  const items = (Array.isArray(all) ? all : [])
    .filter((x) => !x.is_dir && String(x.name || '').startsWith(prefix))
    .map((x) => ({ name: x.name, size: x.size, t: x.mod_time }));
  capListCache = { at: Date.now(), ns: capCode, items };
  return items;
}

function capLoadCache() {
  try {
    const raw = localStorage.getItem('cap_cache_' + capCode);
    capItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(capItems)) capItems = [];
  } catch (_) { capItems = []; }
}
function capSaveCache() {
  try {
    const keep = capItems.slice().sort((a, b) => b.at - a.at).slice(0, 100);
    localStorage.setItem('cap_cache_' + capCode, JSON.stringify(keep));
  } catch (_) {}
}

function capSetReady(on) {
  ['capCollect', 'capSync', 'capDeep'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function capRender() {
  const box = document.getElementById('capList');
  if (!box) return;
  if (!capItems.length) {
    box.innerHTML = '<div class="cap-empty">还没有胶囊。点「收集剪贴板」存第一条。</div>';
    return;
  }
  box.innerHTML = '';
  capItems.slice().sort((a, b) => b.at - a.at).forEach((it) => {
    const d = document.createElement('div');
    d.className = 'cap-item';
    const w = new Date(it.at);
    const when = (w.getMonth() + 1) + '月' + w.getDate() + '日 ' +
      String(w.getHours()).padStart(2, '0') + ':' + String(w.getMinutes()).padStart(2, '0');
    d.innerHTML = '<div class="ch"><b></b><span></span><span></span></div>' +
      '<div class="ct"></div><div class="cf">' +
      '<button type="button" data-copy>复制</button><button type="button" data-open>展开</button>' +
      '<button type="button" class="cap-del" data-del>删除</button></div>';
    const ch = d.querySelectorAll('.ch span');
    d.querySelector('.ch b').textContent = when;
    ch[0].textContent = '设备 ' + (it.dev || '?');
    ch[1].textContent = it.text.length + ' 字';
    d.querySelector('.ct').textContent = it.text;
    d.querySelector('[data-copy]').onclick = (e) => {
      e.stopPropagation();
      capCopy(it.text).then(() => flash('已复制'), () => flash('复制失败'));
    };
    d.querySelector('[data-open]').onclick = (e) => {
      e.stopPropagation();
      d.classList.toggle('open');
      e.target.textContent = d.classList.contains('open') ? '收起' : '展开';
    };
    d.querySelector('[data-del]').onclick = (e) => {
      e.stopPropagation();
      capDelete(it);
    };
    box.appendChild(d);
  });
}

async function capSync(silent, deep) {
  if (!capCode) return;
  const auth = await capAuthHeader();
  if (!auth) return;
  if (!silent) flash(deep ? '深度同步（扫目录，稍慢）…' : '同步中…');
  try {
    const flushed = await capFlushPending(auth);
    let items = [];
    let needDeep = false;
    const tombstones = new Set();
    if (!deep) {
      const idx = await capReadIndex(auth);
      if (idx) {
        for (const x of idx) {
          if (x.del) tombstones.add(x.id);
          else items.push({ name: x.id });
        }
      } else needDeep = true;
    }
    // 应用墓碑：本机有、但别的设备已删除的，这里也移除
    if (tombstones.size) {
      const before = capItems.length;
      capItems = capItems.filter((x) => !tombstones.has(x.name));
      if (capItems.length !== before) { capSaveCache(); capRender(); }
    }
    // 只有「用户明确点深度同步」才扫目录。
    // 为什么不再自动扫：/api/archive/list?path=uploads 会让 knowly 对两万个文件批量提标题
    // （BatchExtractTitles 每个文件开一次 SSH session），并发撞上重连就 panic 整个请求
    // （见 ssh/client.go:1185 → :170 → x/crypto/ssh client.go:135 nil pointer）。
    // 所以默认路径必须绕开它。
    if (deep) {
      items = await capListNs(auth, true);
      if (items.length) {
        capMergeIndex(items.map((x) => ({ id: x.name, at: 0, dev: '' })), auth).catch(() => {});
      }
    } else if (needDeep) {
      if (!silent) flash('这台设备还没索引：先点一次「深度」，之后就走秒同步了');
      return;
    }
    const have = new Set(capItems.map((x) => x.name));
    const todo = items.filter((x) => !have.has(x.name));
    let added = 0;
    for (const it of todo) {
      const j = await capGetJson(it.name, auth);
      if (!j || typeof j.text !== 'string') continue;
      capItems.push({ name: it.name, at: j.at || 0, dev: j.dev || '', text: j.text });
      added++;
    }
    capSaveCache();
    capRender();
    capLastSyncAt = Date.now();
    if (!silent) {
      const parts = [];
      if (flushed) parts.push('补传 ' + flushed + ' 条');
      if (added) parts.push('新增 ' + added + ' 条');
      flash(parts.length ? ('同步完成：' + parts.join('，')) : '已是最新');
    }
  } catch (e) {
    if (!silent) flash('同步失败：' + e.message);
  }
}

// 待传队列：上传失败（NAS 抽风）时先把内容留在本机，下次同步自动补传。
// 避免"点了收集、报错、内容丢了"——那是最伤体验的一种失败。
function capPendingKey() { return 'cap_pending_' + capCode; }
function capLoadPending() {
  try { return JSON.parse(localStorage.getItem(capPendingKey()) || '[]') || []; } catch (_) { return []; }
}
function capSavePending(list) {
  try { localStorage.setItem(capPendingKey(), JSON.stringify(list.slice(-50))); } catch (_) {}
}
async function capFlushPending(auth) {
  const list = capLoadPending();
  if (!list.length) return 0;
  const left = [];
  let sent = 0;
  for (const p of list) {
    try {
      await capPutJson(p.name, { v: 1, at: p.at, dev: p.dev, text: p.text }, auth);
      capMergeIndex([{ id: p.name, at: p.at, dev: p.dev }], auth).catch(() => {});
      sent++;
    } catch (_) { left.push(p); }
  }
  capSavePending(left);
  return sent;
}

async function capSaveText(text) {
  text = String(text || '').trim();
  if (!text) { flash('没有内容'); return; }
  const auth = await capAuthHeader();
  if (!auth) return;
  try {
    const at = Date.now();
    const name = 'cap_' + capCode + '_c_' + capDevId() + '_' + at.toString(36) + '.json';
    await capPutJson(name, { v: 1, at, dev: capDevId(), text }, auth);
    capMergeIndex([{ id: name, at, dev: capDevId() }], auth).catch(() => {});
    capItems.push({ name, at, dev: capDevId(), text });
    capSaveCache();
    capRender();
    flash('已存入胶囊（' + text.length + ' 字）');
  } catch (e) {
    // 上传失败：留在本机待传队列，下次同步自动补
    const at = Date.now();
    const name = 'cap_' + capCode + '_c_' + capDevId() + '_' + at.toString(36) + '.json';
    const q = capLoadPending();
    q.push({ name, at, dev: capDevId(), text });
    capSavePending(q);
    capItems.push({ name, at, dev: capDevId(), text, pending: true });
    capSaveCache();
    capRender();
    flash('已存在本机，稍后自动补传（NAS 暂时不响应：' + e.message + '）');
  }
}

// 删除一条胶囊：写墓碑进索引 → 本机移除。其他设备下次同步会自动消失。
async function capDelete(it) {
  if (!capCode) return;
  if (!confirm('从所有设备的时间线里删除这一条？\n\nNAS 上的文件会保留（服务端没有删除接口），只是不再显示。')) return;
  const auth = await capAuthHeader();
  if (!auth) return;
  flash('删除中…');
  try {
    const cur = (await capReadIndex(auth)) || [];
    const found = cur.some((x) => x.id === it.name);
    const next = cur.map((x) => (x.id === it.name ? capIdxPick(x, { del: 1 }) : x));
    if (!found) next.push({ id: it.name, at: it.at || 0, dev: it.dev || '', del: 1 });
    await capWriteIndex(next, auth);
    capItems = capItems.filter((x) => x.name !== it.name);
    capSaveCache();
    capRender();
    flash('已删除（其他设备下次同步也会消失）');
  } catch (e) {
    flash('删除失败：' + (e && e.message ? e.message : e));
  }
}

async function capCollect() {
  if (!capCode) return;
  const paste = document.getElementById('capPaste');
  if (!capClipboardOk()) {
    paste.hidden = false;
    const ta = document.getElementById('capPasteBox');
    ta.value = ''; ta.focus();
    flash('当前环境不允许脚本读剪贴板，长按输入框粘贴即可');
    return;
  }
  try {
    const t = await navigator.clipboard.readText();
    await capSaveText(t);
  } catch (_) {
    paste.hidden = false;
    document.getElementById('capPasteBox').focus();
    flash('读取剪贴板被拒绝，请长按输入框粘贴');
  }
}

async function capConnect(code) {
  const norm = capNormCode(code);
  if (norm.length < 6) { flash('配对码至少 6 位'); return; }
  capCode = norm;
  try { localStorage.setItem(CAP_CODE_KEY, capFmtCode(code)); } catch (_) {}
  document.getElementById('capSetup').hidden = true;
  document.getElementById('capNs').textContent = '前缀 cap_' + capCode.slice(0, 8) + '…';
  document.getElementById('capCodeShow').textContent = capFmtCode(code);
  capSetReady(true);
  capLoadCache();
  capRender();
  capSync(true);
}

function capOpen() {
  const m = document.getElementById('capModal');
  if (!m) return;
  m.hidden = false;
  capStartPoll();
  document.getElementById('capPaste').hidden = true;
  let saved = '';
  try { saved = localStorage.getItem(CAP_CODE_KEY) || ''; } catch (_) {}
  if (saved) capConnect(saved);
  else {
    document.getElementById('capSetup').hidden = false;
    document.getElementById('capCode').value = capGenCode(10);
    capSetReady(false);
    flash('已生成配对码，点「保存并连接」开始');
  }
}

// 面板打开期间每 30 秒拉一次索引（一个几 KB 的 JSON），有新增才下载
function capStartPoll() {
  capStopPoll();
  capPollTimer = setInterval(() => {
    const m = document.getElementById('capModal');
    if (!m || m.hidden || !capCode) return;
    capSync(true);
  }, 30000);
}
function capStopPoll() {
  if (capPollTimer) { clearInterval(capPollTimer); capPollTimer = 0; }
}

function capBind() {
  const m = document.getElementById('capModal');
  if (!m) return;
  const close = () => { m.hidden = true; capStopPoll(); };
  document.getElementById('capDone').addEventListener('click', close);
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  document.getElementById('capCollect').addEventListener('click', capCollect);
  document.getElementById('capSync').addEventListener('click', () => capSync(false));
  const deepBtn = document.getElementById('capDeep');
  if (deepBtn) deepBtn.addEventListener('click', () => {
    if (!confirm('深度同步会扫描 NAS 上传目录（两万多个文件，较慢，且会给 Knowly 造成压力）。\n\n只在换新设备或索引丢失时用，平时点「同步」即可。继续？')) return;
    capSync(false, true);
  });
  const copyCode = document.getElementById('capCodeCopy');
  if (copyCode) copyCode.addEventListener('click', () => {
    const cur = document.getElementById('capCodeShow').textContent;
    if (!cur || cur === '—') { flash('还没有配对码'); return; }
    capCopy(cur).then(() => flash('配对码已复制，另一台设备粘进去即可'), () => flash('复制失败'));
  });
  const changeCode = document.getElementById('capCodeChange');
  if (changeCode) changeCode.addEventListener('click', () => {
    document.getElementById('capSetup').hidden = false;
    document.getElementById('capCode').value = document.getElementById('capCodeShow').textContent.replace('—', '');
    flash('改完点「保存并连接」生效（旧码的胶囊不会跟过来）');
  });
  document.getElementById('capGen').addEventListener('click', () => {
    document.getElementById('capCode').value = capGenCode(10);
    flash('已生成配对码，记下来');
  });
  document.getElementById('capSave').addEventListener('click', () => {
    const v = document.getElementById('capCode').value.trim();
    if (!v) { flash('先输入或生成配对码'); return; }
    capConnect(v);
  });
  document.getElementById('capForget').addEventListener('click', () => {
    try {
      localStorage.removeItem(CAP_CODE_KEY);
      localStorage.removeItem('cap_cache_' + capCode);
    } catch (_) {}
    capCode = ''; capItems = [];
    document.getElementById('capCodeShow').textContent = '—';
    capSetReady(false);
    document.getElementById('capSetup').hidden = false;
    document.getElementById('capCode').value = capGenCode(10);
    capRender();
    flash('已忘记这台设备的配对');
  });
  document.getElementById('capPasteSave').addEventListener('click', async () => {
    await capSaveText(document.getElementById('capPasteBox').value);
    document.getElementById('capPasteBox').value = '';
    document.getElementById('capPaste').hidden = true;
  });
}

capBind();

// === SECTION: 锚点同步滚动辅助 ===
let lastSanitizedHtml = '';
let headingLineMap = new Map();
let anchorNavLock = 0;
// slugify / buildHeadingLineMap 已下沉到 lib/md-core.js：
// 两侧（DOM 标题 id 与源码行映射）必须共用同一个 slugger，否则同名标题会产生重复 id。
// 行偏移缓存：同一份字符串（不可变）只算一次。
// 旧实现在 renderMarkdown / updateGutter / updatePos / scrollEditorToLine / 查找定位里
// 各自 editor.value.split('\n')，1MB 文档下每次编辑要建多份临时数组。
let _loCache = { v: null, off: [0] };
function getLineOffsets(v) {
  if (_loCache.v !== v) _loCache = { v, off: lineOffsets(v) };
  return _loCache.off;
}

function scrollEditorToLine(line) {
  const off = getLineOffsets(editor.value);
  const pos = off[Math.max(0, Math.min(line, off.length - 1))];
  if (viewMode !== 'preview') {
    // lh 仅此处需要；放在分支内，避免预览模式下 getComputedStyle 触发 reflow、打断 tocJumpTo 的 smooth 滚动
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 25;
    editor.scrollTop = Math.max(0, line * lh - editor.clientHeight / 3);
    syncHighlightScroll();
  }
  editor.selectionStart = editor.selectionEnd = pos;
  if (viewMode !== 'preview') editor.focus();
}
// 切换到预览时，把预览定位到编辑器当前所在章节（即时滚动，切换瞬间无需平滑）。
// 编辑模式下目录跳转可靠，配合此函数即可「编辑定位 → 切预览保持」，绕开预览模式滚动顽疾。
function syncPreviewToLine(lineNo) {
  const lines = editor.value.split('\n');
  let targetSlug = null;
  for (let i = Math.min(lineNo, lines.length - 1); i >= 0; i--) {
    const m = lines[i] && lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) { targetSlug = slugify(m[1]); break; }
  }
  if (!targetSlug) return;   // 在任何标题之前 → 保持顶部
  let h = null;
  try { h = preview.querySelector('#' + CSS.escape(targetSlug)); } catch (e) {}
  if (!h) { try { h = document.getElementById(targetSlug); } catch (e) {} }
  if (!h) return;
  const targetTop = h.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
  previewPane.scrollTop = Math.max(0, targetTop);
}

function onPreviewAnchorClick(e) {
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!href.startsWith('#') || href.length < 2) return;
  // 阻止浏览器默认 hash 滚动：在「原生全屏 + body{overflow:hidden} + 嵌套 overflow:auto」下，
  // 它会滚 documentElement 而非预览区，表现为点击正文目录链接后预览被拉回首页。
  e.preventDefault();
  const slug = decodeURIComponent(href.slice(1));   // 中文标题 hash 会被百分号编码，解码后才能匹配中文 id
  const heading = document.getElementById(slug);
  if (!heading) return;
  anchorNavLock = Date.now() + 550;   // 跳转锁：覆盖 450ms 手动动画 + 缓冲
  // 手动平滑滚预览区到标题（不用浏览器原生 smooth——会被 reflow 取消停在半路）
  const targetTop = heading.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
  smoothScrollTo(previewPane, Math.max(0, targetTop), 450);
  if (headingLineMap.has(slug)) scrollEditorToLine(headingLineMap.get(slug));
}

// === SECTION: 目录（右侧大纲抽屉：阅读长文时跳转章节 + 滚动高亮当前所在） ===
const tocDrawer = $('#tocDrawer');
const tocList = $('#tocList');
const tocEmpty = $('#tocEmpty');
const btnToc = $('#btnToc');
let tocOpen = localStorage.getItem('md-toc') === '1';   // 开关状态持久化
let tocSpyRaf = 0;

// 渲染后重建目录：遍历预览里的所有标题，按层级缩进生成可点击条目
function buildToc() {
  if (!tocList) return;
  const heads = preview.querySelectorAll('h1,h2,h3,h4,h5,h6');
  tocList.innerHTML = '';
  if (!heads.length) {
    if (tocEmpty) tocEmpty.hidden = false;
    return;
  }
  if (tocEmpty) tocEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  heads.forEach((h) => {
    const level = h.tagName.slice(1);
    const text = (h.textContent || '').trim();
    const slug = h.id || slugify(text);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.dataset.level = level;
    btn.dataset.slug = slug;
    btn.textContent = text || '(无标题)';
    btn.title = text;
    frag.appendChild(btn);
  });
  tocList.appendChild(frag);
  if (tocOpen) updateTocActive();   // 文档变更后刷新当前章节高亮
}

function setTocOpen(on) {
  tocOpen = on;
  localStorage.setItem('md-toc', on ? '1' : '0');
  tocDrawer.classList.toggle('open', on);
  tocDrawer.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (btnToc) {
    btnToc.setAttribute('aria-expanded', on ? 'true' : 'false');
    btnToc.classList.toggle('active', on);
  }
  if (on) {
    buildToc();
    updateTocActive();   // 打开即定位到当前阅读位置
  }
}

// 点击目录条目 → 滚动预览到对应标题，并同步编辑器到源码行（复用锚点跳转的锁机制）
// 手动平滑滚动：逐帧「即时」设置 scrollTop。不依赖浏览器原生 smooth——后者进行中会被
// getBoundingClientRect 的 reflow 取消，导致目录跳转停在半路（预览模式的顽疾；编辑模式用
// 即时 editor.scrollTop= 所以从不中招）。每帧即时赋值，无「进行中」状态可被打断，又保留动画。
let tocScrollTimer = 0;
function smoothScrollTo(el, targetTop, duration) {
  clearTimeout(tocScrollTimer);
  targetTop = Math.max(0, targetTop);
  const start = el.scrollTop;
  const distance = targetTop - start;
  if (Math.abs(distance) < 2) { el.scrollTop = targetTop; return; }
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);   // easeInOutQuad
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    el.scrollTop = start + distance * ease(t);
    if (t < 1) tocScrollTimer = setTimeout(() => step(performance.now()), 16);
    else el.scrollTop = targetTop;   // final precise landing (avoid 1px short)
  };
  tocScrollTimer = setTimeout(() => step(performance.now()), 0);
}
function tocJumpTo(slug) {
  if (!slug) return;
  let heading = null;
  try { heading = preview.querySelector('#' + CSS.escape(slug)); } catch (_) {}
  if (!heading) { try { heading = document.getElementById(slug); } catch (_) {} }
  if (!heading) return;
  anchorNavLock = Date.now() + 550;   // 跳转锁：覆盖下方 450ms 手动动画 + 缓冲；期间暂停比例同步与 scroll-spy
  const targetTop = heading.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
  smoothScrollTo(previewPane, Math.max(0, targetTop), 450);
  if (headingLineMap.has(slug)) scrollEditorToLine(headingLineMap.get(slug));
}

// scroll-spy：高亮预览当前所在章节。用 getBoundingClientRect 相对预览区顶部判定，
// 不依赖 offsetParent，在 flex/换行布局下也稳定。
function updateTocActive() {
  if (!tocList) return;
  const heads = preview.querySelectorAll('h1,h2,h3,h4,h5,h6');
  if (!heads.length) return;
  // 纯编辑模式（预览 display:none）：没有预览滚动上下文，改为「跟随光标所在章节」。
  // 旧实现固定高亮第一个标题，等于在编辑态目录完全没用。
  if (previewPane.clientHeight === 0) {
    const { line } = posToLineCol(getLineOffsets(editor.value), editor.selectionStart);
    let bestSlug = null, bestLine = -1;
    headingLineMap.forEach((ln, slug) => { if (ln <= line && ln > bestLine) { bestLine = ln; bestSlug = slug; } });
    const hit = bestSlug ? Array.prototype.find.call(heads, (h) => h.id === bestSlug) : null;
    setActiveTocItem(hit || heads[0]);
    return;
  }
  const paneTop = previewPane.getBoundingClientRect().top;
  const offset = previewPane.clientHeight * 0.25;   // 标题进入预览顶部 25% 即视为「当前章节」
  let active = null;
  heads.forEach((h) => {
    if (h.getBoundingClientRect().top - paneTop <= offset) active = h;
  });
  if (!active) active = heads[0];   // 顶部之上的首屏：高亮第一个标题
  setActiveTocItem(active);
}

// 给指定标题对应的目录条目加 .active，其余清除；并把当前项滚进目录可视区
function setActiveTocItem(heading) {
  if (!heading) return;
  const slug = heading.id || slugify(heading.textContent);
  let cur = null;
  tocList.querySelectorAll('.toc-item').forEach((it) => {
    const on = it.dataset.slug === slug;
    it.classList.toggle('active', on);
    if (on) cur = it;
  });
  if (cur) {
    // 显式只滚目录面板，让当前高亮项可见。绝不用 scrollIntoView——它会遍历滚动祖先链，
    // 在「原生全屏 + body{overflow:hidden}」、长目录目标项在面板外时，误把预览区也滚了，
    // 覆盖掉 tocJumpTo 的 scrollBy，导致点击章节后预览被拉回首页。只驱动 tocList 自身。
    const r = cur.getBoundingClientRect(), pr = tocList.getBoundingClientRect();
    if (r.top < pr.top) tocList.scrollBy({ top: r.top - pr.top });
    else if (r.bottom > pr.bottom) tocList.scrollBy({ top: r.bottom - pr.bottom });
  }
}

if (btnToc) btnToc.addEventListener('click', () => setTocOpen(!tocOpen));
if ($('#tocClose')) $('#tocClose').addEventListener('click', () => setTocOpen(false));
if (tocList) tocList.addEventListener('click', (e) => {
  const it = e.target.closest('.toc-item');
  if (it) tocJumpTo(it.dataset.slug);
});
// Esc 关闭目录（与全屏退出共用 keydown，互不冲突：全屏时才拦截 Esc）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tocOpen && !document.body.classList.contains('fullscreen')) setTocOpen(false);
});

// === SECTION: Blob 图片：入库 + 解析 ===
let imgUrlCache = new Map();   // id -> { blob }，带 LRU 上限，防止 Blob 长期驻留内存（见 resolveImages）
const IMG_CACHE_MAX = 30;      // 最多缓存 30 张图，超出淘汰最旧，避免大文档/多图场景内存只增不减
let activeImgUrls = new Set();
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function resolveImages() {
  if (!libDb) return;
  // 按 data-libimg 定位（src 此时是占位图）；已解析过的图 src 已是 blob:，无需重复处理
  const imgs = preview.querySelectorAll('img[data-libimg]');
  if (!imgs.length) return;
  const newUrls = new Set();
  const pending = [];
  imgs.forEach((img) => {
    const id = img.getAttribute('data-libimg');
    if (img.getAttribute('src') && img.getAttribute('src').startsWith('blob:')) return;   // 已解析
    pending.push((async () => {
      let entry = imgUrlCache.get(id);
      if (!entry) {
        try {
          const rec = await idbGetImage(id);
          if (!rec || !rec.blob) { img.classList.add('broken'); return; }
          entry = { blob: rec.blob };
          imgUrlCache.set(id, entry);
          if (imgUrlCache.size > IMG_CACHE_MAX) {   // LRU 淘汰：超出上限删除最旧条目
            const oldest = imgUrlCache.keys().next().value;
            imgUrlCache.delete(oldest);
          }
        } catch (_) { img.classList.add('broken'); return; }
      } else {
        imgUrlCache.delete(id);   // 命中缓存：刷新 LRU 顺序，常用图不被误淘汰
        imgUrlCache.set(id, entry);
      }
      const url = URL.createObjectURL(entry.blob);
      newUrls.add(url);
      img.loading = 'lazy';   // 文库图延迟加载：多图/大文档不阻塞首屏（与裸链接图一致）
      img.src = url;          // data-libimg 保留，snapshotPreviewHtml() 据此还原成 libimg://
      img.classList.remove('broken');
    })());
  });
  Promise.all(pending).then(() => {
    activeImgUrls.forEach((u) => { if (!newUrls.has(u)) URL.revokeObjectURL(u); });
    activeImgUrls = newUrls;
  });
}

// 导出用快照：克隆预览 DOM，但把渲染用的 blob: 临时 URL 还原成 libimg://<id>，
// 这样 inlineLibImages() 仍能命中并把图片内联成 data URL（否则导出的 HTML 会丢图）。
function snapshotPreviewHtml() {
  const html = preview.innerHTML;
  // 常见情况（无文库图）：直接返回，零额外开销
  if (html.indexOf('data-libimg') < 0) return html;
  // 纯字符串改写，绝不去碰 <img> 元素：哪怕是在「克隆出来的游离节点」上把 src 设成
  // libimg://，Chrome 也会真的发起一次请求（控制台 ERR_UNKNOWN_URL_SCHEME）。
  return html.replace(/<img\b([^>]*)>/gi, (whole, attrs) => {
    const idm = attrs.match(/data-libimg="([a-z0-9]+)"/i);
    if (!idm) return whole;
    const rest = attrs.replace(/\ssrc="[^"]*"/i, '');
    return '<img src="libimg://' + idm[1] + '"' + rest + '>';
  });
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderMarkdown, 120);
}

// === SECTION: 编辑器源码高亮：textarea 之上叠一层 <pre>，复用 hljs 自带 markdown 语法 ===
function renderEditorHighlight() {
  // 移动端（软换行）不启用：避免错位 / 降级为纯文本
  if (window.innerWidth <= 760) {
    editor.parentElement.classList.remove('has-overlay');
    editorHighlight.textContent = '';
    return;
  }
  // 超长文档（数千行）整篇 hljs 重算开销大，跳过覆盖层高亮避免编辑卡顿（与移动端同降级策略）
  if (getLineOffsets(editor.value).length > 3000) {
    editor.parentElement.classList.remove('has-overlay');
    editorHighlight.textContent = '';
    return;
  }
  try {
    // 用内核的源码高亮，不再用 hljs 的 markdown 语法：
    // hljs 那套是给"渲染后的 markdown"写的，会把 front matter 里的下划线跨行配成 <em>，
    // 还会给标题/强调加粗倾斜 —— 字宽一变，覆盖层就和 textarea 对不齐（见 lib/md-core.js 注释）。
    let html = Core.highlightMarkdownSource(editor.value);
    if (currentSearchHit) html = wrapSearchHitInHtml(html, currentSearchHit);
    editorHighlight.innerHTML = html;
    editor.parentElement.classList.add('has-overlay');
    syncHighlightScroll();
  } catch (_) {
    editor.parentElement.classList.remove('has-overlay');
  }
}
// 在语法高亮 HTML 中给当前查找匹配段包裹 <mark class="search-hit">，使关键词在覆盖层上清晰可见。
// 基于 textContent 偏移映射，可跨语法 token 边界。
function wrapSearchHitInHtml(html, hit) {
  if (!hit || hit.start >= hit.end) return html;
  const frag = document.createRange().createContextualFragment(html);
  let offset = 0, done = false;
  const mark = document.createElement('mark');
  mark.className = 'search-hit';
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    if (done) break;
    const len = node.textContent.length;
    const ns = offset, ne = offset + len;
    offset = ne;
    if (ne <= hit.start || ns >= hit.end) continue;
    const s = Math.max(0, hit.start - ns);
    const e = Math.min(len, hit.end - ns);
    const before = node.textContent.slice(0, s);
    const mid = node.textContent.slice(s, e);
    const after = node.textContent.slice(e);
    const parent = node.parentNode;
    const ref = node;
    if (before) parent.insertBefore(document.createTextNode(before), ref);
    const m = mark.cloneNode();
    m.textContent = mid;
    parent.insertBefore(m, ref);
    if (after) parent.insertBefore(document.createTextNode(after), ref);
    parent.removeChild(ref);
    if (offset >= hit.end) done = true;
  }
  const tmp = document.createElement('div');
  tmp.appendChild(frag);
  return tmp.innerHTML;
}
function syncHighlightScroll() {
  editorHighlight.scrollTop = editor.scrollTop;
  editorHighlight.scrollLeft = editor.scrollLeft;
}

// === SECTION: 编辑器换行：开=软换行（无横向滚动、隐藏行号）；关=不换行（保留行号逐行对齐） ===
let wrapMode = localStorage.getItem('md-wrap') !== 'off';
function applyWrap() {
  editor.wrap = wrapMode ? 'soft' : 'off';
  editor.parentElement.classList.toggle('wrap-on', wrapMode);
  const bw = $('#menuWrap');
  if (bw) bw.textContent = '↩️ 换行：' + (wrapMode ? '开' : '关');
  renderEditorHighlight();
  syncHighlightScroll();
}

// === SECTION: 统计 / 行号 / 光标位置 ===
function updateStats() {
  const r = countWords(editor.value);          // 统计口径（CJK 按字 / 其余按词）在 md-core 里，有单测
  const txt = r.words + ' 字 · ' + r.readMin + ' 分';
  $('#stat').textContent = txt;
  const ri = $('#readInfo'); if (ri) ri.textContent = txt;   // 预览模式底部栏复用同一数据
}
// 行号槽：除了数字，还给出「层级」线索（标题行左侧色条 + 围栏行淡色）。
// 为什么不用改字号/字重来体现层级：gutter 与 #editor 必须逐行对齐（同为 25px 行高），
// 任何字形变化都会让行号错位——和编辑区覆盖层是同一条红线。
function updateGutter() {
  const src = editor.value;
  const lines = src.split('\n');
  // 轻量签名：行数 + 长度 + 标题数量。内容改动（含标题层级变化）都会刷新，纯滚动不会。
  const sig = lines.length + '|' + src.length + '|' + (src.match(/^ {0,3}#{1,6}\s/gm) || []).length;
  if (gutter.dataset.sig === sig) return;
  gutter.dataset.sig = sig;
  gutter.dataset.lines = String(lines.length);
  let html = '';
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let cls = 'gl';
    const fm = ln.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      cls += ' gl-in-fence';
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
    } else if (fm) {
      cls += ' gl-fence'; fence = fm[1];
    } else {
      const h = ln.match(/^ {0,3}(#{1,6})\s/);
      if (h) cls += ' gl-h gl-h' + h[1].length;
    }
    html += '<div class="' + cls + '">' + (i + 1) + '</div>';
  }
  gutter.innerHTML = html;
}
function updatePos() {
  const { line, col } = posToLineCol(getLineOffsets(editor.value), editor.selectionStart);
  $('#posInfo').textContent = '行 ' + line + '，列 ' + col;
  // 目录打开时跟随光标（编辑态没有滚动 spy，只能靠光标）
  if (tocOpen) {
    cancelAnimationFrame(tocSpyRaf);
    tocSpyRaf = requestAnimationFrame(updateTocActive);
  }
}
// 统计 / 行号 / 光标位置：input 每键触发。
// 旧实现用 rAF 合并——但连续打字时「每帧一次」仍是 60 次/秒的全量正则扫描。
// 改成「120ms 去抖 + 空闲回调」：只在真正停手时算一次，大文档逐键开销归零。
const runStats = debounce(() => {
  const work = () => { updateStats(); updateGutter(); updatePos(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 300 });
  else work();
}, 120);
function scheduleStats() { runStats(); }

// === SECTION: 视图：双栏 / 编辑 / 预览 ===
const VIEW_CYCLE = ['split', 'edit', 'preview'];
const VIEW_LABEL = { split: '分屏', edit: '编辑', preview: '预览' };
let viewMode = 'split';
function setView(m) {
  const prev = viewMode;
  // 切到预览前，先记下编辑器当前可见首行（切完 editor 隐藏，其 scrollTop 可能归零，读不到）
  let firstLine = null;
  if (m === 'preview' && prev !== 'preview') {
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 25;
    firstLine = Math.round(editor.scrollTop / lh);
  }
  viewMode = m;
  document.body.classList.remove('no-preview', 'no-editor');
  if (m === 'edit') document.body.classList.add('no-preview');
  if (m === 'preview') document.body.classList.add('no-editor');
  // 底部状态栏按模式切换：预览显「字数·阅读时长」，编辑/分屏显「行·列」
  const isPreview = (m === 'preview');
  const pi = $('#posInfo'), ri = $('#readInfo');
  if (pi) pi.hidden = isPreview;
  if (ri) ri.hidden = !isPreview;
  if (isPreview) updateStats();   // 进入预览即刷新篇幅/阅读时长（编辑期间已是最新）
  $('#btnView').textContent = VIEW_LABEL[m];
  if (m !== 'preview') editor.focus();
  // 进入预览：rAF 等布局稳定后，把预览定位到编辑器当前所在章节（不回开头）
  if (firstLine !== null) requestAnimationFrame(() => syncPreviewToLine(firstLine));
}
// 是否手机布局（单列）：以实际 grid 为准，并用 matchMedia 兜底，保证手机只切「编辑/预览」
function isMobileLayout() {
  // .workspace 是 flex 布局（非 grid），gridTemplateColumns 恒为 'none'，旧的前两项比较永不命中，直接以视口宽度判定
  return window.matchMedia('(max-width: 760px)').matches;
}
function nextView() {
  const cycle = isMobileLayout() ? ['edit', 'preview'] : VIEW_CYCLE;
  setView(cycle[(cycle.indexOf(viewMode) + 1) % cycle.length]);
}
$('#btnView').addEventListener('click', nextView);
// 手机默认预览（打开即看排版效果），桌面默认双栏
{
  setView(isMobileLayout() ? 'preview' : 'split');
}

// === SECTION: 全屏：隐藏工具栏/状态栏（+ 尝试浏览器原生全屏），右上角 ✕ 退出 ===
const btnFullscreen = $('#btnFullscreen');
const btnExitFullscreen = $('#btnExitFullscreen');
const btnTocFs = $('#btnTocFs');   // 全屏浮动目录按钮：默认隐藏，双击屏幕显隐（与 ✕ 同机制）
function setFullscreen(on) {
  // 全屏时若文库抽屉开着，强制关闭，避免退出按钮（z-index:9999）盖在抽屉之上
  if (on && libDrawer && libDrawer.classList.contains('open')) closeLibrary();
  document.body.classList.toggle('fullscreen', on);
  if (btnExitFullscreen) btnExitFullscreen.hidden = !on;   // 用 hidden 属性显隐，默认隐藏（不依赖外部 CSS）
  if (btnTocFs) btnTocFs.hidden = !on;                     // 全屏浮动目录按钮：仅全屏可见
  // 兜底：直接控制 chrome 显隐，即使样式未及时更新也能全屏
  const tb = document.querySelector('.toolbar'), sb = document.querySelector('.statusbar');
  if (tb) tb.style.display = on ? 'none' : '';
  if (sb) sb.style.display = on ? 'none' : '';
  if (on) {
    const el = document.documentElement;
    if (el.requestFullscreen) { try { el.requestFullscreen(); } catch (_) {} }   // iOS 非视频不支持→仅应用级全屏
    if (btnExitFullscreen) btnExitFullscreen.classList.add('idle');   // 进入全屏：✕ 默认隐藏，双击呼出
    if (btnTocFs) btnTocFs.classList.add('idle');                     // 目录按钮同样默认隐藏
  } else {
    if (btnExitFullscreen) btnExitFullscreen.classList.remove('idle');   // 退出全屏：恢复正常显示
    if (btnTocFs) btnTocFs.classList.remove('idle');
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (_) {}
    }
  }
}
// 全屏退出键 ✕ 双击切换：进入全屏默认隐藏，双击屏幕任意处切换显隐。比空闲淡出更可控——
// 滑动阅读时不再频繁闪现，需要时主动双击呼出 / 收起。
document.addEventListener('dblclick', (e) => {
  if (!document.body.classList.contains('fullscreen') || !btnExitFullscreen) return;
  e.preventDefault();   // 避免双击误选正文文字
  btnExitFullscreen.classList.toggle('idle');
  if (btnTocFs) btnTocFs.classList.toggle('idle');   // 目录按钮随 ✕ 一起显隐（双击统一控制全屏浮层控件）
});
if (btnFullscreen) btnFullscreen.addEventListener('click', () => setFullscreen(true));
if (btnExitFullscreen) btnExitFullscreen.addEventListener('click', () => setFullscreen(false));
if (btnTocFs) btnTocFs.addEventListener('click', () => setTocOpen(!tocOpen));   // 全屏浮动目录按钮 → 开/关右侧大纲抽屉
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('fullscreen')) {
    setFullscreen(false);   // 原生全屏被 Esc 退出时同步（含 hidden / 内联样式复位）
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.body.classList.contains('fullscreen')) return;
  if (tocOpen) setTocOpen(false);   // 全屏下目录开着 → Esc 先关目录，而非退出全屏
  else setFullscreen(false);
});

// === SECTION: 同步滚动（编辑 ↔ 预览，仅双栏） ===
let isSyncing = false;
function syncScroll(src, dst) {
  if (isSyncing || viewMode !== 'split') return;
  if (Date.now() < anchorNavLock) return;   // 锚点跳转期间暂停比例同步，避免互相拉扯
  const sMax = src.scrollHeight - src.clientHeight;
  const dMax = dst.scrollHeight - dst.clientHeight;
  if (dMax <= 0) return;
  const ratio = sMax > 0 ? src.scrollTop / sMax : 0;
  isSyncing = true;
  dst.scrollTop = ratio * dMax;
  requestAnimationFrame(() => { isSyncing = false; });
}
editor.addEventListener('scroll', () => {
  gutter.scrollTop = editor.scrollTop;
  syncHighlightScroll();
  syncScroll(editor, previewPane);
});
previewPane.addEventListener('scroll', () => syncScroll(previewPane, editor));
// 目录 scroll-spy：rAF 节流，仅目录打开时计算当前章节
previewPane.addEventListener('scroll', () => {
  if (!tocOpen) return;
  if (Date.now() < anchorNavLock) return;   // 跳转期间暂停：updateTocActive 读 getBoundingClientRect 会强制 reflow，取消进行中的 smooth 滚动，导致跳转停在半路
  cancelAnimationFrame(tocSpyRaf);
  tocSpyRaf = requestAnimationFrame(updateTocActive);
});
preview.addEventListener('click', onPreviewAnchorClick);   // 预览内点击 #锚点 → 同步滚动编辑器到对应行
// 外部文档的远程图片：点一下才真去下载（不点就永远不发出请求）
preview.addEventListener('click', (e) => {
  const img = e.target && e.target.closest ? e.target.closest('img.remote-img') : null;
  if (!img || !img.getAttribute('data-remote-src')) return;
  img.setAttribute('src', img.getAttribute('data-remote-src'));
  img.removeAttribute('data-remote-src');
  img.classList.remove('remote-img');
});

// === SECTION: 阅读进度 ===
// 文库文档的阅读位置记忆 + 顶部细线进度条

function readingScrollRatio() {
  const el = (viewMode === 'preview') ? previewPane : editor;
  const sMax = el.scrollHeight - el.clientHeight;
  return sMax > 0 ? Math.min(1, el.scrollTop / sMax) : 0;
}

let _progressRaf = 0;
function updateReadingProgress() {
  if (!readingProgress || _progressRaf) return;   // 每帧最多写一次，避免滚动时反复触发样式重算
  _progressRaf = requestAnimationFrame(() => {
    _progressRaf = 0;
    readingProgress.style.width = currentLibId ? (readingScrollRatio() * 100) + '%' : '0';
  });
}

// 保存阅读进度到文库文档（2s 去抖，远低于同滚频率，未打开文库文档时即跳过）
// 阅读位置独立成小记录（约几十字节）。旧实现为了存一个浮点数，
// 每滚停一次就把整篇正文 + 20 条历史快照读出来再写回去。
const saveReadingProgress = debounce(() => {
  if (!currentLibId || !libDb) return;
  idbPutPosition({ id: currentLibId, scrollRatio: readingScrollRatio(), lastReadAt: Date.now() }).catch(() => {});
}, 2000);

// 恢复到上次阅读位置（延迟双 rAF，等预览渲染完成、scrollHeight 稳定）
function restoreReadingProgress() {
  if (!currentLibId) return;
  const docId = currentLibId;
  idbGetPosition(docId).then(async (pos) => {
    let ratio = pos ? pos.scrollRatio : null;
    if (ratio == null) {                       // 兼容旧数据：位置曾随文档一起存
      const doc = await idbGet(docId).catch(() => null);
      ratio = doc && doc.scrollRatio != null ? doc.scrollRatio : null;
    }
    if (ratio == null) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = (viewMode === 'preview') ? previewPane : editor;
        const sMax = el.scrollHeight - el.clientHeight;
        if (sMax > 0) el.scrollTop = ratio * sMax;
        updateReadingProgress();
      });
    });
  }).catch(() => {});
}

editor.addEventListener('scroll', updateReadingProgress);
previewPane.addEventListener('scroll', updateReadingProgress);
editor.addEventListener('scroll', saveReadingProgress);
previewPane.addEventListener('scroll', saveReadingProgress);

// === SECTION: 草稿自动保存（去抖 + 静默 + 容错） ===
let curSaveClass = '';
let curSaveText = '就绪';
function setSaveState(cls, text) {
  curSaveClass = cls || '';
  curSaveText = text;
  const el = $('#saveState');
  if (!el) return;
  el.className = curSaveClass;
  el.textContent = text;
}
/* 草稿写入策略（旧实现的三个问题）：
 *   1. 文库文档的正文已经由 writebackLib 落进 IndexedDB，再整篇塞一份到 localStorage 纯属重复占配额；
 *   2. 每次都是同步全量写，4MB 文档每 800ms 卡一次主线程；
 *   3. 超过 4MB 干脆不存（用户以为存了）。
 * 现在：文库文档跳过；≤1MB 仍写 localStorage（首屏可同步秒开）；更大则落 IDB drafts 表。
 */
const DRAFT_LS_MAX = 1024 * 1024;      // localStorage 侧的镜像上限（1MB）
const DRAFT_IDB_MAX = 32 * 1024 * 1024; // IDB 侧上限（再大就提示用户用文库/导出）
let hadBigDraft = false;                // 是否曾写过大文档草稿（避免小文档时反复写空记录）

function writeDraftNow() {
  // 外部只读文档：绝不写草稿。否则刷新后 loadDraft() 会把它当成「你的未完成稿」自动恢复，
  // 未审核的内容就长期驻留在可信上下文里；而且会把真正在写的草稿覆盖掉。
  if (remoteOrigin) { setSaveState('saved', '🌐 外部只读'); return; }
  if (currentLibId) {                  // 文库文档：正文由 writebackLib 负责，不再重复写一份草稿
    setSaveState('saved', '✓ 已保存 · 文库');
    return;
  }
  const content = editor.value;
  const at = Date.now();

  if (content.length > DRAFT_LS_MAX) {
    // 大文档：清掉可能残留的旧 localStorage 草稿，改走 IndexedDB
    try { localStorage.removeItem('md-draft'); } catch (_) {}
    try { localStorage.setItem('md-name', currentName); } catch (_) {}
    if (content.length > DRAFT_IDB_MAX) {
      setSaveState('warn', '⚠ 文档过大，草稿未自动保存（请用导出 / 文库）');
      return;
    }
    openLibDb()
      .then(() => idbPutDraft({ id: 'current', content, name: currentName, at }))
      .then(() => { hadBigDraft = true; setSaveState('saved', '✓ 已保存 · 大文档'); })
      .catch(() => setSaveState('warn', '⚠ 草稿保存失败'));
    return;
  }

  try {
    localStorage.setItem('md-draft', content);
    localStorage.setItem('md-name', currentName);
    localStorage.setItem('md-draft-ts', String(at));
    setSaveState('saved', '✓ 已保存');
    // 从「大文档」缩回小文档时，清一次 IDB 里的旧草稿，避免下次启动被旧内容覆盖
    if (hadBigDraft && libDb) {
      hadBigDraft = false;
      idbPutDraft({ id: 'current', content: '', name: currentName, at: 0 }).catch(() => {});
    }
  } catch (e) {
    // localStorage 满：退化为 IDB 存储，不再静默丢草稿
    openLibDb()
      .then(() => idbPutDraft({ id: 'current', content, name: currentName, at }))
      .then(() => setSaveState('saved', '✓ 已保存 · 本地库'))
      .catch(() => setSaveState('warn', '⚠ 存储空间不足，草稿未保存'));
  }
}

const saveDraft = debounce(() => {
  setSaveState('saving', '保存中…');
  writeDraftNow();
}, 800);

// 兜底保存：页面隐藏/卸载前立即写草稿 + 文库正文 + 阅读位置，
// 补上防抖窗口内最后 <800ms 的输入（浏览器会等待未完成的 IndexedDB 事务）
function flushSave() {
  if (remoteOrigin) return;      // 外部只读：无草稿可写，也不该写
  writeDraftNow();
  if (!currentLibId || !libDb) return;
  const ratio = readingScrollRatio();
  idbPut({                                  // 只写正文与元信息：history 已独立成仓库，不再随文档全量重写
    id: currentLibId, name: currentName, content: editor.value, updatedAt: Date.now(),
    autoName: currentNameIsAuto,
  }).catch(() => {});
  idbPutPosition({ id: currentLibId, scrollRatio: ratio, lastReadAt: Date.now() }).catch(() => {});
}
// 仅注册 pagehide：移动端/桌面端覆盖更全，且避免与 beforeunload 重复执行同一保存
window.addEventListener('pagehide', flushSave);

let flashTimer = null;
function flash(msg) {
  const el = $('#saveState');
  if (!el) return;
  el.className = 'flash';
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = curSaveClass; el.textContent = curSaveText; }, 1600);
}

// 浮动 toast：比底部状态条更醒目，适合上传/下载等关键结果反馈
let toastTimer = null;
function toast(msg, type, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.textContent = msg;
  el.hidden = false;
  // 强制重排以触发过渡动画
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 240);
  }, ms || 3200);
}

// === SECTION: 文件名 / 草稿载入 / 内容变更统一刷新 ===
function updateFileName() {
  const el = $('#fileName');
  if (!el) return;
  el.textContent = currentName;
  el.title = currentName;
}
function loadDraft() {
  // 第一优先：localStorage（同步、秒开，适合 ≤1MB 的常规文档）
  const draft = localStorage.getItem('md-draft');
  if (draft !== null) editor.value = draft;
  const name = localStorage.getItem('md-name');
  if (name) { currentName = name; currentNameIsAuto = false; }
  resetUndo();
  updateFileName();
  syncPodcastOnLoad();
  restoreIdbDraft();      // 第二优先：IDB 大文档草稿（>1MB 时不进 localStorage，避免 5MB 配额与同步写卡顿）
}

// 大文档草稿：正文超过 localStorage 安全阈值后改存 IndexedDB（drafts 表）
async function restoreIdbDraft() {
  try {
    await openLibDb();
    if (!libDb) return;
    const rec = await idbGetDraft('current');
    if (!rec || !rec.content) return;
    const lsTs = Number(localStorage.getItem('md-draft-ts') || 0);
    if (rec.content === editor.value) return;
    if (rec.at <= lsTs) return;                       // localStorage 里的更新，保持现状
    editor.value = rec.content;
    if (rec.name) { currentName = rec.name; currentNameIsAuto = false; updateFileName(); }
    resetUndo();
    afterChange({ skipWriteback: true });
    toast('已恢复大文档草稿（' + humanBytes(rec.content.length) + '）', 'info', 4000);
  } catch (_) { /* 草稿恢复失败不影响正常使用 */ }
}
// 高亮去抖：input 每键都触发，合并到下一帧只跑一次，避免 hljs 全量重绘造成的逐键回流卡顿
let _hlRaf = 0;
function scheduleHighlight() {
  if (_hlRaf) return;
  _hlRaf = requestAnimationFrame(() => { _hlRaf = 0; renderEditorHighlight(); });
}
function afterChange(opts) {
  currentSearchHit = null;       // 内容变化后旧的查找高亮位置失效
  scheduleRender();
  scheduleHighlight();
  scheduleStats();
  saveDraft();
  if (!(opts && opts.skipWriteback)) writebackLibDebounced();   // 文库文档：编辑后去抖自动回写（打开/恢复时跳过，避免刷新时间戳）
}
editor.addEventListener('input', afterChange);
['keyup', 'click', 'select'].forEach((ev) => editor.addEventListener(ev, scheduleStats));

// === SECTION: 打开文件 ===
$('#btnOpen').addEventListener('click', openFile);
async function openFile() {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }],
      });
      currentFileHandle = handle;
      const file = await handle.getFile();
      currentName = file.name;
      currentNameIsAuto = false;
      currentLibId = null;                       // 打开本地文件 → 脱离文库上下文
      localStorage.removeItem('md-lib-current');
      editor.value = await file.text();
      resetUndo();                               // 换文档 → 旧的撤销快照不再合法
      updateFileName();
      afterChange();
      syncPodcastOnLoad();
      flash('已打开 ' + currentName);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;   // 用户取消
    }
  }
  fileInput.click();   // 回退：传统 <input type=file>
}
fileInput.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    editor.value = reader.result;
    currentName = f.name;
    currentNameIsAuto = false;
    currentLibId = null;                       // 导入本地文件 → 脱离文库上下文
    localStorage.removeItem('md-lib-current');
    updateFileName();
    afterChange();
    syncPodcastOnLoad();
    flash('已打开 ' + currentName);
  };
  reader.readAsText(f);
  fileInput.value = '';
});

// === SECTION: 保存 ===
$('#btnSave').addEventListener('click', saveFile);
async function saveFile() {
  // 外部只读文档不能「保存」（它没有归属、也不该被自动写回任何地方），
  // Ctrl+S 就地转成「另存为副本」：用户的意图（想留住它）被满足了，但没有隐式副作用。
  if (remoteOrigin) {
    toast('🌐 外部只读：Ctrl+S 已转为「另存为副本」', 'info', 3600);
    exportMarkdown();
    return;
  }
  ensureNameFromContent();          // 未命名文档：保存时按首行自动命名
  const content = editor.value;
  // 文库文档：内容已自动回写，Ctrl+S 仅作确认提示（仍可用「…」菜单导出 HTML/PDF）
  if (currentLibId) {
    writebackLib();
    flash('已存至文库 ' + currentName);
    return;
  }
  // 1) 原地保存（File System Access API）
  if (currentFileHandle && currentFileHandle.createWritable) {
    try {
      const w = await currentFileHandle.createWritable();
      await w.write(content);
      await w.close();
      flash('已保存 ' + currentName);
      return;
    } catch (e) { /* 落到另存为 */ }
  }
  // 2) 另存为（若支持）
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: currentName,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      currentFileHandle = handle;
      const w = await handle.createWritable();
      await w.write(content);
      await w.close();
      currentName = handle.name;
      currentNameIsAuto = false;
      updateFileName();
      flash('已保存 ' + currentName);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  // 3) 回退：下载
  download(currentName, content, 'text/markdown;charset=utf-8');
  flash('已下载 ' + currentName);
}

// === SECTION: 未命名文档：保存时从首行自动派生标题 ===
/* 从正文首个非空行派生标题：
   - 去除行首 Markdown 标记（标题 / 引用 / 列表 / 警告块等）
   - 文件系统特殊字符与控制字符统一转为下划线；空白也转下划线（slug 化，便于下载与同步）
   - 截断到前 100 字，避免标题过长 */
function deriveTitleFromContent() {
  const text = (editor.value || '').replace(/\r\n?/g, '\n');
  let first = '';
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (t) { first = t; break; }
  }
  if (!first) return '';
  first = first
    .replace(/^#{1,6}\s+/, '')           // # 标题
    .replace(/^>\s+/, '')                 // > 引用
    .replace(/^[-*+]\s+/, '')             // - 无序列表
    .replace(/^\d+[.)]\s+/, '')           // 1. 有序列表
    .replace(/^\[!?[A-Za-z]+\]\s*/, '')   // [!NOTE] 警告块
    .trim();
  let name = first
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')  // 文件系统非法 / 控制字符 → 下划线
    .replace(/\s+/g, '_')                          // 空白 → 下划线（文件名友好）
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name.length > 100) name = name.slice(0, 100).replace(/_+$/g, '');
  return name;
}

/* 文库列表项标题同步（当前文库文档） */
function syncLibName() {
  if (!currentLibId || !libList) return;
  const nameEl = libList.querySelector('.lib-item.active .lib-item-name');
  if (nameEl) nameEl.textContent = currentName;
}
/* 标题命名：
   - 文档无名（未命名）：按首行派生，并标记为「自动派生」
   - 已命名且为自动派生：跟踪首行变化，首行改了则同步更新标题
   返回是否发生了改名 */
function ensureNameFromContent() {
  const isUnnamed = !currentName || currentName === '未命名.md' ||
                    /^未命名(\.\w+)?$/i.test(currentName);
  if (isUnnamed) {
    const derived = deriveTitleFromContent();
    if (!derived) return false;
    const ext = /\.\w+$/.test(currentName) ? currentName.slice(currentName.lastIndexOf('.')) : '.md';
    currentName = derived + ext;
    currentNameIsAuto = true;
    updateFileName();
    syncLibName();
    return true;
  }
  if (currentNameIsAuto) {                    // 已命名且为自动派生：跟踪首行
    const derived = deriveTitleFromContent();
    if (!derived) return false;
    const ext = /\.\w+$/.test(currentName) ? currentName.slice(currentName.lastIndexOf('.')) : '.md';
    const newName = derived + ext;
    if (newName !== currentName) {
      currentName = newName;
      updateFileName();
      syncLibName();
      return true;
    }
  }
  return false;
}

// === SECTION: 新建 / 重命名 ===
$('#btnNew').addEventListener('click', async () => {
  if (editor.value.trim() && !(await askConfirm('新建文档', '未保存的内容将丢失。'))) return;
  currentLibId = null;                       // 顶部「新建」为独立草稿，脱离文库上下文
  localStorage.removeItem('md-lib-current');
  resetUndo();
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      editor.value = text;
      flash('已从剪贴板创建');
    } else {
      editor.value = '';
      flash('已新建');
    }
  } catch {
    // 无剪贴板权限或剪贴板为空 → 新建空白文档
    editor.value = '';
    flash('已新建');
  }
  currentFileHandle = null;
  currentName = '未命名.md';
  currentNameIsAuto = false;
  updateFileName();
  afterChange();
});
async function renameFile() {
  const n = await askInput('文件名：', { def: currentName });
  if (n && n.trim()) {
    currentName = n.trim();
    currentNameIsAuto = false;
    updateFileName();
    saveDraft();
    if (currentLibId) writebackLib();   // 文库文档：同步新文件名
  }
}

// 将 Blob 图片（libimg://id）内联为 data URL，使 HTML 自包含、可独立打开/粘贴。
// 同时被「导出 HTML」与「复制 HTML」复用，避免把 blob: 临时链接泄漏到复制结果里。
async function inlineLibImages(html) {
  if (!libDb) return html;
  const ids = [...new Set([...html.matchAll(/libimg:\/\/([a-z0-9]+)/gi)].map((m) => m[1]))];
  for (const id of ids) {
    try {
      const rec = await idbGetImage(id);
      if (rec && rec.blob) {
        const dataUrl = await blobToDataURL(rec.blob);
        html = html.split('src="libimg://' + id + '"').join('src="' + dataUrl + '"');
      }
    } catch (_) {}
  }
  return html;
}

// === SECTION: 复制 HTML（复用预览结果） ===
async function copyHTML() {
  try {
    const html = await inlineLibImages(lastSanitizedHtml || preview.innerHTML);
    await navigator.clipboard.writeText(html);
    flash('已复制 HTML');
  } catch {
    flash('复制失败');
  }
}
/* 复制渲染后的纯文本：克隆到可见处取 innerText，保证纯编辑视图（预览隐藏）下也有正确换行 */
/* 取预览渲染后的纯文本（已去除 Markdown 标记符号），用于复制 / 导出 txt */
function previewPlainText() {
  const clone = preview.cloneNode(true);
  clone.style.cssText = 'position:absolute;left:-9999px;top:0';
  document.body.appendChild(clone);
  const txt = clone.innerText;
  clone.remove();
  return txt;
}
async function copyText() {
  try {
    await navigator.clipboard.writeText(previewPlainText());
    flash('已复制文本');
  } catch {
    flash('复制失败');
  }
}
/* 复制 Markdown 源码 */
async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(editor.value);
    flash('已复制 Markdown');
  } catch {
    flash('复制失败');
  }
}

// === SECTION: 导出 HTML / 打印 PDF ===
const EXPORT_CSS = [
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#fff;color:#1a2030;max-width:860px;margin:0 auto;padding:32px 24px;line-height:1.75}',
  '.markdown-body h1,.markdown-body h2,.markdown-body h3{line-height:1.3;margin:1.2em 0 .6em;font-weight:700}',
  '.markdown-body h1{font-size:1.9em;border-bottom:1px solid #e2e8f0;padding-bottom:.3em}',
  '.markdown-body h2{font-size:1.5em;border-bottom:1px solid #e2e8f0;padding-bottom:.25em}',
  '.markdown-body h3{font-size:1.25em}',
  '.markdown-body p{margin:.7em 0}',
  '.markdown-body a{color:#4f46e5}',
  '.markdown-body code{background:#f1f5f9;padding:.15em .4em;border-radius:5px;font-family:Consolas,monospace;font-size:.9em}',
  '.markdown-body pre{background:#f5f7fa;padding:14px 16px;border-radius:12px;overflow:auto;border:1px solid #e2e8f0}',
  '.markdown-body pre code{background:none;padding:0}',
  '.markdown-body blockquote{margin:.8em 0;padding:.4em 1em;border-left:4px solid #4f46e5;color:#64748b;background:#f8fafc}',
  '.markdown-body table{border-collapse:collapse;width:100%;margin:1em 0}',
  '.markdown-body th,.markdown-body td{border:1px solid #e2e8f0;padding:8px 12px}',
  '.markdown-body th{background:#f1f5f9}',
  '.markdown-body img{max-width:100%;border-radius:8px}',
  '.markdown-body hr{border:0;border-top:1px solid #e2e8f0;margin:1.4em 0}',
  '.markdown-body ul,.markdown-body ol{padding-left:1.6em}',
  '.hljs{color:#383a42}.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#6f42c1}.hljs-string,.hljs-addition{color:#0a7d34}.hljs-number{color:#b4570c}.hljs-title,.hljs-section{color:#0550ae}.hljs-type,.hljs-built_in{color:#953800}.hljs-attr{color:#0550ae}.hljs-tag,.hljs-meta{color:#57606a}',
].join('');

/**
 * 导出 HTML 用的 KaTeX 样式：把 katex.min.css 里 20 个 woff2 字体读成 data URI 内联进去。
 *
 * 为什么必须连字体一起内联：KaTeX 输出的不是图片，而是一堆靠 CSS 定位的 <span>——
 * 分数线的位置、根号的形状、数学斜体、大运算符，全靠 KaTeX_* 这几个字体 + 精确的
 * margin/height。只带 CSS 不带字体，导出的公式会退回系统字体、上下标错位、分数线跑偏，
 * 看起来比不渲染还糟。单个 woff2 共 ~296KB（base64 后约 400KB），所以只在文档真的有公式时才加。
 * 结果缓存：同一会话多次导出不重复读盘。
 */
let _katexExportCss = null;
async function katexCssForExport() {
  if (_katexExportCss) return _katexExportCss;
  try {
    let css = await (await fetch('./vendor/katex.min.css', { cache: 'no-cache' })).text();
    // 只留 woff2：现代浏览器都支持，另外两种格式（woff/ttf）会让体积翻三倍
    const names = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)].map((m) => m[1]))];
    const toDataUrl = async (name) => {
      try {
        const buf = await (await fetch('./vendor/fonts/' + name + '.woff2', { cache: 'no-cache' })).arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return 'data:font/woff2;base64,' + btoa(bin);
      } catch (_) { return null; }
    };
    for (const name of names) {
      const dataUrl = await toDataUrl(name);
      if (!dataUrl) continue;
      css = css.split('url(fonts/' + name + '.woff2)').join('url(' + dataUrl + ')');
    }
    // 剩下的 woff/ttf 引用直接删掉（src 里已有一份可用的 woff2）
    css = css.replace(/,\s*url\(fonts\/[\w-]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, '');
    _katexExportCss = '\n/* KaTeX（字体已内联，断网可显示） */\n' + css;
    return _katexExportCss;
  } catch (e) {
    console.warn('KaTeX 样式内联失败，导出的公式可能排版不完美：', e);
    return '';
  }
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function exportMarkdown() {
  // 导出原始 Markdown 源文件到本地（优先系统保存对话框，降级为浏览器下载）
  const name = currentName.replace(/\.(md|markdown|txt|html?|pdf)$/i, '') + '.md';
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
      const w = await handle.createWritable();
      await w.write(editor.value);
      await w.close();
      flash('已导出 Markdown');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消
    }
  }
  download(name, editor.value, 'text/markdown;charset=utf-8');
  flash('已导出 Markdown');
}
async function exportTxt() {
  // 导出纯文本（去掉 Markdown 标记，等同于预览的文字内容）为 .txt
  const name = currentName.replace(/\.(md|markdown|txt|html?|pdf)$/i, '') + '.txt';
  const text = previewPlainText();
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '纯文本', accept: { 'text/plain': ['.txt'] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      flash('已导出 txt');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消
    }
  }
  download(name, text, 'text/plain;charset=utf-8');
  flash('已导出 txt');
}
// 从当前已加载的样式表中抽取指定预览主题的颜色 CSS（含 .markdown-body 与 .hljs-*），
// 使导出的 HTML 与预览配色完全一致：深色主题导出处即为深色底，不再白底刺眼。
// 走 CSSOM 而非网络请求，file:// 也能用；跨域/不可读样式表自动跳过。
function getMdThemeCss(theme) {
  try {
    const out = [];
    const needle = 'data-md-theme=' + theme; // CSSOM 会去掉属性选择器的引号，故用无引号匹配
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (_) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.replace(/["']/g, '').indexOf(needle) !== -1) out.push(r.cssText);
      }
    }
    return out.join('\n');
  } catch (_) { return ''; }
}
// 预览主题中的深色配色（背景接近黑）；其余为浅色。仅用于导出时给页面外缘补深色底。
const MD_THEME_DARK = new Set(['onedark', 'nord', 'gruvbox', 'dracula', 'monokai']);

// 导出时沿用当前正文外观，使分享出去的 HTML 与预览一致
function exportTextStyleCss() {
  return 'font-size:' + readTextStyle().size + 'px;';
}

function exportTextColorCss() {
  const color = readTextStyle().color;
  if (!color) return '';
  return 'body.markdown-body p,body.markdown-body li,body.markdown-body td,body.markdown-body th,'
    + 'body.markdown-body dd,body.markdown-body dt{color:' + color + '}'
    + 'body.markdown-body blockquote p{color:inherit}';
}

async function exportHTML() {
  // mermaid 是异步渲染的：不等它画完就快照，导出里只会剩占位符。
  try { await mermaidRendering; } catch (_) {}
  // KaTeX 同理，而且更隐蔽：它产出的是 DOM 里的 <span class="katex">，
  // 不 await 就会把消毒后的原始 "$...$" 导出去（这就是"公式不保真"的根因）。
  try { await mathRendering; } catch (_) {}
  lastSanitizedHtml = snapshotPreviewHtml();   // 重新取快照（含刚画完的图表，且保留 libimg:// 供内联）
  // 将 Blob 图片（libimg://id）内联为 data URL，使导出的 HTML 自包含、可独立打开
  const html = await inlineLibImages(lastSanitizedHtml);
  const mdTheme = mdThemeMode || 'github';
  // 抽取当前预览主题的颜色块（如不可用则降级为默认亮色，行为与旧版一致）
  const themeCss = getMdThemeCss(mdTheme);
  // 深色主题：抽取真实背景色（优先 .preview-pane，其次 .markdown-body），
  // 并显式给 body 设深色底——因为深色主题的 .markdown-body 本身透明，靠 .preview-pane 提供底色；
  // 导出只含 .markdown-body，不设 body 底色会被 EXPORT_CSS 的白底覆盖，反而更刺眼。
  const dark = MD_THEME_DARK.has(mdTheme);
  let pageBg = dark ? '#0d1117' : '#ffffff';
  if (themeCss) {
    const m = themeCss.match(/\.(?:preview-pane|markdown-body)\s*\{[^}]*?background:\s*([^;!]+)/);
    if (m) pageBg = m[1].trim();
  }
  const darkBgRule = dark ? ('html{background:' + pageBg + '}body{background:' + pageBg + '}') : '';
  const doc = '<!DOCTYPE html><html lang="zh-CN" data-md-theme="' + mdTheme + '">'
    + '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
    + escapeHtml(currentName) + '</title><style>'
    + EXPORT_CSS
    + darkBgRule
    + (themeCss ? ('\n' + themeCss) : '')
    + exportTextColorCss()
    + (preview.querySelector('.katex') ? await katexCssForExport() : '')
    + '</style></head><body class="markdown-body" data-md-theme="' + mdTheme + '"'
    + ' style="' + exportTextStyleCss() + '">'
    + html + '</body></html>';
  download(currentName.replace(/\.(md|markdown|txt)$/i, '') + '.html', doc, 'text/html;charset=utf-8');
  flash('已导出 HTML' + (themeCss ? '（' + mdTheme + ' 主题）' : ''));
}
async function exportPDF() {
  const pdfName = currentName.replace(/\.(md|markdown|txt)$/i, '') + '.pdf';
  if (!window.html2pdf) {
    flash('正在加载 PDF 模块…');
    try { await loadScript('./vendor/html2pdf.bundle.min.js'); } catch (e) { console.warn(e); }
    if (!window.html2pdf) { window.print(); return; }   // 加载失败降级系统打印
  }
  flash('正在生成 PDF…');
  try { await mermaidRendering; } catch (_) {}   // 等图表画完再截图，避免 PDF 里出现空白占位
  // 克隆预览内容到 off-screen 容器，强制亮色主题，不受当前视图 / 暗色主题影响
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-theme', 'light');
  wrapper.style.cssText = 'position:absolute;left:-10000px;top:0;width:780px;background:#fff;padding:24px;';
  const inner = document.createElement('div');
  inner.className = 'markdown-body';
  inner.innerHTML = preview.innerHTML;   // 复用已渲染内容（含 hljs class，亮色配色随 data-theme 自动生效）
  wrapper.appendChild(inner);
  document.body.appendChild(wrapper);
  const opt = {
    margin: [10, 10, 12, 10],
    filename: pdfName,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
  };
  try {
    await html2pdf().set(opt).from(inner).save();
    flash('已导出 PDF');
  } catch (e) {
    console.error(e);
    flash('PDF 生成失败，改用系统打印');
    window.print();
  } finally {
    wrapper.remove();
  }
}

// === SECTION: 文本宏命令（Micro-Plugin / Text Pipeline） ===
// 每个宏命令都是一个纯函数：读 editor.value（当前文章纯文本），
// 做字符串变换后写回 editor.value，并调用 afterChange() 触发渲染/统计/草稿保存/文库回写。
/* === SECTION: 撤销栈（程序化改写后仍可 Ctrl+Z） ===
 * 背景：`editor.value = next` 会清空浏览器原生 undo 纪录，导致「全部替换 / AI 应用 /
 * 中英加空格」之后按 Ctrl+Z 完全无反应（旧代码只在 Vim 里用 execCommand('undo') 打了补丁）。
 * 做法：凡是「程序化改写」先压一份快照，撤回时整段还原；原生输入仍交给浏览器自己管。
 * 上限：60 步 / 8MB 总量，超出按最旧丢弃，避免 1MB 文档 × 50 步吃爆内存。
 */
const UNDO_MAX_STEPS = 60;
const UNDO_MAX_BYTES = 8 * 1024 * 1024;
let undoStack = [];        // [{ v, s, e, label }]
let redoStack = [];
let undoBytes = 0;

function resetUndo() { undoStack = []; redoStack = []; undoBytes = 0; }

function pushUndo(label) {
  const snap = { v: editor.value, s: editor.selectionStart, e: editor.selectionEnd, label: label || '编辑' };
  undoStack.push(snap);
  undoBytes += snap.v.length;
  while (undoStack.length > UNDO_MAX_STEPS || (undoBytes > UNDO_MAX_BYTES && undoStack.length > 1)) {
    const dropped = undoStack.shift();
    undoBytes -= dropped.v.length;
  }
  redoStack.length = 0;
}

// 应用一次「可撤销的程序化改写」
function applyProgrammatic(next, label, selStart, selEnd) {
  if (next === editor.value) { flash('文本无变化：' + label); return false; }
  pushUndo(label);
  editor.value = next;
  if (typeof selStart === 'number') {
    const s = Math.max(0, Math.min(selStart, next.length));
    const e = Math.max(s, Math.min(selEnd == null ? s : selEnd, next.length));
    editor.selectionStart = s; editor.selectionEnd = e;
  }
  afterChange();
  return true;
}

function undoStep() {
  if (!undoStack.length) return false;
  redoStack.push({ v: editor.value, s: editor.selectionStart, e: editor.selectionEnd });
  const snap = undoStack.pop();
  undoBytes -= snap.v.length;
  editor.value = snap.v;
  const s = Math.min(snap.s, snap.v.length), e = Math.min(snap.e, snap.v.length);
  editor.selectionStart = s; editor.selectionEnd = e;
  afterChange();
  flash('已撤销：' + snap.label);
  return true;
}

function redoStep() {
  if (!redoStack.length) return false;
  const snap = redoStack.pop();
  undoStack.push({ v: editor.value, s: editor.selectionStart, e: editor.selectionEnd, label: snap.label || '重做' });
  undoBytes += editor.value.length;
  editor.value = snap.v;
  const s = Math.min(snap.s, snap.v.length), e = Math.min(snap.e, snap.v.length);
  editor.selectionStart = s; editor.selectionEnd = e;
  afterChange();
  flash('已重做');
  return true;
}

function commitText(next, label) {
  if (applyProgrammatic(next, label)) flash('已应用：' + label);
}

const TEXT_ACTIONS = {
  // 1. 全局查找替换（应用内浮层，不再用 window.prompt/confirm 系统弹窗）
  searchReplace() {
    let panel = document.getElementById('findReplacePanel');
    if (panel) { const f = panel.querySelector('#frFind'); f.focus(); f.select(); return; }

    panel = document.createElement('div');
    panel.id = 'findReplacePanel';
    panel.className = 'find-replace';
    panel.innerHTML =
      '<div class="fr-row">' +
        '<input id="frFind" class="fr-input" type="text" placeholder="查找…" autocomplete="off" spellcheck="false">' +
        '<input id="frReplace" class="fr-input" type="text" placeholder="替换为（\\n 换行；留空=删除）" autocomplete="off" spellcheck="false">' +
        '<label class="fr-re"><input id="frRe" type="checkbox"> 正则</label>' +
      '</div>' +
      '<div class="fr-row fr-row2">' +
        '<span id="frCount" class="fr-count">输入查找内容</span>' +
        '<span class="fr-btns">' +
          '<button type="button" class="fr-btn" id="frNext">下一个</button>' +
          '<button type="button" class="fr-btn" id="frReplaceOne">替换</button>' +
          '<button type="button" class="fr-btn primary" id="frReplaceAll">全部替换</button>' +
          '<button type="button" class="fr-btn" id="frClose">关闭</button>' +
        '</span>' +
      '</div>';
    document.body.appendChild(panel);

    const $find = panel.querySelector('#frFind');
    const $replace = panel.querySelector('#frReplace');
    const $re = panel.querySelector('#frRe');
    const $count = panel.querySelector('#frCount');
    let cursor = (typeof editor.selectionStart === 'number') ? editor.selectionStart : 0;
    let total = 0;

    /* 构建查找参数。三种返回：
     *   null  → 查找框为空
     *   false → 已就地提示错误（正则非法 / 超长）
     *   { pattern, flags, isRegex }
     * 长度上限 MAX_PATTERN_LEN 来自 md-core：既防误粘贴一大段文本当正则，
     * 也降低构造出灾难性回溯表达式的概率。 */
    function buildPattern() {
      const f = $find.value;
      if (!f) return null;
      if ($re.checked) {
        const v = validatePattern(f);
        if (!v.ok) { $count.textContent = '查找内容过长（上限 ' + MAX_PATTERN_LEN + ' 字符）'; return false; }
        // 加 m（多行）标志：使 ^ $ 表示行首/行尾（而非整段首尾），符合「逐行查找」直觉
        try { new RegExp(f, 'gm'); } catch (e) { $count.textContent = '正则无效：' + e.message; return false; }
        return { pattern: f, flags: 'gm', isRegex: true };
      }
      const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { pattern: esc, flags: 'g', isRegex: false };
    }

    /* 统一执行入口：正则模式送进 Worker（超时即 terminate，页面不会被回溯卡死），
     * 普通文本模式直接同步跑（已被转义，无回溯风险）。 */
    async function execFindReplace(job) {
      const p = buildPattern();
      if (p === null) return { empty: true };
      if (p === false) return { invalid: true };
      const full = { src: editor.value, pattern: p.pattern, flags: p.flags, replacement: job.replacement, from: job.from, mode: job.mode };
      try {
        const out = p.isRegex ? await runRegex(full, 3000) : runRegexJob(full);
        return out || {};
      } catch (e) {
        $count.textContent = e.code === 'TIMEOUT'
          ? '⚠ 表达式过于复杂，已中断执行（页面未卡死）。请简化正则'
          : (e.message || '执行失败');
        return { error: true };
      }
    }
    // 替换串转义（\$ \n \t…）由 lib/md-core.js 的 processReplacement 提供，已有单测覆盖。
    // 单处替换的反向引用求值同样在 md-core 里（evaluateMatchReplacement），与 replaceAll 语义互补。
    let recountSeq = 0;
    async function recount() {
      const seq = ++recountSeq;                       // 输入很快时丢弃过期结果，避免文案倒退
      const r = await execFindReplace({ mode: 'count' });
      if (seq !== recountSeq) return;
      if (r.empty) { total = 0; $count.textContent = '输入查找内容'; currentSearchHit = null; return; }
      if (r.invalid || r.error) { total = 0; return; }
      total = r.count;
      $count.textContent = total
        ? ('找到 ' + total + ' 处' + (r.truncated ? '（已截断统计）' : ''))
        : '未找到匹配';
      if (!total) { currentSearchHit = null; renderEditorHighlight(); }
    }
    // 等宽字体单字符宽度（缓存，避免每次查找都建 DOM）
    let _charW = 0;
    function measureCharWidth(cs) {
      if (_charW) return _charW;
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
      span.style.fontFamily = cs.fontFamily;
      span.style.fontSize = cs.fontSize;
      span.style.fontWeight = cs.fontWeight;
      span.style.letterSpacing = cs.letterSpacing;
      span.textContent = '0'.repeat(80);
      document.body.appendChild(span);
      _charW = span.getBoundingClientRect().width / 80 || 9;
      span.remove();
      return _charW;
    }
    // 显式把匹配位置滚入可视区：setSelectionRange 在 wrap=off 长文档下纵向滚动不可靠，
    // 这里直接按「行/列」算 scrollTop/scrollLeft 兜底，保证关键词始终在屏幕内（覆盖层同步跟随）。
    function revealMatch(start) {
      const { line: ln, col } = posToLineCol(getLineOffsets(editor.value), start);
      const line = ln - 1;            // 转 0 基行号，下面按行高算 Y
      const colChars = col - 1;       // 转 0 基列号
      const cs = getComputedStyle(editor);
      const lh = parseFloat(cs.lineHeight) || 25;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const lineY = line * lh + padTop;                       // 该行顶部 Y（相对内容）
      const viewTop = editor.scrollTop;
      const viewBottom = viewTop + editor.clientHeight;
      const panel = document.getElementById('findReplacePanel');
      const panelHeight = panel ? panel.getBoundingClientRect().height : 0;
      if (lineY < viewTop || lineY + lh > viewBottom) {
        editor.scrollTop = Math.max(0, lineY - Math.max(panelHeight + lh, editor.clientHeight / 3));
      }
      if (!wrapMode) {                                        // 不换行：横向也可能超出，按列滚动
        const cw = measureCharWidth(cs);
        const charX = colChars * cw + padLeft;
        const viewLeft = editor.scrollLeft;
        const viewRight = viewLeft + editor.clientWidth;
        if (charX < viewLeft || charX + cw > viewRight) {
          editor.scrollLeft = Math.max(0, charX - editor.clientWidth / 3);
        }
      }
      syncHighlightScroll();
    }
    // 跳到下一处并选中（循环回绕），不修改内容
    async function findNext() {
      const r = await execFindReplace({ mode: 'find', from: cursor });
      if (r.empty) { $count.textContent = '请输入查找内容'; return; }
      if (r.invalid || r.error) return;
      if (r.index < 0) { $count.textContent = '未找到匹配'; return; }
      editor.focus();
      editor.setSelectionRange(r.index, r.index + r.length);
      currentSearchHit = { start: r.index, end: r.index + r.length };
      revealMatch(r.index);
      renderEditorHighlight();
      cursor = r.index + (r.length || 1);   // 零宽断言（^ $ \b）length=0，兜底 +1 防原地死循环
      $count.textContent = (r.wrapped ? '已到末尾，回到开头 · ' : '') + '找到 ' + total + ' 处';
    }
    // 替换下一处（保留 $1 等反向引用语义）
    async function replaceNext() {
      const r = await execFindReplace({ mode: 'find', from: cursor });
      if (r.empty) { $count.textContent = '请输入查找内容'; return; }
      if (r.invalid || r.error || r.index < 0) { if (!r.error && !r.invalid) $count.textContent = '没有可替换的匹配'; return; }
      const src = editor.value;
      const start = r.index, end = start + r.length;
      // 用自定义求值器解析 $1/$& 等反向引用（单处替换走字面拼接，原生 replace 会把 $1 当字面量）
      const repl = evaluateMatchReplacement(processReplacement($replace.value), r.groups && r.groups.length ? r.groups : [r.text || '']);
      const out = src.slice(0, start) + repl + src.slice(end);
      cursor = start + (repl.length || 1);   // 零宽匹配时 repl 可能为空，兜底 +1 防死循环
      commitText(out, '查找替换（1 处）');
      editor.focus();
      editor.setSelectionRange(cursor, cursor);
      currentSearchHit = { start: start, end: cursor };
      revealMatch(cursor);
      renderEditorHighlight();
      await recount();
      $count.textContent = '已替换 · 还剩 ' + total + ' 处';
    }
    async function replaceAll() {
      const r = await execFindReplace({ mode: 'replaceAll', replacement: processReplacement($replace.value) });
      if (r.empty) { $count.textContent = '请输入查找内容'; return; }
      if (r.invalid || r.error) return;
      if (r.truncated) { $count.textContent = '⚠ 匹配过多或表达式过重，已中止替换（未改动内容）'; return; }
      if (!r.count) { $count.textContent = '未找到匹配'; return; }
      commitText(r.text, `查找替换（${r.count} 处）`);
      $count.textContent = `已替换 ${r.count} 处`;
      closePanel();
    }
    function closePanel() {
      currentSearchHit = null;
      renderEditorHighlight();
      panel.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (document.activeElement === $replace) replaceNext();
        else findNext();
      }
    }

    $find.addEventListener('input', recount);
    $re.addEventListener('change', recount);
    panel.querySelector('#frNext').addEventListener('click', findNext);
    panel.querySelector('#frReplaceOne').addEventListener('click', replaceNext);
    panel.querySelector('#frReplaceAll').addEventListener('click', replaceAll);
    panel.querySelector('#frClose').addEventListener('click', closePanel);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { $find.focus(); }, 0);
  },

  // 2. 中英文之间自动加空格（Typographic 美化）
  formatSpacing() {
    // 用 \p{Script=Han} 覆盖 CJK 扩展区（旧实现只处理 \u4e00-\u9fa5 基本区）
    commitText(formatSpacingText(editor.value), '中英排版优化');
  },

  // 3. 清除所有空行
  removeEmptyLines() {
    commitText(editor.value.replace(/^\s*[\r\n]/gm, ''), '清除空行');
  },

  // 4. 去除每行首尾空白
  trimLines() {
    commitText(editor.value.replace(/^[ \t]+|[ \t]+$/gm, ''), '去除行首尾空白');
  },

  // 5. 按行排序（去重可选? 这里不去重，保留顺序稳定性由 sort 保证）
  sortLines() {
    const lines = editor.value.split(/\r?\n/);
    const before = lines.length;
    lines.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    commitText(lines.join('\n'), `按行排序（${before} 行）`);
  },

  // 6. 转大写
  toUpperCase() {
    commitText(editor.value.toUpperCase(), '转大写');
  },

  // 7. 转小写
  toLowerCase() {
    commitText(editor.value.toLowerCase(), '转小写');
  }
};

// === SECTION: 选区包裹 / 行前缀（格式化快捷键的底层原语） ===
// wrapSelection：用 before/after 包裹当前选区；无选区则插入占位文字并把光标落在内部。
// prefixLines：对选区所跨的整行逐行施加变换（引用 / 列表 / 标题用）。
function wrapSelection(before, after, placeholder) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.slice(s, e) || placeholder || '';
  const insert = before + sel + after;
  editor.value = editor.value.slice(0, s) + insert + editor.value.slice(e);
  const ns = s + before.length;
  editor.selectionStart = ns;
  editor.selectionEnd = ns + sel.length;
  editor.focus();
  editor.dispatchEvent(new Event('input'));
}
function prefixLines(fn) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const v = editor.value;
  let ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e); if (le === -1) le = v.length;
  const block = v.slice(ls, le);
  const out = block.split('\n').map((ln, i) => fn(ln, i)).join('\n');
  editor.value = v.slice(0, ls) + out + v.slice(le);
  editor.selectionStart = ls;
  editor.selectionEnd = ls + out.length;
  editor.focus();
  editor.dispatchEvent(new Event('input'));
}
function setHeading(level) {
  const hashes = '#'.repeat(level) + ' ';
  prefixLines((ln) => {
    const stripped = ln.replace(/^#{1,6}\s+/, '');
    return stripped ? hashes + stripped : '#'.repeat(level);
  });
}

/* 格式化动作：与 TEXT_ACTIONS / AI_ACTIONS 同级，供「格式」子菜单与快捷键共用 */
const FORMAT_ACTIONS = {
  fmtBold:   () => wrapSelection('**', '**', '粗体'),
  fmtItalic: () => wrapSelection('*', '*', '斜体'),
  fmtCode:   () => wrapSelection('`', '`', '代码'),
  fmtLink:   () => wrapSelection('[', '](https://)', '链接文字'),
  fmtImage:  async () => {
    const s = editor.selectionStart, e = editor.selectionEnd;
    const sel = editor.value.slice(s, e);
    const alt = sel || '图片描述';
    const url = await askInput('请输入图片链接（留空则选取本地图片文件）：', { allowEmpty: true });
    if (url === null) { editor.focus(); return; }
    const trimmed = url.trim();
    if (trimmed) {
      // 用户输入了 URL → 插入 Markdown 图片语法
      const insert = '![' + alt + '](' + trimmed + ')';
      editor.value = editor.value.slice(0, s) + insert + editor.value.slice(e);
      const pos = s + insert.length;
      editor.selectionStart = editor.selectionEnd = pos;
      editor.dispatchEvent(new Event('input'));
      editor.focus();
    } else {
      // 空 URL → 弹出文件选择器上传本地图片
      editor.focus();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (file) insertImage(file);
      };
      input.click();
    }
  },
  fmtQuote:  () => prefixLines((ln) => ln ? '> ' + ln : '>'),
  fmtUl:     () => prefixLines((ln) => ln ? '- ' + ln : '-'),
  fmtOl:     () => prefixLines((ln, i) => ln ? (i + 1) + '. ' + ln : '1. '),
  fmtH1: () => setHeading(1),
  fmtH2: () => setHeading(2),
  fmtH3: () => setHeading(3),
  fmtH4: () => setHeading(4),
  fmtH5: () => setHeading(5),
  fmtH6: () => setHeading(6),
};

// === SECTION: AI 智能助理（BYOK：自带 Key，纯前端直连，零后端） ===
// 设计：Key / endpoint / model 仅存本机 localStorage('md-ai-config')，绝不上传。
// 通过浏览器 fetch 直连兼容 OpenAI 格式的 /chat/completions 接口（OpenAI / DeepSeek / 中转 / 本地）。
const AI_CFG_KEY = 'md-ai-config';
function readAiConfig() {
  try { return JSON.parse(localStorage.getItem(AI_CFG_KEY) || '{}'); } catch (_) { return {}; }
}
// 使用过的模型历史：记录 { model, endpoint }（最近优先，最多 20 条），供设置弹窗点选
const AI_MODEL_HISTORY_KEY = 'md-ai-model-history';
const AI_MODEL_HISTORY_MAX = 20;
function readModelHistory() {
  try { const a = JSON.parse(localStorage.getItem(AI_MODEL_HISTORY_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function writeModelHistory(list) {
  try { localStorage.setItem(AI_MODEL_HISTORY_KEY, JSON.stringify(list.slice(0, AI_MODEL_HISTORY_MAX))); } catch (_) {}
}
// 保存/使用模型时记一条历史：按 model+endpoint 去重并提到最前
function recordModelUsage(model, endpoint) {
  if (!model) return;
  const key = model + '\u0000' + (endpoint || '');
  const list = readModelHistory().filter((h) => (h.model + '\u0000' + (h.endpoint || '')) !== key);
  list.unshift({ model, endpoint: endpoint || '' });
  writeModelHistory(list);
}
// 把历史渲染进设置弹窗的 datalist（option.label 显示对应 endpoint 供参考）
function renderModelHistory() {
  const dl = document.getElementById('aiModelHistory');
  if (!dl) return;
  dl.innerHTML = '';
  for (const h of readModelHistory()) {
    const opt = document.createElement('option');
    opt.value = h.model;
    if (h.endpoint) opt.label = h.endpoint;
    dl.appendChild(opt);
  }
}
// 把当前使用的 AI 模型名同步到两处 UI 徽标：
//  - 智能助理菜单项右侧（#aiMenuModel）
//  - AI 生成浮层标题旁（#aspModel）
// model 缺省回退 'free'（与 streamAiApi / openAiSettings 的默认保持一致）。
function updateAiModelBadge() {
  let model = 'free';
  try { model = (readAiConfig().model || 'free'); } catch (_) {}
  const menuEl = document.getElementById('aiMenuModel');
  if (menuEl) menuEl.textContent = model;
  const aspEl = document.getElementById('aspModel');
  if (aspEl) aspEl.textContent = model;
}
// 把 fetch 失败（CORS / 混合内容 / 网络）翻译成可操作的提示
function aiErrorHint(err, endpoint) {
  const m = (err && err.message) || String(err);
  if (m.includes('Failed to fetch') || m.includes('NetworkError') || m.includes('CORS')) {
    const tips = [];
    if (location.protocol === 'https:' && /^http:\/\//i.test(endpoint || '')) {
      tips.push('页面是 HTTPS，不能请求 HTTP 端点（混合内容被浏览器拦截），请改用 https://');
    }
    tips.push('端点未允许跨域（CORS）：需服务端只设置一次 Access-Control-Allow-Origin，并对 OPTIONS 预检返回相同 CORS 头');
    tips.push('若控制台提示 Access-Control-Allow-Origin 出现 "*, *" 多个值 —— 是代理层与应用层重复加了该头，去掉一层即可');
    return '网络或跨域被拦截。' + tips.join('；');
  }
  return m;
}
// 流式调用 AI：读取 ReadableStream 增量解析 SSE（data: 行抽 delta.content），
// 每收到一段回调 onToken(deltaText, fullText)；非流式 JSON 兜底；支持 AbortSignal 中途停止。
// opts: { signal, quiet } —— quiet=true 时不弹"正在思考" toast（由浮层展示进度）。
// 缺 Key 时打开应用内 AI 设置浮层让用户填写（复用 #aiSettingsModal，
// 替代 window.prompt/confirm 系统弹窗）。轮询等待浮层关闭：
// 用户点「保存」→ 全局 saveAiSettings 存配置并关闭 → 返回是否已配好 Key。
function askAiKeyViaModal() {
  return new Promise((resolve) => {
    const m = $('#aiSettingsModal');
    if (!m) return resolve(false);
    const cfg = readAiConfig();
    const ep = $('#aiEndpoint'), md = $('#aiModel'), key = $('#aiKey');
    if (ep) ep.value = cfg.endpoint || 'https://wx.want.biz/v1/chat/completions';
    if (md) md.value = cfg.model || 'free';
    if (key) key.value = '';   // 强制重新输入 Key（已有 Key 不会走到这里）
    renderModelHistory();
    m.hidden = false;
    if (key) key.focus();
    const timer = setInterval(() => {
      if (m.hidden) {
        clearInterval(timer);
        resolve(!!(readAiConfig().apiKey || '').trim());   // 保存了 Key 才算配好
      }
    }, 200);
  });
}
async function streamAiApi(promptText, systemPrompt, onToken, opts) {
  opts = opts || {};
  let cfg = readAiConfig();
  let apiKey = cfg.apiKey;
  if (!apiKey) {
    // 缺 Key：应用内浮层填写（替代 window.prompt/confirm 系统弹窗）
    await askAiKeyViaModal();
    cfg = readAiConfig();      // 用户可能在浮层里改了 endpoint/model/Key
    apiKey = cfg.apiKey;
    if (!apiKey) { toast('未配置 AI Key', 'err'); return null; }
  }
  const endpoint = cfg.endpoint || 'https://wx.want.biz/v1/chat/completions';
  const model = cfg.model || 'free';
  if (!opts.quiet) toast('AI 正在思考…', 'info', 60000);
  let full = '';
  /* 超时保护（旧实现完全没有）：
   *   - 空闲超时：60s 内一个 token 都没来 → 认为对端挂死，主动 abort
   *   - 总超时：5min 硬上限，避免「一直在吐字但永远不结束」
   *   - 用户手动停止（opts.signal）优先，且两者都保留已生成内容 */
  const IDLE_MS = opts.idleTimeout || 60000;
  const TOTAL_MS = opts.timeout || 300000;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  let timedOutMsg = '';
  let idleTimer = 0;
  const bumpIdle = () => {
    if (!ctrl) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOutMsg = 'AI 响应超时（' + Math.round(IDLE_MS / 1000) + 's 无新内容）'; try { ctrl.abort(); } catch (_) {} }, IDLE_MS);
  };
  const totalTimer = ctrl ? setTimeout(() => { timedOutMsg = 'AI 生成超时（已超过 ' + Math.round(TOTAL_MS / 60000) + ' 分钟）'; try { ctrl.abort(); } catch (_) {} }, TOTAL_MS) : 0;
  if (opts.signal && ctrl && opts.signal.addEventListener) {
    if (opts.signal.aborted) { try { ctrl.abort(); } catch (_) {} }
    else opts.signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} });
  }
  const cleanupTimers = () => { clearTimeout(idleTimer); clearTimeout(totalTimer); };
  bumpIdle();
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      signal: ctrl ? ctrl.signal : (opts.signal || undefined),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText }
        ],
        temperature: 0.7,
        stream: true
      })
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const t = await resp.text(); const j = JSON.parse(t); if (j && j.error) msg += '：' + (j.error.message || j.error); } catch (_) {}
      throw new Error(msg);
    }
    if (!resp.body || !resp.body.getReader) {          // 极少数环境下 body 为空：退化为整段读取
      const txt = await resp.text();
      cleanupTimers();
      const content = parseAiContent(txt);
      if (content && onToken) onToken(content, content);
      return content;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', sseMode = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();                                        // 有心跳就重置空闲计时
      buffer += decoder.decode(value, { stream: true });
      if (sseMode === null) {
        const head = buffer.trimStart();
        if (head.startsWith('data:')) sseMode = true;
        else if (head.startsWith('{')) sseMode = false;
      }
      if (sseMode === true) {
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const delta = parseSseLine(line);      // 与 md-core 单测同一份解析逻辑
          if (delta) { full += delta; if (onToken) onToken(delta, full); }
        }
      }
    }
    if (sseMode === false) {
      const data = JSON.parse(buffer.trim());
      full = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      if (onToken) onToken(full, full);
    }
    cleanupTimers();
    return full.trim();
  } catch (e) {
    cleanupTimers();
    if (e && e.name === 'AbortError') {
      // 主动停止 或 超时中断：都保留已生成内容，交给用户决定是否应用
      if (timedOutMsg) toast('⏱ ' + timedOutMsg + '，已保留已生成部分', 'warn', 6000);
      return full;
    }
    console.error(e);
    toast('AI 调用失败：' + aiErrorHint(e, endpoint), 'err', 6000);
    return null;
  }
}
// === SECTION: AI 流式打字机浮层 ===
let aiStreamAbort = null;   // 当前流式请求的 AbortController
let aiStreamApply = null;   // 完成后的"应用"回调
let aiStreamFull = '';      // 已生成全文
let aiAutoWrite = false;    // 「🔁 自动续写」开关：开启后每章应用即自动续写下一章，面板常显
let aiFullAuto = false;     // 「⏩ 全自动写作」开关：生成完成自动应用本章 + 暂停 N 秒 + 自动续写下一章
function setAutoWrite(on) { aiAutoWrite = !!on; const cb = document.getElementById('aspAuto'); if (cb) cb.checked = aiAutoWrite; }
function setFullAuto(on) { aiFullAuto = !!on; const cb = document.getElementById('aspFullAuto'); if (cb) cb.checked = aiFullAuto; }
// 是否处于自动续写（半自动或全自动）状态
function isAutoNow() {
  const a = document.getElementById('aspAuto'), f = document.getElementById('aspFullAuto');
  return !!(aiAutoWrite || aiFullAuto || (a && a.checked) || (f && f.checked));
}
// 全自动章节间隔（毫秒），可由测试覆盖 window.AI_FULLAUTO_PAUSE_MS 加速
const FULLAUTO_PAUSE = (window.AI_FULLAUTO_PAUSE_MS || 10000);
let aiFullAutoTimer = null; // { interval, timeout }

// 清除全自动倒计时（切换章节/停止/取消时调用），恢复标准浮层脚注
function clearFullAutoTimer() {
  if (aiFullAutoTimer) {
    try { clearTimeout(aiFullAutoTimer.timeout); clearInterval(aiFullAutoTimer.interval); } catch (_) {}
    aiFullAutoTimer = null;
  }
  const bar = document.getElementById('aspAutoBar');
  if (bar) bar.hidden = true;
  const foot = document.querySelector('#aiStreamPanel .asp-foot');
  if (foot) foot.hidden = false;
}
// 全自动：写完本章后暂停 FULLAUTO_PAUSE 毫秒，再自动续写下一章；暂停期间可「⏹ 停止」或「⏩ 立即继续」
function startFullAutoCountdown() {
  const bar = document.getElementById('aspAutoBar');
  const foot = document.querySelector('#aiStreamPanel .asp-foot');
  const cd = document.getElementById('aspCountdown');
  if (!bar) { if (aiFullAuto) AI_ACTIONS.aiWriteNextChapter(); return; } // 无 UI 兜底：直接续写
  if (foot) foot.hidden = true;
  bar.hidden = false;
  const endAt = Date.now() + FULLAUTO_PAUSE;
  const tick = () => {
    const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    if (cd) cd.textContent = '⏳ ' + left + ' 秒后继续下一章…（⏹ 停止 / ⏩ 立即继续）';
    if (left <= 0 && aiFullAutoTimer) { /* 由 timeout 统一触发，避免重复 */ }
  };
  tick();
  const interval = setInterval(tick, 250);
  const timeout = setTimeout(() => {
    clearFullAutoTimer();
    if (aiFullAuto) AI_ACTIONS.aiWriteNextChapter(); // 全书写完时 aiWriteNextChapter 内部会自动停止
  }, FULLAUTO_PAUSE);
  aiFullAutoTimer = { interval, timeout };
}
// 应用插入（统一出口）：中止流 + 调用插入回调；返回是否成功插入
function doApplyInsert() {
  if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
  if (aiStreamApply) { const fn = aiStreamApply; aiStreamApply = null; fn(aiStreamFull); return true; }
  return false;
}
// 应用后的续写决策：全自动→倒计时；半自动→立即下一章；否则关闭面板
function afterApply() {
  if (aiFullAuto) startFullAutoCountdown();
  else if (aiAutoWrite) AI_ACTIONS.aiWriteNextChapter();
  else aiStreamPanelEl.hidden = true;
}

// 打开浮层并发起流式请求；文本实时追加到面板，点"应用"时调用 onApply(full)；生成成功完成时调用 onComplete()
function aiRunStream({ label, systemPrompt, promptText, onApply, onComplete }) {
  const panel = document.getElementById('aiStreamPanel');
  const body = document.getElementById('aspBody');
  const caret = document.getElementById('aspCaret');
  const title = document.getElementById('aspTitle');
  const applyBtn = document.getElementById('aspApply');
  if (!panel || !body || !caret) { // 无浮层兜底：直接非流式替换
    streamAiApi(promptText, systemPrompt, null).then((r) => { if (r && onApply) onApply(r); });
    return;
  }
  title.textContent = label;
  body.innerHTML = '';
  body.appendChild(caret);
  panel.hidden = false;
  updateAiModelBadge(); // 生成界面标题旁实时显示当前模型
  if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer(); // 进入新一章：恢复标准脚注、隐藏倒计时条
  applyBtn.disabled = false;
  aiStreamAbort = new AbortController();
  aiStreamFull = '';
  aiStreamApply = onApply;
  const ctrl = aiStreamAbort;
  streamAiApi(promptText, systemPrompt, (delta, acc) => {
    aiStreamFull = acc;
    body.insertBefore(document.createTextNode(delta), caret);
    body.scrollTop = body.scrollHeight;
  }, { signal: ctrl.signal, quiet: true }).then((r) => {
    if (r) {
      aiStreamFull = r;
      if (typeof onComplete === 'function') { try { onComplete(); } catch (_) {} }
    } else { panel.hidden = true; aiStreamApply = null; } // 出错
  });
}

// 对选中文本执行 AI 变换：流式打字机展示，结束后点"应用"替换选区
function aiProcessSelection(systemPrompt, label) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const selected = editor.value.slice(s, e);
  if (!selected) { toast('请先在编辑器中选中一段文本', 'err'); return; }
  aiRunStream({
    label: 'AI ' + label,
    systemPrompt, promptText: selected,
    onApply: (full) => {
      editor.value = editor.value.slice(0, s) + full + editor.value.slice(e);
      editor.selectionStart = s;
      editor.selectionEnd = s + full.length;
      afterChange();
      toast('已' + label + '选中文字', 'ok');
    }
  });
}
// AI 多平台爆款转写：将选中/输入的素材改写为指定平台风格的爆款文案，流式展示后一键插入。
// mode: 'zhihu' = 知乎体；'twitter' = Twitter Thread 风。
async function aiSocialRewrite(mode) {
  const isZhihu = mode === 'zhihu';
  const label = isZhihu ? '知乎体' : 'Twitter Thread';
  const s = editor.selectionStart, e = editor.selectionEnd;
  let selected = editor.value.slice(s, e).trim();

  // 未选中文字时，提示输入素材（与 aiGenerate / aiMindmap / aiBookOutline 同风格）
  if (!selected) {
    selected = await askAiPrompt(`请输入要转写为${label}的素材或原文：`);
    if (!selected) { toast('已取消', 'info'); return; }
  }

  const systemPrompt = isZhihu
    ? '你是一名在知乎深耕多年的高赞答主。请将用户提供的素材/草稿，改写为一篇符合知乎风格的深度回答：开头直接亮明核心观点（可用「先说结论：」或「谢邀，利益相关：」等知乎经典开场）；正文逻辑清晰、分点论述（用一、二、三或 1. 2. 3. 分层），善用数据、案例与因果推导支撑论点；语言克制理性、不浮夸，重论证而非情绪；结尾可升华主题或给出可落地的建议，并适度抛出开放性问题引导讨论。保持用户原意，使用 Markdown 格式，只输出回答正文：'
    : '你是一名擅长病毒式传播的 Twitter/X 内容策略专家。请将用户提供的素材/草稿，改写为一篇 Twitter Thread：用一条强钩子开场推文；后续每条推文聚焦一个观点、控制在 280 字以内、用数字标号（1/ 2/ 3/ …）分段；语言简洁有力、带观点与数据；结尾加一句总结或行动号召。保持用户原意，使用 Markdown 格式，只输出 Thread 正文：';

  aiRunStream({
    label: 'AI ' + label,
    systemPrompt,
    promptText: selected,
    onApply: (full) => {
      // 保留用户原稿：有选区时把爆款文案追加其后，无选区则插入光标处（绝不在回调内二次读 editor.selection*）
      const insertText = '\n\n' + full.trim() + '\n\n';
      if (e > s) {
        editor.value = editor.value.slice(0, e) + insertText + editor.value.slice(e);
        editor.selectionStart = editor.selectionEnd = e + insertText.length;
      } else {
        insertAtCursor(insertText);
      }
      afterChange();
      toast(isZhihu ? '📘 知乎体已生成，已插入' : '🐦 Twitter Thread 已生成，已插入', 'ok');
    }
  });
}

// 应用内「输入提示词」容器（modal）：无选中/剪贴板内容时询问用户。
// 返回 Promise<string|null>：确认=输入内容（trim 后为空视为取消），取消/遮罩/Esc=null。
function askAiPrompt(desc) {
  const modal = document.getElementById('aiPromptModal');
  const input = document.getElementById('aiPromptInput');
  // 无容器兜底（防静态 HTML 缺失）：退回系统 prompt
  if (!modal || !input) return Promise.resolve(window.prompt('请输入主题或提示词：', '') || null);
  return new Promise((resolve) => {
    const descEl = document.getElementById('aiPromptDesc');
    if (descEl) descEl.textContent = desc || '未检测到选中文字或剪贴板内容，请直接输入。';
    input.value = '';
    modal.hidden = false;
    input.focus();
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; modal.hidden = true; resolve(val); };
    document.getElementById('aiPromptOk').onclick = () => finish(input.value.trim() || null);
    document.getElementById('aiPromptCancel').onclick = () => finish(null);
    modal.onclick = (e) => { if (e.target === modal) finish(null); };          // 点遮罩关闭
    input.onkeydown = (e) => {                                                  // Enter 提交；Shift+Enter 换行；Esc 关闭
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); finish(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    };
  });
}

// 通用输入浮层：替代 window.prompt。返回 Promise<string|null>（取消/遮罩/Esc = null）。
// opts: { desc, def, password, multiline }
function askInput(title, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const m = document.getElementById('promptModal');
    const input = document.getElementById('promptModalInput');
    if (!m || !input) return resolve(window.prompt(opts.def !== undefined ? title + '\n（默认：' + opts.def + '）' : title, opts.def || '') || null);   // 无容器兜底
    const titleEl = document.getElementById('promptModalTitle');
    const descEl = document.getElementById('promptModalDesc');
    if (titleEl) titleEl.textContent = title;
    if (descEl) { if (opts.desc) { descEl.textContent = opts.desc; descEl.hidden = false; } else descEl.hidden = true; }
    input.type = opts.password ? 'password' : 'text';
    input.value = opts.def || '';
    m.hidden = false;
    input.focus();
    input.select();
    let settled = false;
    const norm = () => {
      const raw = input.value;
      if (input.type === 'password') return raw || null;   // 密码输入保留首尾空格（NAS 凭据可能含空格）
      const t = raw.trim();
      return opts.allowEmpty ? t : (t || null);
    };
    const finish = (val) => { if (settled) return; settled = true; m.hidden = true; resolve(val); };
    document.getElementById('promptModalOk').onclick = () => finish(norm());
    document.getElementById('promptModalCancel').onclick = () => finish(null);
    m.onclick = (e) => { if (e.target === m) finish(null); };            // 点遮罩关闭
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(norm()); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    };
  });
}
// 通用确认浮层：替代 window.confirm。返回 Promise<boolean>
function askConfirm(title, msg) {
  return new Promise((resolve) => {
    const m = document.getElementById('confirmModal');
    if (!m) return resolve(true);                                        // 无容器兜底：默认继续
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMsg');
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg || '';
    m.hidden = false;
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; m.hidden = true; resolve(ok); };
    document.getElementById('confirmModalOk').onclick = () => finish(true);
    document.getElementById('confirmModalCancel').onclick = () => finish(false);
    m.onclick = (e) => { if (e.target === m) finish(false); };           // 点遮罩=取消
    m.onkeydown = (e) => {   // 覆盖赋值而非 addEventListener,避免多次调用堆积监听
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
  });
}

// ===== AI 逐章写作：参照文档中的书籍大纲，一章一章自动续写 =====
// 章节解析 / 字数目标解析（cnChapterNum / parseChapterList / writtenChapterNums /
// cnSmall / parseCountValue / parseWordCount）已下沉到 lib/md-core.js，顶部统一解构引用。

const AI_ACTIONS = {
  // 全文总结：流式打字机展示，结束后插入文首
  aiSummary() {
    const content = editor.value;
    if (!content.trim()) { toast('文章为空', 'err'); return; }
    aiRunStream({
      label: 'AI 摘要',
      systemPrompt: '你是一名专业的写作助手。请为以下 Markdown 文章写一段精炼的中文摘要（300 字以内），只输出摘要正文，不要标题、序号或前缀：',
      promptText: content,
      onApply: (full) => {
        const block = '> **💡 AI 摘要**\n> ' + full.replace(/\n+/g, '\n> ') + '\n\n---\n\n';
        editor.value = block + editor.value;
        editor.selectionStart = editor.selectionEnd = 0;
        afterChange();
        toast('AI 摘要已插入文首', 'ok');
      }
    });
  },
  // 润色选中文字
  aiPolish() {
    aiProcessSelection('请润色以下文本，使其更加流畅、专业、自然，保留原意与 Markdown 格式，只输出改写后的文本：', '润色');
  },
  // 扩写选中文字
  aiExpand() {
    aiProcessSelection('请基于以下要点/片段进行合理扩写，丰富细节与论证，保留 Markdown 格式，只输出扩写后的文本：', '扩写');
  },
  // 翻译为英文
  aiTranslate() {
    aiProcessSelection('将以下文本准确翻译为地道英文，保留 Markdown 格式，只输出译文：', '翻译');
  },
  // 按提示词生成文章，流式打字机展示，结束后插入光标处
  // 提示词来源三级取用：① 选中文字（直接发送，不弹窗）→ ② 剪贴板内容 → ③ 应用内容器询问
  async aiGenerate() {
    // 必须在最开头捕获选区（浮层/应用按钮会夺走焦点），且不可在 onApply 里二次读取
    const s = editor.selectionStart, e = editor.selectionEnd;
    let topic = editor.value.slice(s, e).trim();      // ① 优先：选区即提示词
    if (!topic && navigator.clipboard && navigator.clipboard.readText) {
      try {
        const clip = (await navigator.clipboard.readText() || '').trim();
        if (clip) { topic = clip; toast('已使用剪贴板内容作为提示词', 'info'); }
      } catch (_) { /* 无剪贴板权限/非安全上下文：继续走容器询问 */ }
    }
    if (!topic) {                                     // ② 兜底：应用内容器询问
      topic = await askAiPrompt();
      if (!topic) { toast('已取消', 'info'); return; }
    }
    aiRunStream({
      label: 'AI 生成',
      systemPrompt: '你是一名专业的写作助手和 Markdown 排版专家。请根据用户给出的主题，撰写一篇结构清晰、Markdown 格式的中文文章（含标题、小节、要点），只输出正文：',
      promptText: topic,
      onApply: (full) => {
        const text = full + '\n\n';
        // 有选区：用生成结果替换选区（选区本身即提示词种子）；无选区：插入光标处
        if (e > s) {
          editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
          editor.selectionStart = editor.selectionEnd = s + text.length;
        } else {
          insertAtCursor(text);
        }
        afterChange();
        toast('AI 已生成并插入', 'ok');
      }
    });
  },
  // 策划书籍大纲：基于选中文字（主题/素材）生成结构化大纲，流式展示后一键插入
  async aiBookOutline() {
    const s = editor.selectionStart, e = editor.selectionEnd;
    let selected = editor.value.slice(s, e).trim();

    // 未选中文字时，提示输入主题（与 aiGenerate / aiMindmap 同风格，避免从更多菜单点按直接报错）
    if (!selected) {
      selected = await askAiPrompt('请输入要策划书籍大纲的主题或素材：');
      if (!selected) { toast('已取消', 'info'); return; }
    }

    aiRunStream({
      label: 'AI 书籍大纲',
      systemPrompt: '你是一名资深的图书策划与写作教练。请根据用户给出的主题或素材，策划一份结构清晰、层次分明的书籍大纲（含推荐书名、篇章结构、各章要点）。硬性格式要求：每一章的标题必须单独成行，且严格使用「## 第X章：章名」的格式（X 用一、二、三…中文小写数字，如「第一章」，切勿使用壹、贰、叁等大写数字写成「第壹章」——大写数字会导致后续 AI 续写无法识别该章），章内要点用列表；这是后续 AI 逐章续写功能解析章节的依据，不得使用其他章标题写法。使用 Markdown 格式，只输出大纲正文：',
      promptText: selected,
      onApply: (full) => {
        // 保留选中的主题/素材，把大纲追加在其后（而非覆盖选区）；无选区则插入光标处。
        // 注意：必须用本函数开头捕获的 s/e，不能在这里重新读 editor.selection*（流式浮层/应用按钮会夺走焦点，导致插入错位）。
        // 末尾追加 <!-- ai-chapter:0 --> 大纲结束锚点：显式划分“大纲区/正文区”，
        // 防止用户手写正文中出现的「第X章」被 aiWriteNextChapter 误当成大纲章节。
        const insertText = '\n\n' + full.trim() + '\n\n<!-- ai-chapter:0 -->\n\n';
        if (e > s) {
          editor.value = editor.value.slice(0, e) + insertText + editor.value.slice(e);
          editor.selectionStart = editor.selectionEnd = e + insertText.length;
        } else {
          insertAtCursor(insertText);
        }
        afterChange();
        toast('📖 书籍大纲已生成，已插入', 'ok');
      }
    });
  },
  // 逐章写作：自动检测「下一个未写的章」，参照大纲 + 上一章结尾续写，追加到文档末尾
  async aiWriteNextChapter() {
    const doc = editor.value;
    if (!doc.trim()) { toast('文档为空，请先用「📖 策划书籍大纲」生成大纲', 'err'); return; }

    // ① 大纲区 = 第一个章节标记之前的部分（尚未写正文时即全文）
    const firstMark = doc.search(/<!--\s*ai-chapter:\d+\s*-->/);
    const outlinePart = firstMark === -1 ? doc : doc.slice(0, firstMark);
    const chapters = parseChapterList(outlinePart);

    // ② 找下一个未写的章
    const done = writtenChapterNums(doc);
    let target = chapters.find((c) => !done.has(c.num));
    if (!target) {
      // 已无未写章节：自动模式且确为书稿（有大纲章或已写过正文）→ 自动补写「终章后记」一次；否则停止
      const isBook = chapters.length > 0 || /<!--\s*ai-chapter:[1-9]\d*\s*-->/.test(doc);
      if (isAutoNow() && isBook) {
        if (!/<!--\s*ai-epilogue\s*-->/.test(doc)) {
          // 全书正文章节已写完，且尚无后记 → 自动生成终章后记（只此一次），生成完即停止全自动
          AI_ACTIONS.aiWriteEpilogue(true);
          return;
        }
        // 正文章节 + 终章后记 均已生成 → 真正结束
        toast('🎉 全书及终章后记已完成，自动写作已停止', 'ok');
        setAutoWrite(false);
        setFullAuto(false);
        if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer();
        const p = document.getElementById('aiStreamPanel'); if (p) p.hidden = true;
        return;
      }
      // 手动模式（或非书稿）：弹窗手动指定重写/加写章节（与 aiGenerate 同风格）
      const hint = chapters.length
        ? '大纲中的章节均已写完。如需重写/加写，请输入章节（如：第4章 XXX）：'
        : '未能从文档中识别出「第X章」大纲。请输入要写的章节（如：第1章 XXX）：';
      const input = await askAiPrompt(hint);
      if (!input || !input.trim()) { toast('已取消', 'info'); return; }
      const parsed = parseChapterList(input.trim());
      // 兜底章号 = 已写最大章号 + 1（不能用 done.size：锚点 0 也在集合里，会数偏）
      target = parsed[0] || { num: Math.max(0, ...done) + 1, title: input.trim() };
    }

    // ③ 本章大纲要点 = 大纲中本章行到下一章行之间的内容
    let points = '';
    const idx = chapters.findIndex((c) => c.num === target.num);
    if (idx !== -1) {
      const from = chapters[idx].at;
      const to = idx + 1 < chapters.length ? chapters[idx + 1].at : outlinePart.length;
      points = outlinePart.slice(from, to).trim().slice(0, 1200);
    }

    // ③b 字数目标：尊重用户要求——优先取本章大纲里的「字数目标」，否则取全局首行的「每章不少于X字」；
    //     两者皆无才回退默认 2000-3000 字（避免硬编码覆盖用户显式要求，见 v2.3.21）。
    const headerText = outlinePart.split(/\n\s*##\s*第/)[0]; // 第一个「## 第X章」之前（含首行字数要求）
    const globalWc = parseWordCount(headerText);
    const chapterWc = points ? parseWordCount(points) : null;
    const wc = chapterWc || globalWc;
    const lenInst = wc
      ? '· 篇幅' + (wc.cmp === 'min' ? '不少于 ' : '约 ') + wc.count + ' 字（这是硬性要求，务必写足，不要过早收尾）。\n'
      : '· 篇幅约 2000-3000 字。\n';

    // ④ 上一章结尾 ~1500 字（保证衔接）；仅当已写过编号≥1的正文章节才带。
    // 不能用 firstMark !== -1 判断：大纲结束锚点 ai-chapter:0 也会命中 firstMark，
    // 若据此把文档尾部（= 大纲本身）当“上一章结尾”传给 AI，会污染首章上下文。
    let prevTail = '';
    if (/<!--\s*ai-chapter:[1-9]\d*\s*-->/.test(doc)) prevTail = doc.slice(-1500).trim();

    const chapLabel = '第' + target.num + '章' + (target.title ? ' ' + target.title : '');
    const promptText = '【全书大纲】\n' + outlinePart.trim().slice(0, 4000) +
      (prevTail ? '\n\n【上一章结尾（仅供衔接，不要复述）】\n' + prevTail : '') +
      (points ? '\n\n【本章大纲要点】\n' + points : '') +
      '\n\n【任务】请撰写：' + chapLabel;

    aiRunStream({
      label: 'AI 续写 ' + chapLabel,
      systemPrompt: '你是一名有个人风格、有血有肉的专业作家，正在按既定大纲撰写一本书。请只撰写用户指定的这一章正文：\n' +
        '· 以「## ' + chapLabel + '」这样的二级标题开头；内容充实、行文与上一章自然衔接。\n' +
        lenInst +
        '· 写完本章即停——不要写下一章、不要复述大纲、不要输出任何解释。\n' +
        '· 反共识：每章至少包含一处与主流认知相悖的「个人观察」，单独成段并以「> 💡 独思时刻：」开头。\n' +
        '   —— 该观察必须以第一人称「我」开头，源于你（作者角色）亲历或推演出的真实体悟，而非转述外部案例报道；\n' +
        '      严禁套用「202X年X月，某地某企业／工厂／CEO……」的万能故事模板——那只会让反共识沦为新的八股，读者一眼看穿。\n' +
        '· 去套话：严禁使用「降维打击」「赋能」「范式转移」「底层逻辑」「超级个体」「终极壁垒」「认知升维」等空洞词汇，改用具体、有画面感的表述。\n' +
        '· 具体化：每个抽象观点都必须配一个不超过 30 字、含具体时间/地点/人物或事件的微型故事，给读者真实的「肉身感」。\n' +
        '· 案例真实性：本章中若用到虚构或基于行业逻辑推演的场景案例，须明确标注其边界——\n' +
        '  可在案例前加「假设你是……」引导，或在段尾加方括号注「注：本案例为行业逻辑推演，非真实事件」，切勿让读者误以为是确凿的新闻事实。\n' +
        '使用 Markdown 格式，只输出本章正文：',
      promptText,
      onApply: (full) => {
        // 隐形进度标记 + 章正文，统一追加到文档末尾（标记在预览中不可见）
        const insertText = '\n\n<!-- ai-chapter:' + target.num + ' -->\n\n' + full.trim() + '\n';
        editor.value = editor.value.replace(/\s*$/, '') + insertText;
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        afterChange();
        editor.scrollTop = editor.scrollHeight;
        toast('✍️ ' + chapLabel + ' 已写完并追加到文末', 'ok');
      },
      onComplete: () => {
        // 全自动模式：生成完成即自动应用本章（插入正文），并进入倒计时续写下一章
        if (aiFullAuto && aiStreamApply) {
          const fn = aiStreamApply; aiStreamApply = null; fn(aiStreamFull);
          afterApply();
        }
      }
    });
  },
  // 终章后记：全书正文章节写完后，以前书中设定的「作者」第一人称口吻，生成一篇约500字的终章后记
  // autoMode=true 时（全自动/半自动流程触发）：生成完成即自动应用并结束写作；false 时（手动按钮）由用户点「应用」插入
  aiWriteEpilogue(autoMode) {
    const doc = editor.value;
    if (!doc.trim()) { toast('文档为空', 'err'); return; }
    if (/<!--\s*ai-epilogue\s*-->/.test(doc)) { toast('终章后记已存在', 'info'); return; }
    const titleMatch = doc.match(/^#\s+(.+)$/m);
    const bookTitle = titleMatch ? titleMatch[1].trim() : '本书';

    // 【修复】喂给 AI「全书大纲」+「各章 💡 独思时刻摘录」作上下文。
    // 修复前只传了书名，AI 没看过正文/大纲，"最痛苦的决策""呼应独思时刻"等要求只能凭空幻觉，导致后记与正文毫无联系。
    const firstMark = doc.search(/<!--\s*ai-chapter:\d+\s*-->/);
    const outlineContext = (firstMark === -1 ? doc : doc.slice(0, firstMark)).trim().slice(0, 3000);
    // 抽取正文里各章的「💡 独思时刻」，供后记真实呼应（而非脑补）；每条取首行、限长，最多 12 条防 token 超限
    const moments = [];
    const mRe = /独思时刻[：:]\s*(.+)/g;
    let mm;
    while ((mm = mRe.exec(doc)) && moments.length < 12) {
      const t = mm[1].trim().slice(0, 120);
      if (t) moments.push('· ' + t);
    }
    const momentContext = moments.length
      ? '\n\n【书中「💡 独思时刻」摘录（可任选一个真实呼应，不要复述原文）】\n' + moments.join('\n')
      : '';

    const promptText = '这是一本名为《' + bookTitle + '》的商业书籍，所有正文章节已经写完。\n' +
      '【全书大纲参考】\n' + outlineContext + momentContext + '\n\n' +
      '请基于以上书籍核心内容，以前书中设定的「作者」第一人称口吻，写一篇约 500 字的「终章·后记」：\n' +
      '· 以作者个人口吻对读者掏心窝子地说一段话，不要用教科书或 AI 助手的口吻；\n' +
      '· 必须包含：基于本书核心主题在创作过程中最痛苦的一个决策、最意外的一个收获；\n' +
      '· 请真实地呼应大纲中的某个具体观点或上面某个「💡 独思时刻」，用作者自己的反思语气，而非重复正文；\n' +
      '· 允许留白、允许不确定、允许真实的人类情绪（犹豫、后悔、兴奋）；禁用空洞词（赋能、降维打击、范式转移、底层逻辑、超级个体、终极壁垒、认知升维）；\n' +
      '· 使用 Markdown，以二级标题「## 终章·后记」开头，只输出后记正文。';
    const systemPrompt = '你就是这本书的作者，一位有真实商业实战经验、有脾气、有偏见的从业者。现在彻底放下「AI 助手」的身份，用你本人的口吻写作。' +
      '语言要有体温、有具体细节、允许不完美与真实的人类情绪；严禁任何空洞词汇与工整的排比套话。只输出后记正文：';
    aiRunStream({
      label: '✍️ 终章后记',
      systemPrompt,
      promptText,
      onApply: (full) => {
        // 隐形标记 + 后记正文，统一追加到文档末尾（标记在预览中不可见）
        const insertText = '\n\n<!-- ai-epilogue -->\n\n' + full.trim() + '\n';
        editor.value = editor.value.replace(/\s*$/, '') + insertText;
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        afterChange();
        editor.scrollTop = editor.scrollHeight;
        toast('📝 终章后记已追加到文末', 'ok');
        // 自动流程触发：写完后记即结束写作（不再续章），复位开关并隐藏面板
        if (autoMode) {
          setAutoWrite(false);
          setFullAuto(false);
          if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer();
          const p = document.getElementById('aiStreamPanel'); if (p) p.hidden = true;
        }
      },
      onComplete: () => {
        // 全自动模式：生成完成即自动应用后记，并结束（不续写下一章）
        if (aiFullAuto && aiStreamApply) {
          const fn = aiStreamApply; aiStreamApply = null; fn(aiStreamFull);
          // 注意：不调用 afterApply（否则会启动倒计时续章）；onApply 内部已停止全自动并隐藏面板
        }
      }
    });
  },
  // 新增：AI 一键生成思维导图 (Mermaid)
  async aiMindmap() {
    const s = editor.selectionStart, e = editor.selectionEnd;
    let selected = editor.value.slice(s, e).trim();

    // 未选中文字时，提示输入主题（与 aiGenerate 同风格）
    if (!selected) {
      selected = await askAiPrompt('请输入要生成思维导图的主题或杂乱笔记：');
      if (!selected) { toast('已取消', 'info'); return; }
    }

    aiRunStream({
      label: 'AI 提炼思维导图',
      systemPrompt: '你是一个知识提炼与数据可视化专家。请提取用户输入内容的核心逻辑与层级关系，并将其转化为 Mermaid 语法的思维导图（mindmap）。\n要求如下：\n1. 提取出核心主题作为根节点，将相关概念归纳为 2-4 个层级的子节点。\n2. 节点文本必须极度精简（最好不超过 8 个字）。\n3. 严格使用 Mermaid 语法，不要输出任何额外的解释性文字！\n4. 格式范例：\n```mermaid\nmindmap\n  root((核心主题))\n    分支1\n      节点A\n      节点B\n    分支2\n      节点C\n```\n请直接输出包含 ```mermaid 的 Markdown 代码块。',
      promptText: selected,
      onApply: (full) => {
        // 鲁棒提取 Mermaid 代码块：优先匹配 ```mermaid ... ```，否则把整段当 Mermaid 语法
        let code = '';
        const m = full.match(/```mermaid\s*\n([\s\S]*?)```/i);
        if (m) {
          code = m[1].trim();
        } else {
          code = full.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
        }
        if (!code) { toast('AI 未返回有效 Mermaid 内容', 'err'); return; }

        const block = '```mermaid\n' + code + '\n```';
        const insertText = '\n\n> 🧠 **AI 知识提炼**\n\n' + block + '\n\n';

        if (e > s) {
          // 划词触发：追加在选中文字后方（保留原文）
          editor.value = editor.value.slice(0, e) + insertText + editor.value.slice(e);
          editor.selectionStart = editor.selectionEnd = e + insertText.length;
        } else {
          // 弹窗触发：插入光标处
          insertAtCursor(insertText);
        }
        afterChange();
        toast('🧠 思维导图已生成，请在右侧预览区查看', 'ok');
      }
    });
  },
  // 打开 AI 设置
  aiSettings() { openAiSettings(); },
  // AI 多平台爆款转写：知乎体
  aiRewriteZhihu() { aiSocialRewrite('zhihu'); },
  // AI 多平台爆款转写：Twitter Thread 风
  aiRewriteTwitter() { aiSocialRewrite('twitter'); }
};

/* AI 设置弹窗（BYOK） */
function openAiSettings() {
  const cfg = readAiConfig();
  const ep = $('#aiEndpoint'), md = $('#aiModel'), key = $('#aiKey');
  if (ep) ep.value = cfg.endpoint || 'https://wx.want.biz/v1/chat/completions';
  if (md) md.value = cfg.model || 'free';
  if (key) key.value = cfg.apiKey || '';
  renderModelHistory(); // 填充「最近使用」候选
  const m = $('#aiSettingsModal');
  if (m) m.hidden = false;
}
function saveAiSettings() {
  const ep = $('#aiEndpoint').value.trim() || 'https://wx.want.biz/v1/chat/completions';
  const md = $('#aiModel').value.trim() || 'free';
  const key = $('#aiKey').value.trim();
  if (!key) { toast('请填写 API Key', 'err'); return; }
  try { localStorage.setItem(AI_CFG_KEY, JSON.stringify({ endpoint: ep, model: md, apiKey: key })); } catch (_) {}
  recordModelUsage(md, ep); // 记录本次使用的模型到历史
  updateAiModelBadge(); // 模型变更后刷新菜单/浮层徽标
  const m = $('#aiSettingsModal');
  if (m) m.hidden = true;
  toast('AI 配置已保存（仅本机）', 'ok');
}
// 恢复默认：误写地址/模型时一键回退到代码默认。API Key 作为本机密钥予以保留（无默认值、不应被清空）；如需更换 Key 请手动改后保存。
function resetAiSettings() {
  const cfg = readAiConfig();
  const defEp = 'https://wx.want.biz/v1/chat/completions';
  const defMd = 'free';
  try { localStorage.setItem(AI_CFG_KEY, JSON.stringify({ endpoint: defEp, model: defMd, apiKey: cfg.apiKey || '' })); } catch (_) {}
  updateAiModelBadge(); // 恢复默认模型后刷新徽标
  const ep = $('#aiEndpoint'), md = $('#aiModel'), key = $('#aiKey');
  if (ep) ep.value = defEp;
  if (md) md.value = defMd;
  if (key) key.value = cfg.apiKey || '';
  toast('已恢复默认地址/模型，Key 保留', 'ok');
}
// 测试 AI 连接：用极小请求验证端点可达 + Key 有效（不插入正文，仅提示结果）
async function testAiConnection() {
  // 优先用表单里当前填写的值（可能还没点保存）
  const epEl = $('#aiEndpoint'), mdEl = $('#aiModel'), keyEl = $('#aiKey');
  const cfg = readAiConfig();
  const endpoint = (epEl && epEl.value.trim()) || cfg.endpoint || 'https://wx.want.biz/v1/chat/completions';
  const model = (mdEl && mdEl.value.trim()) || cfg.model || 'free';
  const apiKey = (keyEl && keyEl.value.trim()) || cfg.apiKey || '';
  if (!apiKey) { toast('请先填写 API Key', 'err'); return; }
  toast('正在测试连接…', 'info', 30000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      signal: ctrl.signal,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false })
    });
    clearTimeout(timer);
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const t = await resp.text(); const j = JSON.parse(t); if (j && j.error) msg += '：' + (j.error.message || j.error); } catch (_) {}
      toast('连接失败：' + msg, 'err', 6000);
      return;
    }
    let okMsg = '连接成功 ✓';
    try { const j = await resp.json(); if (j && j.model) okMsg += '（' + j.model + '）'; } catch (_) {}
    toast(okMsg, 'ok', 4000);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') toast('连接超时（>20s），请检查网络或端点', 'err', 6000);
    else toast('连接失败：' + aiErrorHint(e, endpoint), 'err', 6000);
  }
}
const aiModal = $('#aiSettingsModal');
if (aiModal) {
  $('#aiSettingsSave').addEventListener('click', saveAiSettings);
  $('#aiReset').addEventListener('click', resetAiSettings);
  $('#aiTest').addEventListener('click', testAiConnection);
  $('#aiSettingsCancel').addEventListener('click', () => { aiModal.hidden = true; });
  // 从历史选择模型时，若 endpoint 为空则顺带补上该模型上次使用的 endpoint
  $('#aiModel').addEventListener('input', () => {
    const v = $('#aiModel').value.trim();
    if (!v) return;
    const hit = readModelHistory().filter((h) => h.model === v && h.endpoint);
    const epEl = $('#aiEndpoint');
    if (hit.length === 1 && epEl && !epEl.value.trim()) epEl.value = hit[0].endpoint;
  });
  // 点击遮罩空白处关闭
  aiModal.addEventListener('click', (e) => { if (e.target === aiModal) aiModal.hidden = true; });
  // 回车保存 / Esc 关闭
  aiModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveAiSettings(); }
    else if (e.key === 'Escape') aiModal.hidden = true;
  });
}
  // 初始渲染一次模型徽标（菜单项右侧 + 生成浮层标题旁）
  updateAiModelBadge();

  // 背景图片设置弹窗
  const bgModal = $('#bgModal');
  if (bgModal) {
    const bgFileInput = $('#bgFileInput');
    // 按钮现在是 <label for="bgFileInput">，点击由浏览器原生唤起选择器，不用 JS 再 click 一次
    //（那样在某些浏览器里会触发两次，或者被当作非用户手势拦掉）。
    // 键盘可达性：label 不是按钮，Enter/Space 需要自己补一次。
    const bgBtn = $('#bgFileBtn');
    if (bgBtn) {
      bgBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bgFileInput.click(); }
      });
    }
    bgFileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadBgFile(f);
      e.target.value = '';                 // 允许重复选同一文件
    });
    $('#bgUrlApply').addEventListener('click', () => applyBgUrl($('#bgUrl').value));
    $('#bgUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBgUrl(e.target.value); } });
    $('#bgScrim').addEventListener('input', (e) => setBgScrim(e.target.value));
    $('#bgFit').addEventListener('change', (e) => setBgFit(e.target.value));
    $('#bgRemove').addEventListener('click', () => { removeAppBg(); bgModal.hidden = true; });
    $('#bgDone').addEventListener('click', () => { bgModal.hidden = true; });
    bgModal.addEventListener('click', (e) => { if (e.target === bgModal) bgModal.hidden = true; });
    bgModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') bgModal.hidden = true; });
  }
  // 正文字号与颜色弹窗：拖动即时预览，选择即保存
  const tsModal = document.getElementById('textStyleModal');
  if (tsModal) {
    const tsSize = document.getElementById('tsSize');
    if (tsSize) tsSize.addEventListener('input', () => updateTextStyle({ size: tsSize.value }));
    const tsPresets = document.getElementById('tsSizePresets');
    if (tsPresets) tsPresets.addEventListener('click', (e) => {
      const b = e.target.closest('[data-size]');
      if (b) updateTextStyle({ size: b.dataset.size });
    });
    const tsColor = document.getElementById('tsColor');
    if (tsColor) tsColor.addEventListener('input', () => updateTextStyle({ color: tsColor.value }));
    const tsColorReset = document.getElementById('tsColorReset');
    if (tsColorReset) tsColorReset.addEventListener('click', () => updateTextStyle({ color: '' }));
    const tsSwatches = document.getElementById('tsSwatches');
    if (tsSwatches) tsSwatches.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b) updateTextStyle({ color: b.dataset.color });
    });
    const tsReset = document.getElementById('tsReset');
    if (tsReset) tsReset.addEventListener('click', resetTextStyle);
    const tsDone = document.getElementById('tsDone');
    if (tsDone) tsDone.addEventListener('click', () => { tsModal.hidden = true; });
    tsModal.addEventListener('click', (e) => { if (e.target === tsModal) tsModal.hidden = true; });
    tsModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') tsModal.hidden = true; });
    // 菜单触发后焦点仍在工具栏按钮上，故再挂一个全局 Esc（弹窗内部 Esc 也覆盖）
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tsModal.hidden) tsModal.hidden = true; });
  }
  // 自定义格式刷弹窗
  const fbCustModal = document.getElementById('fbCustomizeModal');
  if (fbCustModal) {
    document.getElementById('fbCustSave').addEventListener('click', saveFbCustomize);
    document.getElementById('fbCustReset').addEventListener('click', resetFbCustomize);
    document.getElementById('fbCustClose').addEventListener('click', closeFbCustomize);
    fbCustModal.addEventListener('click', (e) => { if (e.target === fbCustModal) closeFbCustomize(); });
    fbCustModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFbCustomize(); });
  }
  // 启动：若已设置过背景图则自动恢复（setTimeout 确保在模块顶层执行完、libDb 初始化后再跑，
  // 否则顶层同步调用会撞上 libDb 的暂时性死区而抛 ReferenceError）
  setTimeout(loadAppBg, 0);
  // 按用户配置构建格式刷按钮（FB_TOOLS 定义在文件更靠后的位置，顶层同步调用会撞 TDZ，故延迟到下一拍）
  setTimeout(buildFormatBrush, 0);
  // 构建左上角 logo 快捷菜单（QUICK_CATALOG 同样定义在文件更靠后，延迟到下一拍避免 TDZ）
  setTimeout(buildQuickMenu, 0);

// 协作分享弹窗：复制按钮 / 完成 / 遮罩 / Esc 关闭
const shareModal = $('#shareModal');
if (shareModal) {
  $('#shareCopyBtn').addEventListener('click', copyShareUrl);
  $('#shareCloseBtn').addEventListener('click', () => { shareModal.hidden = true; });
  shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !shareModal.hidden) shareModal.hidden = true; });
}

// 发布到博客结果弹窗：复制 / 打开 / 关闭（背景点击 + ESC 亦关闭）
const blogPublishModal = $('#blogPublishModal');
if (blogPublishModal) {
  const blogUrl = $('#blogUrlText');
  const copyBlogUrl = () => {
    if (!blogUrl || !blogUrl.value) return;
    if (navigator.clipboard) navigator.clipboard.writeText(blogUrl.value).then(() => toast('已复制博客链接', 'ok'), () => toast('复制失败', 'err'));
    else { blogUrl.select(); try { document.execCommand('copy'); toast('已复制博客链接', 'ok'); } catch (_) { toast('复制失败', 'err'); } }
  };
  $('#blogCopyBtn').addEventListener('click', copyBlogUrl);
  $('#blogOpenBtn').addEventListener('click', () => { if (blogUrl && blogUrl.value) window.open(blogUrl.value, '_blank', 'noopener'); });
  $('#blogCloseBtn').addEventListener('click', () => { blogPublishModal.hidden = true; });
  blogPublishModal.addEventListener('click', (e) => { if (e.target === blogPublishModal) blogPublishModal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !blogPublishModal.hidden) blogPublishModal.hidden = true; });
}

/* AI 流式打字机浮层按钮：应用 / 取消 / 停止 / 自动续写开关 */
const aiStreamPanelEl = document.getElementById('aiStreamPanel');
if (aiStreamPanelEl) {
  // 🔁 自动续写开关：勾选后，每章"应用"即自动续写下一章，面板保持常显
  const aspAutoEl = document.getElementById('aspAuto');
  if (aspAutoEl) aspAutoEl.addEventListener('change', () => { aiAutoWrite = aspAutoEl.checked; });
  // ⏩ 全自动写作开关：生成完成自动应用本章 + 暂停后自动续写下一章
  const aspFullAutoEl = document.getElementById('aspFullAuto');
  if (aspFullAutoEl) aspFullAutoEl.addEventListener('change', () => { aiFullAuto = aspFullAutoEl.checked; });

  document.getElementById('aspApply').addEventListener('click', () => {
    const applied = doApplyInsert();
    if (applied) afterApply();
    else aiStreamPanelEl.hidden = true;
  });
  document.getElementById('aspCancel').addEventListener('click', () => {
    if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
    aiStreamApply = null;
    setAutoWrite(false);
    setFullAuto(false);
    if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer();
    aiStreamPanelEl.hidden = true;
  });
  document.getElementById('aspStop').addEventListener('click', () => {
    if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
    // 停止后保留已生成内容，应用按钮仍可用；自动续写保持武装（应用该章后仍会继续）
  });
  // 全自动倒计时条：⏩ 立即继续（跳过等待）/ ⏹ 停止（结束全自动）
  const aspSkipEl = document.getElementById('aspSkip');
  if (aspSkipEl) aspSkipEl.addEventListener('click', () => {
    if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer();
    if (aiFullAuto) AI_ACTIONS.aiWriteNextChapter();
  });
  const aspStopAutoEl = document.getElementById('aspStopAuto');
  if (aspStopAutoEl) aspStopAutoEl.addEventListener('click', () => {
    if (typeof clearFullAutoTimer === 'function') clearFullAutoTimer();
    setFullAuto(false);
    aiStreamPanelEl.hidden = true;
  });
}

// === SECTION: 选中文字后的浮动 AI 气泡菜单（Floating Toolbar） ===
// 思路：编辑器内划词选中 → 在选区上方浮出毛玻璃小工具条，点按即触发 AI_ACTIONS。
const aiToolbar = $('#aiFloatingToolbar');
let aiSel = { start: 0, end: 0 };

// 计算 textarea 内某偏移量的像素坐标（内容坐标系，未扣滚动）
function getTextareaCaretPos(el, position) {
  const doc = el.ownerDocument;
  const div = doc.createElement('div');
  const style = getComputedStyle(el);
  const copy = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'letterSpacing', 'wordSpacing', 'tabSize'];
  copy.forEach((p) => { div.style[p] = style[p]; });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.top = '0';
  div.style.left = '0';
  div.style.overflow = 'hidden';
  div.style.whiteSpace = (el.wrap === 'off') ? 'pre' : 'pre-wrap';
  div.style.wordWrap = (el.wrap === 'off') ? 'normal' : 'break-word';
  div.textContent = el.value.substring(0, position);
  const span = doc.createElement('span');
  span.textContent = el.value.substring(position) || '.';
  div.appendChild(span);
  doc.body.appendChild(div);
  const coords = {
    top: span.offsetTop + parseInt(style.borderTopWidth) || 0,
    left: span.offsetLeft + parseInt(style.borderLeftWidth) || 0,
    height: parseInt(style.lineHeight) || (parseInt(style.fontSize) * 1.2)
  };
  doc.body.removeChild(div);
  return coords;
}

// 缓存 getTextareaCaretPos 的昂贵结果：大文档每次选区变化都要把文档前缀整段复制到离屏 div，
// 用「位置 + 文档长度 + wrap 模式」作键，三者皆同才算同一坐标，内容/选区变化即重算（保证正确）。
// 视口 x/y 仍由调用方用当前 rect/scrollTop 重算，故滚动/缩放永远准确。
let _caretPosCache = { key: '', pos: null };
function getCaretPosCached(el, position) {
  const key = position + '|' + el.value.length + '|' + el.wrap;
  if (_caretPosCache.key === key) return _caretPosCache.pos;
  const pos = getTextareaCaretPos(el, position);
  _caretPosCache = { key, pos };
  return pos;
}

// 浮动工具条定位共用逻辑：按选区末端视口坐标计算 left/top/transform（含上方空间不足翻转）
function positionToolbar(el, s, e) {
  if (!el) return;
  const pos = getCaretPosCached(editor, e);           // 选区末端坐标（内容坐标，带缓存）
  const rect = editor.getBoundingClientRect();
  const x = rect.left + pos.left - editor.scrollLeft;   // 视口坐标
  const y = rect.top + pos.top - editor.scrollTop;
  el.hidden = false;
  const tw = el.offsetWidth, th = el.offsetHeight;
  const left = Math.max(tw / 2 + 6, Math.min(x, window.innerWidth - tw / 2 - 6));
  el.style.left = left + 'px';
  el.style.top = y + 'px';
  // 上方空间不足则翻到选区下方
  const placeBelow = (y - th - 12) < 0;
  el.style.transform = placeBelow
    ? 'translate(-50%, 12px)'
    : 'translate(-50%, calc(-100% - 12px))';
}

function showAiToolbar() {
  if (!aiToolbar) return;
  const s = editor.selectionStart, e = editor.selectionEnd;
  if (s === e) { hideAiToolbar(); return; } // 无选区则隐藏
  aiSel = { start: s, end: e };
  positionToolbar(aiToolbar, s, e);
}

function hideAiToolbar() {
  if (aiToolbar) aiToolbar.hidden = true;
}

// === SECTION: 格式刷：选中文字浮出的 WPS 风格工具条 ===
const formatBrush = $('#formatBrush');
let fmtSel = null;            // 记录当前选区，供按钮点击后还原

function showFormatBrush() {
  if (!formatBrush) return;
  // Vim Normal 模式下由 Vim 接管选区，不弹格式刷
  if (isVimMode && vimState === 'normal') { hideFormatBrush(); return; }
  const s = editor.selectionStart, e = editor.selectionEnd;
  if (s === e) { hideFormatBrush(); return; }   // 无选区则隐藏
  fmtSel = { start: s, end: e };
  positionToolbar(formatBrush, s, e);
}
function hideFormatBrush() { if (formatBrush) formatBrush.hidden = true; }

// 划词 / 键盘选择后浮出格式刷（用 setTimeout 等浏览器先把选区定好）
editor.addEventListener('mouseup', () => setTimeout(showFormatBrush, 0));
editor.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') showFormatBrush(); });

// 点工具条按钮：先还原选区，再触发对应 AI 动作
if (aiToolbar) {
  aiToolbar.addEventListener('mousedown', (e) => e.preventDefault()); // 防止抢焦点导致选区丢失
  aiToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ai]');
    if (!btn) return;
    const action = btn.dataset.ai;
    hideAiToolbar();
    editor.focus();
    editor.setSelectionRange(aiSel.start, aiSel.end);
    if (AI_ACTIONS[action]) AI_ACTIONS[action]();
  });
}

// 点格式刷按钮：还原选区 → 套用对应格式 / AI 动作（__ai 展开完整 AI 浮层，__customize 打开自定义）
if (formatBrush) {
  formatBrush.addEventListener('mousedown', (e) => e.preventDefault()); // 防止抢焦点导致选区丢失
  formatBrush.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (!btn) return;
    const tool = btn.dataset.tool;
    if (tool === '__customize') { openFbCustomize(); return; }
    if (tool === '__ai') {        // 展开完整 AI 智能助理浮层
      hideFormatBrush();
      editor.focus();
      showAiToolbar();
      return;
    }
    const kind = btn.dataset.kind;
    hideFormatBrush();
    editor.focus();
    if (fmtSel) editor.setSelectionRange(fmtSel.start, fmtSel.end);
    if (kind === 'ai') { if (AI_ACTIONS && AI_ACTIONS[tool]) AI_ACTIONS[tool](); }
    else if (kind === 'format') { if (FORMAT_ACTIONS && FORMAT_ACTIONS[tool]) FORMAT_ACTIONS[tool](); }
  });
}

// 选区外点击 / 滚动 / Esc 时收起
document.addEventListener('mousedown', (ev) => {
  if (aiToolbar && !aiToolbar.hidden && !aiToolbar.contains(ev.target)) hideAiToolbar();
  if (formatBrush && !formatBrush.hidden && !formatBrush.contains(ev.target)) hideFormatBrush();
});
window.addEventListener('scroll', () => { hideAiToolbar(); hideFormatBrush(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideAiToolbar(); hideFormatBrush(); closeQuickMenu(); closeQuickCustomize(); } });

// === SECTION: 格式刷自定义（可勾选显示哪些工具，含常用 AI 按钮） ===
const FB_KEY = 'md-format-brush';
// 主列表：决定渲染顺序与可选范围；group 用于分组（fmt 文本格式 / ai AI 动作）
const FB_TOOLS = [
  // —— 文本格式 ——
  { id: 'fmtBold',   label: 'B',    title: '加粗 (Ctrl+B)',     kind: 'format', group: 'fmt' },
  { id: 'fmtItalic', label: 'I',    title: '斜体 (Ctrl+I)',     kind: 'format', group: 'fmt' },
  { id: 'fmtCode',   label: '</>',  title: '行内代码 (Ctrl+E)', kind: 'format', group: 'fmt' },
  { id: 'fmtLink',   label: '🔗',   title: '链接 (Ctrl+K)',     kind: 'format', group: 'fmt' },
  { id: 'fmtImage',  label: '🖼',   title: '图片',               kind: 'format', group: 'fmt' },
  { id: 'fmtQuote',  label: '❝',    title: '引用',               kind: 'format', group: 'fmt' },
  { id: 'fmtUl',     label: '•',    title: '无序列表',           kind: 'format', group: 'fmt' },
  { id: 'fmtOl',     label: '1.',   title: '有序列表',           kind: 'format', group: 'fmt' },
  { id: 'fmtH1',     label: 'H1',   title: '一级标题',           kind: 'format', group: 'fmt' },
  { id: 'fmtH2',     label: 'H2',   title: '二级标题',           kind: 'format', group: 'fmt' },
  { id: 'fmtH3',     label: 'H3',   title: '三级标题',           kind: 'format', group: 'fmt' },
  { id: 'fmtH4',     label: 'H4',   title: '四级标题',           kind: 'format', group: 'fmt' },
  { id: 'fmtH5',     label: 'H5',   title: '五级标题',           kind: 'format', group: 'fmt' },
  { id: 'fmtH6',     label: 'H6',   title: '六级标题',           kind: 'format', group: 'fmt' },
  // —— AI 动作 ——
  { id: 'aiPolish',          label: '✨ 润色',  title: '润色选中文字',          kind: 'ai', group: 'ai' },
  { id: 'aiExpand',          label: '📈 扩写',  title: '扩写选中文字',          kind: 'ai', group: 'ai' },
  { id: 'aiTranslate',       label: '🌐 翻译',  title: '翻译为英文',            kind: 'ai', group: 'ai' },
  { id: 'aiSummary',         label: '📝 总结',  title: '全文总结摘要',          kind: 'ai', group: 'ai' },
  { id: 'aiGenerate',        label: '💡 生成',  title: '按提示词生成',          kind: 'ai', group: 'ai' },
  { id: 'aiBookOutline',     label: '📖 大纲',  title: '策划书籍大纲',          kind: 'ai', group: 'ai' },
  { id: 'aiWriteNextChapter',label: '✍️ 下一章',title: '按大纲续写下一章',      kind: 'ai', group: 'ai' },
  { id: 'aiWriteEpilogue',   label: '📜 后记',  title: '生成终章后记',          kind: 'ai', group: 'ai' },
  { id: 'aiMindmap',         label: '🧠 脑图',  title: '生成思维导图',          kind: 'ai', group: 'ai' },
  { id: 'aiRewriteZhihu',    label: '📘 知乎',  title: '转写为知乎体',          kind: 'ai', group: 'ai' },
  { id: 'aiRewriteTwitter',  label: '🐦 Thread',title: '转写为 Twitter Thread',kind: 'ai', group: 'ai' },
];
// 默认显示：常用文本格式（H1–H3）+ 几个常用 AI 按钮
const FB_DEFAULT = ['fmtBold', 'fmtItalic', 'fmtCode', 'fmtLink', 'fmtImage', 'fmtQuote', 'fmtUl', 'fmtOl', 'fmtH1', 'fmtH2', 'fmtH3', 'aiPolish', 'aiExpand', 'aiSummary', 'aiWriteNextChapter'];

function loadFbConfig() {
  try {
    const raw = localStorage.getItem(FB_KEY);
    if (!raw) return FB_DEFAULT.slice();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return FB_DEFAULT.slice();
    const valid = FB_TOOLS.map((t) => t.id);
    // 仅保留仍有效的 id，保持用户保存的顺序；不重新追加被取消勾选的项
    return arr.filter((id) => valid.includes(id));
  } catch (_) { return FB_DEFAULT.slice(); }
}
function saveFbConfig(ids) {
  try { localStorage.setItem(FB_KEY, JSON.stringify(ids)); } catch (_) {}
}
// 按配置动态生成格式刷按钮，分组之间自动插分隔线
function buildFormatBrush() {
  const box = document.getElementById('fbButtons');
  if (!box) return;
  const ids = loadFbConfig();
  let html = '';
  let lastGroup = null;
  ids.forEach((id) => {
    const t = FB_TOOLS.find((x) => x.id === id);
    if (!t) return;
    if (lastGroup !== null && lastGroup !== t.group) html += '<span class="fb-sep" aria-hidden="true"></span>';
    lastGroup = t.group;
    const cls = t.kind === 'ai' ? ' class="fb-ai"' : '';
    html += '<button type="button" data-tool="' + id + '" data-kind="' + t.kind + '"' + cls + ' title="' + t.title + '">' + t.label + '</button>';
  });
  box.innerHTML = html;
}
// 打开自定义弹窗：按分组渲染复选框
function openFbCustomize() {
  const modal = document.getElementById('fbCustomizeModal');
  if (!modal) return;
  const box = document.getElementById('fbCustList');
  if (box) {
    const checked = new Set(loadFbConfig());
    const groups = [{ g: 'fmt', label: '文本格式' }, { g: 'ai', label: 'AI 动作' }];
    let html = '';
    groups.forEach((grp) => {
      html += '<div class="fb-cust-group"><div class="fb-cust-glabel">' + grp.label + '</div>';
      FB_TOOLS.filter((t) => t.group === grp.g).forEach((t) => {
        const on = checked.has(t.id) ? ' checked' : '';
        html += '<label class="fb-opt"><input type="checkbox" data-fb="' + t.id + '"' + on + '>'
              + '<span class="fb-opt-text"><b>' + t.label + '</b><small>' + t.title + '</small></span></label>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }
  modal.hidden = false;
}
function closeFbCustomize() {
  const modal = document.getElementById('fbCustomizeModal');
  if (modal) modal.hidden = true;
}
function saveFbCustomize() {
  const modal = document.getElementById('fbCustomizeModal');
  if (!modal) return;
  const ids = [];
  FB_TOOLS.forEach((t) => {                        // 按主列表顺序收集勾选项
    const c = modal.querySelector('input[data-fb="' + t.id + '"]');
    if (c && c.checked) ids.push(t.id);
  });
  saveFbConfig(ids);
  buildFormatBrush();
  closeFbCustomize();
  if (typeof flash === 'function') flash('格式刷已更新');
}
function resetFbCustomize() {
  saveFbConfig(FB_DEFAULT.slice());
  buildFormatBrush();
  openFbCustomize();                                // 刷新勾选状态
}


// === SECTION: 左上角 logo 快捷菜单（右上角「⋯」菜单的可定制子集） ===
const QUICK_KEY = 'md-quick-menu';
// 候选目录：取自右上角「⋯」菜单的叶节点动作（data-action 走 TEXT/AI/FORMAT_ACTIONS，data-act 走 handleDataAct）
const QUICK_CATALOG = [
  { id: 'searchReplace', label: '🔍 查找与替换', kind: 'action', act: 'searchReplace', group: 'general' },
  { id: 'rename', label: '✏️ 重命名', kind: 'act', act: 'rename', group: 'general' },
  { id: 'bg', label: '🖼️ 设置背景图片', kind: 'act', act: 'bg', group: 'general' },
  { id: 'fmtImage', label: '🖼 插入图片', kind: 'action', act: 'fmtImage', group: 'doc' },
  { id: 'match-podcast', label: '🎧 插入播客播放器', kind: 'act', act: 'match-podcast', group: 'doc' },
  { id: 'nas-download', label: '📥 从 NAS 下载', kind: 'act', act: 'nas-download', group: 'doc' },
  { id: 'addtolib', label: '📚 添加到文库', kind: 'act', act: 'addtolib', group: 'doc' },
  { id: 'publish-blog', label: '📝 发布到博客', kind: 'act', act: 'publish-blog', group: 'doc' },
  { id: 'save-ima', label: '💾 保存到 IMA 笔记', kind: 'act', act: 'save-ima', group: 'doc' },
  { id: 'publish-podcast', label: '🎙️ 文档转播客', kind: 'act', act: 'publish-podcast', group: 'doc' },
  { id: 'fetch-url', label: '🌐 从网址打开（只读）', kind: 'act', act: 'fetch-url', group: 'doc' },
  { id: 'nas-upload', label: '📤 上传到 NAS', kind: 'act', act: 'nas-upload', group: 'doc' },
  { id: 'md', label: '⬇️ 导出 Markdown', kind: 'act', act: 'md', group: 'export' },
  { id: 'txt', label: '📃 导出为 txt 文件', kind: 'act', act: 'txt', group: 'export' },
  { id: 'html', label: '📄 导出 html', kind: 'act', act: 'html', group: 'export' },
  { id: 'share-r2', label: '🔗 生成分享链接', kind: 'act', act: 'share-r2', group: 'export' },
  { id: 'copytext', label: '📋 复制纯文本', kind: 'act', act: 'copytext', group: 'export' },
  { id: 'copymd', label: '📋 复制Markdown', kind: 'act', act: 'copymd', group: 'export' },
  { id: 'copy', label: '📋 复制 html', kind: 'act', act: 'copy', group: 'export' },
  { id: 'theme', label: '🌗 切换深/浅/跟随', kind: 'act', act: 'theme', group: 'look' },
  { id: 'textStyle', label: '🔠 正文字号与颜色', kind: 'act', act: 'textStyle', group: 'look' },
  { id: 'fmtBold', label: '🅱 加粗', kind: 'action', act: 'fmtBold', group: 'fmt' },
  { id: 'fmtItalic', label: '🇮 斜体', kind: 'action', act: 'fmtItalic', group: 'fmt' },
  { id: 'fmtCode', label: '⌨️ 行内代码', kind: 'action', act: 'fmtCode', group: 'fmt' },
  { id: 'fmtLink', label: '🔗 链接', kind: 'action', act: 'fmtLink', group: 'fmt' },
  { id: 'fmtQuote', label: '❝ 引用', kind: 'action', act: 'fmtQuote', group: 'fmt' },
  { id: 'fmtUl', label: '• 无序列表', kind: 'action', act: 'fmtUl', group: 'fmt' },
  { id: 'fmtOl', label: '1. 有序列表', kind: 'action', act: 'fmtOl', group: 'fmt' },
  { id: 'fmtH1', label: 'H1 一级标题', kind: 'action', act: 'fmtH1', group: 'fmt' },
  { id: 'fmtH2', label: 'H2 二级标题', kind: 'action', act: 'fmtH2', group: 'fmt' },
  { id: 'fmtH3', label: 'H3 三级标题', kind: 'action', act: 'fmtH3', group: 'fmt' },
  { id: 'aiSummary', label: '🗒️ 全文总结摘要', kind: 'action', act: 'aiSummary', group: 'ai' },
  { id: 'aiPolish', label: '✨ 润色选中文字', kind: 'action', act: 'aiPolish', group: 'ai' },
  { id: 'aiExpand', label: '📈 扩写选中文字', kind: 'action', act: 'aiExpand', group: 'ai' },
  { id: 'aiTranslate', label: '🌐 翻译为英文', kind: 'action', act: 'aiTranslate', group: 'ai' },
  { id: 'aiGenerate', label: '💡 按提示词生成', kind: 'action', act: 'aiGenerate', group: 'ai' },
  { id: 'aiBookOutline', label: '📖 策划书籍大纲', kind: 'action', act: 'aiBookOutline', group: 'ai' },
  { id: 'aiWriteNextChapter', label: '✍️ 续写下一章', kind: 'action', act: 'aiWriteNextChapter', group: 'ai' },
  { id: 'aiWriteEpilogue', label: '📜 终章后记', kind: 'action', act: 'aiWriteEpilogue', group: 'ai' },
  { id: 'aiMindmap', label: '🧠 生成思维导图', kind: 'action', act: 'aiMindmap', group: 'ai' },
  { id: 'aiRewriteZhihu', label: '📘 知乎体', kind: 'action', act: 'aiRewriteZhihu', group: 'ai' },
  { id: 'aiRewriteTwitter', label: '🐦 Twitter Thread', kind: 'action', act: 'aiRewriteTwitter', group: 'ai' },
  { id: 'aiSettings', label: '⚙️ AI 设置（BYOK）', kind: 'action', act: 'aiSettings', group: 'ai' },
];
const QUICK_GROUPS = [
  { g: 'general', label: '常用' },
  { g: 'doc', label: '文档操作' },
  { g: 'export', label: '导出与复制' },
  { g: 'look', label: '外观' },
  { g: 'fmt', label: '文本格式' },
  { g: 'ai', label: 'AI 动作' },
];
// 文库副标题：默认「本地文档库」；想写自己名字就 localStorage.setItem('md-lib-sub', '…')
try {
  const sub = localStorage.getItem('md-lib-sub');
  const el = document.getElementById('libSubtitle');
  if (sub && el) el.textContent = sub;
} catch (_) {}

const QUICK_DEFAULT = ['searchReplace', 'rename', 'bg', 'fmtImage', 'addtolib', 'md', 'txt', 'share-r2', 'theme', 'aiSummary', 'aiGenerate', 'aiBookOutline'];

function loadQuickConfig() {
  try {
    const raw = localStorage.getItem(QUICK_KEY);
    if (!raw) return QUICK_DEFAULT.slice();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return QUICK_DEFAULT.slice();
    const valid = QUICK_CATALOG.map((t) => t.id);
    return arr.filter((id) => valid.includes(id));
  } catch (_) { return QUICK_DEFAULT.slice(); }
}
function saveQuickConfig(ids) {
  try { localStorage.setItem(QUICK_KEY, JSON.stringify(ids)); } catch (_) {}
}
function buildQuickMenu() {
  const box = document.getElementById('quickButtons');
  if (!box) return;
  const ids = loadQuickConfig();
  if (!ids.length) {
    box.innerHTML = '<div class="quick-empty">尚未选择常用功能，点下方「⚙ 自定义常用菜单」添加。</div>';
    return;
  }
  let html = '';
  ids.forEach((id) => {
    const t = QUICK_CATALOG.find((x) => x.id === id);
    if (!t) return;
    const attr = t.kind === 'action' ? ('data-action="' + t.act + '"') : ('data-act="' + t.act + '"');
    html += '<button type="button" role="menuitem" ' + attr + '>' + t.label + '</button>';
  });
  box.innerHTML = html;
}
function openQuickMenu(open) {
  const m = document.getElementById('quickMenu');
  const b = document.getElementById('brandEl');
  if (!m) return;
  if (open) { buildQuickMenu(); m.removeAttribute('hidden'); if (b) b.setAttribute('aria-expanded', 'true'); }
  else { m.setAttribute('hidden', ''); if (b) b.setAttribute('aria-expanded', 'false'); }
}
function closeQuickMenu() { openQuickMenu(false); }

// 自定义弹窗
function openQuickCustomize() {
  const modal = document.getElementById('quickCustomizeModal');
  if (!modal) return;
  const box = document.getElementById('quickCustList');
  if (box) {
    const checked = new Set(loadQuickConfig());
    let html = '';
    QUICK_GROUPS.forEach((grp) => {
      const items = QUICK_CATALOG.filter((t) => t.group === grp.g);
      if (!items.length) return;
      html += '<div class="fb-cust-group"><div class="fb-cust-glabel">' + grp.label + '</div>';
      items.forEach((t) => {
        const on = checked.has(t.id) ? ' checked' : '';
        html += '<label class="fb-opt"><input type="checkbox" data-qk="' + t.id + '"' + on + '>'
              + '<span class="fb-opt-text"><b>' + t.label + '</b></span></label>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }
  modal.hidden = false;
}
function closeQuickCustomize() {
  const modal = document.getElementById('quickCustomizeModal');
  if (modal) modal.hidden = true;
}
function saveQuickCustomize() {
  const modal = document.getElementById('quickCustomizeModal');
  if (!modal) return;
  const ids = [];
  QUICK_CATALOG.forEach((t) => {
    const c = modal.querySelector('input[data-qk="' + t.id + '"]');
    if (c && c.checked) ids.push(t.id);
  });
  saveQuickConfig(ids);
  buildQuickMenu();                                    // 立即重建，使改动无需重开/刷新即生效
  closeQuickCustomize();
  if (typeof flash === 'function') flash('常用菜单已更新');
}
function resetQuickCustomize() {
  saveQuickConfig(QUICK_DEFAULT.slice());
  buildQuickMenu();                                    // 同步重建菜单
  openQuickCustomize();                                // 刷新勾选状态
}
// logo 点击 / 键盘打开；菜单内点击分发；外部点击与 Esc 关闭
(function bindQuickMenu() {
  const brandEl = document.getElementById('brandEl');
  const quickMenuEl = document.getElementById('quickMenu');
  if (brandEl) {
    brandEl.addEventListener('click', (e) => {
      if (e.target.closest('#quickMenu')) return;     // 点菜单内部不切换
      openQuickMenu(quickMenuEl && quickMenuEl.hasAttribute('hidden'));
    });
    brandEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openQuickMenu(quickMenuEl && quickMenuEl.hasAttribute('hidden'));
      }
    });
  }
  if (quickMenuEl) {
    quickMenuEl.addEventListener('click', (e) => {
      const gear = e.target.closest('#quickCustomizeBtn');
      if (gear) { closeQuickMenu(); openQuickCustomize(); return; }
      const more = e.target.closest('#quickMoreBtn');
      if (more) { closeQuickMenu(); openMoreMenu(true); return; }
      const btn = e.target.closest('[data-act], [data-action]');
      if (!btn) return;
      const macro = btn.dataset.action;
      if (macro) {
        const fn = TEXT_ACTIONS[macro] || AI_ACTIONS[macro] || (FORMAT_ACTIONS && FORMAT_ACTIONS[macro]);
        if (fn) fn();
        closeQuickMenu();
        return;
      }
      const act = btn.dataset.act;
      if (act) { handleDataAct(act, btn); closeQuickMenu(); }
    });
  }
  // 自定义弹窗：背景点击 / Esc 关闭 + 按钮
  const qcm = document.getElementById('quickCustomizeModal');
  if (qcm) {
    qcm.addEventListener('click', (e) => { if (e.target === qcm) closeQuickCustomize(); });
    qcm.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQuickCustomize(); });
    const r = document.getElementById('quickCustReset'); if (r) r.addEventListener('click', resetQuickCustomize);
    const c = document.getElementById('quickCustClose'); if (c) c.addEventListener('click', closeQuickCustomize);
    const s = document.getElementById('quickCustSave'); if (s) s.addEventListener('click', saveQuickCustomize);
  }
})();



// === SECTION: 命令面板（Ctrl/Cmd+Shift+P） ===
// 为什么要有它：右上角「⋯」里已经 70 多项，手机上翻菜单很痛苦。
// 实现上刻意「不维护第二份命令表」——直接从菜单 DOM 里抓 data-act / data-action，
// 执行时 el.click() 复用原有全部接线（含 NAS 提示、AI 子菜单、主题切换）。
// 这样以后加菜单项，命令面板自动就有，不会出现两份清单对不上。
const palette = $('#palette');
const paletteScrim = $('#paletteScrim');
const paletteInput = $('#paletteInput');
const paletteList = $('#paletteList');
let paletteItems = [];
let paletteActive = 0;

function collectPaletteCommands() {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('#moreMenu [data-act], #moreMenu [data-action]').forEach((el) => {
    if (el.hasAttribute('data-sub')) return;            // 子菜单标题不是命令
    if (el.id === 'aiMenuModel') return;
    const key = el.dataset.act ? 'act:' + el.dataset.act : 'action:' + el.dataset.action;
    if (seen.has(key)) return;
    seen.add(key);
    // 取标签前先克隆并剔除菜单里已渲染的 .kbd 快捷键（否则面板里会重复显示一遍）
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.kbd, .mi-model').forEach((n) => n.remove());
    let label = (clone.textContent || '').replace(/[▸]/g, '').replace(/\s+/g, ' ').trim();
    const hintKey = el.dataset.act || el.dataset.action;
    out.push({ el, label, key, hint: ACTION_HINTS[hintKey] || '' });
  });
  return out;
}

// 模糊匹配逻辑已下沉到 lib/md-core.js 的 fuzzyScore（有单测）

function renderPalette(query) {
  const all = collectPaletteCommands();
  const scored = all
    .map((c) => ({ c, s: Core.fuzzyScore(query, c.label) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  paletteItems = scored.map((x) => x.c);
  paletteActive = 0;
  paletteList.innerHTML = '';
  if (!paletteItems.length) {
    paletteList.innerHTML = '<li class="palette-empty">没有匹配的命令</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  paletteItems.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'palette-item' + (i === 0 ? ' active' : '');
    li.setAttribute('role', 'option');
    li.innerHTML = '<span class="pi-label"></span><span class="pi-hint"></span>';
    li.querySelector('.pi-label').textContent = c.label;
    li.querySelector('.pi-hint').textContent = c.hint ? formatCombo(c.hint) : '';
    li.addEventListener('mousedown', (e) => { e.preventDefault(); runPaletteItem(i); });
    frag.appendChild(li);
  });
  paletteList.appendChild(frag);
}

function movePaletteActive(delta) {
  if (!paletteItems.length) return;
  paletteActive = (paletteActive + delta + paletteItems.length) % paletteItems.length;
  [...paletteList.children].forEach((li, i) => li.classList.toggle('active', i === paletteActive));
  const cur = paletteList.children[paletteActive];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(i) {
  const c = paletteItems[i];
  closePalette();
  if (!c || !c.el) return;
  // 用 click 而不是直接调函数：子菜单按钮、需要 btn.dataset 的动作都能照常工作
  c.el.click();
}

function openPalette() {
  if (!palette) return;
  palette.hidden = false;
  paletteScrim.hidden = false;
  paletteInput.value = '';
  renderPalette('');
  setTimeout(() => paletteInput.focus(), 0);
}

function closePalette() {
  if (!palette || palette.hidden) return;
  palette.hidden = true;
  paletteScrim.hidden = true;
  editor.focus();
}

if (palette) {
  paletteInput.addEventListener('input', () => renderPalette(paletteInput.value.trim()));
  paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteActive); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  paletteScrim.addEventListener('click', closePalette);
}

// === SECTION: NAS 同步：上传 / 下载 ===
// 凭据不写死在代码里（避免随仓库泄露）。
// 首次上传时在本机弹窗输入一次，仅存入浏览器 localStorage（不上传、不入 git）。
const NAS_UPLOAD_URL = 'https://upload.want.biz/api/upload';
const NAS_DOWNLOAD_URL = 'https://upload.want.biz/api/uploads/download';
const NAS_ARCHIVE_DOMAIN = 'knowly.want.biz';
const NAS_ARCHIVE_HOST = 'https://knowly.want.biz';
const NAS_MAX_BYTES = 200 * 1024 * 1024;

// NAS 菜单提示：凭据已配置（localStorage 'nas-auth' 非空）则不标注；未配置才显示「（需凭据）」
function updateNasMenuHint() {
  const configured = !!localStorage.getItem('nas-auth');
  const suffix = configured ? '' : '（需凭据）';
  const dl = document.querySelector('[data-act="nas-download"]');
  const ul = document.querySelector('[data-act="nas-upload"]');
  if (dl) dl.textContent = '📥 从 NAS 取回' + suffix;
  if (ul) ul.textContent = '📤 存到 NAS' + suffix;
}
updateNasMenuHint();

function nasBasicAuth() {
  const auth = localStorage.getItem('nas-auth') || '';
  try { return auth ? 'Basic ' + btoa(auth) : ''; } catch (_) { return ''; }
}
// 确保 NAS 凭据可用：缺失时本机输入一次并存 localStorage（不进仓库）；用户取消返回 null
async function ensureNasAuth(label) {
  let auth = localStorage.getItem('nas-auth') || '';
  if (!auth) {
    auth = (await askInput('请输入 NAS ' + (label || '') + '凭据（格式 user:password，仅本机保存）：', { password: true })) || '';
    if (!auth) return null;
    try { localStorage.setItem('nas-auth', auth); } catch (_) {}
    updateNasMenuHint();   // 凭据已配置，去掉菜单的「（需凭据）」提示
  }
  return auth;
}

// 从 knowly.want.biz 归档链接，或纯文件名中解析出 uploads 目录里的文件名（仅 basename）
function extractNasFilename(input) {
  if (!input) return '';
  const s = String(input).trim();
  // 完整归档链接：https://knowly.want.biz/#/archive/2026/07/22/180032_xxx.md
  let m = s.match(/knowly\.want\.biz\/#?\/archive\/[^?\s]*\/([^/?#\s]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // 其它 knowly.want.biz 路径里的 .md/.markdown/.txt
  m = s.match(/knowly\.want\.biz\/[^?\s]*\/([^/?#\s]+\.(?:md|markdown|txt))/i);
  if (m) return decodeURIComponent(m[1]);
  // 纯文件名（不含协议、不含路径分隔符）
  if (!/^https?:\/\//i.test(s)) {
    const base = s.split(/[\\/]/).pop();
    if (/\.(md|markdown|txt)$/i.test(base)) return base;
  }
  return '';
}

// 归档链接 → knowly 归档下载接口。
// 关键：path 为【相对】/data/archive/ 的路径（如 2026/07/22/<file>.md），
// 不是绝对路径 /data/archive/...（绝对路径会触发服务端 "failed to get file size: Process exited with status 1" 的 503）。
function nasArchiveUrl(input) {
  const s = String(input || '').trim();
  const m = s.match(/knowly\.want\.biz\/#?\/archive\/(\d{4})\/(\d{2})\/(\d{2})\/([^/?#\s]+\.(?:md|markdown|txt))/i);
  if (!m) return null;
  const rel = m[1] + '/' + m[2] + '/' + m[3] + '/' + decodeURIComponent(m[4]);
  return NAS_ARCHIVE_HOST + '/api/archive/download?path=' + encodeURIComponent(rel);
}

// 上传当前 Markdown 文档到 NAS（multipart/form-data，字段 file，携带 Basic 鉴权）
async function uploadToNas() {
  if (blockInRemoteMode('上传到 NAS')) return;
  if (!editor.value.trim()) { flash('文档为空，无需上传'); return; }
  // 凭据缺失时本机输入一次，仅存 localStorage（不进仓库）
  const auth = await ensureNasAuth('上传');
  if (!auth) { flash('未配置 NAS 凭据，已取消上传'); return; }
  let authHeader = '';
  try { authHeader = 'Basic ' + btoa(auth); } catch (_) { flash('凭据含非法字符，已取消'); return; }
  const blob = new Blob([editor.value], { type: 'text/markdown' });
  if (blob.size > NAS_MAX_BYTES) { flash('文件超过 200MB 上限，已取消'); return; }
  const name = currentName.replace(/\.(md|markdown|txt|html?|pdf)$/i, '') + '.md';
  // === 改进 A（简化版）：上传前检测服务端同名文件，预警将被归档覆盖 ===
  // 服务端在「同名上传」时会把旧版本归档为 <name>_<YYYYMMDD>_<HHMMSS>.md 并用新内容覆盖，
  // 但上传响应里 saved_as 始终等于原文件名，前端无法从响应判断。故上传前主动 GET 探测同名文件是否存在。
  // 注意：服务端不支持 HEAD（405），且无时间戳头；GET 仅用于判断存在性，不读取 body。
  try {
    const probe = await fetch(NAS_DOWNLOAD_URL + '?filename=' + encodeURIComponent(name), { headers: { 'Authorization': authHeader } });
    if (probe.status === 200) {
      const ok = await askConfirm('继续上传？',
        '⚠️ 服务端已存在同名文件「' + name + '」。\n' +
        '上传后，服务端会把现有版本归档为「' + name + '_<时间戳>.md」，并用当前内容覆盖。\n' +
        '（归档旧版不会丢失，可手动按归档名下载找回）\n\n' +
        '点击「确定」继续上传；点击「取消」放弃上传（服务端旧版本保持不变）。'
      );
      if (!ok) { flash('已取消上传，服务端旧版本未改动'); return; }
    }
  } catch (_) { /* 网络异常时不阻断上传 */ }
  const fd = new FormData();
  fd.append('file', blob, name);
  flash('正在上传到 NAS…');
  try {
    const resp = await fetch(NAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Authorization': authHeader },
      body: fd
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg += '：' + j.error; } catch (_) {}
      throw new Error(msg);
    }
    let info = {};
    try { info = await resp.json(); } catch (_) {}
    const savedName = info.saved_as || info.filename || name;
    flash('已上传到 NAS：' + savedName);
    toast('✅ 已上传到 NAS：' + savedName, 'ok');
  } catch (e) {
    console.error(e);
    const msg = '上传失败：' + e.message + '（检查网络 / CORS）';
    flash(msg);
    toast('❌ ' + msg, 'err');
  }
}

// 按文件名（或归档链接）从 NAS 取回文本。
// - 归档链接（knowly.want.biz/#/archive/...）→ 走 knowly 归档接口（相对路径）
// - 其它（纯文件名 / 未归档的 uploads 文件名）→ 走 upload.want.biz/api/uploads/download
// 两者共用 localStorage 里的 Basic 鉴权（服务端要求鉴权，不携带会被 401 拒绝）
async function downloadFromNas(input) {
  const s = String(input || '').trim();
  if (!s) { flash('无法解析 NAS 文件名'); return null; }

  let url, label;
  const arcUrl = nasArchiveUrl(s);
  if (arcUrl) {
    url = arcUrl;
    label = '归档文件';
  } else {
    // extractNasFilename 只认 .md/.markdown/.txt（菜单里手输时够用）。
    // 但从 pi-gw 抽屉进来的文件名可能是 .json/.log/.js 等，这里补一条兜底：
    // 只要是"单个文件名"（不含协议头、不含路径分隔符）就接受。
    let filename = extractNasFilename(s);
    if (!filename) {
      let bare = s;
      try { bare = decodeURIComponent(bare); } catch (_) {}
      if (!/^https?:/i.test(bare) && !/[\\/]/.test(bare) && bare.length <= 200) filename = bare;
    }
    if (!filename) { flash('无法解析 NAS 文件名'); return null; }
    url = NAS_DOWNLOAD_URL + '?filename=' + encodeURIComponent(filename);
    label = filename;
  }

  // 凭据缺失时本机输入一次，仅存 localStorage（不进仓库）
  const auth = await ensureNasAuth('下载');
  if (!auth) { flash('未配置 NAS 凭据，已取消下载'); return null; }
  let authHeader = '';
  try { authHeader = 'Basic ' + btoa(auth); } catch (_) { flash('凭据含非法字符，已取消'); return null; }

  flash('正在从 NAS 下载：' + label + '…');
  try {
    const resp = await fetch(url, { headers: { 'Authorization': authHeader } });
    if (!resp.ok) {
      // 关键兜底：uploads 里没有的文件，多半躺在「归档」目录里（knowly 按日期分目录：
      // archive/YYYY/MM/DD/<文件名>）。用户从 Knowly 界面复制出来的往往只是一个带时间戳前缀的
      // 文件名（如 195435_xxx.md），不知道日期 —— 这时按"今天往前 N 天"逐个试一次。
      // 这也是那个 503「failed to get file size」最常见的来源：不是服务挂了，是文件不在这条路径下。
      if (resp.status === 503 || resp.status === 404) {
        // ① 先问 Knowly 搜索（按文件名精确匹配，不受日期限制）
        const tok = await ensureKnowlyToken();
        const bySearch = await findViaKnowlySearch(label, tok);
        if (bySearch) { flash('已通过 Knowly 搜索取回：' + bySearch.path); return bySearch.text; }
        // ② 搜索不可用（没 token / 没命中）→ 退回按日期扫最近 14 天
        const hit = await findInNasArchive(label, authHeader);
        if (hit) { flash('已从归档取回：' + hit.path); return hit.text; }
      }
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg += '：' + j.error; } catch (_) {}
      throw new Error(msg);
    }
    return await resp.text();
  } catch (e) {
    console.error(e);
    const hint = /503|file size/.test(String(e.message))
      ? '（这个文件名不在上传目录里，归档最近 14 天也没找到。请在 Knowly 里打开该文件、复制完整链接再试）'
      : '（服务端错误，检查 NAS 下载服务）';
    flash('下载失败：' + e.message + hint);
    return null;
  }
}

// Knowly 全文检索：按文件名精确找回归档路径（比"按日期盲扫"快得多，且不受天数限制）。
// 认证是 Bearer token（跟上传/下载的 Basic 是两套），所以单独存一个 localStorage 键。
// 绝不把 token 写进源码——这个仓库是公开的。
const KNOWLY_SEARCH_HOST = 'https://knowly.want.biz';

function getKnowlyToken() {
  try { return localStorage.getItem('knowly-token') || ''; } catch (_) { return ''; }
}

// 没有 token 时问一次，允许跳过（跳过就退回按日期扫描，功能不受影响）
async function ensureKnowlyToken() {
  const had = getKnowlyToken();
  if (had) return had;
  const v = await askInput('粘贴 Knowly 搜索 token（knowly.want.biz 的 Bearer token，仅本机保存；留空则跳过）', { password: true });
  if (!v) return null;
  try { localStorage.setItem('knowly-token', v.trim()); } catch (_) {}
  return v.trim();
}

// 文件名 → 归档路径 的本机缓存：同一个文件反复取时省掉一次搜索（搜索要 1~3 秒）
const KNOWLY_PATH_KEY = 'knowly-path-cache';
function rememberKnowlyPath(filename, p) {
  try {
    const m = JSON.parse(localStorage.getItem(KNOWLY_PATH_KEY) || '{}');
    m[filename] = p;
    const keys = Object.keys(m);
    if (keys.length > 200) delete m[keys[0]];      // 只留最近 200 条
    localStorage.setItem(KNOWLY_PATH_KEY, JSON.stringify(m));
  } catch (_) {}
}
function recallKnowlyPath(filename) {
  try { return (JSON.parse(localStorage.getItem(KNOWLY_PATH_KEY) || '{}'))[filename] || ''; } catch (_) { return ''; }
}

async function findViaKnowlySearch(filename, token) {
  if (!token) return null;
  // Knowly 是全文检索：直接拿带时间戳前缀的文件名去搜，命中的往往是"正文里提到它"的别的文档
  // （实测：搜 195435_xxx 返回的是 205341_Knowly.md）。所以去掉前缀再搜一次，并放宽匹配规则。
  // 查询词要"去前缀 + 去扩展名"：实测带 .md 搜只有 1 条（命中的还是提到它的别的文档），
  // 去掉扩展名搜「监控体系开发文档」才返回目标文件本身。所以三种形态都试一遍，去重后按序。
  // 先查缓存：命中就直接取原文，跳过搜索
  const cached = recallKnowlyPath(filename);
  if (cached) {
    try {
      const r = await fetch(KNOWLY_SEARCH_HOST + '/api/v1/entry?path=' + encodeURIComponent(cached),
        { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j.content === 'string') return { path: cached, text: j.content };
      }
    } catch (_) { /* 缓存失效就走搜索 */ }
  }
  const bare = String(filename).replace(/^\d{6}_/, '');
  const title = bare.replace(/\.[^.]+$/, '');
  // 顺序按命中率排：标题 > 去前缀名 > 原始文件名（越靠前越省时间）
  const queries = [title, bare, filename].filter((q, i, a) => q && a.indexOf(q) === i);
  const seen = new Set();
  for (const q of queries) {
    let results = [];
    try {
      const u = KNOWLY_SEARCH_HOST + '/api/v1/search?q=' + encodeURIComponent(q) + '&limit=20';
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) continue;
      const j = await r.json();
      results = (j && j.results) || [];
    } catch (_) { continue; }
    for (const hit of results) {
      const p = String(hit.path || '');
      const base = p.split('/').pop();
      if (seen.has(p)) continue;
      seen.add(p);
      // 三档匹配，从严到宽：完全同名 → 带时间戳前缀的同名 → 以 "_<裸名>" 结尾
      const stripped = base.replace(/^\d{6}_/, '');
      const ok = base === filename || base === bare || stripped === bare || stripped === title;
      if (!ok) continue;
      try {
        const e = await fetch(KNOWLY_SEARCH_HOST + '/api/v1/entry?path=' + encodeURIComponent(p),
          { headers: { Authorization: 'Bearer ' + token } });
        if (!e.ok) continue;
        const ej = await e.json();
        if (ej && typeof ej.content === 'string') {
          rememberKnowlyPath(filename, p);   // 下次同名文件直接取，省掉搜索
          return { path: p, text: ej.content };
        }
      } catch (_) {}
    }
  }
  return null;
}

// 在 NAS 归档里按文件名找：archive/YYYY/MM/DD/<文件名>，从今天往前找 days 天。
// 只发 HEAD 太重（服务端不支持），直接 GET 小文件；未命中的日期会快速返回 503。
async function findInNasArchive(filename, authHeader, days) {
  const n = days || 14;
  const now = new Date();
  for (let d = 0; d < n; d++) {
    const t = new Date(now.getTime() - d * 86400000);
    const rel = t.getFullYear() + '/' +
      String(t.getMonth() + 1).padStart(2, '0') + '/' +
      String(t.getDate()).padStart(2, '0') + '/' + filename;
    const u = NAS_ARCHIVE_HOST + '/api/archive/download?path=' + encodeURIComponent(rel);
    try {
      const r = await fetch(u, { headers: { 'Authorization': authHeader } });
      if (r.ok) return { path: rel, text: await r.text() };
    } catch (_) { /* 单日失败继续找 */ }
  }
  return null;
}

// 解析并打开（供菜单与粘贴共用）：下载后作为独立草稿载入编辑器
async function nasOpen(input) {
  const filename = extractNasFilename(input);
  if (!filename) { flash('无法解析 NAS 文件名'); return; }
  const text = await downloadFromNas(input);
  if (text == null) return;
  // === 改进 C：下载前本地改动保护 ===
  // 若编辑器内已有非空、且与远程不同的内容，直接覆盖会丢失本地改动。
  const local = editor.value || '';
  if (local.trim() !== '' && local.trim() !== String(text).trim()) {
    const ok = await askConfirm('下载并覆盖本地？',
      '本地编辑器已有未保存的改动，直接下载「' + filename + '」会丢失这些改动！\n' +
      '点击「确定」：先把本地当前内容备份到本机草稿（localStorage），再下载远程版本。\n' +
      '点击「取消」：放弃下载，保留本地内容。'
    );
    if (!ok) { flash('已取消下载，保留本地内容'); return; }
    try {
      const bak = { name: currentName || '未命名草稿', content: local, ts: Date.now() };
      localStorage.setItem('md-nas-backup-' + bak.ts, JSON.stringify(bak));
      localStorage.setItem('md-nas-backup-latest', JSON.stringify(bak));
    } catch (_) {}
    toast('📌 本地内容已备份到本机草稿（localStorage 的 md-nas-backup-latest），可随时找回', 'info', 6000);
  }
  currentLibId = null;                 // 脱离文库上下文，作为独立草稿
  currentName = filename;
  currentNameIsAuto = false;
  editor.value = text;
  updateFileName();
  afterChange();
  flash('已从 NAS 打开：' + filename);
  // 注意：下载内容仅载入编辑器（并备份到 localStorage 草稿），
  // 不会自动进文库、也不写磁盘。需手动「存到文库」或「导出文件」才能真正留存。
  toast('📥 已从 NAS 载入编辑器：' + filename + '（未存入文库，请手动保存）', 'info', 4200);
}

// 菜单：从 NAS 下载某一篇文档并用编辑器打开
async function nasDownloadAndOpen() {
  const input = await askInput('从 NAS 打开', { desc: '输入文件名（如 180032_xxx.md）或 ' + NAS_ARCHIVE_DOMAIN + ' 归档链接' });
  if (!input) return;
  await nasOpen(input);
}

// === SECTION: 文库静默增量同步（本地→NAS，单向） ===
// 文库每篇改动后，自动把「updatedAt 晚于上次同步时间」的文档推到 NAS。
// 文件名用文库 id（{id}.md）：稳定唯一、可增量匹配、绝不重名覆盖。
// 单向：NAS 永不主动推回编辑器；用户需要时手动「从 NAS 下载」即可。
const NAS_SYNC_STATE_KEY = 'nas-sync-state';
const SYNC_DEBOUNCE_MS = 4000;

function loadSyncState() {
  try { return JSON.parse(localStorage.getItem(NAS_SYNC_STATE_KEY) || '{}'); } catch (_) { return {}; }
}
function saveSyncState(state) {
  try { localStorage.setItem(NAS_SYNC_STATE_KEY, JSON.stringify(state)); } catch (_) {}
}
function setSyncDot(state, title) {
  const dot = document.getElementById('syncDot');
  if (dot) { dot.dataset.state = state; dot.title = 'NAS 同步：' + title; }
}

const syncLibraryToNasDebounced = debounce(syncLibraryToNas, SYNC_DEBOUNCE_MS);

// 增量同步文库到 NAS：只传 updatedAt 晚于上次同步时间的文档
async function syncLibraryToNas() {
  if (!navigator.onLine) { setSyncDot('idle', '离线，待联网后补传'); return; }
  const auth = localStorage.getItem('nas-auth');
  if (!auth) { setSyncDot('idle', '未配置 NAS 凭据，跳过自动同步'); return; }
  let authHeader = '';
  try { authHeader = 'Basic ' + btoa(auth); } catch (_) { return; }

  let docs = [];
  try {
    if (!libDb) await openLibDb();        // 确保连接已建立（修复启动/空闲回收后 libDb 为 null 直接抛错）
    docs = await idbGetAll();
  } catch (_) {
    // 连接可能已被浏览器关闭（后台回收 / 多标签页 versionchange），重置后重试一次
    try {
      libDb = null;
      await openLibDb();
      docs = await idbGetAll();
    } catch (_) {
      setSyncDot('error', '读取文库失败');
      return;
    }
  }
  const state = loadSyncState();
  const pending = docs.filter((d) => (d.updatedAt || 0) > (state[d.id] || 0));
  if (!pending.length) { setSyncDot('ok', '已是最新'); return; }

  setSyncDot('syncing', '正在同步 ' + pending.length + ' 篇到 NAS…');
  let ok = 0, fail = 0;
  for (const doc of pending) {
    try {
      const blob = new Blob([doc.content || ''], { type: 'text/markdown' });
      if (blob.size > NAS_MAX_BYTES) { state[doc.id] = doc.updatedAt; ok++; continue; } // 超大跳过但标记已同步，避免反复尝试
      const fd = new FormData();
      fd.append('file', blob, doc.id + '.md');
      const resp = await fetch(NAS_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': authHeader },
        body: fd
      });
      if (!resp.ok) { fail++; continue; }
      state[doc.id] = doc.updatedAt;
      ok++;
    } catch (_) { fail++; }
  }
  saveSyncState(state);
  if (fail === 0) setSyncDot('ok', '已同步 ' + ok + ' 篇到 NAS（' + new Date().toLocaleTimeString() + '）');
  else setSyncDot('error', ok + ' 篇成功，' + fail + ' 篇失败（下次补传）');
}

/* 粘贴 knowly.want.biz 归档链接时自动从 NAS 下载并打开（仅整串为一个该域名链接、且非其它输入框时触发） */
document.addEventListener('paste', (e) => {
  const dt = e.clipboardData || window.clipboardData;
  if (!dt) return;
  const text = (dt.getData('text') || '').trim();
  if (!text) return;
  if (!new RegExp('^https?://' + NAS_ARCHIVE_DOMAIN.replace(/\./g, '\\.') + '/\\S+$', 'i').test(text)) return;
  if (e.target && e.target !== editor && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  nasOpen(text);
});

const moreMenu = $('#moreMenu');
const menuWrap = $('.menu-wrap');
const btnMore = $('#btnMore');
// 收起所有二级菜单
function closeAllSubmenus() {
  document.querySelectorAll('.menu.sub').forEach((s) => { s.hidden = true; s.classList.remove('open'); });
  document.querySelectorAll('[data-sub]').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-expanded', 'false'); });
}
// 展开 / 收起某个二级菜单（同组互斥，再点一次收起）
function toggleSubmenu(name) {
  const sub = document.getElementById('sub-' + name);
  if (!sub) return;
  const isOpen = sub.classList.contains('open');
  closeAllSubmenus();
  if (!isOpen) {
    sub.hidden = false;
    sub.classList.add('open');
    const trig = document.querySelector('[data-sub="' + name + '"]');
    if (trig) { trig.classList.add('active'); trig.setAttribute('aria-expanded', 'true'); }
  }
}
// Esc 关闭「⋯」菜单与快捷菜单：原来只有点外面才关，键盘用户按 Esc 没反应。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (palette && !palette.hidden) return;          // 命令面板自己处理
  if (moreMenu && !moreMenu.hidden) { openMoreMenu(false); }
  // 快捷菜单的变量作用域在下面那个 IIFE 里，这里直接按 id 取，避免 ReferenceError
  const qm = document.getElementById('quickMenu');
  if (qm && !qm.hasAttribute('hidden')) closeQuickMenu();
}, true);

// === 常用功能：按点击频率取前 5 项 ===
// 数据只存在本机 localStorage（不上传、不入库）：这是使用习惯，不是文档内容。
// 只统计「真正执行了的菜单项」——二级菜单触发器、命令面板入口不计入，否则会把"打开子菜单"当成常用。
const FREQ_KEY = 'md-act-freq';
const FREQ_TOP = 5;
// 初始默认（还没积累使用数据时先摆这五项）：存到 NAS / 从 NAS 取回 / 添加到文库 / 主题设置 / 导出纯文本。
// 种子计数为 1，用户真用过的项一旦达到 2 次就会顶掉它们——默认值是起点，不是特权。
// sub: 前缀表示「二级菜单触发器」（点开子菜单），这类不参与计数，只作为初始占位。
const FREQ_DEFAULTS = ['act:nas-upload', 'act:nas-download', 'act:addtolib', 'sub:theme', 'act:txt'];

function loadFreq() {
  try {
    const raw = localStorage.getItem(FREQ_KEY);
    if (!raw) {
      // 首次运行：写入默认五项（计数 1），之后完全由真实使用决定排序
      const seed = {};
      FREQ_DEFAULTS.forEach((k) => { seed[k] = 1; });
      saveFreq(seed);
      return seed;
    }
    const map = JSON.parse(raw);
    return (map && typeof map === 'object') ? map : {};
  } catch (_) { return {}; }
}
function saveFreq(map) {
  try { localStorage.setItem(FREQ_KEY, JSON.stringify(map)); } catch (_) {}
}
function bumpFreq(key) {
  if (!key) return;
  const map = loadFreq();
  map[key] = (map[key] || 0) + 1;
  // 只留前 50 个键，避免 localStorage 无限膨胀（菜单项总数也远小于这个量级）
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 50);
  saveFreq(Object.fromEntries(entries));
}
// 按 data-act / data-action 找原始菜单项（克隆它，样式与行为天然一致）
function findMenuButton(key) {
  const [kind, name] = key.split(':');
  const attr = kind === 'act' ? 'data-act' : kind === 'sub' ? 'data-sub' : 'data-action';
  const all = menuWrap.querySelectorAll('[' + attr + ']');
  for (const el of all) {
    if (el.getAttribute(attr) === name && !el.closest('#freqSection')) return el;
  }
  return null;
}
// 统一在一个 capture 监听里统计：菜单、左上角快捷菜单、命令面板（内部走 el.click()）三条路径
// 最终都会冒泡到这里，只记一次；不用在每个入口各写一遍（那样迟早漏掉一条路径）。
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[data-act], [data-action]') : null;
  if (!el) return;
  if (el.dataset.act === 'commandPalette') return;
  if (el.dataset.act) bumpFreq('act:' + el.dataset.act);
  else if (el.dataset.action) bumpFreq('action:' + el.dataset.action);
}, true);

function renderFreqMenu() {
  const section = document.getElementById('freqSection');
  const list = document.getElementById('freqList');
  if (!section || !list) return;
  const top = rankFreq(loadFreq(), FREQ_TOP, ['act:commandPalette'], FREQ_DEFAULTS);
  list.innerHTML = '';
  let shown = 0;
  for (const key of top) {
    const src = findMenuButton(key);
    if (!src) continue;                       // 菜单项被删了 → 静默跳过
    const clone = src.cloneNode(true);
    clone.classList.add('mi-freq');
    // 子菜单触发器：保留箭头（点开确实还有一层），其余项去掉多余的 ▸
    if (key.indexOf('sub:') !== 0) {
      clone.querySelectorAll('.mi-label').forEach((n) => { n.textContent = n.textContent.replace('▸', '').trim(); });
    }
    clone.querySelectorAll('.kbd').forEach((n) => n.remove());
    const combo = ACTION_HINTS[key.split(':')[1]];
    if (combo) {
      const kbd = document.createElement('span');
      kbd.className = 'kbd';
      kbd.textContent = formatCombo(combo);
      clone.appendChild(kbd);
    }
    list.appendChild(clone);
    shown++;
  }
  section.hidden = shown === 0;
}

function openMoreMenu(open) {
  closeAllSubmenus();
  if (open) { renderFreqMenu(); moreMenu.removeAttribute('hidden'); btnMore.setAttribute('aria-expanded', 'true'); updateAiModelBadge(); }
  else { moreMenu.setAttribute('hidden', ''); btnMore.setAttribute('aria-expanded', 'false'); }
}
btnMore.addEventListener('click', () => openMoreMenu(moreMenu.hasAttribute('hidden')));
document.addEventListener('click', (e) => {
  if (menuWrap.contains(e.target) || btnMore.contains(e.target)) return;
  if (!moreMenu.hasAttribute('hidden')) openMoreMenu(false);
  else closeAllSubmenus();
  // 关闭左上角 logo 快捷菜单（点 logo 自身由 logo 的点击处理器切换，不在此处理）
  const qm = document.getElementById('quickMenu');
  const be = document.getElementById('brandEl');
  if (qm && be && !qm.hasAttribute('hidden') && !be.contains(e.target)) closeQuickMenu();
});
menuWrap.addEventListener('click', (e) => {
  // 二级菜单触发器：只展开/收起，不关闭主菜单
  const subTrigger = e.target.closest('[data-sub]');
  if (subTrigger) { toggleSubmenu(subTrigger.dataset.sub); return; }
  const btn = e.target.closest('[data-act], [data-action]');
  if (!btn) return;
  const macro = btn.dataset.action;
  if (macro) {
    openMoreMenu(false);
    const fn = TEXT_ACTIONS[macro] || AI_ACTIONS[macro] || (FORMAT_ACTIONS && FORMAT_ACTIONS[macro]);
    if (fn) fn();
    return;
  }
  const act = btn.dataset.act;
  if (!act) return;
  openMoreMenu(false);
  handleDataAct(act, btn);
});

// 右上角「⋯」菜单与左上角 logo 快捷菜单共用的 data-act 分发
function handleDataAct(act, btn) {
  if (act === 'rename') renameFile();
  else if (act === 'addtolib') addToLibrary();
  else if (act === 'publish-blog') publishToBlog();
  else if (act === 'save-ima') saveToIma();
  else if (act === 'publish-podcast') publishToPodcast();
  else if (act === 'match-podcast') matchPodcastManual();
  else if (act === 'nas-upload') uploadToNas();
  else if (act === 'nas-download') nasDownloadAndOpen();
  else if (act === 'fetch-url') openRemoteDoc();
  else if (act === 'copytext') copyText();
  else if (act === 'copymd') copyMarkdown();
  else if (act === 'copy') copyHTML();
  else if (act === 'md') exportMarkdown();
  else if (act === 'txt') exportTxt();
  else if (act === 'html') exportHTML();
  else if (act === 'pdf') exportPDF();
  else if (act === 'wrap') { wrapMode = !wrapMode; localStorage.setItem('md-wrap', wrapMode ? 'on' : 'off'); applyWrap(); }
  else if (act === 'theme') applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3]);
  else if (act === 'mdtheme') applyMdTheme(btn.dataset.val);
  else if (act === 'textStyle') openTextStyleDialog();
  else if (act === 'vim') toggleVimMode();
  else if (act === 'share-r2') shareViaR2();
  else if (act === 'layout-swap') toggleLayoutSwap();
  else if (act === 'layout-reset') resetLayout();
  else if (act === 'bg') openBgDialog();
  else if (act === 'capsule') capOpen();
  else if (act === 'fb-customize') openFbCustomize();
  else if (act === 'backup-export') exportBackup();
  else if (act === 'backup-import') importBackup();
  else if (act === 'diagnostics') showDiagnostics();
  else if (act === 'commandPalette') openPalette();
  else if (act === 'hardReset') hardResetApp(true);
}

// === SECTION: 发布到博客（POST /api/publish，逻辑提取自 Taio Action，改用浏览器 fetch） ===
// 博客后端地址：如需自托管，仅改这一行即可（与 R2_WORKER_URL 同属「唯一后端耦合点」约定）。
const BLOG_PUBLISH_URL = 'https://api.yuangs.cc/api/publish';
const BLOG_TARGETS = ['blog'];
// BLOG_TITLE_MAX_LEN 由 lib/md-core.js 提供（顶部解构），与 blogSmartCut 同源。

// 默认标签：年月（如 202607）
function defaultBlogTags() {
  const d = new Date();
  return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
}

// blogSmartCut / parseBlogMeta / blogMdToPlain 已下沉到 lib/md-core.js（含单测）。

async function blogPostJSON(url, json, extraHeaders, timeoutMs) {
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const t = timeoutMs || 20000;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), t) : null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
      body: JSON.stringify(json),
      signal: ctrl ? ctrl.signal : undefined
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok) {
      const msg = (data && (data.message || data.error)) ? (data.message || data.error) : JSON.stringify(data);
      throw new Error('HTTP ' + resp.status + '：' + msg);
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（' + (t / 1000) + 's），请稍后重试');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function showBlogResult(url) {
  const modal = $('#blogPublishModal');
  const ta = $('#blogUrlText');
  if (ta) ta.value = url || '';
  if (modal) modal.removeAttribute('hidden');
  if (url && navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
  toast('✅ 博客发布成功', 'ok');
}

async function publishToBlog() {
  if (blockInRemoteMode('发布到博客')) return;
  const md = (editor.value || '').trim();
  if (!md) { flash('没有内容：请先写点东西再发布'); return; }
  flash('正在发布到博客…');
  try {
    const { title, tags, body } = parseBlogMeta(md);
    const payload = {
      title,
      content: blogMdToPlain(body),
      content_md: body,
      tags: (Array.isArray(tags) && tags.length) ? tags.join(',') : defaultBlogTags(),
      targets: BLOG_TARGETS
    };
    const result = await blogPostJSON(BLOG_PUBLISH_URL, payload);
    const blog = result && result.blog;
    if (blog && blog.status === 'success') {
      showBlogResult(blog.redirect_url || '');
      flash('已发布到博客');
    } else {
      const msg = blog ? (blog.message || JSON.stringify(blog)) : JSON.stringify(result);
      toast('❌ 发布失败：' + msg, 'err', 5000);
      flash('发布失败');
    }
  } catch (err) {
    toast('❌ 发布失败：' + (err.message || err), 'err', 5000);
    flash('发布失败');
  }
}

// === SECTION: 保存到 IMA 笔记（POST 到自托管 ima 代理，密钥只存服务端，浏览器无 CORS 问题） ===
// 背景：腾讯 ima 的 OpenAPI（/openapi/note/v1/import_doc）要求携带
//   ima-openapi-clientid / ima-openapi-apikey 两个自定义请求头，
//   但这两个头不在 ima.qq.com 的 CORS Access-Control-Allow-Headers 白名单里，
//   浏览器直连会被 CORS 拦截。因此统一走「浏览器 → 自托管代理 → ima.qq.com」，
//   与「发布到博客」共用同一前端形态，密钥保存在服务端 env / Worker secret。
// 代理只需把前端 POST 来的 { title, content, content_format } 转发给
//   https://ima.qq.com/openapi/note/v1/import_doc 并注入 ima 凭证头即可。
// 前端仅写死一个端点（IMA_PROXY_URL），与 BLOG_PUBLISH_URL / R2_WORKER_URL 同属「唯一后端耦合点」约定。
// 若代理部署到别处，改这一行即可；密钥只保存在服务端，浏览器不存也不配置。
const IMA_PROXY_URL = 'https://api.yuangs.cc/api/ima/import';
function showImaResultModal(docId, url, title) {
  const modal = $('#imaResultModal');
  const ta = $('#imaUrlText');
  if (ta) ta.value = url || '';
  const tt = $('#imaResultTitle');
  if (tt) tt.value = title || '';
  if (modal) modal.removeAttribute('hidden');
  if (url && navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
  toast('✅ 已保存到 IMA 笔记', 'ok');
}
async function saveToIma() {
  if (blockInRemoteMode('保存到 IMA')) return;
  const md = (editor.value || '').trim();
  if (!md) { flash('没有内容：请先写点东西再保存'); return; }
  const { title, tags, body } = parseBlogMeta(md);
  flash('正在保存到 IMA 笔记…');
  try {
    const result = await blogPostJSON(IMA_PROXY_URL, {
      title,
      content: body,
      content_format: 1,
      tags: (Array.isArray(tags) && tags.length) ? tags.join(',') : defaultBlogTags()
    });
    const docId = result && (result.doc_id || result.docId || (result.data && result.data.doc_id));
    if (docId) {
      const url = result.url || ('https://ima.qq.com/note/' + docId);
      showImaResultModal(docId, url, title);
      flash('已保存到 IMA 笔记');
    } else {
      const msg = (result && (result.message || result.error || result.msg))
        ? (result.message || result.error || result.msg)
        : JSON.stringify(result);
      toast('❌ 保存失败：' + msg, 'err', 5000);
      flash('保存失败');
    }
  } catch (err) {
    toast('❌ 保存失败：' + (err.message || err), 'err', 5000);
    flash('保存失败');
  }
}
const imaResultModalEl = $('#imaResultModal');
if (imaResultModalEl) {
  const url = $('#imaUrlText');
  const cp = $('#imaCopyBtn');
  if (cp) cp.addEventListener('click', () => { if (url && url.value) navigator.clipboard.writeText(url.value).then(() => toast('已复制 IMA 链接', 'ok'), () => toast('复制失败', 'err')); });
  const op = $('#imaOpenBtn');
  if (op) op.addEventListener('click', () => { if (url && url.value) window.open(url.value, '_blank', 'noopener'); });
  const cc = $('#imaCloseBtn');
  if (cc) cc.addEventListener('click', () => { imaResultModalEl.hidden = true; });
  imaResultModalEl.addEventListener('click', (e) => { if (e.target === imaResultModalEl) imaResultModalEl.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !imaResultModalEl.hidden) imaResultModalEl.hidden = true; });
}

// === SECTION: 一键转播客（POST /api/publish，逻辑提取自 Taio 直读脚本，改用浏览器 fetch） ===
// 与「发布到博客」共用同一后端地址（BLOG_PUBLISH_URL）；区别在 targets=['nas'] + transform='read'，
// 把内容送进 NAS 单人朗读队列，而非发布成文章。优先取编辑器选中文本，否则取整篇正文。
async function publishToPodcast() {
  if (blockInRemoteMode('转成播客')) return;
  // 1. 取内容：优先选中文本，否则整篇正文
  let text = '';
  if (editor.selectionStart !== editor.selectionEnd) {
    text = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
  }
  if (!text) text = (editor.value || '').trim();
  if (!text) { flash('没有可转播的内容'); return; }

  // 2. 自动提取第一行作为标题：[Read] <首行>
  const firstLine = text.split('\n')[0].replace(/[#*>-]/g, '').trim();
  const title = ('[Read] ' + firstLine).substring(0, 50);

  flash('正在加入朗读队列…');
  try {
    const payload = {
      title,
      content: text,
      content_md: text,
      targets: ['nas'],
      transform: 'read'
    };
    // 注意：不要带自定义请求头（如 X-App-ID），否则浏览器会发 CORS 预检(OPTIONS)，
    // 若服务端不响应预检请求就会一直挂起、既不成功也不失败。与「发布到博客」保持完全相同的请求形态。
    const result = await blogPostJSON(BLOG_PUBLISH_URL, payload);
    // 成功判定兼容多种响应结构：后端可能返回 {nas:{...}} / {read:{...}} / {status:'success'} 等。
    // 因为 blogPostJSON 在 HTTP 非 2xx 时已抛错，能走到这里说明服务端已接受（2xx），
    // 仅当响应里显式含错误信号时才判为失败。
    const field = (result && (result.nas || result.read)) || {};
    const isErr = !!(result && (result.status === 'error' || result.error || field.status === 'error' || field.success === false));
    if (!isErr) {
      toast('✅ 已加入 NAS 直读队列', 'ok', 4000);
      flash('已加入朗读队列');
    } else {
      const msg = (field && (field.message || field.error)) || (result && (result.message || result.error)) || JSON.stringify(result);
      toast('❌ 转播客失败：' + msg, 'err', 5000);
      flash('转播客失败');
    }
  } catch (err) {
    toast('❌ 转播客失败：' + (err.message || err), 'err', 5000);
    flash('转播客失败');
  }
}

/* 打印时临时切亮色，避免暗色配色的代码在白底 PDF 上看不清 */
let printPrevTheme = null;
window.addEventListener('beforeprint', () => {
  printPrevTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
});
window.addEventListener('afterprint', () => {
  if (printPrevTheme) document.documentElement.setAttribute('data-theme', printPrevTheme);
  printPrevTheme = null;
});

// === SECTION: 拖拽 / 粘贴图片（转 base64 插入光标处） ===
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function insertAtCursor(text) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const next = editor.value.slice(0, s) + text + editor.value.slice(e);
  const pos = s + text.length;
  pushUndo('插入内容');                        // 图片 / 播客 / AI 结果插入也可 Ctrl+Z 撤回
  editor.value = next;
  editor.selectionStart = editor.selectionEnd = pos;
  editor.dispatchEvent(new Event('input'));   // 触发 afterChange（渲染 / 统计 / 草稿）
  editor.focus();
}
// 大图压缩：>2MB 时经 canvas 降采样（长边≤2560px）并转 webp，
// 压缩后仍大于原图（如已高度压缩的图）则原样返回；失败也原样返回（保证可用性）
async function compressImage(file) {
  const MAX_SIDE = 2560;
  const MAX_BYTES = 2 * 1024 * 1024;
  if (!file || file.size <= MAX_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    let w = bitmap.width, h = bitmap.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    if (scale < 1) { w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    let blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.82));
    if (!blob) blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (blob && blob.size < file.size) return blob;
    return file;
  } catch (_) { return file; }
}
async function insertImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 2 * 1024 * 1024) {
    if (!(await askConfirm('压缩后插入', '图片较大（' + Math.round(file.size / 1024) + ' KB），将自动压缩后插入，继续？'))) return;
  }
  const img = await compressImage(file);   // >2MB 自动压缩（降采样 + 转 webp），IDB 与 base64 两条路径体积都受限
  // 文库不可用（无 IndexedDB）→ 回退 base64 内联，保证可用（压缩后体积已受控）
  if (!libDb) {
    const url = await fileToDataURL(img);
    insertAtCursor('\n![' + (file.name || 'image') + '](' + url + ')\n');
    flash('已插入图片');
    return;
  }
  // 正文只存 libimg://<id> 引用，图片 Blob 单独入库，文档体积与同步开销大幅下降
  const id = genId();
  try {
    await idbPutImage({ id, name: file.name || 'image', type: img.type, blob: img });
  } catch (_) {
    flash('图片入库失败');
    return;
  }
  insertAtCursor('\n![' + (file.name || 'image') + '](libimg://' + id + ')\n');
  flash('已插入图片');
}
editor.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); insertImage(f); return; }
    }
  }
});
editor.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
editor.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const img = [...files].find((f) => f.type.startsWith('image/'));
  if (img) { e.preventDefault(); insertImage(img); }
});

// === SECTION: Tab 插入两空格 ===
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    // 表格里 Tab 跳下一格（Shift+Tab 上一格）——写表格时不用手点，这是最高频的表格痛点。
    // 判定很保守：当前行必须是表格行（以 | 开头），且光标在该行内。
    if (jumpTableCell(e.shiftKey)) return;
    const s = editor.selectionStart, en = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
    editor.selectionStart = editor.selectionEnd = s + 2;
    editor.dispatchEvent(new Event('input'));
  }
});

// === 表格单元格跳转（Tab / Shift+Tab） ===
// 返回 true 表示已处理（调用方不要再插入缩进）。
// 规则：只认「整行是表格行」的情形（`|...|` 或含 ≥2 个 | 的行），
// 避免把正文里的竖线误判成表格。跳到下一格即「下一个 | 之后」；行末则跳到下一行第一个单元格；
// 最后一行最后一格 → 新建一行空表格行（保持列数），这样连续录入不用离开键盘。
function jumpTableCell(backward) {
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) return false;
  const src = editor.value;
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = src.indexOf('\n', pos);
  if (lineEnd < 0) lineEnd = src.length;
  const line = src.slice(lineStart, lineEnd);
  if (!/^\s*\|/.test(line) || (line.match(/\|/g) || []).length < 2) return false;

  const col = pos - lineStart;
  const pipes = [];
  for (let i = 0; i < line.length; i++) if (line[i] === '|') pipes.push(i);
  let target = -1;
  if (backward) {
    for (let k = pipes.length - 1; k >= 0; k--) if (pipes[k] < col - 1) { target = pipes[k]; break; }
    if (target < 0) return false;                       // 已在首格
    // 放到该竖线后第一个非空格
    let p = target + 1;
    while (p < line.length && line[p] === ' ') p++;
    editor.selectionStart = editor.selectionEnd = lineStart + p;
  } else {
    for (let k = 0; k < pipes.length; k++) if (pipes[k] > col) { target = pipes[k]; break; }
    if (target < 0) {
      // 行末 → 下一行首格；没有下一行就补一行（列数沿用当前行）
      const nextStart = lineEnd + 1;
      const nextEnd = src.indexOf('\n', nextStart);
      const nextLine = src.slice(nextStart, nextEnd < 0 ? src.length : nextEnd);
      if (/^\s*\|/.test(nextLine)) {
        let p = nextStart;
        while (p < src.length && src[p] !== '|') p++;
        if (p < src.length) {
          p++;
          while (p < src.length && src[p] === ' ') p++;
          editor.selectionStart = editor.selectionEnd = p;
          return true;
        }
      }
      const cols = Math.max(1, pipes.length - 1);
      const blank = '|' + '   |'.repeat(cols);
      editor.value = src.slice(0, lineEnd) + '\n' + blank + src.slice(lineEnd);
      editor.selectionStart = editor.selectionEnd = lineEnd + 3;
      editor.dispatchEvent(new Event('input'));
      return true;
    }
    let p = target + 1;
    while (p < line.length && line[p] === ' ') p++;
    editor.selectionStart = editor.selectionEnd = lineStart + p;
  }
  editor.dispatchEvent(new Event('select'));
  return true;
}

// === SECTION: 全局快捷键（Map 化：组合键归一化为 "mod+alt+shift+key"） ===
// mod = Ctrl(Linux/Win) 或 ⌘(macOS)；alt = Alt / ⌥；shift = Shift / ⇧
// 新增快捷键：在 SHORTCUTS 追加一行 + 在 ACTION_HINTS 登记对应菜单项即可，
const SHORTCUTS = new Map([
  // 文件 / 文档
  ['mod+s', saveFile],
  ['mod+o', openFile],
  ['mod+alt+n', () => { const b = $('#btnNew'); if (b) b.click(); }],
  ['mod+shift+r', renameFile],
  ['f2', renameFile],
  ['mod+shift+l', addToLibrary],
  ['mod+shift+e', exportMarkdown],
  ['mod+alt+p', exportPDF],
  ['mod+shift+m', copyMarkdown],
  ['mod+shift+c', copyHTML],
  ['mod+shift+y', copyText],
  ['mod+shift+w', () => { wrapMode = !wrapMode; localStorage.setItem('md-wrap', wrapMode ? 'on' : 'off'); applyWrap(); }],
  ['mod+shift+t', () => applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3])],
  ['mod+f', () => TEXT_ACTIONS.searchReplace()],
  ['mod+shift+p', () => openPalette()],
  ['mod+alt+v', nextView],
  ['mod+alt+shift+d', showDiagnostics],   // 诊断信息（真机上排查问题用）
  // 格式
  ['mod+b', () => FORMAT_ACTIONS.fmtBold()],
  ['mod+i', () => FORMAT_ACTIONS.fmtItalic()],
  ['mod+e', () => FORMAT_ACTIONS.fmtCode()],
  ['mod+k', () => FORMAT_ACTIONS.fmtLink()],
  ['mod+shift+i', () => FORMAT_ACTIONS.fmtImage()],
  ['mod+shift+q', () => FORMAT_ACTIONS.fmtQuote()],
  ['mod+shift+u', () => FORMAT_ACTIONS.fmtUl()],
  ['mod+shift+o', () => FORMAT_ACTIONS.fmtOl()],
  ['mod+1', () => FORMAT_ACTIONS.fmtH1()],
  ['mod+2', () => FORMAT_ACTIONS.fmtH2()],
  ['mod+3', () => FORMAT_ACTIONS.fmtH3()],
  ['mod+4', () => FORMAT_ACTIONS.fmtH4()],
  ['mod+5', () => FORMAT_ACTIONS.fmtH5()],
  ['mod+6', () => FORMAT_ACTIONS.fmtH6()],
]);
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;   // 输入法组合中不抢键

  // —— 撤销 / 重做 ——
  // 只在「焦点在编辑器或页面本身」且我们有自己的快照时才接管；
  // 否则放行给浏览器原生 undo（普通打字场景仍由浏览器维护）。
  const mod = e.ctrlKey || e.metaKey;
  const inOurEditor = document.activeElement === editor || document.activeElement === document.body;
  if (mod && !e.altKey && inOurEditor) {
    const k0 = (e.key || '').toLowerCase();
    const isUndo = k0 === 'z' && !e.shiftKey;
    const isRedo = (k0 === 'y' && !e.shiftKey) || (k0 === 'z' && e.shiftKey);
    if (isUndo && undoStack.length) { e.preventDefault(); undoStep(); return; }
    if (isRedo && redoStack.length) { e.preventDefault(); redoStep(); return; }
  }

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = (e.key || '').toLowerCase();
  if (['control', 'meta', 'alt', 'shift', 'tab'].includes(k)) return;   // 忽略纯修饰键 / Tab 由编辑器处理
  parts.push(k);
  const handler = SHORTCUTS.get(parts.join('+'));
  if (handler) { e.preventDefault(); handler(); }
});

// === SECTION: 菜单快捷键提示（自动渲染，无需手写每处） ===
/* 菜单项（data-act / data-action）→ 归一化组合键；与 SHORTCUTS 的 key 一致 */
const ACTION_HINTS = {
  rename: 'mod+shift+r', addtolib: 'mod+shift+l',
  copytext: 'mod+shift+y', copymd: 'mod+shift+m', copy: 'mod+shift+c',
  md: 'mod+shift+e', pdf: 'mod+alt+p', wrap: 'mod+shift+w', theme: 'mod+shift+t',
  commandPalette: 'mod+shift+p',
  searchReplace: 'mod+f',
  fmtBold: 'mod+b', fmtItalic: 'mod+i', fmtCode: 'mod+e', fmtLink: 'mod+k',
  fmtImage: 'mod+shift+i',
  fmtQuote: 'mod+shift+q', fmtUl: 'mod+shift+u', fmtOl: 'mod+shift+o',
  fmtH1: 'mod+1', fmtH2: 'mod+2', fmtH3: 'mod+3',
  fmtH4: 'mod+4', fmtH5: 'mod+5', fmtH6: 'mod+6',
};

// === Mac 快捷键提示归一 ===
// 大量 title 里写死了 "Ctrl+O" 这类字样。Mac 上应该是 ⌘O，且 Ctrl 与 Cmd 不是一回事。
// 这里在启动时统一改写一次：只动 title 属性里的 Ctrl，不动正文（正文里提到 Ctrl 的地方是说明文字）。
function normalizeMacShortcutHints() {
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || '') ||
    /mac/i.test(navigator.userAgent || '');
  if (!isMac) return;
  document.querySelectorAll('[title]').forEach((el) => {
    const t = el.getAttribute('title') || '';
    if (!/Ctrl/.test(t)) return;
    el.setAttribute('title', t.replace(/Ctrl\+(?=[A-Za-z])/g, '⌘').replace(/Ctrl/g, '⌘'));
  });
}
normalizeMacShortcutHints();

/* 组合键 → 用户可读标签（区分 macOS / 其它平台） */
function formatCombo(combo) {
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || '') ||
    /mac/i.test(navigator.userAgent || '');
  const map = isMac ? { mod: '⌘', alt: '⌥', shift: '⇧' } : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  return combo.split('+').map((p) => map[p] || (p.length === 1 ? p.toUpperCase() : p)).join(isMac ? '' : '+');
}

/* 在「⋯」菜单（含全部二级子菜单）中渲染快捷键提示 */
function renderShortcutHints() {
  document.querySelectorAll('.menu-wrap [data-act], .menu-wrap [data-action]').forEach((btn) => {
    const key = btn.dataset.act || btn.dataset.action;
    const combo = ACTION_HINTS[key];
    if (!combo || btn.querySelector('.kbd')) return;   // 无快捷键 / 已渲染 → 跳过（幂等）
    const span = document.createElement('span');
    span.className = 'kbd';
    span.textContent = formatCombo(combo);
    btn.appendChild(span);
  });
}

// === 混合缓存的最终兜底：注销 SW + 清空所有 Cache + 带时间戳重载 ===
// 为什么需要它：手机上（尤其 iOS PWA）既没有 Ctrl+Shift+R，也可能被旧 SW 长期接管。
// 光弹提示「请强制刷新」等于让用户自己解决一个他解决不了的问题。
// 只做一次（sessionStorage 标记），避免服务端真出现新旧文件并存时陷入无限重载。
async function hardResetApp(manual) {
  const FLAG = 'md-ver-reset';
  // 手动触发（菜单「强制更新」）总是执行；自动修复每次会话只做一次，避免循环重载
  if (!manual) {
    try { if (sessionStorage.getItem(FLAG) === '1') return; sessionStorage.setItem(FLAG, '1'); } catch (_) {}
  }
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
  try {
    const u = new URL(location.href);
    u.searchParams.set('_r', String(Date.now()));
    location.replace(u.toString());
  } catch (_) { location.reload(); }
}

// === 远端版本自检：解决「手机上一直跑着旧版」 ===
// SW 只在导航时检查更新，PWA 常驻后台时可能几天都不导航一次，用户就一直看到旧版本
// （典型症状：本地已是 v4.16，手机状态栏还写着 v4.14）。
// 这里主动拉一次 index.html（no-store）读 meta 版本，比当前新就弹更新提示条。
let remoteVerCheckedAt = 0;
async function checkRemoteVersion() {
  const now = Date.now();
  if (now - remoteVerCheckedAt < 10 * 60 * 1000) return;   // 10 分钟内不重复查
  remoteVerCheckedAt = now;
  try {
    const resp = await fetch('./index.html', { cache: 'no-store' });
    if (!resp.ok) return;
    const html = await resp.text();
    const m = html.match(/name="app-version" content="([\d.]+)"/);
    if (!m) return;
    if (compareVersion(m[1], APP_VERSION) > 0) {
      console.info('[mdviewer] 发现新版本 ' + m[1] + '（当前 ' + APP_VERSION + '）');
      const banner = document.getElementById('updateBanner');
      if (banner) banner.hidden = false;
    }
  } catch (_) { /* 离线 / 无网：静默，离线本来就是设计目标 */ }
}
setTimeout(checkRemoteVersion, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkRemoteVersion();   // 从后台切回来时顺手查一次
});

// === SECTION: 注册 Service Worker（PWA 离线 / 可安装） ===
/* 部署后新版本提示：检测到新 SW 安装完成（且当前有旧 SW 在控制页面）时，
   弹出非阻塞提示条，用户点击「立即刷新」即应用新版本，无需反复手动硬刷。 */
if ('serviceWorker' in navigator) {
  const updateBanner = document.getElementById('updateBanner');
  // 本次会话已处理过更新（点过「立即刷新」或「✕」），加载后不再反复弹更新条
  const SW_DISMISSED = 'md-sw-dismissed';
  const isDismissed = () => { try { return sessionStorage.getItem(SW_DISMISSED) === '1'; } catch (_) { return false; } };
  const showUpdateBanner = () => { if (isDismissed()) return; if (updateBanner) updateBanner.hidden = false; };
  const hideUpdateBanner = () => { try { sessionStorage.setItem(SW_DISMISSED, '1'); } catch (_) {} if (updateBanner) updateBanner.hidden = true; };

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // 常规更新检查触发的「发现新版本」
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // installed 且存在旧 SW 控制页面 → 说明有可用更新
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // 不清除 SW_DISMISSED：本会话点过「立即刷新 / ✕」就不再因 updatefound 反复弹；
            // sessionStorage 为会话级，关闭标签页后下个会话自然恢复提示能力。
            showUpdateBanner();
          }
        });
      });
      // 若注册时已有等待中的 SW（上次部署遗留），直接提示
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();

      // 后台探测新版本：长期驻留的标签页也能及时发现部署更新并弹出更新条
      // （仅提示，不自动刷新；用户主动点击「立即刷新」才重载）。
      /* 后台探测新版本：只在页面可见时轮询，且用指数退避（60s → 2m → 5m 封顶）。
         旧实现无条件 setInterval 60s，标签页挂一天就是 1000+ 次请求。 */
      let updateDelay = 60000;
      let updateTimer = 0;
      const pullUpdate = () => {
        if (document.visibilityState === 'visible') { try { reg.update().catch(() => {}); } catch (_) {} }
        clearTimeout(updateTimer);
        updateTimer = setTimeout(pullUpdate, updateDelay);
        updateDelay = Math.min(updateDelay * 2, 300000);
      };
      pullUpdate();
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        updateDelay = 60000;          // 回到前台重置退避，尽快发现新版本
        clearTimeout(updateTimer);
        pullUpdate();
      });
    }).catch(() => {});
  });

  // 用户点击「立即刷新」：先标记本次已处理（避免重载后更新条反复弹），
  // 再让等待中的新 SW 立即接管（postMessage SKIP_WAITING，覆盖 iOS 等 claim 不及时场景），
  // 待其真正 activated 后再 reload；1.2s 兜底也刷新（新 SW 已就绪，网络优先保证拿到最新外壳）。
  const doUpdate = () => {
    try { sessionStorage.setItem(SW_DISMISSED, '1'); } catch (_) {}
    const sw = navigator.serviceWorker;
    const reload = () => location.reload();
    if (!sw || !sw.getRegistration) { reload(); return; }
    sw.getRegistration().then((reg) => {
      if (reg && reg.waiting) {
        // 新 SW 处于 waiting：通知其立即激活；监听 controllerchange（新 SW 经 claim 真正接管
        // 页面后触发）再 reload 最稳。切勿监听 reg.waiting.statechange——worker 一旦 activated，
        // reg.waiting 即变为 null，回调里读不到 'activated' 状态，刷新逻辑会失效（旧版 bug）。
        let done = false;
        const go = () => { if (!done) { done = true; reload(); } };
        sw.addEventListener('controllerchange', go);
        try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
        setTimeout(go, 1500);   // 兜底：极少数情况 claim 不及时
      } else {
        reload();   // 无 waiting（已是最新 SW）：直接刷新
      }
    }).catch(reload);
  };
  const rb = document.getElementById('updateReloadBtn');
  const db = document.getElementById('updateDismissBtn');
  if (rb) rb.onclick = doUpdate;
  if (db) db.onclick = hideUpdateBanner;

  // 手动模式：新 SW 经 skipWaiting + clients.claim 接管后，不自动重载本页，
  // 避免自动刷新死循环。用户主动点击「立即刷新」(doUpdate) 才 location.reload()，
  // 由已就绪的新 SW 提供最新 app.js / index.html。
}

// === SECTION: 响应式：窄屏启用软换行（手机可换行），宽屏 wrap=off 保持行号对齐 ===
function applyResponsive() {
  if (isMobileLayout() && viewMode === 'split') setView('preview');   // 旋屏/缩窗进入手机布局时，若仍停在分屏则退回预览（手机不分屏，默认预览）
  renderEditorHighlight();   // 进入/离开移动端时重算覆盖层显隐（换行由用户偏好 applyWrap 控制）
}
window.addEventListener('resize', debounce(applyResponsive, 200));
applyResponsive();

// === SECTION: 文库（本地文档库，IndexedDB 持久化；打开文档后编辑自动回写） ===
let currentLibId = null;   // 当前打开的文库文档 id（非文库文档时为 null）

const LIB_DB = 'md-library';
const LIB_STORE = 'docs';
let libDb = null;

/* 存储分层（DB v3）：
 *   docs      —— 文档元信息 + 正文（**不再携带 history**，列表读取不再被历史快照拖慢）
 *   images    —— 图片 Blob（正文只存 libimg://<id>）
 *   history   —— 版本快照，独立仓库 + byDoc 索引（原先内嵌在 doc.history 里，
 *                每次回写都要连 20 条快照一起读写，单次最大可达数 MB）
 *   positions —— 阅读位置（几十字节的小记录，不再为存一个浮点数重写整篇文档）
 *   drafts    —— 大文档草稿（>1MB 时替代 localStorage，避免 5MB 配额与同步写卡顿）
 * 兼容策略：升级只「新建仓库」，不破坏性迁移旧数据；旧的 doc.history 由 readHistory()
 * 兜底读取，并在下次回写时自然淡出（写库时 strip 掉 history 字段）。
 */
const DB_VERSION = 3;

function openLibDb() {
  return new Promise((resolve, reject) => {
    if (libDb) return resolve(libDb);
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
    const req = indexedDB.open(LIB_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });   // 图片 Blob 单独入库，正文只存 libimg://<id>
      }
      if (!db.objectStoreNames.contains('history')) {
        const hs = db.createObjectStore('history', { keyPath: 'hid' });
        hs.createIndex('byDoc', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains('positions')) {
        db.createObjectStore('positions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      libDb = req.result;
      // 浏览器可能因后台回收、存储压力等关闭空闲连接，重置 libDb 以便下次 openLibDb() 重连
      libDb.onclose = () => { libDb = null; };
      libDb.onversionchange = () => {
        toast('检测到文库数据被其他标签页更新，正在重新连接…', 'info', 3000);
        libDb.close();
        libDb = null;
        setTimeout(() => { openLibDb().catch(() => { libDb = null; }); }, 500);   // 避开对方升级事务窗口再重连
      };
      resolve(libDb);
    };
    req.onerror = () => reject(req.error);
  });
}
function libStore(mode) { return libDb.transaction(LIB_STORE, mode).objectStore(LIB_STORE); }
function idbReq(fn) {
  return new Promise((res, rej) => {
    const r = fn();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const idbGetAll = () => idbReq(() => libStore('readonly').getAll());
const idbGet = (id) => idbReq(() => libStore('readonly').get(id));
const idbPut = (doc) => idbReq(() => libStore('readwrite').put(doc));
const idbDelete = (id) => idbReq(() => libStore('readwrite').delete(id));

/* 图片 Blob 库（独立于 docs，避免大体积拖慢文档读写） */
const IMG_STORE = 'images';
const BG_ID = '__bg__';   // 背景图 Blob 在 images 仓库的专用 key（受 GC 保护，不随孤儿图清理）
function imgStore(mode) { return libDb.transaction(IMG_STORE, mode).objectStore(IMG_STORE); }
const idbGetImage = (id) => idbReq(() => imgStore('readonly').get(id));
const idbPutImage = (rec) => idbReq(() => imgStore('readwrite').put(rec));
const idbGetAllImageKeys = () => idbReq(() => imgStore('readonly').getAllKeys());
const idbDeleteImage = (id) => idbReq(() => imgStore('readwrite').delete(id));

/* ---- 版本历史仓库（独立，避免每次回写带着 20 条快照全量读写） ---- */
const HISTORY_STORE = 'history';
function historyStore(mode) { return libDb.transaction(HISTORY_STORE, mode).objectStore(HISTORY_STORE); }
const idbAddHistory = (rec) => idbReq(() => historyStore('readwrite').put(rec));
const idbDeleteHistory = (hid) => idbReq(() => historyStore('readwrite').delete(hid));

// 读取某文档的全部快照（按时间升序）。兼容旧数据：history 仓库为空时回退读 doc.history。
async function readHistory(docId) {
  if (!libDb) return [];
  let list = [];
  try {
    const idx = historyStore('readonly').index('byDoc');
    list = await idbReq(() => idx.getAll(IDBKeyRange.only(docId)));
  } catch (_) { list = []; }
  if (list.length) return list.sort((a, b) => a.at - b.at);
  try {
    const doc = await idbGet(docId);            // 旧版本数据兜底
    if (doc && Array.isArray(doc.history) && doc.history.length) {
      return doc.history.map((h, i) => ({ ...h, hid: docId + '@legacy-' + i, docId }));
    }
  } catch (_) {}
  return [];
}

// 同一个 hid 覆盖写；保留最近 HISTORY_KEEP 条
const HISTORY_KEEP = 20;
async function trimHistory(docId) {
  try {
    const list = await readHistory(docId);
    const own = list.filter((h) => h.hid && h.hid.indexOf('@legacy-') < 0);
    const extra = own.length - HISTORY_KEEP;
    for (let i = 0; i < extra; i++) await idbDeleteHistory(own[i].hid);
  } catch (_) {}
}

/* ---- 阅读位置仓库（小记录，独立读写） ---- */
const POS_STORE = 'positions';
function posStore(mode) { return libDb.transaction(POS_STORE, mode).objectStore(POS_STORE); }
const idbPutPosition = (rec) => idbReq(() => posStore('readwrite').put(rec));
const idbGetPosition = (id) => idbReq(() => posStore('readonly').get(id));

/* ---- 大文档草稿仓库 ---- */
const DRAFT_STORE = 'drafts';
function draftStore(mode) { return libDb.transaction(DRAFT_STORE, mode).objectStore(DRAFT_STORE); }
const idbPutDraft = (rec) => idbReq(() => draftStore('readwrite').put(rec));
const idbGetDraft = (id) => idbReq(() => draftStore('readonly').get(id));

// === SECTION: 孤儿图片 GC（Orphan Images Garbage Collection） ===
// 痛点：粘贴/拖拽图片时 Blob 永久写入 images 仓库；若正文删掉 ![..](libimg://id)
// 或整篇文档被删，该 Blob 不会自动释放，成了孤儿图片占用本地空间。
// 机制：扫描全部文库文档正文 + 当前编辑器内容，提取所有被引用的 libimg://id 组成 Set；
// 再遍历 images 仓库，删除不在 Set 中的无主 Blob。
// 触发：① 启动 10s 后静默运行（文库闲置）；② 文库抽屉「🧹 清理图片」手动触发。
let _gcRunning = false;
async function gcOrphanImages({ silent = false } = {}) {
  if (_gcRunning) return -1;            // 已有 GC 在进行，跳过
  _gcRunning = true;
  try {
    await openLibDb();
    if (!libDb) return 0;              // IndexedDB 不可用，无操作
    // 1. 收集所有被引用的图片 id（含尚未写入文库的当前编辑器内容，避免误删刚粘贴的图片）
    const referenced = new Set();
    const addRefs = (text) => {
      if (!text) return;
      const re = /libimg:\/\/([a-z0-9]+)/gi;
      let m;
      while ((m = re.exec(text)) !== null) referenced.add(m[1]);
    };
    addRefs(editor && editor.value);
    try {
      const docs = await idbGetAll();
      docs.forEach((d) => addRefs(d && (d.content || '')));
    } catch (_) { /* 扫描文档失败不阻断，至少保护当前编辑器引用 */ }
    // 2. 遍历 images 仓库，安全删除无主 Blob（逐条 try，单条失败不影响其余）
    let keys = [];
    try { keys = await idbGetAllImageKeys(); } catch (_) { return 0; }
    let removed = 0;
    for (const id of keys) {
      if (id === BG_ID) continue;            // 背景图是常驻设置，不被当作孤儿图清理
      if (!referenced.has(id)) {
        try { await idbDeleteImage(id); removed++; } catch (_) {}
      }
    }
    if (!silent) {
      flash(removed > 0 ? ('🧹 已清理 ' + removed + ' 张未引用的图片') : '🧹 没有需要清理的孤儿图片');
    } else if (removed > 0) {
      // 孤儿图片清理是静默后台任务，不输出噪音日志
    }
    return removed;
  } catch (_) {
    return 0;
  } finally {
    _gcRunning = false;
  }
}

// === SECTION: 全应用背景图（用户上传，本地 IndexedDB 存储，不上传服务器） ===
// 作用范围：整个窗口，编辑区与预览区文字都浮在图上（两处各加主题色遮罩保证清晰）。
// 存储：本地图片 Blob 写入 images 仓库（key=BG_ID），远程链接只存 URL 字符串；
// CSS 变量 --bg-image/--bg-scrim/--bg-fit 控制呈现；
// 遮罩浓度 / 填充方式 / 远程链接等轻量设置存 localStorage['app-bg-settings']。
// 两种来源互斥：后设置的生效（设置远程链接会清掉本地 Blob，反之清掉 url 字段）。
let appBgSrc = null;        // 当前背景图来源：object URL（本地图片）或 http(s) 远程链接
let appBgObjectUrl = null;  // 仅本地图片时为非空（即 object URL），用于 revoke 避免内存泄漏

function readBgSettings() {
  try { return JSON.parse(localStorage.getItem('app-bg-settings') || '{}'); } catch (_) { return {}; }
}
function saveBgSettings(s) { localStorage.setItem('app-bg-settings', JSON.stringify(s)); }

// 统一入口：切换当前背景来源并同步弹窗预览。objectUrl 省略/null 表示来源是远程链接。
function setBgSrc(src, objectUrl) {
  if (appBgObjectUrl && appBgObjectUrl !== objectUrl) URL.revokeObjectURL(appBgObjectUrl);
  appBgObjectUrl = objectUrl || null;
  appBgSrc = src;
  applyAppBg(src, readBgSettings());
  updateBgPreview();
}

function updateBgPreview() {
  const preview = document.getElementById('bgPreview');
  if (!preview) return;
  if (appBgSrc) { preview.style.backgroundImage = 'url("' + appBgSrc + '")'; preview.classList.add('has-img'); }
  else { preview.classList.remove('has-img'); preview.style.backgroundImage = ''; }
}

function applyAppBg(url, settings) {
  const el = document.getElementById('appBg');
  const scrim = (settings && settings.scrim != null) ? settings.scrim : 0.7;
  const fit = (settings && settings.fit) || 'cover';
  el.style.setProperty('--bg-image', 'url("' + url + '")');
  el.style.setProperty('--bg-scrim', scrim);
  el.style.setProperty('--bg-fit', fit);
  el.classList.add('active');
  document.body.classList.add('has-app-bg');
}

async function loadAppBg() {
  const s = readBgSettings();
  // 远程链接优先：url 存在即用它（与本地 Blob 互斥，后设置的生效）
  if (s && s.url) { setBgSrc(s.url, null); return; }
  try {
    await openLibDb();
    if (!libDb) return;
    const rec = await idbGetImage(BG_ID);
    if (!rec || !rec.blob) return;
    const ou = URL.createObjectURL(rec.blob);
    setBgSrc(ou, ou);   // 本地 Blob：src 与 object URL 同源，登记以便后续 revoke
  } catch (e) { console.error('[bg] loadAppBg 失败', (e && e.message) || String(e)); }
}

async function uploadBgFile(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) { flash('请选择图片文件'); return; }
  try {
    await openLibDb();
    if (!libDb) { flash('本地存储不可用'); return; }
    await idbPutImage({ id: BG_ID, blob: file, name: file.name, ts: Date.now() });
    const s = readBgSettings(); delete s.url; saveBgSettings(s);   // 与远程链接互斥
    const ou = URL.createObjectURL(file);
    setBgSrc(ou, ou);
    const urlEl = document.getElementById('bgUrl'); if (urlEl) urlEl.value = '';
    updateBgPreview();
    const hint = document.getElementById('bgHint');
    if (hint) hint.textContent = '已应用：' + file.name + '（' + Math.round(file.size / 1024) + ' KB）';
    flash('背景图片已应用');
  } catch (e) {
    console.error('[bg] 保存失败', e);
    flash('背景图片保存失败');
  }
}

// 远程链接：仅做基本校验（http/https），不预加载——加载失败由 CSS 静默降级为纯色底。
function applyBgUrl(rawUrl) {
  const u = (rawUrl || '').trim();
  if (!u) { flash('请先填写图片链接'); return; }
  let parsed;
  try { parsed = new URL(u, location.href); } catch (_) { flash('链接格式不正确'); return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { flash('仅支持 http/https 图片链接'); return; }
  const s = readBgSettings(); s.url = parsed.href; saveBgSettings(s);
  // 与本地 Blob 互斥：清掉已存的本地图片，避免下次启动被覆盖
  openLibDb().then(() => { if (libDb) return idbDeleteImage(BG_ID); }).catch(() => {});
  setBgSrc(parsed.href, null);
  flash('背景图片已应用');
}

async function removeAppBg() {
  try {
    await openLibDb();
    if (libDb) await idbDeleteImage(BG_ID);
  } catch (_) {}
  const el = document.getElementById('appBg');
  el.classList.remove('active');
  document.body.classList.remove('has-app-bg');
  el.style.removeProperty('--bg-image');
  el.style.removeProperty('--bg-scrim');
  el.style.removeProperty('--bg-fit');
  if (appBgObjectUrl) { URL.revokeObjectURL(appBgObjectUrl); appBgObjectUrl = null; }
  appBgSrc = null;
  localStorage.removeItem('app-bg-settings');
  updateBgPreview();
  const urlEl = document.getElementById('bgUrl'); if (urlEl) urlEl.value = '';
  flash('已移除背景图片');
}

function openBgDialog() {
  const dlg = document.getElementById('bgModal');
  if (!dlg) return;
  updateBgPreview();
  const s = readBgSettings();
  const urlEl = document.getElementById('bgUrl');
  if (urlEl) urlEl.value = s.url || '';
  const scrimEl = document.getElementById('bgScrim');
  const fitEl = document.getElementById('bgFit');
  if (scrimEl) scrimEl.value = (s.scrim != null) ? s.scrim : 0.7;
  if (fitEl) fitEl.value = s.fit || 'cover';
  dlg.hidden = false;
}

// 实时调节遮罩浓度 / 填充方式（无需重新选图）
function setBgScrim(v) {
  const el = document.getElementById('appBg');
  el.style.setProperty('--bg-scrim', v);
  const s = readBgSettings(); s.scrim = +v; saveBgSettings(s);
}
function setBgFit(v) {
  const el = document.getElementById('appBg');
  el.style.setProperty('--bg-fit', v);
  const s = readBgSettings(); s.fit = v; saveBgSettings(s);
}

function genId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  try { return new Date(ts).toLocaleDateString('zh-CN'); } catch (_) { return ''; }
}

// HTML 转义（正文可能含 < & " 等，防止注入并正确显示）
// escapeHtml 已下沉到 lib/md-core.js（参数校验更严：null/undefined → ''）。

// 从正文中截取包含关键词的上下文片段，并高亮命中词。返回安全的 HTML 串。
// 仅在调用方已确认正文命中（indexOf >= 0）时使用。
function buildSnippet(content, kw) {
  const idx = content.toLowerCase().indexOf(kw);
  if (idx < 0) return escapeHtml(content.slice(0, 60));
  const start = Math.max(0, idx - 20);
  const end = Math.min(content.length, idx + kw.length + 40);
  const before = content.slice(start, idx).replace(/\s+/g, ' ');
  const hit = content.slice(idx, idx + kw.length);
  const after = content.slice(idx + kw.length, end).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '')
    + escapeHtml(before)
    + '<mark class="lib-snippet-hit">' + escapeHtml(hit) + '</mark>'
    + escapeHtml(after)
    + (end < content.length ? '…' : '');
}

/* 抽屉开关 */
const libDrawer = $('#libDrawer');
const libScrim = $('#libScrim');
const libBtn = $('#btnLibrary');
function openLibrary() {
  libScrim.hidden = false;
  requestAnimationFrame(() => libScrim.classList.add('show'));   // 触发淡入
  libDrawer.classList.add('open');
  libDrawer.setAttribute('aria-hidden', 'false');
  libBtn.setAttribute('aria-expanded', 'true');
  renderLibrary();
  setTimeout(() => { const s = $('#libSearch'); if (s) s.focus(); }, 120);
}
function closeLibrary() {
  libDrawer.classList.remove('open');
  libDrawer.setAttribute('aria-hidden', 'true');
  libBtn.setAttribute('aria-expanded', 'false');
  libScrim.classList.remove('show');
  setTimeout(() => { libScrim.hidden = true; }, 200);
}
function toggleLibrary() { libDrawer.classList.contains('open') ? closeLibrary() : openLibrary(); }
if (libBtn) libBtn.addEventListener('click', toggleLibrary);
const libCloseBtn = $('#libClose');
if (libCloseBtn) libCloseBtn.addEventListener('click', closeLibrary);
if (libScrim) libScrim.addEventListener('click', closeLibrary);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && libDrawer && libDrawer.classList.contains('open')) closeLibrary();
});

/* 文库内嵌音乐播放器：折叠开关（iframe 首次展开时才加载，避免一开页面就触发外链自动搜索） */
const libMusic = $('#libMusic');
const libMusicToggle = $('#libMusicToggle');
if (libMusicToggle) libMusicToggle.addEventListener('click', () => {
  if (!libMusic) return;
  const open = libMusic.hidden;
  libMusic.hidden = !open;
  libMusicToggle.setAttribute('aria-expanded', String(open));
  libMusicToggle.classList.toggle('active', open);
  if (open) {
    const f = libMusic.querySelector('.lib-music-frame');
    if (f && !f.getAttribute('src') && f.dataset.src) f.src = f.dataset.src;
  }
});

/* 渲染列表 */
const libList = $('#libList');
const libEmpty = $('#libEmpty');
const libCount = $('#libCount');
const libFootCount = $('#libFootCount');
const libSearch = $('#libSearch');
let libDocsCache = [];

async function renderLibrary() {
  if (!libDb) {
    try { await openLibDb(); } catch (_) { return; }
  }
  try { libDocsCache = await idbGetAll(); } catch (_) {
    // 连接可能已被浏览器关闭（后台回收等），重置后重试一次
    libDb = null;
    try {
      await openLibDb();
      libDocsCache = await idbGetAll();
    } catch (_) { libDocsCache = []; }
  }
  libDocsCache.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const kw = (libSearch.value || '').trim().toLowerCase();
  // 全文检索：文件名 + 正文一起匹配（纯内存，毫秒级）
  const shown = kw ? libDocsCache.filter((d) => {
    const nameMatch = (d.name || '').toLowerCase().includes(kw);
    const contentMatch = (d.content || '').toLowerCase().includes(kw);
    return nameMatch || contentMatch;
  }) : libDocsCache;
  libList.innerHTML = '';
  shown.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'lib-item' + (d.id === currentLibId ? ' active' : '');
    li.dataset.id = d.id;
    const avatar = document.createElement('span');
    avatar.className = 'lib-avatar';
    avatar.textContent = (d.name || '未').trim().charAt(0).toUpperCase();
    const open = document.createElement('button');
    open.className = 'lib-item-open';
    open.innerHTML = '<span class="lib-item-name"></span><span class="lib-item-time"></span>';
    const name = d.name || '未命名.md';
    open.querySelector('.lib-item-name').textContent = name;
    const timeEl = open.querySelector('.lib-item-time');
    // 若仅正文命中（文件名未命中），副标题改为展示带高亮的正文摘要
    const content = d.content || '';
    if (kw && !name.toLowerCase().includes(kw) && content.toLowerCase().includes(kw)) {
      timeEl.classList.add('is-snippet');
      timeEl.innerHTML = buildSnippet(content, kw);
    } else {
      timeEl.classList.remove('is-snippet');
      timeEl.textContent = fmtTime(d.updatedAt || Date.now());
    }
    const acts = document.createElement('span');
    acts.className = 'lib-item-actions';
    acts.innerHTML = '<button class="lib-act" data-act="history" title="版本历史">⏱️</button>'
      + '<button class="lib-act" data-act="download" title="下载为 .md">⬇️</button>'
      + '<button class="lib-act" data-act="rename" title="重命名">✏️</button>'
      + '<button class="lib-act" data-act="delete" title="删除">🗑</button>';
    li.appendChild(avatar);
    li.appendChild(open);
    li.appendChild(acts);
    libList.appendChild(li);
  });
  libEmpty.hidden = libDocsCache.length > 0;
  if (libCount) {
    libCount.textContent = String(libDocsCache.length);
    libCount.hidden = libDocsCache.length === 0;
  }
  if (libFootCount) libFootCount.textContent = String(libDocsCache.length);
}

/* 打开文库文档 → 载入编辑器，后续编辑自动回写 */
function openLibDocData(doc) {
  currentLibId = doc.id;
  currentFileHandle = null;
  currentName = doc.name || '未命名.md';
  currentNameIsAuto = !!doc.autoName;
  editor.value = doc.content || '';
  resetUndo();
  localStorage.setItem('md-lib-current', doc.id);
  updateFileName();
  afterChange({ skipWriteback: true });   // 打开即载入，不应刷新更新时间
  syncPodcastOnLoad();
  restoreReadingProgress();              // 恢复到上次阅读位置（rAF 延迟执行，在渲染之后）
  setSaveState('saved', '✓ 已保存 · 文库');
  renderLibrary();
}
async function openLibDoc(id) {
  try {
    const doc = await idbGet(id);
    if (!doc) { renderLibrary(); return; }
    openLibDocData(doc);
  } catch (_) { flash('打开失败'); }
}
libList.addEventListener('click', (e) => {
  const item = e.target.closest('.lib-item');
  if (!item) return;
  const id = item.dataset.id;
  const actBtn = e.target.closest('.lib-act');
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === 'history') showHistoryModal(id);
    else if (act === 'download') downloadLibDoc(id);
    else if (act === 'rename') renameLibDoc(id);
    else if (act === 'delete') deleteLibDoc(id);
    return;
  }
  openLibDoc(id);
});
if (libSearch) libSearch.addEventListener('input', debounce(renderLibrary, 150));

/* 新建文库文档 */
async function newLibDoc() {
  const doc = { id: genId(), name: '未命名.md', content: '', updatedAt: Date.now() };
  try {
    await idbPut(doc);
    openLibDocData(doc);
    if (editor) editor.focus();
    renderLibrary();
    flash('已新建（文库）');
  } catch (_) { flash('新建失败'); }
}
$('#libNew').addEventListener('click', newLibDoc);

/* 重命名 / 删除 */
async function renameLibDoc(id) {
  const doc = await idbGet(id).catch(() => null);
  if (!doc) return;
  const n = await askInput('重命名', { def: doc.name || '未命名.md' });
  if (!n || !n.trim()) return;
  doc.name = n.trim();
  doc.updatedAt = Date.now();
  try { await idbPut(doc); } catch (_) {}
  if (id === currentLibId) { currentName = doc.name; currentNameIsAuto = false; updateFileName(); }
  renderLibrary();
  flash('已重命名');
}
async function deleteLibDoc(id) {
  const doc = await idbGet(id).catch(() => null);
  if (!(await askConfirm('删除文档', '删除「' + (doc ? doc.name : '该文档') + '」？此操作不可恢复。'))) return;
  try { await idbDelete(id); } catch (_) {}
  // 连同该文档的版本快照与阅读位置一起清理，避免 history / positions 仓库残留孤儿记录
  try {
    const snaps = await readHistory(id);
    for (const h of snaps) if (h.hid && h.hid.indexOf('@legacy-') < 0) await idbDeleteHistory(h.hid);
  } catch (_) {}
  try { await idbReq(() => posStore('readwrite').delete(id)); } catch (_) {}
  if (id === currentLibId) {
    currentLibId = null;
    localStorage.removeItem('md-lib-current');
    currentFileHandle = null;
    currentName = '未命名.md';
    currentNameIsAuto = false;
    editor.value = '';
    resetUndo();
    localStorage.removeItem('md-draft');   // 清掉旧草稿，避免删除后内容在重载时复活
    localStorage.removeItem('md-name');
    localStorage.removeItem('md-draft-ts');
    updateFileName();
    renderMarkdown({ force: true }); updateStats(); updateGutter(); updatePos();   // 刷新空视图（不触发草稿写入）
    setSaveState('', '待编辑');
  }
  renderLibrary();
  flash('已删除');
}

/* 当前文档转存到文库（如从电脑打开的文章） */
async function addToLibrary() {
  if (currentLibId) { flash('当前已在文库'); return; }
  if (remoteOrigin) {
    const ok = await askConfirm('把外部文档存入文库？',
      '来源：' + remoteOrigin + '\n\n' +
      '存入后它会变成【你自己的文档】：可编辑、自动保存、参与 NAS 同步。\n' +
      '这一下来等于你认领了这份内容，所以只在你确实需要时才继续。');
    if (!ok) return;
    adoptRemoteDoc();
  }
  ensureNameFromContent();                                     // 先自动命名（未命名 → 首行派生标题）
  const doc = { id: genId(), name: currentName || '未命名.md', content: editor.value, updatedAt: Date.now(), autoName: currentNameIsAuto };
  try {
    await idbPut(doc);
    currentLibId = doc.id;                                 // 之后编辑自动回写文库
    localStorage.setItem('md-lib-current', doc.id);
    setSaveState('saved', '✓ 已保存 · 文库');
    renderLibrary();
    flash('已加入文库');
  } catch (_) { flash('加入失败'); }
}

/* 文库条目下载为 .md 文件 */
async function downloadLibDoc(id) {
  try {
    const doc = await idbGet(id);
    if (!doc) return;
    const name = (doc.name || '未命名.md').replace(/\.(md|markdown|txt|html?|pdf)$/i, '') + '.md';
    download(name, doc.content || '', 'text/markdown;charset=utf-8');
    flash('已下载 ' + name);
  } catch (_) { flash('下载失败'); }
}

/* 上传本地文档到文库（支持多选 / 手机文件选择器） */
const libFileInput = $('#libFileInput');
if (libFileInput) {
  $('#libUpload').addEventListener('click', () => libFileInput.click());
  const libGcBtn = $('#libGc');
  if (libGcBtn) libGcBtn.addEventListener('click', () => {
    libGcBtn.disabled = true;
    gcOrphanImages({ silent: false }).then(() => { libGcBtn.disabled = false; }).catch(() => { libGcBtn.disabled = false; });
  });
  libFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let ok = 0;
    for (const f of files) {
      try {
        const content = await f.text();
        await idbPut({ id: genId(), name: f.name, content, updatedAt: Date.now() });
        ok++;
      } catch (_) {}
    }
    libFileInput.value = '';
    renderLibrary();
    flash(ok ? `已上传 ${ok} 个文档` : '上传失败');
  });
}

/* 自动回写：打开文库文档后，每次编辑去抖写入 IndexedDB，并保留版本历史 */
const MAX_HISTORY_SNAPSHOT = 200000;   // 历史快照单条内容上限 200KB（超大文档只存前 200KB 并标记 truncated）
const writebackLibDebounced = debounce(() => { writebackLib(); }, 800);

/* 记录一条历史快照（策略在 md-core.shouldSnapshot，有单测）：
 *   - 至少间隔 5 分钟，或长度变化 ≥5% 才留档 → 快照真正覆盖「不同阶段」而非最近几分钟的近似副本
 *   - 快照独立存进 history 仓库，正文写入不再携带它（原先单次写入最多要连 20×200KB 一起搬）
 */
async function snapshotHistory(docId, content) {
  try {
    const list = await readHistory(docId);
    const last = list[list.length - 1];
    if (!last) { /* 首版必存 */ }
    else if (!shouldSnapshot({ lastAt: last.at, prevLen: last.len || (last.content || '').length, newLen: content.length })) return;

    const at = Date.now();
    const overLimit = content.length > MAX_HISTORY_SNAPSHOT;
    await idbAddHistory({
      hid: docId + '@' + at,
      docId,
      at,
      len: content.length,
      summary: content.slice(0, 200) + (content.length > 200 ? '…' : ''),
      content: overLimit ? content.slice(0, MAX_HISTORY_SNAPSHOT) : content,
      truncated: overLimit,
    });
    await trimHistory(docId);
  } catch (_) { /* 快照失败不影响正文保存 */ }
}

function writebackLib() {
  if (!currentLibId || !libDb) return;
  ensureNameFromContent();          // 未命名文库文档：首次编辑即按首行自动命名
  const newContent = editor.value;
  idbGet(currentLibId).then((oldDoc) => {
    const changed = !(oldDoc && oldDoc.content === newContent);
    // 正文与元信息一次写入；历史字段在此自然淡出（旧数据结构里的 doc.history 不再被复制）
    return idbPut({
      id: currentLibId, name: currentName, content: newContent, updatedAt: Date.now(),
      autoName: currentNameIsAuto,
    }).then(() => (changed ? snapshotHistory(currentLibId, newContent) : null));
  }).then(() => {
    setSaveState('saved', '✓ 已保存 · 文库');
    const t = libList.querySelector('.lib-item.active .lib-item-time');   // 轻量更新时间，不打断列表
    if (t) t.textContent = fmtTime(Date.now());
    syncLibraryToNasDebounced();   // 文库改动后静默触发增量同步（去抖，不打断输入）
  }).catch(() => setSaveState('saved', '回写失败'));
}

/* 版本历史弹窗：列出快照，选择后恢复（截断其后历史，符合 Git 恢复逻辑） */
async function showHistoryModal(docId) {
  const doc = await idbGet(docId).catch(() => null);
  const snaps = await readHistory(docId).catch(() => []);
  if (!doc || !snaps.length) {
    flash('该文档暂无历史版本');
    return;
  }
  const list = snaps.map((h, i) =>
    `${i + 1}. ${new Date(h.at).toLocaleString('zh-CN')} - ${h.summary}${h.truncated ? '（截断）' : ''}`
  ).join('\n');
  const choice = await askInput(`选择要恢复的版本（输入编号 1-${snaps.length}）：`, { desc: list });
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= snaps.length) return;
  const target = snaps[idx];
  if (target.truncated) toast('⚠️ 该版本为大文档截断快照（仅含前 200KB），恢复后内容不完整', 'info', 6000);
  if (!(await askConfirm('恢复版本', `恢复至 ${new Date(target.at).toLocaleString('zh-CN')} 的版本？当前内容将被覆盖。`))) return;

  pushUndo('恢复历史版本');                          // 误点恢复也能 Ctrl+Z 撤回
  editor.value = target.content;
  currentName = doc.name;
  currentNameIsAuto = false;
  currentLibId = docId;
  currentFileHandle = null;
  updateFileName();
  // 截断：被恢复版本之后的历史丢弃（符合 Git 恢复语义），且只删快照，不动正文
  const later = snaps.slice(idx + 1).filter((h) => h.hid && h.hid.indexOf('@legacy-') < 0);
  for (const h of later) await idbDeleteHistory(h.hid).catch(() => {});
  const nextDoc = { ...doc, content: target.content, updatedAt: Date.now() };
  delete nextDoc.history;                       // 历史已迁到独立仓库，别把这个字段继续写回去
  await idbPut(nextDoc);
  afterChange({ skipWriteback: true });
  renderLibrary();
  flash('已恢复至历史版本');
}

// === SECTION: 初始化 ===
// === SECTION: 微信协作分享：基于 Cloudflare R2 + Worker 的中转站 ===
// 前端仅持有 Worker 的【公开端点】URL；R2 凭据写在 Cloudflare Worker 的绑定里，
// 绝不下发到前端、不入 git（符合“密钥永不写进会被提交代码”的原则）。
async function shareViaR2() {
  if (blockInRemoteMode('生成分享链接')) return;
  if (!R2_WORKER_URL) { flash('未配置分享服务地址'); return; }
  if (!editor.value.trim()) { flash('文档为空，无法分享'); return; }
  toast(currentShareId ? '正在更新协作文档…' : '正在生成协作链接…', 'info');
  const url = currentShareId ? `${R2_WORKER_URL}/${encodeURIComponent(currentShareId)}` : R2_WORKER_URL;
  const method = currentShareId ? 'PUT' : 'POST';
  try {
    const resp = await fetch(url, {
      method,
      // X-Mdviewer 是写入端点的「降噪」标记：Worker 侧据此挡掉无脑扫描器（返回 403）。
      // 加了自定义头会让跨域请求先发 OPTIONS 预检，Worker 的 CORS 已放行该头。
      headers: { 'Content-Type': 'text/markdown;charset=utf-8', 'X-Mdviewer': '1' },
      body: new Blob([editor.value], { type: 'text/markdown' })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const resData = await resp.json();
    currentShareId = resData.id;
    const shareUrl = `${location.origin}${location.pathname}?share_r2=${encodeURIComponent(currentShareId)}`;
    showShareModal(shareUrl);   // 弹出可见链接 + 复制按钮，不依赖静默剪贴板 / prompt
  } catch (e) {
    toast('❌ 生成协作链接失败：' + (e.message || e), 'err', 5000);
  }
}

// 弹出可见的分享弹窗（明文链接 + 复制按钮），彻底不依赖 prompt / 静默剪贴板
function showShareModal(shareUrl) {
  const m = $('#shareModal');
  if (!m) return;
  const ta = $('#shareUrlText');
  if (ta) ta.value = shareUrl;
  const tip = $('#shareTip');
  if (tip) tip.textContent = '';
  m.hidden = false;
}

// 复制按钮：优先 clipboard，失败用 textarea + execCommand 兜底（兼容 file:// 与微信内置浏览器）
function copyShareUrl() {
  const ta = $('#shareUrlText');
  const url = ta ? ta.value : '';
  if (!url) return;
  const mark = (ok) => {
    const tip = $('#shareTip');
    if (tip) tip.textContent = ok ? '✓ 已复制到剪贴板' : '复制失败，请长按上方链接手动复制';
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => mark(true)).catch(() => mark(fallbackCopy(url)));
    return;
  }
  mark(fallbackCopy(url));
}

function fallbackCopy(txt) {
  try {
    const el = document.createElement('textarea');
    el.value = txt;
    el.style.position = 'fixed';
    el.style.top = '-9999px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch (_) {
    return false;
  }
}

/* ---------- 外部文档浏览（?open=/path/x.md） ----------
 * 用途：mdviewer 也可以由容器内的 serve-web.js 提供，目录列表里点 .md 直接以排版阅读，
 *      比 text/markdown 的纯文本体验好；因为是同源，所以不涉及 CORS / mixed content。
 * 安全：只允许同源路径，绝不 fetch 任意外部地址（外部文档请走 ?share_r2=）。
 * 返回 true 表示已消费该参数（不再落入文库/草稿初始化）。
 */
async function openExternalDocFromQuery() {
  let raw = null;
  try { raw = new URLSearchParams(location.search).get('open'); } catch (_) { return false; }
  if (!raw) return false;
  let target;
  try { target = new URL(raw, location.href); } catch (_) { return false; }
  if (target.origin !== location.origin) {
    toast('❌ ?open= 只支持打开同源路径下的 Markdown', 'err');
    return true;
  }
  toast('正在加载文档…', 'info');
  try {
    const resp = await fetch(target.href, { cache: 'no-store' });
    if (!resp.ok) {
      toast(`❌ 打不开该文档（HTTP ${resp.status}）`, 'err');
      return false;          // 回退到文库/草稿，别把用户卡在空页面
    }
    editor.value = await resp.text();
    currentLibId = null;
    currentShareId = null;   // 外部文档不是协作文档，避免「生成协作链接」误覆盖别人的分享
    let base = target.pathname.split('/').pop() || 'document.md';
    try { base = decodeURIComponent(base); } catch (_) {}
    currentName = base;
    currentNameIsAuto = false;
    updateFileName();
    afterChange({ skipWriteback: true });
    syncPodcastOnLoad();
    // ?view=preview：从 serve-web 目录列表点进来的都是"看"而不是"写"，
    // 默认双栏（编辑器占一半屏）没意义；显式允许 split/edit/preview 三种取值。
    try {
      const wantView = new URLSearchParams(location.search).get('view');
      if (wantView === 'preview' || wantView === 'edit' || wantView === 'split') setView(wantView);
    } catch (_) { /* 参数非法就保持默认视图 */ }
    toast('📖 已以浏览模式载入外部文档（要保存副本请 Ctrl/Cmd+S 另存）', 'ok', 5000);
    return true;
  } catch (e) {
    toast('❌ 文档加载失败：' + (e.message || e), 'err');
    return false;
  }
}

/* ---------- NAS 文件名入口（?nas=xxx.md） ----------
 * 用途：mdviewer 部署在公网静态站时，本地文件没法直接读；先经 pi-gw 的
 * 「存到 Knowly」传到 NAS，再用 ?nas=<文件名> 打开，内容始终留在自己的 NAS 上，
 * 不经过公开中转站。与 ?open=（同源文件）互补：
 *   ?open=  同源静态文件，无需鉴权
 *   ?nas=   NAS 上的文件，走 Basic 鉴权（凭据只在本机 localStorage）
 * 返回 true 表示已消费该参数。
 */
async function openNasDocFromQuery() {
  let raw = null;
  try { raw = new URLSearchParams(location.search).get('nas'); } catch (_) { return false; }
  if (!raw) return false;
  // 注意：这里不能用 extractNasFilename —— 它只认 .md/.markdown/.txt，
  // 而我们是从 pi-gw 抽屉进来的，文件名可能是 .json/.log/.js 等（2026-11-05 实测报"无法解析文件名"）。
  // 只做最小校验：去掉路径、拒绝协议头，剩下的交给 NAS 决定。
  let filename = String(raw).trim();
  try { filename = decodeURIComponent(filename); } catch (_) {}
  filename = filename.split(/[\\/]/).pop() || '';
  if (!filename || /^https?:/i.test(filename)) return false;
  flash('正在从 NAS 取回 ' + filename + '…');
  const text = await downloadFromNas(filename);
  if (text == null) return false;             // 凭据缺失/网络失败：交给正常启动流程
  editor.value = text;
  currentLibId = null;
  currentShareId = null;
  currentFileHandle = null;
  currentName = filename;
  currentNameIsAuto = false;
  updateFileName();
  afterChange({ skipWriteback: true });
  syncPodcastOnLoad();
  try {
    const wantView = new URLSearchParams(location.search).get('view');
    if (wantView === 'preview' || wantView === 'edit' || wantView === 'split') setView(wantView);
    else setView('preview');
  } catch (_) { setView('preview'); }
  toast('📥 已从 NAS 打开：' + filename, 'ok', 4500);
  return true;
}

/* ---------- 外部网址只读浏览（v4.10：菜单「🌐 从网址打开」 / ?url=） ----------
 * 与 ?open= 的区别：?open= 只允许同源（自家容器里的文件），这里要去取别人的站点，
 * 所以必须过一道代理（浏览器跨域拿不到），也必须按「不可信内容」对待。
 *
 * 三条铁律（缺一条这个功能就不安全）：
 *   1. 取文过安检（lib/fetch-guard.js，代理侧会再跑一遍，前端这次只是省一次网络往返）；
 *   2. 渲染走消毒严档（REMOTE_SANITIZE）+ 外链断 opener + 远程图片不自动加载；
 *   3. 一切自动写入全部关闭（草稿 / 文库回写 / 分享 / 发布 / 上传），只允许用户显式另存。
 */

function isRemoteMode() { return !!remoteOrigin; }

/** 外部只读模式下拦截某个写入动作；返回 true 表示已被拦下 */
function blockInRemoteMode(what) {
  if (!remoteOrigin) return false;
  toast('🔒 外部只读文档不能' + what + '，请先「另存为副本」或存入文库', 'warn', 4600);
  return true;
}

function showRemoteBanner(href) {
  const el = document.getElementById('remoteBanner');
  const host = document.getElementById('remoteHost');
  if (host) {
    host.textContent = remoteOrigin || '-';
    host.title = href || '';
  }
  if (el) el.hidden = false;
}
function hideRemoteBanner() {
  const el = document.getElementById('remoteBanner');
  if (el) el.hidden = true;
}

/** 解除只读 + 清掉外部标记（只在用户明确「认领」时调用，如存入文库） */
function adoptRemoteDoc() {
  remoteOrigin = null;
  remoteHref = '';
  editor.readOnly = false;
  document.body.classList.remove('remote-mode');
  hideRemoteBanner();
  lastRenderedSrc = null;      // 强制重渲：消毒档不同（还要把远程图片恢复为直接加载）
  renderMarkdown({ force: true });
}

/**
 * 通过代理取回远端 Markdown 文本。
 * @returns {Promise<{ok:true,text:string,href:string,host:string}|{ok:false,reason:string,message?:string}>}
 */
async function fetchRemoteText(raw) {
  if (!FetchGuard) return { ok: false, reason: 'disabled' };        // 规则模块缺失（缓存不完整）就不取
  const pre = FetchGuard.checkFetchUrl(raw);                        // 本地预检：不合规根本不必发请求
  if (!pre.ok) return { ok: false, reason: pre.reason, message: pre.message };

  const proxy = resolveFetchProxy();
  const url = proxy + '?url=' + encodeURIComponent(pre.href);
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  // 代理侧超时是 10s；客户端多留 5s，让「代理自己超时返回 504」优先发生，错误理由更准
  const timer = ctrl ? setTimeout(() => ctrl.abort(), (FetchGuard.FETCH_TIMEOUT_MS || 10000) + 5000) : null;
  try {
    const resp = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',                                            // 不向代理带任何凭据
      headers: { 'X-Mdviewer': '1' },
      signal: ctrl ? ctrl.signal : undefined,
    });
    const ct = resp.headers.get('content-type') || '';
    // 失败一律是 JSON（带 reason），先解析出来再把理由翻译成人话
    if (!resp.ok || /json/i.test(ct)) {
      let payload = null;
      try { payload = await resp.json(); } catch (_) { /* 不是 JSON：多半是端点不存在，走下面的兜底 */ }
      if (payload && payload.ok === false) return { ok: false, reason: payload.reason || 'bad-response', message: payload.message };
      // 返回体不是本服务的约定格式（老版本 Worker 会把 /fetch-md 当成分享 id 处理，回 {error:'bad-id'}）
      // → 统一解释为「取文端点没部署/没开启」，这比「对方返回了错误状态码」准确得多。
      return { ok: false, reason: 'disabled', message: (payload && (payload.message || payload.error)) || ('HTTP ' + resp.status) };
    }
    if (!/markdown|text\/plain/i.test(ct)) return { ok: false, reason: 'bad-response', message: 'content-type: ' + (ct || '-') };

    // 按字节再量一次（代理已经量过，这里防「代理被换掉/被中间层篡改」）
    const buf = await resp.arrayBuffer();
    if (FetchGuard.exceedsLimit(buf.byteLength)) return { ok: false, reason: 'too-large' };
    const text = new TextDecoder('utf-8').decode(buf);
    return { ok: true, text, href: pre.href, host: pre.host };
  } catch (e) {
    const aborted = ctrl && ctrl.signal.aborted;
    return { ok: false, reason: aborted ? 'timeout' : 'network', message: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 菜单入口：弹输入框 → 取文 → 进只读模式 */
async function openRemoteDoc(rawInput) {
  if (remoteLoading) return;
  let raw = rawInput;
  if (!raw) {
    raw = await askInput('从网址打开（只读）', {
      desc: '粘贴一个 https 开头的 Markdown 链接，例如 https://raw.githubusercontent.com/…/README.md\n' +
            '只读打开：不写入文库、不覆盖草稿、不自动保存。',
      def: remoteHref || '',
    });
  }
  if (!raw) return;
  remoteLoading = true;
  try {
    toast('正在取文…', 'info');
    const r = await fetchRemoteText(raw);
    if (!r.ok) {
      const msg = FetchGuard ? FetchGuard.describeFailure(r.reason) : ('取文失败：' + (r.reason || ''));
      toast('❌ ' + msg, 'err', 6200);
      console.warn('[mdviewer] 取文失败', r);
      return;
    }
    enterRemoteMode(r);
    toast('🌐 已按只读方式载入外部文档（编辑、分享、发布均已禁用）', 'ok', 4600);
  } finally {
    remoteLoading = false;
  }
}

/** 进入外部只读模式：清空所有「归属」上下文，再载入正文 */
function enterRemoteMode(r) {
  const name = FetchGuard ? FetchGuard.fileNameFromUrl(r.href) : 'remote.md';
  remoteOrigin = r.host || 'external';
  remoteHref = r.href || '';
  // 这三行是关键：把「这份内容是谁的」彻底切断，让所有隐式写入无处可去
  currentLibId = null;        // 不在文库上下文里 → writebackLib 无事可做
  currentShareId = null;      // 不会拿别人的文档去覆盖某个协作分享
  currentFileHandle = null;   // Ctrl+S 不会写回某个本地文件
  currentName = name;
  currentNameIsAuto = false;

  editor.value = r.text;
  editor.readOnly = true;     // 只读：这不是「你的稿子」，不需要也不应该在这里改
  document.body.classList.add('remote-mode');
  resetUndo();
  updateFileName();
  showRemoteBanner(r.href);
  // skipWriteback 挡住文库回写；草稿不需要额外开关——writeDraftNow() 里看到 remoteOrigin 就直接返回。
  afterChange({ skipWriteback: true });
  setView('preview');         // 来看的，不是来写的
  setSaveState('saved', '🌐 外部只读');
}

/** 退出只读：直接回干净的地址（远程正文本来就没落盘，重载不会丢任何东西） */
function exitRemoteMode() {
  location.assign(location.origin + location.pathname);
}

// 横幅按钮：另存副本（走导出）+ 退出
document.getElementById('remoteSaveCopy')?.addEventListener('click', () => { exportMarkdown(); });
document.getElementById('remoteExit')?.addEventListener('click', () => {
  hideRemoteBanner();
  exitRemoteMode();
});

async function initLibrary() {
  // === 外部文档浏览入口：命中 ?open=<同源路径> 时直接载入（配合 serve-web.js 的目录列表）===
  if (await openExternalDocFromQuery()) return;

  // === NAS 文件入口：命中 ?nas=<文件名>（线上站配合 pi-gw 的「存到 Knowly」用）===
  if (await openNasDocFromQuery()) return;

  // === 外部网址只读入口：命中 ?url=<https 地址>（serve-web 外的情况走 Worker 代理）===
  try {
    const rawUrl = new URLSearchParams(location.search).get('url');
    if (rawUrl) {
      await openRemoteDoc(rawUrl);
      if (remoteOrigin) return;          // 取文失败则继续往下走，别把用户卡在空页
    }
  } catch (_) { /* 参数非法：忽略，按普通启动处理 */ }

  // === 协作分享入口：命中 ?share_r2=xxx.md 时从 R2 拉取并进入协作模式 ===
  try {
    const shareId = new URLSearchParams(window.location.search).get('share_r2');
    if (shareId) {
      toast('正在加载协作文档…', 'info');
      const resp = await fetch(`${R2_WORKER_URL}/${encodeURIComponent(shareId)}`);
      if (resp.ok) {
        editor.value = await resp.text();
        currentLibId = null;
        currentShareId = shareId;
        currentName = '协作文档_' + shareId;
        currentNameIsAuto = false;
        updateFileName();
        afterChange({ skipWriteback: true });
        syncPodcastOnLoad();
        const cleanUrl = location.protocol + '//' + location.host + location.pathname;
        history.replaceState({ path: cleanUrl }, '', cleanUrl);
        toast('📥 已载入，修改后点「生成协作链接」即可覆盖发回', 'ok', 5000);
        return;
      }
      toast('❌ 协作文档加载失败（不存在或已失效）', 'err');
    }
  } catch (e) {
    toast('❌ 协作文档加载失败：' + (e.message || e), 'err');
  }

  try {
    await openLibDb();
  } catch (e) {
    loadDraft();   // IndexedDB 不可用 → 退回草稿
    return;
  }
  const curId = localStorage.getItem('md-lib-current');
  if (curId) {
    try {
      const doc = await idbGet(curId);
      if (doc) { openLibDocData(doc); return; }   // 恢复上次文库文档（含自动回写上下文）
    } catch (_) {}
  }
  loadDraft();     // 无文库上下文 → 加载草稿
}

// === SECTION: 布局：左右交换 + 可拖拽分隔线 ===
// - 交换：.workspace 加 .swapped（flex row-reverse）
// - 拖拽：调整 --editor-w（编辑器面板 flex-basis），预览区自适应
// - 偏好持久化到 localStorage，刷新后保留
let isLayoutSwapped = localStorage.getItem('md-layout-swapped') === '1';
let editorWidthPx = parseFloat(localStorage.getItem('md-editor-width')) || null;
const menuLayoutToggle = $('#menuLayout');

function applyLayout() {
  const ws = document.querySelector('.workspace');
  if (!ws) return;
  ws.classList.toggle('swapped', isLayoutSwapped);
  if (editorWidthPx && editorWidthPx > 0) ws.style.setProperty('--editor-w', editorWidthPx + 'px');
  else ws.style.removeProperty('--editor-w');
  if (menuLayoutToggle) menuLayoutToggle.textContent = '🔀 交换左右布局：' + (isLayoutSwapped ? '开' : '关');
}

function toggleLayoutSwap() {
  isLayoutSwapped = !isLayoutSwapped;
  localStorage.setItem('md-layout-swapped', isLayoutSwapped ? '1' : '0');
  applyLayout();
}

// 一键恢复默认布局：编辑区在左、预览区在右、各占 50%，并清除持久化
function resetLayout() {
  isLayoutSwapped = false;
  editorWidthPx = null;
  try {
    localStorage.removeItem('md-layout-swapped');
    localStorage.removeItem('md-editor-width');
  } catch (_) {}
  applyLayout();
}

function persistLayoutWidth() {
  if (editorWidthPx != null) localStorage.setItem('md-editor-width', String(editorWidthPx));
}

function initSplitter() {
  const ws = document.querySelector('.workspace');
  const splitter = document.getElementById('splitter');
  if (!ws || !splitter) return;
  const MIN = 220;                 // 单块最小宽度（px）
  let dragging = false;

  const clampW = (w) => {
    const rect = ws.getBoundingClientRect();
    const sw = splitter.offsetWidth;
    return Math.max(MIN, Math.min(w, rect.width - sw - MIN));
  };
  const setW = (w) => {
    editorWidthPx = w;
    ws.style.setProperty('--editor-w', w + 'px');
  };
  const pointX = (e) => (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);

  const onDown = (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    if (e.cancelable) e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const rect = ws.getBoundingClientRect();
    const x = pointX(e);
    const w = isLayoutSwapped ? (rect.right - x) : (x - rect.left);
    setW(clampW(w));
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persistLayoutWidth();
  };

  splitter.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  splitter.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);

  // 键盘可达性：聚焦分隔线后用 ←/→ 微调，Home 复位 50%
  splitter.addEventListener('keydown', (e) => {
    const rect = ws.getBoundingClientRect();
    const sw = splitter.offsetWidth;
    const cur = editorWidthPx || (rect.width - sw) / 2;
    let next = cur;
    if (e.key === 'ArrowLeft') next = isLayoutSwapped ? cur + 24 : cur - 24;
    else if (e.key === 'ArrowRight') next = isLayoutSwapped ? cur - 24 : cur + 24;
    else if (e.key === 'Home') { setW((rect.width - sw) / 2); persistLayoutWidth(); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    setW(clampW(next));
    persistLayoutWidth();
  });
}

setSaveState('', '待编辑');
initLibrary();
// 文库闲置 GC：启动 10s 后静默扫描孤儿图片并清理（不弹提示）
setTimeout(() => { gcOrphanImages({ silent: true }).catch(() => {}); }, 10000);
renderMarkdown();
setTocOpen(tocOpen);    // 还原目录抽屉开关状态（renderMarkdown 已建好大纲）
applyWrap();            // 设置换行模式（默认软换行）+ 渲染覆盖层
applyLayout();          // 应用上次保存的左右布局与分隔宽度
initSplitter();         // 启用编辑区 / 预览区分隔线拖拽
applyMdTheme(mdThemeMode);
applyTextStyle(readTextStyle());   // 还原用户设置的预览正文字号 / 字色
updateStats();
updateGutter();
updatePos();
renderShortcutHints();   // 在「⋯」菜单渲染快捷键提示
setupAudioDock();         // 底部常驻音频小窗（事件委托，仅挂载一次）

// 文库静默增量同步调度：联网即补传、定时兜底、持久化存储防清理
window.addEventListener('online', () => syncLibraryToNas());
window.addEventListener('offline', () => setSyncDot('idle', '离线'));
syncLibraryToNas();                                  // 启动补传（无改动则秒过）
setInterval(syncLibraryToNas, 3 * 60 * 1000);        // 每 3 分钟兜底
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});       // 请求持久化，避免文库被浏览器当缓存清
}
setSyncDot('idle', 'NAS 自动同步已就绪');

// === SECTION: Vanilla JS 微型 Vim 引擎 (Micro-Vim Engine) ===
// 适配原生 <textarea>，支持 Normal / Insert 模式与核心操作。
// 设计要点：
// - #vimBlockCursor 必须是 .editor-wrap 的子元素（.editor-wrap 为
// position:relative），这样 editor.offsetLeft/Top 与 getTextareaCaretPos
// 返回的内容坐标才共用同一参考系，方块光标才能精准贴合字符。
// - keydown 以【捕获阶段】注册，抢在 editor 自带的 Tab 缩进处理（冒泡阶段）
// 之前拦截，避免 Normal 模式下按 Tab 误插入空格。
// - j/k 移动后只滚动、不重置光标列（scrollEditorToLine 会把光标跳到行首）。

let isVimMode = localStorage.getItem('md-vim-mode') === '1';
let vimState = 'normal';            // 'normal' | 'insert'
let vimBuffer = '';                 // 组合键缓存，如 'd' 等待下一个 'd'
let vimIdealColumn = -1;            // j/k 垂直移动的理想列（跨短行记忆、回长行回弹）；-1 表示需以当前列为基准重算
const vimStatusEl = $('#vimStatus');
const vimBlockCursor = $('#vimBlockCursor');
const menuVimToggle = $('#menuVim');

// 切换 Vim 模式（由「⋯」菜单 data-act="vim" 触发）
function toggleVimMode() {
  isVimMode = !isVimMode;
  localStorage.setItem('md-vim-mode', isVimMode ? '1' : '0');
  vimState = 'normal';
  vimBuffer = '';
  if (menuVimToggle) menuVimToggle.textContent = '🟩 Vim 模式：' + (isVimMode ? '开' : '关');
  updateVimUI();
  if (isVimMode) editor.focus();
}

// 刷新界面：状态栏文字 + 方块光标（仅 Normal 模式显示）
function updateVimUI() {
  if (menuVimToggle) menuVimToggle.textContent = '🟩 Vim 模式：' + (isVimMode ? '开' : '关');

  if (!isVimMode) {
    if (vimStatusEl) vimStatusEl.hidden = true;
    if (vimBlockCursor) vimBlockCursor.hidden = true;
    if (editor.parentElement) editor.parentElement.classList.remove('vim-normal');
    return;
  }

  if (vimStatusEl) {
    vimStatusEl.hidden = false;
    vimStatusEl.textContent = vimState === 'normal'
      ? (vimBuffer ? `-- NORMAL (${vimBuffer}) --` : '-- NORMAL --')
      : '-- INSERT --';
  }

  if (vimState === 'normal') {
    if (editor.parentElement) editor.parentElement.classList.add('vim-normal');
    if (vimBlockCursor) {
      const pos = getTextareaCaretPos(editor, editor.selectionStart);
      const charWidth = parseInt(getComputedStyle(editor).fontSize, 10) * 0.6;   // 等宽字体近似字宽
      vimBlockCursor.style.left = (editor.offsetLeft + pos.left - editor.scrollLeft) + 'px';
      vimBlockCursor.style.top = (editor.offsetTop + pos.top - editor.scrollTop) + 'px';
      vimBlockCursor.style.width = Math.max(charWidth, 8) + 'px';
      vimBlockCursor.style.height = (pos.height || 25) + 'px';
      vimBlockCursor.hidden = false;
    }
  } else {
    if (editor.parentElement) editor.parentElement.classList.remove('vim-normal');
    if (vimBlockCursor) vimBlockCursor.hidden = true;
  }
}

// 光标移动 / 滚动 / 点击时刷新方块光标位置
editor.addEventListener('select', updateVimUI);
editor.addEventListener('scroll', updateVimUI);
editor.addEventListener('click', () => { if (isVimMode) updateVimUI(); });

// 半页行数（Ctrl+D / Ctrl+U 用）
function vimHalfPage() {
  const lh = parseFloat(getComputedStyle(editor).lineHeight) || 25;
  const pageRows = Math.floor(editor.clientHeight / lh) || 1;
  return Math.max(1, Math.floor(pageRows / 2));
}

// 安全替换 textarea 区间文本并保留原生撤销栈（避免 editor.value= 清空撤销历史，使 Vim 的 u 失效）
// 优先 execCommand('insertText')（触发 input 事件、保留 Undo）；极旧环境兜底 setRangeText（会丢撤销栈）
function replaceTextSafely(start, end, newText, caretPos) {
  editor.focus();
  editor.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, newText); } catch (_) { ok = false; }
  if (!ok) {
    pushUndo('Vim 编辑');                     // execCommand 不可用时退回手动改写，需自行补撤销点
    editor.setRangeText(newText, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  const cp = (caretPos == null) ? (start + newText.length) : caretPos;
  editor.selectionStart = editor.selectionEnd = cp;
}

// 按行移动光标（n>0 下、n<0 上），保持理想列（短行钳到行尾、回长行回弹）；Ctrl+M 时 toLineStart=true 移到行首
function vimMoveByLines(n, toLineStart) {
  const val = editor.value;
  const s = editor.selectionStart;
  const curLineStart = val.lastIndexOf('\n', s - 1) + 1;
  const curCol = s - curLineStart;
  const lines = val.split('\n');
  const curIdx = val.slice(0, s).split('\n').length - 1;
  let targetIdx = curIdx + n;
  if (targetIdx < 0) targetIdx = 0;
  if (targetIdx >= lines.length) targetIdx = lines.length - 1;
  const tgtLine = lines[targetIdx];

  let col;
  if (toLineStart) {
    col = 0;
    vimIdealColumn = -1;                                   // 行首移动后重置理想列
  } else {
    if (vimIdealColumn === -1) vimIdealColumn = curCol;    // 首次进入垂直序列，以当前列为基准
    col = Math.min(vimIdealColumn, tgtLine.length);         // 钳到目标行实际长度；理想列本身保留，便于回弹
  }

  let pos = 0;
  for (let i = 0; i < targetIdx; i++) pos += lines[i].length + 1;
  pos += col;
  editor.selectionStart = editor.selectionEnd = pos;
  const lh = parseFloat(getComputedStyle(editor).lineHeight) || 25;
  const targetTop = targetIdx * lh;
  // 双向滚动：目标行在视口上/下边界外时，将其带入视口
  const viewTop = editor.scrollTop;
  const viewBottom = viewTop + editor.clientHeight;
  if (targetTop < viewTop) editor.scrollTop = Math.max(0, targetTop - lh);
  else if (targetTop + lh > viewBottom) editor.scrollTop = targetTop - editor.clientHeight + lh;
}

// 拦截类 Vim 按键的统一收尾：阻止默认 + 冒泡 + 刷新方块光标
function finishVimKey(e) {
  e.preventDefault();
  e.stopPropagation();
  updateVimUI();
}

// 核心：键盘拦截与状态机（捕获阶段，优先于 Tab 缩进）
function vimKeydown(e) {
  if (!isVimMode) return;
  // IME 组合输入进行中（中文/日文等输入法拼音上屏阶段）：放行所有按键，
  // 否则 Normal 模式下 e.preventDefault() 会把拼音 hjkl 当 Vim 指令吞掉，中文根本进不去
  if (e.isComposing || e.keyCode === 229) return;

  // --- Insert 模式：仅 Esc / Ctrl+[ 退回 Normal，其余交给浏览器正常输入 ---
  if (vimState === 'insert') {
    if (e.key === 'Escape' || (e.key === '[' && e.ctrlKey)) {
      e.preventDefault();
      vimState = 'normal';
      editor.selectionStart = editor.selectionEnd = Math.max(0, editor.selectionStart - 1); // 退回一格
      updateVimUI();
    }
    return;
  }

  // --- Normal 模式 ---
  if (e.metaKey) return;                 // Cmd/Win 组合交给系统/快捷键系统
  if (e.altKey) return;                  // Alt 组合放行
  // Vim 专用的 Ctrl 组合在此拦截处理；其余 Ctrl（如 Ctrl+S 保存）放行给快捷键系统
  if (e.ctrlKey) {
    const ck = (e.key || '').toLowerCase();
    if (ck === 'd') { vimMoveByLines(vimHalfPage(), false); finishVimKey(e); return; }
    if (ck === 'u') { vimMoveByLines(-vimHalfPage(), false); finishVimKey(e); return; }
    if (ck === 'm') { vimMoveByLines(1, true); finishVimKey(e); return; }
    if (ck === '[') { editor.selectionStart = editor.selectionEnd = Math.max(0, editor.selectionStart - 1); vimState = 'normal'; finishVimKey(e); return; }
    return;  // 其它 Ctrl 组合（Ctrl+S 等）放行
  }
  if (e.key === 'Shift' || e.key === 'CapsLock') return;
  e.preventDefault();
  e.stopPropagation();                                       // 阻断 editor 的 Tab 缩进等冒泡处理

  const val = editor.value;
  let s = editor.selectionStart;
  const key = e.key;   // Vim 中大小写代表不同指令（A=行尾插入 / a=后插入，G=跳文末 / g=gg 缓冲），不归一化
  // 非上下移动（j/k）即重置理想列，使下次垂直移动以当前光标列为基准
  if (key !== 'j' && key !== 'k') vimIdealColumn = -1;

  // 1. 双键组合（dd / yy / gg）
  if (vimBuffer) {
    if (vimBuffer === 'd' && key === 'd') {
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = val.indexOf('\n', s);
      if (lineEnd === -1) lineEnd = val.length; else lineEnd++;
      const lineText = val.slice(lineStart, lineEnd);
      vimIdealColumn = -1;
      replaceTextSafely(lineStart, lineEnd, '', lineStart);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lineText).catch(() => {});
    } else if (vimBuffer === 'y' && key === 'y') {
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = val.indexOf('\n', s);
      if (lineEnd === -1) lineEnd = val.length; else lineEnd++;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val.slice(lineStart, lineEnd)).catch(() => {});
      toast('已复制当前行');
    } else if (vimBuffer === 'g' && key === 'g') {
      editor.selectionStart = editor.selectionEnd = 0;
      editor.scrollTop = 0;
    }
    vimBuffer = '';
    updateVimUI();
    return;
  }

  // 2. 模式切换
  if (key === 'i') {
    vimState = 'insert';
  } else if (key === 'a') {
    editor.selectionStart = editor.selectionEnd = Math.min(val.length, s + 1);
    vimState = 'insert';
  } else if (key === 'A') {
    let lineEnd = val.indexOf('\n', s);
    if (lineEnd === -1) lineEnd = val.length;
    editor.selectionStart = editor.selectionEnd = lineEnd;
    vimState = 'insert';
  } else if (key === 'I') {
    const lineStart = val.lastIndexOf('\n', s - 1) + 1;
    editor.selectionStart = editor.selectionEnd = lineStart;
    vimState = 'insert';
  } else if (key === 'o') {
    let lineEnd = val.indexOf('\n', s);
    if (lineEnd === -1) lineEnd = val.length;
    vimIdealColumn = -1;
    replaceTextSafely(lineEnd, lineEnd, '\n', lineEnd + 1);
    vimState = 'insert';
  } else if (key === 'O') {
    const lineStart = val.lastIndexOf('\n', s - 1) + 1;
    vimIdealColumn = -1;
    replaceTextSafely(lineStart, lineStart, '\n', lineStart);
    vimState = 'insert';
  }

  // 3. 光标移动 hjkl + 行列端点
  else if (key === 'h') {
    if (s > 0 && val[s - 1] !== '\n') editor.selectionStart = editor.selectionEnd = s - 1;
  } else if (key === 'l') {
    if (s < val.length && val[s] !== '\n') editor.selectionStart = editor.selectionEnd = s + 1;
  } else if (key === 'j') {
    vimMoveByLines(1, false);
  } else if (key === 'k') {
    vimMoveByLines(-1, false);
  } else if (key === '0') {
    editor.selectionStart = editor.selectionEnd = val.lastIndexOf('\n', s - 1) + 1;
  } else if (key === '$') {
    let lineEnd = val.indexOf('\n', s);
    editor.selectionStart = editor.selectionEnd = lineEnd === -1 ? val.length : lineEnd;
  } else if (key === 'G') {
    editor.selectionStart = editor.selectionEnd = val.length;
    editor.scrollTop = editor.scrollHeight;
  } else if (key === 'g') {
    vimBuffer = 'g';                          // 单 g：等待第二个 g（gg 跳文首）
  }

  // 4. 编辑与操作
  else if (key === 'x') {
    if (s < val.length && val[s] !== '\n') {
      vimIdealColumn = -1;
      replaceTextSafely(s, s + 1, '', s);
    }
  } else if (key === 'u') {
    document.execCommand('undo');
  } else if (key === 'p') {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((clip) => {
        if (!clip) return;
        vimIdealColumn = -1;
        replaceTextSafely(s + 1, s + 1, clip, s + 1 + clip.length);
      }).catch(() => {});
    } else {
      toast('当前环境不支持读取剪贴板');
    }
  } else if (key === 'd' || key === 'y') {
    vimBuffer = key;                          // 进入等待双键状态
  }

  // 移动后滚动（j/k/Ctrl+D/U 已在 vimMoveByLines 内处理滚动，这里补全其余移动的滚动）
  if (editor.selectionStart !== s && key !== 'j' && key !== 'k') {
    const ln = val.slice(0, editor.selectionStart).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 25;
    editor.scrollTop = Math.max(0, ln * lh - editor.clientHeight / 3);
  }
  updateVimUI();
}
editor.addEventListener('keydown', vimKeydown, true);   // 捕获阶段：优先于 Tab 缩进

// 初始化：依据 localStorage 还原开关状态与初始标签
updateVimUI();

// 多标签页草稿同步：其他标签页更新 md-draft 时提示（不自动覆盖当前输入，避免丢字）
window.addEventListener('storage', (e) => {
  if (!e || e.key !== 'md-draft' || e.newValue == null) return;
  if (e.newValue !== editor.value) {
    toast('另一标签页已更新草稿，当前页内容可能过期，请手动刷新', 'info', 5000);
  }
});

// === SECTION: 错误日志环形缓冲（让用户在真机上也能自证问题） ===
// 旧实现用 preventDefault() 把所有 rejection 吞掉，只闪一次 toast：
// 用户报「出问题了」时既看不到细节，也没法取证。这里保留最近 50 条，可一键复制。
let lastErrToastAt = 0;
function toastGlobalErr(msg) {
  const now = Date.now();
  if (now - lastErrToastAt < 2000) return;   // 2s 内只提示一次，避免连发刷屏
  lastErrToastAt = now;
  toast('⚠️ ' + msg, 'err', 5000);
}

const ERR_LOG_MAX = 50;
const errLog = [];
function logError(kind, msg, extra) {
  errLog.push({ at: new Date().toISOString(), kind, msg: String(msg || '').slice(0, 500), extra: extra ? String(extra).slice(0, 500) : '' });
  if (errLog.length > ERR_LOG_MAX) errLog.shift();
}
window.addEventListener('error', (e) => {
  logError('error', (e && e.message) || '未知脚本错误', e && e.filename ? e.filename + ':' + e.lineno : '');
  toastGlobalErr((e && e.message) || '未知脚本错误');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  logError('rejection', (r && r.message) || String(r || '未处理 Promise 错误'), r && r.stack);
  if (e && e.preventDefault) e.preventDefault();
  toastGlobalErr((r && r.message) || String(r || '未处理 Promise 错误'));
});

// 诊断信息：Ctrl/Cmd + Alt + Shift + D，或「⋯ → 🩺 诊断信息」
function diagnosticsText() {
  let storage = 'n/a';
  try {
    let ls = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls += (k.length + String(localStorage.getItem(k) || '').length) * 2;
    }
    storage = humanBytes(ls);
  } catch (_) {}
  const ua = navigator.userAgent;
  return [
    '# mdviewer 诊断信息',
    '',
    '- 版本：' + APP_VERSION,
    '- 时间：' + new Date().toLocaleString('zh-CN'),
    '- 页面：' + location.href,
    '- 视口：' + window.innerWidth + '×' + window.innerHeight + '（dpr ' + (window.devicePixelRatio || 1) + '）',
    '- 视图模式：' + viewMode + ' · 换行：' + (wrapMode ? '开' : '关') + ' · Vim：' + (isVimMode ? '开' : '关'),
    '- 文档：' + (currentName || '') + '（' + countWords(editor.value).words + ' 字）' + (currentLibId ? ' · 文库' : ''),
    '- 文库：' + (libDocsCache ? libDocsCache.length + ' 篇' : '未加载') + ' · localStorage 占用 ' + storage,
    '- 库版本：md-core ' + (Core ? '已加载' : '缺失') + ' · SW ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? '已接管' : '未接管'),
    '- UA：' + ua,
    '',
    '## 最近错误（' + errLog.length + ' 条）',
    errLog.length ? errLog.map((x) => '- [' + x.at + '] ' + x.kind + '：' + x.msg + (x.extra ? '\n  ' + x.extra : '')).join('\n') : '（无）',
  ].join('\n');
}

let diagModalEl = null;
function showDiagnostics() {
  const text = diagnosticsText();
  if (!diagModalEl) {
    diagModalEl = document.createElement('div');
    diagModalEl.id = 'diagModal';
    diagModalEl.className = 'modal';
    diagModalEl.hidden = true;          // 必须初始隐藏：观察的是 hidden 属性「变化」
    diagModalEl.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true" aria-label="诊断信息">' +
        '<div class="modal-title">🩺 诊断信息</div>' +
        '<p class="modal-desc">反馈问题时附上这段文本，能省掉一半排查时间。</p>' +
        '<textarea id="diagText" class="share-url" readonly spellcheck="false" rows="14"></textarea>' +
        '<div class="modal-actions">' +
          '<button type="button" id="diagCopy">复制</button>' +
          '<button type="button" id="diagClose" data-modal-close class="primary">关闭</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(diagModalEl);
    diagModalEl.querySelector('#diagClose').addEventListener('click', () => { diagModalEl.hidden = true; });
    diagModalEl.querySelector('#diagCopy').addEventListener('click', async () => {
      const t = diagModalEl.querySelector('#diagText');
      t.select();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t.value);
        else fallbackCopy(t.value);
        toast('已复制诊断信息', 'ok');
      } catch (_) { fallbackCopy(t.value); }
    });
    diagModalEl.addEventListener('click', (e) => { if (e.target === diagModalEl) diagModalEl.hidden = true; });
    enhanceModal(diagModalEl);          // 动态元素也要接入焦点陷阱
  }
  diagModalEl.querySelector('#diagText').value = text;
  diagModalEl.hidden = false;
}

// === SECTION: 弹窗可访问性（焦点陷阱 + 背景 inert + 焦点归还） ===
// 12 个弹窗原先各写各的 Esc，且 Tab 能跑到背景上去。这里用「统一观察 hidden 属性」的
// 方式一次性接管，避免逐个改动 12 处调用点（低风险、全覆盖）。
const modalStack = [];
const modalReturnFocus = new WeakMap();

function modalFocusables(m) {
  return Array.from(m.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onModalOpen(m) {
  modalStack.push(m);
  modalReturnFocus.set(m, document.activeElement);
  const appEl = document.querySelector('.app');
  if (appEl) appEl.inert = true;               // 背景不可聚焦（Chrome/Safari/FF 均支持）
  const box = m.querySelector('.modal-box') || m;
  if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
  const first = modalFocusables(m)[0];
  (first || box).focus({ preventScroll: true });
}

function onModalClose(m) {
  const i = modalStack.indexOf(m);
  if (i >= 0) modalStack.splice(i, 1);
  if (!modalStack.length) {
    const appEl = document.querySelector('.app');
    if (appEl) appEl.inert = false;
    const prev = modalReturnFocus.get(m);
    if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
  }
}

function enhanceModal(m) {
  let wasHidden = m.hidden;
  new MutationObserver(() => {
    if (wasHidden && !m.hidden) onModalOpen(m);
    else if (!wasHidden && m.hidden) onModalClose(m);
    wasHidden = m.hidden;
  }).observe(m, { attributes: true, attributeFilter: ['hidden'] });
}

function enhanceModals() {
  document.querySelectorAll('.modal').forEach(enhanceModal);
}

// Tab 在弹窗内循环；Esc 落到最上层弹窗的「取消/关闭」按钮上兜底
document.addEventListener('keydown', (e) => {
  if (!modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  if (e.key === 'Escape' && !e.defaultPrevented) {
    // 只走「点关闭按钮」这条路：强行 hidden 会让 askConfirm/askInput 的 Promise 永远挂起。
    // 没有统一关闭按钮的弹窗（少数）交回给它自己的 keydown 处理。
    const closer = top.querySelector(
      '[data-modal-close],#aiSettingsCancel,#fbCustClose,#qcmClose,#bgClose,#tsClose,' +
      '#shareClose,#blogClose,#imaClose,#confirmModalCancel,#promptModalCancel'
    );
    if (closer) { e.preventDefault(); closer.click(); }
    return;
  }
  if (e.key !== 'Tab') return;
  const items = modalFocusables(top);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);

// === SECTION: 菜单键盘导航（role=menu 应支持上下键，而不是只能 Tab） ===
document.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const menu = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('[role="menu"]')
    : null;
  if (!menu || menu.hidden) return;
  const items = Array.from(menu.querySelectorAll('button[role="menuitem"],button:not([hidden])'))
    .filter((b) => !b.disabled && b.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let next = 0;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  e.preventDefault();
  items[next].focus();
}, true);

// === SECTION: 全库备份 / 恢复（IndexedDB 是唯一副本，清站点数据即全丢） ===
// ZIP 读写实现在 lib/md-core.js（zipStore / unzipStore），零依赖且已单测。
function backupFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return 'mdviewer-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';
}

async function exportBackup() {
  try {
    await openLibDb();
    if (!libDb) { toast('本地库不可用，无法备份', 'err'); return; }
    const docs = await idbGetAll();
    const keys = await idbGetAllImageKeys();
    if (!docs.length) { toast('文库为空，无需备份', 'info'); return; }
    toast('正在打包 ' + docs.length + ' 篇文档…', 'info');

    const enc = new TextEncoder();
    const files = [];
    const manifest = { app: 'mdviewer', version: APP_VERSION, exportedAt: new Date().toISOString(), docs: docs.length, images: keys.length };
    files.push({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });

    for (const d of docs) {
      const body = d.content || '';
      files.push({ name: 'docs/' + d.id + '.md', data: enc.encode(body) });
      const snaps = (await readHistory(d.id).catch(() => [])).map((h) => ({ at: h.at, summary: h.summary, truncated: !!h.truncated }));
      const meta = {
        id: d.id, name: d.name || '未命名.md', updatedAt: d.updatedAt || null,
        autoName: !!d.autoName, history: snaps,
      };
      files.push({ name: 'docs/' + d.id + '.json', data: enc.encode(JSON.stringify(meta, null, 2)) });
    }
    for (const id of keys) {
      try {
        const rec = await idbGetImage(id);
        if (rec && rec.blob) files.push({ name: 'images/' + id, data: new Uint8Array(await rec.blob.arrayBuffer()) });
      } catch (_) {}
    }
    const zip = zipStore(files);
    download(backupFileName(), zip, 'application/zip');
    toast('✅ 已导出备份：' + docs.length + ' 篇 / ' + humanBytes(zip.length), 'ok', 5000);
  } catch (e) {
    toast('备份失败：' + (e.message || e), 'err', 6000);
  }
}

const backupFileInput = document.createElement('input');
backupFileInput.type = 'file';
backupFileInput.accept = '.zip,application/zip';
backupFileInput.hidden = true;
document.body.appendChild(backupFileInput);

backupFileInput.addEventListener('change', async () => {
  const f = backupFileInput.files && backupFileInput.files[0];
  backupFileInput.value = '';
  if (!f) return;
  try {
    await openLibDb();
    const entries = await unzipStore(new Uint8Array(await f.arrayBuffer()));
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    const dec = new TextDecoder();
    const docIds = entries
      .map((e) => e.name)
      .filter((n) => /^docs\/.+\.md$/.test(n))
      .map((n) => n.slice(5, -3));
    if (!docIds.length) { toast('备份里没有找到文档', 'warn'); return; }
    if (!(await askConfirm('从备份恢复', '将导入 ' + docIds.length + ' 篇文档（同名 id 会被覆盖，不会删除现有文档）。继续？'))) return;

    let ok = 0;
    for (const id of docIds) {
      const body = dec.decode(byName.get('docs/' + id + '.md'));
      let meta = {};
      try { meta = JSON.parse(dec.decode(byName.get('docs/' + id + '.json'))); } catch (_) {}
      await idbPut({
        id, name: meta.name || id + '.md', content: body,
        updatedAt: meta.updatedAt || Date.now(), autoName: !!meta.autoName,
      });
      ok++;
    }
    let imgs = 0;
    for (const [name, data] of byName) {
      if (!name.startsWith('images/')) continue;
      try {
        await idbPutImage({ id: name.slice(7), name: name.slice(7), type: 'application/octet-stream', blob: new Blob([data]) });
        imgs++;
      } catch (_) {}
    }
    await renderLibrary();
    toast('✅ 已恢复 ' + ok + ' 篇文档 / ' + imgs + ' 张图片', 'ok', 6000);
  } catch (e) {
    toast('恢复失败：' + (e.message || e), 'err', 6000);
  }
});

// 统一入口：菜单 / 快捷键
function importBackup() { backupFileInput.click(); }

// 启动时挂载弹窗增强
enhanceModals();
