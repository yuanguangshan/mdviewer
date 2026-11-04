'use strict';
/**
 * tests/math-protect.test.js —— 公式保护（渲染前抽占位符）的纯函数测试
 *
 * 这层存在的唯一理由：marked 会破坏公式。所以用例的重点不是"能不能抽出公式"，
 * 而是"哪些东西绝不能被当成公式"（围栏代码、行内代码、价格、转义 $）。
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/md-core.js');

const P = (src) => C.protectMath(src);

test('protectMath：行内公式被替换成占位符，TeX 原样保留', () => {
  const r = P('质能方程 $E = mc^2$ 很简洁');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].display, false);
  assert.equal(r.blocks[0].tex, 'E = mc^2');
  assert.ok(r.text.indexOf('xMDVMATHx0x') >= 0);
  assert.ok(r.text.indexOf('$') < 0 || r.text.indexOf('$E') < 0, '行内公式不应留在正文里');
});

test('protectMath：多行 $$ 块能整块抽出（这是原来渲染不出来的那个 bug）', () => {
  const src = '前文\n\n$$\n\\int_{0}^{1} x^{2}\\,dx = \\frac{1}{3}\n$$\n\n后文';
  const r = P(src);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].display, true);
  assert.match(r.blocks[0].tex, /\\int_\{0\}\^\{1\}/);
  assert.ok(r.blocks[0].tex.indexOf('\\,') >= 0, '\\, 不能被吃掉');
  assert.ok(r.text.indexOf('\n\nxMDVMATHx0x\n\n') >= 0, '行间公式应单独成段');
});

test('protectMath：反斜杠转义原样保留（\\{ \\% \\, 不被当 CommonMark 转义）', () => {
  const r = P('$\\{x \\mid x > 0\\}$ 与 $50\\%$ 与 $a\\,b$');
  assert.equal(r.blocks.length, 3);
  assert.equal(r.blocks[0].tex, '\\{x \\mid x > 0\\}');
  assert.equal(r.blocks[1].tex, '50\\%');
  assert.equal(r.blocks[2].tex, 'a\\,b');
});

test('protectMath：围栏代码块里的 $$ 与 $x$ 绝不当公式', () => {
  const src = '```js\nconst a = "$$not math$$";\nconst b = "$x$";\n```\n\n真正的 $y$ 公式';
  const r = P(src);
  assert.equal(r.blocks.length, 1, '只应抽出最后一个 $y$');
  assert.equal(r.blocks[0].tex, 'y');
  assert.ok(r.text.indexOf('$$not math$$') >= 0);
});

test('protectMath：~~~ 围栏同样受保护', () => {
  const r = P('~~~\n$$\nraw\n$$\n~~~\n\n$$a$$');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].tex, 'a');
});

test('protectMath：行内代码里的 $ 不当公式', () => {
  const r = P('用 `$HOME` 表示家目录，公式是 $x^2$');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].tex, 'x^2');
  assert.ok(r.text.indexOf('`$HOME`') >= 0);
});

test('protectMath：价格/货币不会被误判成公式', () => {
  const r = P('价格 $5 到 $10 之间，另一个 $5$ 才是公式');
  assert.equal(r.blocks.length, 1, '只有 $5$ 是公式');
  assert.equal(r.blocks[0].tex, '5');
});

test('protectMath：转义的 \\$ 不当分隔符', () => {
  const r = P('花了 \\$100 和 \\$200');
  assert.equal(r.blocks.length, 0);
});

test('protectMath：未闭合的 $$ 原样保留', () => {
  const r = P('这里有 $$ 但没闭合');
  assert.equal(r.blocks.length, 0);
  assert.ok(r.text.indexOf('$$') >= 0);
});

test('protectMath：源文里已有占位符串时自动换名，不会串位', () => {
  const r = P('文本里本来就有 xMDVMATHx0x 这串字，公式 $a$');
  assert.equal(r.blocks.length, 1);
  assert.notEqual(r.tokenBase, 'xMDVMATHx');
  assert.ok(r.text.indexOf(r.tokenBase + '0x') >= 0);
});

test('restoreMathSource：降级还原成 $…$ / $$…$$ 源码', () => {
  const r = P('行内 $a+b$ 与\n\n$$c+d$$\n');
  const back = C.restoreMathSource(r.blocks, r.tokenBase)(r.text);
  assert.ok(back.indexOf('$a+b$') >= 0);
  assert.ok(back.indexOf('$$c+d$$') >= 0);
  assert.ok(back.indexOf('xMDVMATH') < 0, '占位符必须清干净');
});

test('splitByFences：围栏切分正确（含未闭合围栏）', () => {
  const segs = C.splitByFences('a\n```\ncode\n```\nb\n~~~\nnever closed');
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.map((x) => x.code), [false, true, false, true]);
});

test('protectMath：没有公式时必须逐字节相同（不能插入任何换行）', () => {
  const doc = [
    '| 断言 | 问题 |',
    '|---|---|',
    '| `/api/health` 与 `/api/state` 的形状 | 字段改名了吗 |',
    '',
    '普通段落里 `a` 和 `b` 两处 `c`。',
    '',
    '```',
    'code `x` $y$',
    '```',
  ].join('\n');
  const r = C.protectMath(doc);
  assert.equal(r.text, doc, '没有公式时不允许改动原文（早先的 bug 会在每处行内代码两侧插换行）');
  assert.equal(r.blocks.length, 0);
});

test('protectMath：有行内公式时，除公式外逐字节相同（表格行不许被拆）', () => {
  const doc = '| `a` 与 `b` | 行内 $x$ 和 $y$ |\n\n段落 `c`，公式 $z^2$ 结束。';
  const r = C.protectMath(doc);
  const restored = r.text.replace(new RegExp(r.tokenBase + '\\d+x', 'g'), '@@');
  const expected = doc.replace(/\$[^$\n]+\$/g, '@@');
  assert.equal(restored, expected, '除公式占位符外不得有任何差异（尤其不能多换行）');
  assert.ok(!r.text.includes('\n|'), '表格行不应被拆成多行');
});
