'use strict';
/**
 * tests/palette-fuzzy.test.js —— 命令面板的模糊匹配
 * 面板最难受的故障不是"报错"，是"明明有这个命令却搜不到"。所以这里把边界钉死：
 * 中文子串、拼音缩写式的子序列、跨词命中、以及"完全不沾边必须返回 0"。
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/md-core.js');

test('空查询返回正分（列出全部命令）', () => {
  assert.ok(C.fuzzyScore('', '导出 Markdown') > 0);
  assert.ok(C.fuzzyScore('   ', '导出 Markdown') > 0);
});

test('连续子串命中得分最高，且越靠前分越高', () => {
  const a = C.fuzzyScore('导出', '导出 Markdown（.md）');
  const b = C.fuzzyScore('Markdown', '导出 Markdown（.md）');
  assert.ok(a > b, '靠前的子串应得分更高');
});

test('子序列命中（跳字搜索）', () => {
  assert.ok(C.fuzzyScore('导md', '导出 Markdown（.md）') > 0);
  assert.ok(C.fuzzyScore('cps', '复制纯文本') === 0, '英文子序列不该命中纯中文');
});

test('大小写不敏感', () => {
  assert.ok(C.fuzzyScore('MARKDOWN', '导出 Markdown') > 0);
  assert.ok(C.fuzzyScore('markdown', '导出 Markdown') > 0);
});

test('完全不沾边返回 0', () => {
  assert.equal(C.fuzzyScore('zzzz', '导出 Markdown'), 0);
  assert.equal(C.fuzzyScore('导出', '设置背景图片'), 0);
});

test('连续命中比跳字命中分高', () => {
  const contig = C.fuzzyScore('abc', 'xabc');
  const spread = C.fuzzyScore('abc', 'xa_b_c');
  assert.ok(contig > spread);
});
