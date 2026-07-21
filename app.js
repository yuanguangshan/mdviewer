'use strict';

const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const preview = $('#preview');
const previewPane = $('#previewPane');
const gutter = $('#gutter');
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
$('#btnView').addEventListener('click', () => setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(viewMode) + 1) % 3]));
// 手机默认纯编辑（双屏在窄屏各占一半太挤），桌面默认双栏
setView(matchMedia('(max-width: 760px)').matches ? 'edit' : 'split');

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
  updateStats();
  updateGutter();
  updatePos();
  saveDraft();
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
$('#btnNew').addEventListener('click', () => {
  if (editor.value.trim() && !confirm('新建文档？未保存的内容将丢失。')) return;
  editor.value = '';
  currentFileHandle = null;
  currentName = '未命名.md';
  updateFileName();
  afterChange();
  flash('已新建');
});
function renameFile() {
  const n = prompt('文件名：', currentName);
  if (n && n.trim()) {
    currentName = n.trim();
    updateFileName();
    saveDraft();
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
  else if (act === 'copy') copyHTML();
  else if (act === 'html') exportHTML();
  else if (act === 'pdf') exportPDF();
  else if (act === 'theme') applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % 3]);
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
  const narrow = window.innerWidth <= 760;
  editor.wrap = narrow ? 'soft' : 'off';
}
window.addEventListener('resize', debounce(applyResponsive, 200));
applyResponsive();

/* ---------- 初始化 ---------- */
setSaveState('', '就绪');
loadDraft();
renderMarkdown();
updateStats();
updateGutter();
updatePos();
