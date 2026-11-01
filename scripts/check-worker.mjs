#!/usr/bin/env node
/**
 * check-worker.mjs —— 校验 worker/ 目录能作为 ESM 正常解析。
 *
 * 为什么单独写：worker/ 被 .gitignore 排除（源码仅本地维护），CI 里不存在是正常的，
 * 所以「缺目录 → 跳过」而不是报错；只有当地目录存在时才做严格校验。
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'worker');

if (!existsSync(DIR)) {
  console.log('· worker/ 不存在（未纳入 git），跳过 Worker 校验');
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => /\.(m?js)$/.test(f));
if (!files.length) {
  console.log('· worker/ 里没有 js 文件，跳过');
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(join(DIR, f)).href);
    console.log('✓ worker/' + f + ' 可作为 ESM 加载');
  } catch (e) {
    console.error('✗ worker/' + f + ' 加载失败：' + e.message);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
