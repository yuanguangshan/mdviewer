'use strict';

const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const preview = $('#preview');
const previewPane = $('#previewPane');
const gutter = $('#gutter');
const editorHighlight = $('#editorHighlight');
const fileInput = $('#fileInput');

// 自愈守卫：关键按钮（#btnMore）缺失 = SW 更新过渡期 HTML/JS 版本错配。
// 旧版用 sessionStorage 仅限一次刷新，若错配持续（SW 一直没切到新版本）则无能为力；
// 改为 localStorage + 时间戳，60s 冷却窗口内最多自愈一次：既防刷新死循环，
// 又允许错配持续时在下个冷却窗口重新拉取一致版本。
const SELFHEAL_KEY = 'md-selfheal-ts';
const SELFHEAL_COOLDOWN_MS = 60 * 1000;
if (!document.querySelector('#btnMore')) {
  const last = Number(localStorage.getItem(SELFHEAL_KEY) || 0);
  const now = Date.now();
  if (now - last > SELFHEAL_COOLDOWN_MS) {
    localStorage.setItem(SELFHEAL_KEY, String(now));
    location.reload();
  }
}

/* ===================== SECTION INDEX ===================== */
// 机器可解析分区标记统一格式： // === SECTION: <标题> ===
// 提取正则： ^// === SECTION: (.+) ===$
//   小工具
//   DOMPurify：放行自定义图片方案 libimg://（Blob 入库后引用）
//   主题：auto / light / dark，auto 跟随系统
//   预览主题：github / onedark / solarized / nord（独立于 app 主题）
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
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// === SECTION: DOMPurify：放行自定义图片方案 libimg://（Blob 入库后引用） ===
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
      node.setAttribute('src', 'libimg://' + node.getAttribute('data-libimg'));
      node.removeAttribute('data-libimg');
    }
  });
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

// === SECTION: 预览主题：github / onedark / solarized / nord（独立于 app 主题） ===
const MD_THEME_CYCLE = ['github', 'onedark', 'solarized', 'nord'];
const MD_THEME_LABEL = { github: 'GitHub', onedark: 'One Dark', solarized: 'Solarized', nord: 'Nord' };
let mdThemeMode = localStorage.getItem('md-mdtheme') || 'github';
if (!MD_THEME_CYCLE.includes(mdThemeMode)) mdThemeMode = 'github';
function applyMdTheme(mode) {
  mdThemeMode = mode;
  document.documentElement.setAttribute('data-md-theme', mode);
  localStorage.setItem('md-mdtheme', mode);
  document.querySelectorAll('[data-act="mdtheme"]').forEach((b) => {
    b.textContent = (b.dataset.val === mode ? '✓ ' : '') + MD_THEME_LABEL[b.dataset.val];
  });
}

// === SECTION: 渲染 + 代码高亮 ===
let renderTimer = null;
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
    mermaidLoading = loadScript('./vendor/mermaid.min.js').catch((e) => { console.warn(e); return false; });
  }
  const ok = await mermaidLoading;
  if (ok && window.mermaid && !mermaidReady) {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
    mermaidReady = true;
  }
  return !!window.mermaid;
}
// 渲染流程图（仅在文档含 mermaid 代码块且库尚未加载时，才去懒加载 mermaid）
async function renderMermaidDiagrams() {
  if (!preview.querySelector('pre code.language-mermaid')) return;
  const ok = await ensureMermaid();
  if (!ok) return;
  try {
    const mermaidEls = preview.querySelectorAll('pre code.language-mermaid');
    mermaidEls.forEach((el, idx) => {
      const parent = el.parentElement;
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-wrapper';
      wrapper.id = 'mermaid-' + Date.now() + '-' + idx;
      wrapper.textContent = el.textContent;
      parent.replaceWith(wrapper);
    });
    window.mermaid.run({ nodes: preview.querySelectorAll('.mermaid-wrapper') });
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
      .catch((e) => { console.warn(e); return false; });
  }
  return katexLoading;
}
// 仅当文档确有公式定界符（$$…$$ / $…$ / \(…\) / \[…\]）时才懒加载 KaTeX
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
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    });
  } catch (e) {
    console.warn('KaTeX 渲染失败:', e);
  }
}
function renderMarkdown() {
  const src = editor.value || '';
  let html;
  // --- 空状态：展示欢迎卡片，而非斜体占位符 ---
  if (!src.trim()) {
    html = '<div class="welcome-card">'
      + '<div class="welcome-emoji">✍️</div>'
      + '<h2>开始创作</h2>'
      + '<p class="welcome-sub">支持 <kbd>Ctrl+S</kbd> 保存 · <kbd>Ctrl+O</kbd> 打开</p>'
      + '<p class="welcome-note">拖拽/粘贴图片 · 语法高亮 · 多主题预览 · 📚 文库自动回写</p>'
      + '</div>';
  } else {
    try {
      html = window.marked ? marked.parse(src, { breaks: true, gfm: true }) : '<pre>' + escapeHtml(src) + '</pre>';
    } catch (e) {
      html = '<p style="color:#e06c75">渲染错误：' + escapeHtml(e.message) + '</p>';
    }
  }
  preview.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  // 后处理高亮：对任何 marked 版本都稳，且不依赖已废弃的 setOptions({highlight})
  if (window.hljs) {
    preview.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (_) {}
    });
  }
  // --- Mermaid 图表渲染（按需懒加载 mermaid 库，见 renderMermaidDiagrams）---
  renderMermaidDiagrams();
  // --- KaTeX 数学公式渲染（按需懒加载 katex 库，见 renderMathFormulas）---
  renderMathFormulas();
  // --- 标题加 id（支持页内锚点跳转），并建立「标题 slug → 源码行」映射，用于锚点同步滚动 ---
  headingLineMap = buildHeadingMap(editor.value);
  preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const id = slugify(h.textContent);
    if (id) h.id = id;   // 始终以 slug 为 id，保证与 buildHeadingMap 一致、锚点可跳转
  });
  buildToc();   // 同步重建右侧目录大纲（标题已就绪，含 id）
  lastSanitizedHtml = preview.innerHTML;   // 快照（含 libimg:// 引用，供导出时内联为 data URL）
  // --- 解析 Blob 图片引用（libimg://）→ 临时 object URL 渲染 ---
  resolveImages();
}

// === SECTION: 锚点同步滚动辅助 ===
let lastSanitizedHtml = '';
let headingLineMap = new Map();
let anchorNavLock = 0;
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
function buildHeadingMap(src) {
  const map = new Map();
  src.split('\n').forEach((line, i) => {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      const slug = slugify(m[1]);
      if (slug && !map.has(slug)) map.set(slug, i);
    }
  });
  return map;
}
function scrollEditorToLine(line) {
  const lines = editor.value.split('\n');
  let pos = 0;
  for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
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
  // 纯编辑模式（预览 display:none）无滚动上下文 → 高亮首个标题即可
  if (previewPane.clientHeight === 0) {
    setActiveTocItem(heads[0]);
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
let imgUrlCache = new Map();   // id -> { blob }
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
  const imgs = preview.querySelectorAll('img[src^="libimg://"]');
  if (!imgs.length) return;
  const newUrls = new Set();
  const pending = [];
  imgs.forEach((img) => {
    const id = img.getAttribute('src').slice('libimg://'.length);
    pending.push((async () => {
      let entry = imgUrlCache.get(id);
      if (!entry) {
        try {
          const rec = await idbGetImage(id);
          if (!rec || !rec.blob) { img.classList.add('broken'); return; }
          entry = { blob: rec.blob };
          imgUrlCache.set(id, entry);
        } catch (_) { img.classList.add('broken'); return; }
      }
      const url = URL.createObjectURL(entry.blob);
      newUrls.add(url);
      img.src = url;
      img.classList.remove('broken');
    })());
  });
  Promise.all(pending).then(() => {
    activeImgUrls.forEach((u) => { if (!newUrls.has(u)) URL.revokeObjectURL(u); });
    activeImgUrls = newUrls;
  });
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderMarkdown, 120);
}

// === SECTION: 编辑器源码高亮：textarea 之上叠一层 <pre>，复用 hljs 自带 markdown 语法 ===
function renderEditorHighlight() {
  // 移动端（软换行）或缺 markdown 语法时不启用：避免错位 / 降级为纯文本
  if (window.innerWidth <= 760 || !window.hljs || !hljs.getLanguage || !hljs.getLanguage('markdown')) {
    editor.parentElement.classList.remove('has-overlay');
    editorHighlight.textContent = '';
    return;
  }
  try {
    editorHighlight.innerHTML = hljs.highlight(editor.value, { language: 'markdown' }).value;
    editor.parentElement.classList.add('has-overlay');
    syncHighlightScroll();
  } catch (_) {
    editor.parentElement.classList.remove('has-overlay');
  }
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
  const t = editor.value;
  const cjkRe = /[一-鿿぀-ヿ가-힯]/g;
  const cjk = (t.match(cjkRe) || []).length;                               // 中日韩按字
  const enWords = (t.replace(cjkRe, ' ').match(/[A-Za-z0-9]+/g) || []).length; // 其余按词
  const words = cjk + enWords;
  const readMin = Math.max(1, Math.round(words / 300));
  $('#stat').textContent = words + ' 字 · ' + readMin + ' 分';
}
function updateGutter() {
  const lines = editor.value.split('\n').length;
  if (gutter.dataset.lines === String(lines)) return;
  gutter.dataset.lines = String(lines);
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  gutter.textContent = s;   // white-space:pre 下逐行对齐 #editor（line-height:25px 一致）
}
function updatePos() {
  const v = editor.value, pos = editor.selectionStart;
  const before = v.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');   // 无换行时 lastIndexOf=-1 → col=pos+1（第 1 列起算）
  $('#posInfo').textContent = '行 ' + line + '，列 ' + col;
}

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
  $('#btnView').textContent = VIEW_LABEL[m];
  if (m !== 'preview') editor.focus();
  // 进入预览：rAF 等布局稳定后，把预览定位到编辑器当前所在章节（不回开头）
  if (firstLine !== null) requestAnimationFrame(() => syncPreviewToLine(firstLine));
}
// 是否手机布局（单列）：以实际 grid 为准，并用 matchMedia 兜底，保证手机只切「编辑/预览」
function isMobileLayout() {
  const g = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns;
  return g === '1fr' || g === '1fr 0px' || window.matchMedia('(max-width: 760px)').matches;
}
function nextView() {
  const cycle = isMobileLayout() ? ['edit', 'preview'] : VIEW_CYCLE;
  setView(cycle[(cycle.indexOf(viewMode) + 1) % cycle.length]);
}
$('#btnView').addEventListener('click', nextView);
// 手机默认纯编辑（上下叠放时双屏没法用），桌面默认双栏
{
  setView(isMobileLayout() ? 'edit' : 'split');
}

// === SECTION: 全屏：隐藏工具栏/状态栏（+ 尝试浏览器原生全屏），右上角 ✕ 退出 ===
const btnFullscreen = $('#btnFullscreen');
const btnExitFullscreen = $('#btnExitFullscreen');
function setFullscreen(on) {
  // 全屏时若文库抽屉开着，强制关闭，避免退出按钮（z-index:9999）盖在抽屉之上
  if (on && libDrawer && libDrawer.classList.contains('open')) closeLibrary();
  document.body.classList.toggle('fullscreen', on);
  if (btnExitFullscreen) btnExitFullscreen.hidden = !on;   // 用 hidden 属性显隐，默认隐藏（不依赖外部 CSS）
  // 兜底：直接控制 chrome 显隐，即使样式未及时更新也能全屏
  const tb = document.querySelector('.toolbar'), sb = document.querySelector('.statusbar');
  if (tb) tb.style.display = on ? 'none' : '';
  if (sb) sb.style.display = on ? 'none' : '';
  if (on) {
    const el = document.documentElement;
    if (el.requestFullscreen) { try { el.requestFullscreen(); } catch (_) {} }   // iOS 非视频不支持→仅应用级全屏
    if (btnExitFullscreen) btnExitFullscreen.classList.add('idle');   // 进入全屏：✕ 默认隐藏，双击呼出
  } else {
    if (btnExitFullscreen) btnExitFullscreen.classList.remove('idle');   // 退出全屏：恢复正常显示
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
});
if (btnFullscreen) btnFullscreen.addEventListener('click', () => setFullscreen(true));
if (btnExitFullscreen) btnExitFullscreen.addEventListener('click', () => setFullscreen(false));
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

// === SECTION: 草稿自动保存（去抖 + 静默 + 容错） ===
let curSaveClass = '';
let curSaveText = '就绪';
function setSaveState(cls, text) {
  curSaveClass = cls || '';
  curSaveText = text;
  const el = $('#saveState');
  el.className = curSaveClass;
  el.textContent = text;
}
const saveDraft = debounce(() => {
  setSaveState('saving', '保存中…');
  try {
    localStorage.setItem('md-draft', editor.value);
    localStorage.setItem('md-name', currentName);
    setSaveState('saved', '✓ 已保存');
  } catch (e) {
    setSaveState('saved', '草稿已满');
  }
}, 800);

let flashTimer = null;
function flash(msg) {
  const el = $('#saveState');
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
  el.textContent = currentName;
  el.title = currentName;
}
function loadDraft() {
  const draft = localStorage.getItem('md-draft');
  if (draft !== null) editor.value = draft;
  const name = localStorage.getItem('md-name');
  if (name) { currentName = name; currentNameIsAuto = false; }
  updateFileName();
}
function afterChange(opts) {
  renderMarkdown();
  renderEditorHighlight();
  updateStats();
  updateGutter();
  updatePos();
  saveDraft();
  if (!(opts && opts.skipWriteback)) writebackLibDebounced();   // 文库文档：编辑后去抖自动回写（打开/恢复时跳过，避免刷新时间戳）
}
editor.addEventListener('input', afterChange);
['keyup', 'click', 'select'].forEach((ev) => editor.addEventListener(ev, updatePos));

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
      updateFileName();
      afterChange();
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
    flash('已打开 ' + currentName);
  };
  reader.readAsText(f);
  fileInput.value = '';
});

// === SECTION: 保存 ===
$('#btnSave').addEventListener('click', saveFile);
async function saveFile() {
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
  if (editor.value.trim() && !confirm('新建文档？未保存的内容将丢失。')) return;
  currentLibId = null;                       // 顶部「新建」为独立草稿，脱离文库上下文
  localStorage.removeItem('md-lib-current');
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
function renameFile() {
  const n = prompt('文件名：', currentName);
  if (n && n.trim()) {
    currentName = n.trim();
    currentNameIsAuto = false;
    updateFileName();
    saveDraft();
    if (currentLibId) writebackLib();   // 文库文档：同步新文件名
  }
}

// === SECTION: 复制 HTML（复用预览结果） ===
async function copyHTML() {
  try {
    await navigator.clipboard.writeText(preview.innerHTML);
    flash('已复制 HTML');
  } catch {
    flash('复制失败');
  }
}
/* 复制渲染后的纯文本：克隆到可见处取 innerText，保证纯编辑视图（预览隐藏）下也有正确换行 */
async function copyText() {
  try {
    const clone = preview.cloneNode(true);
    clone.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(clone);
    const txt = clone.innerText;
    clone.remove();
    await navigator.clipboard.writeText(txt);
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
async function exportHTML() {
  let html = lastSanitizedHtml || preview.innerHTML;
  // 将 Blob 图片（libimg://id）内联为 data URL，使导出的 HTML 自包含、可独立打开
  if (libDb) {
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
  }
  const doc = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
    + escapeHtml(currentName) + '</title><style>' + EXPORT_CSS + '</style></head><body class="markdown-body">'
    + html + '</body></html>';
  download(currentName.replace(/\.(md|markdown|txt)$/i, '') + '.html', doc, 'text/html;charset=utf-8');
  flash('已导出 HTML');
}
async function exportPDF() {
  const pdfName = currentName.replace(/\.(md|markdown|txt)$/i, '') + '.pdf';
  if (!window.html2pdf) {
    flash('正在加载 PDF 模块…');
    try { await loadScript('./vendor/html2pdf.bundle.min.js'); } catch (e) { console.warn(e); }
    if (!window.html2pdf) { window.print(); return; }   // 加载失败降级系统打印
  }
  flash('正在生成 PDF…');
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
function commitText(next, label) {
  if (next === editor.value) { flash('文本无变化：' + label); return; }
  editor.value = next;
  afterChange();
  flash('已应用：' + label);
}

const TEXT_ACTIONS = {
  // 1. 全局查找替换（支持正则开关）
  searchReplace() {
    const target = window.prompt('要查找的文本（留空取消）：', '') || '';
    if (!target) { flash('已取消'); return; }
    const useRe = window.confirm('把查找内容当作正则表达式？(取消=纯文本)');
    const replacement = window.prompt('替换为：', '') || '';
    if (replacement === null) { flash('已取消'); return; }
    const src = editor.value;
    let out, count;
    if (useRe) {
      let re;
      try { re = new RegExp(target, 'g'); } catch (e) { flash('正则无效：' + e.message); return; }
      count = (src.match(re) || []).length;
      out = src.replace(re, replacement);
    } else {
      const parts = src.split(target);
      count = Math.max(0, parts.length - 1);
      out = parts.join(replacement);
    }
    if (count === 0) { flash('未找到匹配项：' + target); return; }
    commitText(out, `查找替换（${count} 处）`);
  },

  // 2. 中英文之间自动加空格（Typographic 美化）
  formatSpacing() {
    let t = editor.value
      .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
    commitText(t, '中英排版优化');
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
async function streamAiApi(promptText, systemPrompt, onToken, opts) {
  opts = opts || {};
  let cfg = readAiConfig();
  let apiKey = cfg.apiKey;
  const endpoint = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  const model = cfg.model || 'gpt-4o-mini';
  if (!apiKey) {
    apiKey = window.prompt('请输入 AI API Key（OpenAI / DeepSeek / 中转商，仅存本机）：', '');
    if (!apiKey) { toast('未配置 AI Key', 'err'); return null; }
    if (window.confirm('是否将此配置保留在本机 localStorage 以便下次使用？')) {
      try { localStorage.setItem(AI_CFG_KEY, JSON.stringify({ apiKey, endpoint, model })); } catch (_) {}
    }
  }
  if (!opts.quiet) toast('AI 正在思考…', 'info', 60000);
  let full = '';
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      signal: opts.signal || undefined,
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
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', sseMode = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const ch = j.choices && j.choices[0];
            const delta = (ch && ((ch.delta && ch.delta.content) || (ch.message && ch.message.content))) || '';
            if (delta) { full += delta; if (onToken) onToken(delta, full); }
          } catch (_) { /* keepalive / 非 JSON */ }
        }
      }
    }
    if (sseMode === false) {
      const data = JSON.parse(buffer.trim());
      full = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      if (onToken) onToken(full, full);
    }
    return full.trim();
  } catch (e) {
    if (e && e.name === 'AbortError') return full; // 主动停止：保留已生成内容
    console.error(e);
    toast('AI 调用失败：' + aiErrorHint(e, endpoint), 'err', 6000);
    return null;
  }
}
// 非流式便捷封装（一次性返回全文）
async function callAiApi(promptText, systemPrompt) {
  return streamAiApi(promptText, systemPrompt, null, { quiet: false });
}

// === SECTION: AI 流式打字机浮层 ===
let aiStreamAbort = null;   // 当前流式请求的 AbortController
let aiStreamApply = null;   // 完成后的"应用"回调
let aiStreamFull = '';      // 已生成全文

// 打开浮层并发起流式请求；文本实时追加到面板，点"应用"时调用 onApply(full)
function aiRunStream({ label, systemPrompt, promptText, onApply }) {
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
    if (r) aiStreamFull = r;
    else { panel.hidden = true; aiStreamApply = null; } // 出错
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
  aiGenerate() {
    const topic = window.prompt('请输入主题或提示词：', '');
    if (!topic) { toast('已取消', 'info'); return; }
    aiRunStream({
      label: 'AI 生成',
      systemPrompt: '你是一名专业的写作助手和 Markdown 排版专家。请根据用户给出的主题，撰写一篇结构清晰、Markdown 格式的中文文章（含标题、小节、要点），只输出正文：',
      promptText: topic,
      onApply: (full) => { insertAtCursor(full + '\n\n'); toast('AI 已生成并插入', 'ok'); }
    });
  },
  // 打开 AI 设置
  aiSettings() { openAiSettings(); }
};

/* AI 设置弹窗（BYOK） */
function openAiSettings() {
  const cfg = readAiConfig();
  const ep = $('#aiEndpoint'), md = $('#aiModel'), key = $('#aiKey');
  if (ep) ep.value = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  if (md) md.value = cfg.model || 'gpt-4o-mini';
  if (key) key.value = cfg.apiKey || '';
  const m = $('#aiSettingsModal');
  if (m) m.hidden = false;
}
function saveAiSettings() {
  const ep = $('#aiEndpoint').value.trim() || 'https://api.openai.com/v1/chat/completions';
  const md = $('#aiModel').value.trim() || 'gpt-4o-mini';
  const key = $('#aiKey').value.trim();
  if (!key) { toast('请填写 API Key', 'err'); return; }
  try { localStorage.setItem(AI_CFG_KEY, JSON.stringify({ endpoint: ep, model: md, apiKey: key })); } catch (_) {}
  const m = $('#aiSettingsModal');
  if (m) m.hidden = true;
  toast('AI 配置已保存（仅本机）', 'ok');
}
// 测试 AI 连接：用极小请求验证端点可达 + Key 有效（不插入正文，仅提示结果）
async function testAiConnection() {
  // 优先用表单里当前填写的值（可能还没点保存）
  const epEl = $('#aiEndpoint'), mdEl = $('#aiModel'), keyEl = $('#aiKey');
  const cfg = readAiConfig();
  const endpoint = (epEl && epEl.value.trim()) || cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  const model = (mdEl && mdEl.value.trim()) || cfg.model || 'gpt-4o-mini';
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
  $('#aiTest').addEventListener('click', testAiConnection);
  $('#aiSettingsCancel').addEventListener('click', () => { aiModal.hidden = true; });
  // 点击遮罩空白处关闭
  aiModal.addEventListener('click', (e) => { if (e.target === aiModal) aiModal.hidden = true; });
  // 回车保存 / Esc 关闭
  aiModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveAiSettings(); }
    else if (e.key === 'Escape') aiModal.hidden = true;
  });
}

// 协作分享弹窗：复制按钮 / 完成 / 遮罩 / Esc 关闭
const shareModal = $('#shareModal');
if (shareModal) {
  $('#shareCopyBtn').addEventListener('click', copyShareUrl);
  $('#shareCloseBtn').addEventListener('click', () => { shareModal.hidden = true; });
  shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !shareModal.hidden) shareModal.hidden = true; });

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
}

/* AI 流式打字机浮层按钮：应用 / 取消 / 停止 */
const aiStreamPanelEl = document.getElementById('aiStreamPanel');
if (aiStreamPanelEl) {
  document.getElementById('aspApply').addEventListener('click', () => {
    if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
    if (aiStreamApply) {
      const fn = aiStreamApply; aiStreamApply = null;
      fn(aiStreamFull);
    }
    aiStreamPanelEl.hidden = true;
  });
  document.getElementById('aspCancel').addEventListener('click', () => {
    if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
    aiStreamApply = null;
    aiStreamPanelEl.hidden = true;
  });
  document.getElementById('aspStop').addEventListener('click', () => {
    if (aiStreamAbort) { try { aiStreamAbort.abort(); } catch (_) {} aiStreamAbort = null; }
    // 停止后保留已生成内容，应用按钮仍可用
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

function showAiToolbar() {
  if (!aiToolbar) return;
  const s = editor.selectionStart, e = editor.selectionEnd;
  if (s === e) { hideAiToolbar(); return; } // 无选区则隐藏
  aiSel = { start: s, end: e };
  const pos = getTextareaCaretPos(editor, e);           // 选区末端坐标（内容坐标）
  const rect = editor.getBoundingClientRect();
  const x = rect.left + pos.left - editor.scrollLeft;   // 视口坐标
  const y = rect.top + pos.top - editor.scrollTop;
  aiToolbar.hidden = false;
  const tw = aiToolbar.offsetWidth, th = aiToolbar.offsetHeight;
  const left = Math.max(tw / 2 + 6, Math.min(x, window.innerWidth - tw / 2 - 6));
  aiToolbar.style.left = left + 'px';
  aiToolbar.style.top = y + 'px';
  // 上方空间不足则翻到选区下方
  const placeBelow = (y - th - 12) < 0;
  aiToolbar.style.transform = placeBelow
    ? 'translate(-50%, 12px)'
    : 'translate(-50%, calc(-100% - 12px))';
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
  const pos = getTextareaCaretPos(editor, e);   // 选区末端坐标（内容坐标）
  const rect = editor.getBoundingClientRect();
  const x = rect.left + pos.left - editor.scrollLeft;   // 视口坐标
  const y = rect.top + pos.top - editor.scrollTop;
  formatBrush.hidden = false;
  const tw = formatBrush.offsetWidth, th = formatBrush.offsetHeight;
  const left = Math.max(tw / 2 + 6, Math.min(x, window.innerWidth - tw / 2 - 6));
  formatBrush.style.left = left + 'px';
  formatBrush.style.top = y + 'px';
  const placeBelow = (y - th - 12) < 0;
  formatBrush.style.transform = placeBelow
    ? 'translate(-50%, 12px)'
    : 'translate(-50%, calc(-100% - 12px))';
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

// 点格式刷按钮：还原选区 → 套用对应格式（AI 按钮则展开 AI 浮层）
if (formatBrush) {
  formatBrush.addEventListener('mousedown', (e) => e.preventDefault()); // 防止抢焦点导致选区丢失
  formatBrush.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fmt]');
    if (!btn) return;
    const fmt = btn.dataset.fmt;
    if (fmt === 'ai') {            // 展开 AI 智能助理浮层
      hideFormatBrush();
      editor.focus();
      showAiToolbar();
      return;
    }
    hideFormatBrush();
    editor.focus();
    editor.setSelectionRange(fmtSel.start, fmtSel.end);
    if (FORMAT_ACTIONS && FORMAT_ACTIONS[fmt]) FORMAT_ACTIONS[fmt]();
  });
}

// 选区外点击 / 滚动 / Esc 时收起
document.addEventListener('mousedown', (ev) => {
  if (aiToolbar && !aiToolbar.hidden && !aiToolbar.contains(ev.target)) hideAiToolbar();
  if (formatBrush && !formatBrush.hidden && !formatBrush.contains(ev.target)) hideFormatBrush();
});
window.addEventListener('scroll', () => { hideAiToolbar(); hideFormatBrush(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideAiToolbar(); hideFormatBrush(); } });


// === SECTION: NAS 同步：上传 / 下载 ===
// 凭据不写死在代码里（避免随仓库泄露）。
// 首次上传时在本机弹窗输入一次，仅存入浏览器 localStorage（不上传、不入 git）。
const NAS_UPLOAD_URL = 'https://upload.want.biz/api/upload';
const NAS_DOWNLOAD_URL = 'https://upload.want.biz/api/uploads/download';
const NAS_ARCHIVE_DOMAIN = 'knowly.want.biz';
const NAS_ARCHIVE_HOST = 'https://knowly.want.biz';
const NAS_MAX_BYTES = 200 * 1024 * 1024;

function nasBasicAuth() {
  const auth = localStorage.getItem('nas-auth') || '';
  try { return auth ? 'Basic ' + btoa(auth) : ''; } catch (_) { return ''; }
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
  if (!editor.value.trim()) { flash('文档为空，无需上传'); return; }
  // 凭据缺失时本机输入一次，仅存 localStorage（不进仓库）
  let auth = localStorage.getItem('nas-auth') || '';
  if (!auth) {
    auth = window.prompt('请输入 NAS 上传凭据（格式 user:password，仅本机保存）：', '') || '';
    if (!auth) { flash('未配置 NAS 凭据，已取消上传'); return; }
    try { localStorage.setItem('nas-auth', auth); } catch (_) {}
  }
  let authHeader = '';
  try { authHeader = 'Basic ' + btoa(auth); } catch (_) { flash('凭据含非法字符，已取消'); return; }
  const blob = new Blob([editor.value], { type: 'text/markdown' });
  if (blob.size > NAS_MAX_BYTES) { flash('文件超过 200MB 上限，已取消'); return; }
  const name = currentName.replace(/\.(md|markdown|txt|html?|pdf)$/i, '') + '.md';
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
    const filename = extractNasFilename(s);
    if (!filename) { flash('无法解析 NAS 文件名'); return null; }
    url = NAS_DOWNLOAD_URL + '?filename=' + encodeURIComponent(filename);
    label = filename;
  }

  // 凭据缺失时本机输入一次，仅存 localStorage（不进仓库）
  let auth = localStorage.getItem('nas-auth') || '';
  if (!auth) {
    auth = window.prompt('请输入 NAS 下载凭据（格式 user:password，仅本机保存）：', '') || '';
    if (!auth) { flash('未配置 NAS 凭据，已取消下载'); return null; }
    try { localStorage.setItem('nas-auth', auth); } catch (_) {}
  }
  let authHeader = '';
  try { authHeader = 'Basic ' + btoa(auth); } catch (_) { flash('凭据含非法字符，已取消'); return null; }

  flash('正在从 NAS 下载：' + label + '…');
  try {
    const resp = await fetch(url, { headers: { 'Authorization': authHeader } });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg += '：' + j.error; } catch (_) {}
      throw new Error(msg);
    }
    return await resp.text();
  } catch (e) {
    console.error(e);
    flash('下载失败：' + e.message + '（服务端错误，检查 NAS 下载服务）');
    return null;
  }
}

// 解析并打开（供菜单与粘贴共用）：下载后作为独立草稿载入编辑器
async function nasOpen(input) {
  const filename = extractNasFilename(input);
  if (!filename) { flash('无法解析 NAS 文件名'); return; }
  const text = await downloadFromNas(input);
  if (text == null) return;
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
  const input = prompt('输入 NAS 文件名（如 180032_xxx.md）或 ' + NAS_ARCHIVE_DOMAIN + ' 归档链接：', '');
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
  try { docs = await idbGetAll(); } catch (_) { setSyncDot('error', '读取文库失败'); return; }
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
function openMoreMenu(open) {
  closeAllSubmenus();
  if (open) { moreMenu.removeAttribute('hidden'); btnMore.setAttribute('aria-expanded', 'true'); }
  else { moreMenu.setAttribute('hidden', ''); btnMore.setAttribute('aria-expanded', 'false'); }
}
btnMore.addEventListener('click', () => openMoreMenu(moreMenu.hasAttribute('hidden')));
document.addEventListener('click', (e) => {
  if (menuWrap.contains(e.target) || btnMore.contains(e.target)) return;
  if (!moreMenu.hasAttribute('hidden')) openMoreMenu(false);
  else closeAllSubmenus();
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
  if (act === 'rename') renameFile();
  else if (act === 'addtolib') addToLibrary();
  else if (act === 'publish-blog') publishToBlog();
  else if (act === 'publish-podcast') publishToPodcast();
  else if (act === 'nas-upload') uploadToNas();
  else if (act === 'nas-download') nasDownloadAndOpen();
  else if (act === 'copytext') copyText();
  else if (act === 'copymd') copyMarkdown();
  else if (act === 'copy') copyHTML();
  else if (act === 'md') exportMarkdown();
  else if (act === 'html') exportHTML();
  else if (act === 'pdf') exportPDF();
  else if (act === 'wrap') { wrapMode = !wrapMode; localStorage.setItem('md-wrap', wrapMode ? 'on' : 'off'); applyWrap(); }
  else if (act === 'theme') applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3]);
  else if (act === 'mdtheme') applyMdTheme(btn.dataset.val);
  else if (act === 'vim') toggleVimMode();
  else if (act === 'share-r2') shareViaR2();
  else if (act === 'layout-swap') toggleLayoutSwap();
  else if (act === 'layout-reset') resetLayout();
});

// === SECTION: 发布到博客（POST /api/publish，逻辑提取自 Taio Action，改用浏览器 fetch） ===
// 博客后端地址：如需自托管，仅改这一行即可（与 R2_WORKER_URL 同属「唯一后端耦合点」约定）。
const BLOG_PUBLISH_URL = 'https://api.yuangs.cc/api/publish';
const BLOG_TARGETS = ['blog'];
const BLOG_TITLE_MAX_LEN = 40;

// 默认标签：年月（如 202607）
function defaultBlogTags() {
  const d = new Date();
  return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
}

// 智能截断为标题：优先按句号/问号/感叹号/换行截断，再按长度截断
function blogSmartCut(str, maxLen) {
  const s = str.replace(/\s+/g, ' ').trim();
  const idx = [
    s.indexOf('。'), s.indexOf('！'), s.indexOf('？'),
    s.indexOf('. '), s.indexOf('! '), s.indexOf('? '), s.indexOf('\n')
  ].filter(i => i >= 0);
  const punct = idx.length ? Math.min(...idx) : -1;
  let cut = punct >= 0 ? s.slice(0, punct) : s;
  if (cut.length > maxLen) cut = cut.slice(0, maxLen);
  return cut || 'Untitled';
}

// 解析 YAML Front Matter 与标题（优先 front matter → 第一个 H1 → 正文智能截断）
function parseBlogMeta(markdown) {
  const meta = {};
  let body = markdown;
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = markdown.slice(fm[0].length);
    fm[1].split(/\r?\n/).forEach(line => {
      const m = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
      if (m) {
        const k = m[1].trim().toLowerCase();
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k === 'tags') {
          try { meta.tags = v.startsWith('[') ? JSON.parse(v.replace(/'/g, '"')) : v.split(',').map(s => s.trim()).filter(Boolean); }
          catch (_) { meta.tags = v.split(',').map(s => s.trim()).filter(Boolean); }
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
    const firstNonEmptyLine = body.split(/\r?\n/).find(l => l.trim().length > 0) || '';
    title = blogSmartCut(firstNonEmptyLine, BLOG_TITLE_MAX_LEN);
  } else if (title.length > BLOG_TITLE_MAX_LEN) {
    title = blogSmartCut(title, BLOG_TITLE_MAX_LEN);
  }
  return { title: title || 'Untitled', tags: Array.isArray(meta.tags) ? meta.tags : [], body };
}

// Markdown 转纯文本（content 字段）
function blogMdToPlain(markdown) {
  return markdown
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

// === SECTION: 一键转播客（POST /api/publish，逻辑提取自 Taio 直读脚本，改用浏览器 fetch） ===
// 与「发布到博客」共用同一后端地址（BLOG_PUBLISH_URL）；区别在 targets=['nas'] + transform='read'，
// 把内容送进 NAS 单人朗读队列，而非发布成文章。优先取编辑器选中文本，否则取整篇正文。
async function publishToPodcast() {
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
  editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
  const pos = s + text.length;
  editor.selectionStart = editor.selectionEnd = pos;
  editor.dispatchEvent(new Event('input'));   // 触发 afterChange（渲染 / 统计 / 草稿）
  editor.focus();
}
async function insertImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 2 * 1024 * 1024) {
    if (!confirm('图片较大（' + Math.round(file.size / 1024) + ' KB），将作为 Blob 存入文库（不占正文体积），继续？')) return;
  }
  // 文库不可用（无 IndexedDB）→ 回退 base64 内联，保证可用
  if (!libDb) {
    const url = await fileToDataURL(file);
    insertAtCursor('\n![' + (file.name || 'image') + '](' + url + ')\n');
    flash('已插入图片');
    return;
  }
  // 正文只存 libimg://<id> 引用，图片 Blob 单独入库，文档体积与同步开销大幅下降
  const id = genId();
  try {
    await idbPutImage({ id, name: file.name || 'image', type: file.type, blob: file });
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
    const s = editor.selectionStart, en = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
    editor.selectionStart = editor.selectionEnd = s + 2;
    editor.dispatchEvent(new Event('input'));
  }
});

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
  ['mod+p', exportPDF],
  ['mod+shift+m', copyMarkdown],
  ['mod+shift+c', copyHTML],
  ['mod+shift+y', copyText],
  ['mod+shift+w', () => { wrapMode = !wrapMode; localStorage.setItem('md-wrap', wrapMode ? 'on' : 'off'); applyWrap(); }],
  ['mod+shift+t', () => applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3])],
  ['mod+f', () => TEXT_ACTIONS.searchReplace()],
  ['mod+alt+v', nextView],
  // 格式
  ['mod+b', () => FORMAT_ACTIONS.fmtBold()],
  ['mod+i', () => FORMAT_ACTIONS.fmtItalic()],
  ['mod+e', () => FORMAT_ACTIONS.fmtCode()],
  ['mod+k', () => FORMAT_ACTIONS.fmtLink()],
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
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = e.key.toLowerCase();
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
  md: 'mod+shift+e', pdf: 'mod+p', wrap: 'mod+shift+w', theme: 'mod+shift+t',
  searchReplace: 'mod+f',
  fmtBold: 'mod+b', fmtItalic: 'mod+i', fmtCode: 'mod+e', fmtLink: 'mod+k',
  fmtQuote: 'mod+shift+q', fmtUl: 'mod+shift+u', fmtOl: 'mod+shift+o',
  fmtH1: 'mod+1', fmtH2: 'mod+2', fmtH3: 'mod+3',
  fmtH4: 'mod+4', fmtH5: 'mod+5', fmtH6: 'mod+6',
};

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

// === SECTION: 注册 Service Worker（PWA 离线 / 可安装） ===
/* 部署后新版本提示：检测到新 SW 安装完成（且当前有旧 SW 在控制页面）时，
   弹出非阻塞提示条，用户点击「立即刷新」即应用新版本，无需反复手动硬刷。 */
if ('serviceWorker' in navigator) {
  const updateBanner = document.getElementById('updateBanner');
  const showUpdateBanner = () => { if (updateBanner) updateBanner.hidden = false; };
  const hideUpdateBanner = () => { if (updateBanner) updateBanner.hidden = true; };

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // 常规更新检查触发的「发现新版本」
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // installed 且存在旧 SW 控制页面 → 说明有可用更新
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });
      // 若注册时已有等待中的 SW（上次部署遗留），直接提示
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    }).catch(() => {});
  });

  // 用户点击「立即刷新」→ 重新加载本页。因 sw.js 安装时已 skipWaiting + clients.claim，
  // 新 SW 已就绪，reload 后即为新版本（含最新 app.js / index.html）。
  const doUpdate = () => { location.reload(); };
  const rb = document.getElementById('updateReloadBtn');
  const db = document.getElementById('updateDismissBtn');
  if (rb) rb.addEventListener('click', doUpdate);
  if (db) db.addEventListener('click', hideUpdateBanner);
}

// === SECTION: 响应式：窄屏启用软换行（手机可换行），宽屏 wrap=off 保持行号对齐 ===
function applyResponsive() {
  if (isMobileLayout() && viewMode === 'split') setView('edit');   // 旋屏/缩窗进入手机布局时，若仍停在分屏则退回编辑（手机不分屏）
  renderEditorHighlight();   // 进入/离开移动端时重算覆盖层显隐（换行由用户偏好 applyWrap 控制）
}
window.addEventListener('resize', debounce(applyResponsive, 200));
applyResponsive();

// === SECTION: 文库（本地文档库，IndexedDB 持久化；打开文档后编辑自动回写） ===
let currentLibId = null;   // 当前打开的文库文档 id（非文库文档时为 null）

const LIB_DB = 'md-library';
const LIB_STORE = 'docs';
let libDb = null;

function openLibDb() {
  return new Promise((resolve, reject) => {
    if (libDb) return resolve(libDb);
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
    const req = indexedDB.open(LIB_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });   // 图片 Blob 单独入库，正文只存 libimg://<id>
      }
    };
    req.onsuccess = () => { libDb = req.result; resolve(libDb); };
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
function imgStore(mode) { return libDb.transaction(IMG_STORE, mode).objectStore(IMG_STORE); }
const idbGetImage = (id) => idbReq(() => imgStore('readonly').get(id));
const idbPutImage = (rec) => idbReq(() => imgStore('readwrite').put(rec));

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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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
$('#libClose').addEventListener('click', closeLibrary);
if (libScrim) libScrim.addEventListener('click', closeLibrary);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && libDrawer && libDrawer.classList.contains('open')) closeLibrary();
});

/* 文库内嵌音乐播放器：折叠开关（iframe 首次展开时才加载，避免一开页面就触发外链自动搜索） */
const libMusic = $('#libMusic');
const libMusicToggle = $('#libMusicToggle');
if (libMusicToggle) libMusicToggle.addEventListener('click', () => {
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
  if (!libDb) return;
  try { libDocsCache = await idbGetAll(); } catch (_) { libDocsCache = []; }
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
  localStorage.setItem('md-lib-current', doc.id);
  updateFileName();
  afterChange({ skipWriteback: true });   // 打开即载入，不应刷新更新时间
  setSaveState('saved', '✓ 文库');
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
  const n = prompt('文件名：', doc.name || '未命名.md');
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
  if (!confirm('删除「' + (doc ? doc.name : '该文档') + '」？此操作不可恢复。')) return;
  try { await idbDelete(id); } catch (_) {}
  if (id === currentLibId) {
    currentLibId = null;
    localStorage.removeItem('md-lib-current');
    currentFileHandle = null;
    currentName = '未命名.md';
    currentNameIsAuto = false;
    editor.value = '';
    localStorage.removeItem('md-draft');   // 清掉旧草稿，避免删除后内容在重载时复活
    localStorage.removeItem('md-name');
    updateFileName();
    renderMarkdown(); updateStats(); updateGutter(); updatePos();   // 刷新空视图（不触发草稿写入）
    setSaveState('', '就绪');
  }
  renderLibrary();
  flash('已删除');
}

/* 当前文档转存到文库（如从电脑打开的文章） */
async function addToLibrary() {
  if (currentLibId) { flash('当前已在文档库'); return; }
  const doc = { id: genId(), name: currentName || '未命名.md', content: editor.value, updatedAt: Date.now(), autoName: currentNameIsAuto };
  try {
    await idbPut(doc);
    currentLibId = doc.id;                                 // 之后编辑自动回写文库
    localStorage.setItem('md-lib-current', doc.id);
    setSaveState('saved', '✓ 文库');
    renderLibrary();
    flash('已加入文档库');
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
const MAX_HISTORY = 20;
const writebackLibDebounced = debounce(() => { writebackLib(); }, 800);
function writebackLib() {
  if (!currentLibId || !libDb) return;
  ensureNameFromContent();          // 未命名文库文档：首次编辑即按首行自动命名
  const newContent = editor.value;
  idbGet(currentLibId).then((oldDoc) => {
    const history = (oldDoc && oldDoc.history) || [];
    // 内容未变：仅更新时间戳，不记快照（避免空转刷屏历史）
    if (oldDoc && oldDoc.content === newContent) {
      return idbPut({ id: currentLibId, name: currentName, content: newContent, updatedAt: Date.now(), history, autoName: currentNameIsAuto });
    }
    history.push({
      at: Date.now(),
      summary: newContent.slice(0, 200) + (newContent.length > 200 ? '…' : ''),
      content: newContent,
    });
    if (history.length > MAX_HISTORY) history.shift();   // 只留最近 20 条
    return idbPut({ id: currentLibId, name: currentName, content: newContent, updatedAt: Date.now(), history, autoName: currentNameIsAuto });
  }).then(() => {
    setSaveState('saved', '✓ 已存文库');
    const t = libList.querySelector('.lib-item.active .lib-item-time');   // 轻量更新时间，不打断列表
    if (t) t.textContent = fmtTime(Date.now());
    syncLibraryToNasDebounced();   // 文库改动后静默触发增量同步（去抖，不打断输入）
  }).catch(() => setSaveState('saved', '回写失败'));
}

/* 版本历史弹窗：列出快照，选择后恢复（截断其后历史，符合 Git 恢复逻辑） */
async function showHistoryModal(docId) {
  const doc = await idbGet(docId).catch(() => null);
  if (!doc || !doc.history || !doc.history.length) {
    flash('该文档暂无历史版本');
    return;
  }
  const list = doc.history.map((h, i) =>
    `${i + 1}. ${new Date(h.at).toLocaleString('zh-CN')} - ${h.summary}`
  ).join('\n');
  const choice = prompt(`选择要恢复的版本（输入编号 1-${doc.history.length}）：\n\n${list}`);
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= doc.history.length) return;
  const target = doc.history[idx];
  if (!confirm(`恢复至 ${new Date(target.at).toLocaleString('zh-CN')} 的版本？当前内容将被覆盖。`)) return;

  editor.value = target.content;
  currentName = doc.name;
  currentNameIsAuto = false;
  currentLibId = docId;
  currentFileHandle = null;
  updateFileName();
  doc.history = doc.history.slice(0, idx + 1);   // 截断：被恢复版本之后的历史丢弃
  doc.content = target.content;
  doc.updatedAt = Date.now();
  await idbPut(doc);
  afterChange({ skipWriteback: true });
  renderLibrary();
  flash('已恢复至历史版本');
}

// === SECTION: 初始化 ===
// === SECTION: 微信协作分享：基于 Cloudflare R2 + Worker 的中转站 ===
// 前端仅持有 Worker 的【公开端点】URL；R2 凭据写在 Cloudflare Worker 的绑定里，
// 绝不下发到前端、不入 git（符合“密钥永不写进会被提交代码”的原则）。
async function shareViaR2() {
  if (!R2_WORKER_URL) { flash('未配置分享服务地址'); return; }
  if (!editor.value.trim()) { flash('文档为空，无法分享'); return; }
  toast(currentShareId ? '正在更新协作文档…' : '正在生成协作链接…', 'info');
  const url = currentShareId ? `${R2_WORKER_URL}/${encodeURIComponent(currentShareId)}` : R2_WORKER_URL;
  const method = currentShareId ? 'PUT' : 'POST';
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'text/markdown;charset=utf-8' },
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

async function initLibrary() {
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

setSaveState('', '就绪');
initLibrary();
renderMarkdown();
setTocOpen(tocOpen);    // 还原目录抽屉开关状态（renderMarkdown 已建好大纲）
applyWrap();            // 设置换行模式（默认软换行）+ 渲染覆盖层
applyLayout();          // 应用上次保存的左右布局与分隔宽度
initSplitter();         // 启用编辑区 / 预览区分隔线拖拽
applyMdTheme(mdThemeMode);
updateStats();
updateGutter();
updatePos();
renderShortcutHints();   // 在「⋯」菜单渲染快捷键提示

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
    const ck = e.key.toLowerCase();
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
