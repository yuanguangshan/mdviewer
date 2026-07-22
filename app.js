'use strict';

const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const preview = $('#preview');
const previewPane = $('#previewPane');
const gutter = $('#gutter');
const editorHighlight = $('#editorHighlight');
const fileInput = $('#fileInput');

// 自愈守卫：关键按钮缺失 = SW 更新过渡期 HTML/JS 版本错配，刷新一次拉一致版本（限一次防死循环）
if (!document.querySelector('#btnMore')) {
  if (!sessionStorage.getItem('md-selfheal')) {
    sessionStorage.setItem('md-selfheal', '1');
    location.reload();
  }
}

let currentFileHandle = null;   // FileSystemFileHandle（支持时用于原地保存）
let currentName = '未命名.md';

/* ---------- 小工具 ---------- */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* ---------- 主题：auto / light / dark，auto 跟随系统 ---------- */
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

/* ---------- 预览主题：github / onedark / solarized / nord（独立于 app 主题）---------- */
const MD_THEME_CYCLE = ['github', 'onedark', 'solarized', 'nord'];
const MD_THEME_LABEL = { github: 'GitHub', onedark: 'One Dark', solarized: 'Solarized', nord: 'Nord' };
let mdThemeMode = localStorage.getItem('md-mdtheme') || 'github';
if (!MD_THEME_CYCLE.includes(mdThemeMode)) mdThemeMode = 'github';
function applyMdTheme(mode) {
  mdThemeMode = mode;
  document.documentElement.setAttribute('data-md-theme', mode);
  localStorage.setItem('md-mdtheme', mode);
  const mm = $('#moreMenu');
  if (mm) mm.querySelectorAll('[data-act="mdtheme"]').forEach((b) => {
    b.textContent = (b.dataset.val === mode ? '✓ ' : '') + MD_THEME_LABEL[b.dataset.val];
  });
}

/* ---------- 渲染 + 代码高亮 ---------- */
let renderTimer = null;
function renderMarkdown() {
  const src = editor.value || '*开始输入以预览…*';
  let html;
  try {
    html = window.marked ? marked.parse(src, { breaks: true, gfm: true }) : '<pre>' + escapeHtml(src) + '</pre>';
  } catch (e) {
    html = '<p style="color:#e06c75">渲染错误：' + escapeHtml(e.message) + '</p>';
  }
  preview.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  // 后处理高亮：对任何 marked 版本都稳，且不依赖已废弃的 setOptions({highlight})
  if (window.hljs) {
    preview.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (_) {}
    });
  }
}
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderMarkdown, 120);
}

/* ---------- 编辑器源码高亮：textarea 之上叠一层 <pre>，复用 hljs 自带 markdown 语法 ---------- */
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

/* ---------- 编辑器换行：开=软换行（无横向滚动、隐藏行号）；关=不换行（保留行号逐行对齐）---------- */
let wrapMode = localStorage.getItem('md-wrap') !== 'off';
function applyWrap() {
  editor.wrap = wrapMode ? 'soft' : 'off';
  editor.parentElement.classList.toggle('wrap-on', wrapMode);
  const bw = $('#menuWrap');
  if (bw) bw.textContent = '↩️ 换行：' + (wrapMode ? '开' : '关');
  renderEditorHighlight();
  syncHighlightScroll();
}

/* ---------- 统计 / 行号 / 光标位置 ---------- */
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

/* ---------- 视图：双栏 / 编辑 / 预览 ---------- */
const VIEW_CYCLE = ['split', 'edit', 'preview'];
const VIEW_LABEL = { split: '分屏', edit: '编辑', preview: '预览' };
let viewMode = 'split';
function setView(m) {
  viewMode = m;
  document.body.classList.remove('no-preview', 'no-editor');
  if (m === 'edit') document.body.classList.add('no-preview');
  if (m === 'preview') document.body.classList.add('no-editor');
  $('#btnView').textContent = VIEW_LABEL[m];
  if (m !== 'preview') editor.focus();
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

/* ---------- 全屏：隐藏工具栏/状态栏（+ 尝试浏览器原生全屏），右上角 ✕ 退出 ---------- */
const btnFullscreen = $('#btnFullscreen');
const btnExitFullscreen = $('#btnExitFullscreen');
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (btnExitFullscreen) btnExitFullscreen.hidden = !on;   // 用 hidden 属性显隐，默认隐藏（不依赖外部 CSS）
  // 兜底：直接控制 chrome 显隐，即使样式未及时更新也能全屏
  const tb = document.querySelector('.toolbar'), sb = document.querySelector('.statusbar');
  if (tb) tb.style.display = on ? 'none' : '';
  if (sb) sb.style.display = on ? 'none' : '';
  if (on) {
    const el = document.documentElement;
    if (el.requestFullscreen) { try { el.requestFullscreen(); } catch (_) {} }   // iOS 非视频不支持→仅应用级全屏
  } else if (document.fullscreenElement) {
    try { document.exitFullscreen(); } catch (_) {}
  }
}
if (btnFullscreen) btnFullscreen.addEventListener('click', () => setFullscreen(true));
if (btnExitFullscreen) btnExitFullscreen.addEventListener('click', () => setFullscreen(false));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('fullscreen')) {
    setFullscreen(false);   // 原生全屏被 Esc 退出时同步（含 hidden / 内联样式复位）
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) setFullscreen(false);
});

/* ---------- 同步滚动（编辑 ↔ 预览，仅双栏）---------- */
let isSyncing = false;
function syncScroll(src, dst) {
  if (isSyncing || viewMode !== 'split') return;
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

/* ---------- 草稿自动保存（去抖 + 静默 + 容错）---------- */
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

/* ---------- 文件名 / 草稿载入 / 内容变更统一刷新 ---------- */
function updateFileName() {
  const el = $('#fileName');
  el.textContent = currentName;
  el.title = currentName;
}
function loadDraft() {
  const draft = localStorage.getItem('md-draft');
  if (draft !== null) editor.value = draft;
  const name = localStorage.getItem('md-name');
  if (name) currentName = name;
  updateFileName();
}
function afterChange() {
  renderMarkdown();
  renderEditorHighlight();
  updateStats();
  updateGutter();
  updatePos();
  saveDraft();
  writebackLibDebounced();   // 文库文档：编辑后去抖自动回写（非文库文档时内部直接跳过）
}
editor.addEventListener('input', afterChange);
['keyup', 'click', 'select'].forEach((ev) => editor.addEventListener(ev, updatePos));

/* ---------- 打开文件 ---------- */
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
    currentLibId = null;                       // 导入本地文件 → 脱离文库上下文
    localStorage.removeItem('md-lib-current');
    updateFileName();
    afterChange();
    flash('已打开 ' + currentName);
  };
  reader.readAsText(f);
  fileInput.value = '';
});

/* ---------- 保存 ---------- */
$('#btnSave').addEventListener('click', saveFile);
async function saveFile() {
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

/* ---------- 新建 / 重命名 ---------- */
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
  updateFileName();
  afterChange();
});
function renameFile() {
  const n = prompt('文件名：', currentName);
  if (n && n.trim()) {
    currentName = n.trim();
    updateFileName();
    saveDraft();
    if (currentLibId) writebackLib();   // 文库文档：同步新文件名
  }
}

/* ---------- 复制 HTML（复用预览结果）---------- */
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

/* ---------- 导出 HTML / 打印 PDF ---------- */
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
  const name = currentName.replace(/\.(html?|pdf)$/i, '') + '.md';
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
function exportHTML() {
  const doc = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
    + escapeHtml(currentName) + '</title><style>' + EXPORT_CSS + '</style></head><body class="markdown-body">'
    + preview.innerHTML + '</body></html>';
  download(currentName.replace(/\.(md|markdown|txt)$/i, '') + '.html', doc, 'text/html;charset=utf-8');
  flash('已导出 HTML');
}
async function exportPDF() {
  const pdfName = currentName.replace(/\.(md|markdown|txt)$/i, '') + '.pdf';
  if (!window.html2pdf) { window.print(); return; }   // 无库降级系统打印
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

const moreMenu = $('#moreMenu');
const btnMore = $('#btnMore');
function openMoreMenu(open) {
  if (open) { moreMenu.removeAttribute('hidden'); btnMore.setAttribute('aria-expanded', 'true'); }
  else { moreMenu.setAttribute('hidden', ''); btnMore.setAttribute('aria-expanded', 'false'); }
}
btnMore.addEventListener('click', () => openMoreMenu(moreMenu.hasAttribute('hidden')));
document.addEventListener('click', (e) => {
  if (!moreMenu.hasAttribute('hidden') && !moreMenu.contains(e.target) && !btnMore.contains(e.target)) {
    openMoreMenu(false);
  }
});
moreMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  openMoreMenu(false);
  if (act === 'rename') renameFile();
  else if (act === 'copytext') copyText();
  else if (act === 'copymd') copyMarkdown();
  else if (act === 'copy') copyHTML();
  else if (act === 'md') exportMarkdown();
  else if (act === 'html') exportHTML();
  else if (act === 'pdf') exportPDF();
  else if (act === 'wrap') { wrapMode = !wrapMode; localStorage.setItem('md-wrap', wrapMode ? 'on' : 'off'); applyWrap(); }
  else if (act === 'theme') applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3]);
  else if (act === 'mdtheme') applyMdTheme(btn.dataset.val);
});

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

/* ---------- 拖拽 / 粘贴图片（转 base64 插入光标处）---------- */
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
    if (!confirm('图片较大（' + Math.round(file.size / 1024) + ' KB），转 base64 会显著增大文档，继续？')) return;
  }
  const url = await fileToDataURL(file);
  insertAtCursor('\n![' + (file.name || 'image') + '](' + url + ')\n');
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

/* ---------- Tab 插入两空格 ---------- */
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart, en = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
    editor.selectionStart = editor.selectionEnd = s + 2;
    editor.dispatchEvent(new Event('input'));
  }
});

/* ---------- 全局快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveFile(); }
  else if (mod && k === 'o') { e.preventDefault(); openFile(); }
  else if (mod && e.altKey && k === 'n') { e.preventDefault(); $('#btnNew').click(); }
});

/* ---------- 注册 Service Worker（PWA 离线 / 可安装）---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* ---------- 响应式：窄屏启用软换行（手机可换行），宽屏 wrap=off 保持行号对齐 ---------- */
function applyResponsive() {
  if (isMobileLayout() && viewMode === 'split') setView('edit');   // 旋屏/缩窗进入手机布局时，若仍停在分屏则退回编辑（手机不分屏）
  renderEditorHighlight();   // 进入/离开移动端时重算覆盖层显隐（换行由用户偏好 applyWrap 控制）
}
window.addEventListener('resize', debounce(applyResponsive, 200));
applyResponsive();

/* ---------- 文库（本地文档库，IndexedDB 持久化；打开文档后编辑自动回写）---------- */
let currentLibId = null;   // 当前打开的文库文档 id（非文库文档时为 null）

const LIB_DB = 'md-library';
const LIB_STORE = 'docs';
let libDb = null;

function openLibDb() {
  return new Promise((resolve, reject) => {
    if (libDb) return resolve(libDb);
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
    const req = indexedDB.open(LIB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: 'id' });
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

function genId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  try { return new Date(ts).toLocaleDateString('zh-CN'); } catch (_) { return ''; }
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

/* 渲染列表 */
const libList = $('#libList');
const libEmpty = $('#libEmpty');
const libCount = $('#libCount');
const libSearch = $('#libSearch');
let libDocsCache = [];

async function renderLibrary() {
  if (!libDb) return;
  try { libDocsCache = await idbGetAll(); } catch (_) { libDocsCache = []; }
  libDocsCache.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const kw = (libSearch.value || '').trim().toLowerCase();
  const shown = kw ? libDocsCache.filter((d) => (d.name || '').toLowerCase().includes(kw)) : libDocsCache;
  libList.innerHTML = '';
  shown.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'lib-item' + (d.id === currentLibId ? ' active' : '');
    li.dataset.id = d.id;
    const open = document.createElement('button');
    open.className = 'lib-item-open';
    open.innerHTML = '<span class="lib-item-name"></span><span class="lib-item-time"></span>';
    open.querySelector('.lib-item-name').textContent = d.name || '未命名.md';
    open.querySelector('.lib-item-time').textContent = fmtTime(d.updatedAt || Date.now());
    const acts = document.createElement('span');
    acts.className = 'lib-item-actions';
    acts.innerHTML = '<button class="lib-act" data-act="rename" title="重命名">✏️</button>'
      + '<button class="lib-act" data-act="delete" title="删除">🗑</button>';
    li.appendChild(open);
    li.appendChild(acts);
    libList.appendChild(li);
  });
  libEmpty.hidden = libDocsCache.length > 0;
  if (libCount) {
    libCount.textContent = String(libDocsCache.length);
    libCount.hidden = libDocsCache.length === 0;
  }
}

/* 打开文库文档 → 载入编辑器，后续编辑自动回写 */
function openLibDocData(doc) {
  currentLibId = doc.id;
  currentFileHandle = null;
  currentName = doc.name || '未命名.md';
  editor.value = doc.content || '';
  localStorage.setItem('md-lib-current', doc.id);
  updateFileName();
  afterChange();
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
    if (act === 'rename') renameLibDoc(id);
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
  if (id === currentLibId) { currentName = doc.name; updateFileName(); }
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

/* 自动回写：打开文库文档后，每次编辑去抖写入 IndexedDB */
const writebackLibDebounced = debounce(() => { writebackLib(); }, 800);
function writebackLib() {
  if (!currentLibId || !libDb) return;
  const doc = { id: currentLibId, name: currentName, content: editor.value, updatedAt: Date.now() };
  idbPut(doc).then(() => {
    setSaveState('saved', '✓ 已存文库');
    const t = libList.querySelector('.lib-item.active .lib-item-time');   // 轻量更新时间，不打断列表
    if (t) t.textContent = fmtTime(doc.updatedAt);
  }).catch(() => setSaveState('saved', '回写失败'));
}

/* ---------- 初始化 ---------- */
async function initLibrary() {
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
setSaveState('', '就绪');
initLibrary();
renderMarkdown();
applyWrap();            // 设置换行模式（默认软换行）+ 渲染覆盖层
applyMdTheme(mdThemeMode);
updateStats();
updateGutter();
updatePos();
