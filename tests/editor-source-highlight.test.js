'use strict';
/**
 * tests/editor-source-highlight.test.js —— 编辑区源码高亮（textarea 覆盖层）
 *
 * 这层最容易出的事故不是"颜色不好看"，而是"看起来对、实际错位或误判"：
 * ① front matter 里的下划线被配成强调（sync_time … content_hash 跨行成 <em>）→ 整块变紫变斜；
 * ② 高亮给标题/强调加粗倾斜 → 字宽变了，覆盖层和 textarea 的字符位置对不上；
 * ③ 围栏代码里的 # 注释被当成标题。
 * 所以断言的重点是"不许改字形"和"去掉标签必须还原成原文"。
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/md-core.js');

const FM = [
  '---',
  'title: "终端为何有生命力"',
  'tags: [终端, 历史与机制]',
  'score: 9',
  'sync_time: 2026-11-05 13:45:45',
  'source: clipboard',
  'content_hash: 3ddcecc6cfa1819f41d0d9ded6b41ba0221f70363c22bed0913241bc60d0428',
  'manual_edit: false',
  '---',
  '',
  '# 核心摘要',
  '',
  '- 持续存在的三大约束',
].join('\n');

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('去掉标签后必须与原文逐字相同（含 front matter 的下划线标识符）', () => {
  assert.equal(stripTags(C.highlightMarkdownSource(FM)), FM);
});

test('front matter 的下划线不许跨行配成强调', () => {
  const html = C.highlightMarkdownSource(FM);
  assert.ok(!html.includes('src-em'), 'front matter 里出现斜体标记，说明 _ 又被配对了');
  // 键名单独成 token，值不吞掉后面的行
  assert.ok(html.includes('<span class="src-key">sync_time</span>'));
  assert.ok(html.includes('<span class="src-key">content_hash</span>'));
  assert.ok(html.includes('<span class="src-key">manual_edit</span>'));
});

test('输出里不允许出现任何 font-* 样式（字宽一变就错位）', () => {
  const html = C.highlightMarkdownSource(FM);
  assert.ok(!/font-(style|weight|size|family)/i.test(html));
});

test('围栏代码里的 # 与 * 不许被当成标题/强调', () => {
  const doc = '```sh\n# 这是注释\n*不是列表*\n```\n\n# 真标题';
  const html = C.highlightMarkdownSource(doc);
  assert.ok(!html.includes('<span class="src-h"># 这是注释</span>'));
  const lines = html.split('\n');
  assert.ok(lines[0].includes('src-fence'));
  assert.ok(lines[1].includes('src-fence'));
  assert.ok(lines[5].includes('src-h'), '围栏外的标题仍要高亮');
  assert.equal(stripTags(html), doc);
});

test('front matter 的值按类型上色，且不做行内解析', () => {
  const html = C.highlightMarkdownSource(FM);
  assert.ok(html.includes('<span class="src-num">9</span>'));
  assert.ok(html.includes('<span class="src-bool">false</span>'));
  assert.ok(html.includes('<span class="src-str">&quot;终端为何有生命力&quot;</span>'));
});

test('HTML 特殊字符必须转义', () => {
  const html = C.highlightMarkdownSource('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('3*4*5 这类算式不许被当成斜体', () => {
  const html = C.highlightMarkdownSource('计算 3*4*5 的结果');
  assert.ok(!html.includes('src-em'));
  assert.equal(stripTags(html), '计算 3*4*5 的结果');
});

test('正文里的加粗/斜体只变色不换字形', () => {
  const html = C.highlightMarkdownSource('这是 **加粗** 和 *斜体* 和 `代码`');
  assert.ok(html.includes('src-strong'));
  assert.ok(html.includes('src-em'));
  assert.ok(html.includes('src-code'));
  assert.ok(!/font-(style|weight)/i.test(html));
});

test('半渲染：语法标记要单独成 src-marker（只调透明度），文字不变', () => {
  const doc = '# 标题 **粗** 和 *斜* 和 `码` 和 [链接](http://a.b)';
  const html = C.highlightMarkdownSource(doc);
  assert.ok(html.includes('<span class="src-marker">#</span>'), '标题的 # 要能被淡化');
  assert.ok(html.includes('<span class="src-marker">**</span>'), '加粗标记要能被淡化');
  assert.ok(html.includes('src-h1'), '标题按层级上色');
  assert.equal(stripTags(html), doc, '半渲染同样不许改动任何字符');
});

test('半渲染：表格竖线淡化、任务清单方括号按状态上色', () => {
  const doc = '| a | b |\n| - | - |\n- [x] 做完\n- [ ] 没做';
  const html = C.highlightMarkdownSource(doc);
  assert.ok(html.includes('<span class="src-marker">|</span>'));
  assert.ok(html.includes('src-str">[x]'), '已完成用字符串色');
  assert.ok(html.includes('src-bool">[ ]'), '未完成用另一种色');
  assert.equal(stripTags(html), doc);
});
