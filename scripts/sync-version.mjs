#!/usr/bin/env node
/**
 * sync-version.mjs —— 版本号「单一来源」写入器
 *
 * 问题：版本号手抄在四个地方（VERSION / index.html 的 meta + 页脚 + styles.css?v / sw.js 的 CACHE_NAME），
 * 项目历史上就因为漏 bump 出过「离线用户拿到旧 app.js」（git log v3.8 就是修这个）。
 *
 * 用法：
 *   node scripts/sync-version.mjs            # 读 VERSION 文件，写入各处
 *   node scripts/sync-version.mjs 4.9        # 指定版本（同时回写 VERSION / package.json）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (f) => join(ROOT, f);

const argVersion = process.argv[2];
const versionFile = p('VERSION');

const version = (argVersion || readFileSync(versionFile, 'utf8')).trim().replace(/^v/, '');
if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
  console.error('✗ 版本号格式非法：' + version + '（应形如 4.8 或 4.8.1）');
  process.exit(1);
}

// 缓存名用完整版本（4.8 / 4.8.1 都能触发缓存更新）；展示用短版本
const short = version.split('.').slice(0, 2).join('.');

const edits = [
  // sw.js 缓存名
  ['sw.js', /const CACHE_NAME = 'md-editor-v[\d.]+';/, `const CACHE_NAME = 'md-editor-v${version}';`],
  // index.html：meta + 页脚 + styles.css?v
  ['index.html', /<meta name="app-version" content="[\d.]+" \/>/, `<meta name="app-version" content="${short}" />`],
  ['index.html', /<span class="version">v[\d.]+<\/span>/, `<span class="version">v${short}</span>`],
  ['index.html', /href="\.\/styles\.css\?v=[\d.]+"/, `href="./styles.css?v=${short}"`],   // 与 check-version 一致：资源指纹用短版
  // 本地脚本也要带指纹：app.js 曾经没有 ?v=，部署后浏览器/CDN 边缘缓存仍给旧脚本，
  // 表现为「页面是 4.18、脚本还是 4.16，怎么刷新都没用」。
  ['index.html', /src="\.\/app\.js(\?v=[\d.]+)?"/, `src="./app.js?v=${short}"`],
  ['index.html', /src="\.\/lib\/md-core\.js(\?v=[\d.]+)?"/, `src="./lib/md-core.js?v=${short}"`],
  ['index.html', /src="\.\/lib\/fetch-guard\.js(\?v=[\d.]+)?"/, `src="./lib/fetch-guard.js?v=${short}"`],
  ['index.html', /src="\.\/vendor\/marked\.min\.js(\?v=[\d.]+)?"/, `src="./vendor/marked.min.js?v=${short}"`],
  ['index.html', /src="\.\/vendor\/highlight\.min\.js(\?v=[\d.]+)?"/, `src="./vendor/highlight.min.js?v=${short}"`],
  ['index.html', /src="\.\/vendor\/purify\.min\.js(\?v=[\d.]+)?"/, `src="./vendor/purify.min.js?v=${short}"`],
  // app.js：APP_VERSION 常量（运行时与 meta 自检）
  ['app.js', /const APP_VERSION = '[\d.]+';/, `const APP_VERSION = '${short}';`],
];

let changed = 0;
for (const [file, re, replacement] of edits) {
  const before = readFileSync(p(file), 'utf8');
  if (!re.test(before)) {
    console.error(`✗ ${file}：没找到可替换的版本标记 → ${re}`);
    process.exit(1);
  }
  const after = before.replace(re, replacement);
  if (after !== before) {
    writeFileSync(p(file), after);
    changed++;
    console.log(`✓ ${file} → ${replacement}`);
  }
}

writeFileSync(versionFile, version + '\n');

// package.json 版本同步（只影响元数据，不参与运行时）
try {
  const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
  const next = version.split('.').length === 2 ? version + '.0' : version;
  if (pkg.version !== next) {
    pkg.version = next;
    writeFileSync(p('package.json'), JSON.stringify(pkg, null, 2) + '\n');
    console.log(`✓ package.json → ${next}`);
    changed++;
  }
} catch (_) {}

console.log(changed ? `\n版本已同步为 v${version}（短版 ${short}）` : `\n已是最新：v${version}`);
