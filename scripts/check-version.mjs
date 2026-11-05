#!/usr/bin/env node
/**
 * check-version.mjs —— 版本一致性校验（CI / 提交前跑）
 *
 * 校验四处版本标记必须一致：
 *   VERSION 文件 · index.html(meta app-version) · app.js(APP_VERSION) · sw.js(CACHE_NAME)
 * 外加：sw.js 的 SHELL 预缓存清单必须覆盖 index.html 里引用的所有本地脚本/样式，
 * 否则离线首访会缺文件（历史上新增 vendor 库时踩过）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const errors = [];
const warnings = [];

function must(re, text, what) {
  const m = text.match(re);
  if (!m) { errors.push(`缺少版本标记：${what}`); return null; }
  return m[1];
}

const version = read('VERSION').trim().replace(/^v/, '');
const short = version.split('.').slice(0, 2).join('.');

const html = read('index.html');
const app = read('app.js');
const sw = read('sw.js');

const metaVer = must(/<meta name="app-version" content="([\d.]+)" \/>/, html, 'index.html meta[app-version]');
const footVer = must(/<span class="version">v([\d.]+)<\/span>/, html, 'index.html 页脚版本');
const cssVer = must(/styles\.css\?v=([\d.]+)/, html, 'index.html styles.css?v');
const appVer = must(/const APP_VERSION = '([\d.]+)';/, app, 'app.js APP_VERSION');
const swVer = must(/const CACHE_NAME = 'md-editor-v([\d.]+)';/, sw, 'sw.js CACHE_NAME');

const pairs = [
  ['index.html meta', metaVer], ['index.html 页脚', footVer],
  ['styles.css?v', cssVer], ['app.js APP_VERSION', appVer],
];
for (const [what, v] of pairs) {
  if (v && v !== short) errors.push(`版本不一致：${what} = ${v}，应为 ${short}（VERSION=${version}）`);
}
if (swVer && swVer !== version) errors.push(`版本不一致：sw.js CACHE_NAME = ${swVer}，应为 ${version}`);

// 陈旧版本扫描：源码里不该残留「别的版本号」。
// 事故来源：手改 app.js 的注释/文案时带上 "（v4.14）" 之类字样，用户看到会以为没更新。
// 只查 5 个版本载体文件，注释里的历史版本号（如 v4.10）用白名单放行。
const STALE_ALLOW = new Set(['4.10', '4.11', '4.12', '4.13', '4.14', '4.15']);
for (const f of ['index.html', 'app.js', 'sw.js', 'VERSION', 'package.json']) {
  const text = read(f);
  for (const m of text.matchAll(/v?(\d+\.\d+(?:\.\d+)?)/g)) {
    const v = m[1];
    if (!/^4\.\d+/.test(v)) continue;
    if (v === short || v === version || v === version + '.0') continue;
    if (STALE_ALLOW.has(v)) continue;
    warnings.push(`${f} 里出现非当前版本号：${v}（当前 ${version}）`);
  }
}

// SHELL 覆盖率：index.html 里引用的本地 js/css 必须在 SW 预缓存清单中
const shell = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
const shellPaths = new Set([...shell.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, '')));
const localRefs = [...html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^"]*)?"/g)]
  .map((m) => m[1])
  .filter((f) => /\.(js|css|webmanifest)$/.test(f));
for (const f of new Set(localRefs)) {
  if (!shellPaths.has(f)) errors.push(`sw.js 的 SHELL 未预缓存：${f}（离线首访会缺文件）`);
}
for (const f of shellPaths) {
  if (!existsSync(join(ROOT, f))) errors.push(`sw.js 的 SHELL 指向不存在的文件：${f}`);
}

// 提示项：lib 目录下的 js 应全部进 SHELL
for (const f of ['lib/md-core.js', 'lib/md-regex-worker.js']) {
  if (!shellPaths.has(f)) warnings.push(`建议把 ${f} 加入 sw.js 的 SHELL`);
}

if (warnings.length) warnings.forEach((w) => console.warn('⚠ ' + w));
if (errors.length) {
  errors.forEach((e) => console.error('✗ ' + e));
  process.exit(1);
}
console.log(`✓ 版本一致：v${version}（短版 ${short}）· SHELL ${shellPaths.size} 项 · 引用 ${new Set(localRefs).size} 个本地资源`);
