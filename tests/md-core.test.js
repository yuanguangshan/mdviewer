'use strict';
/**
 * md-core 单元测试（零依赖，node --test 直接跑）
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/md-core.js');

/* ---------------- 文本 ---------------- */

test('escapeHtml：五类危险字符全部转义', () => {
  assert.equal(Core.escapeHtml(`<img src="x" onerror='1'>&`),
    '&lt;img src=&quot;x&quot; onerror=&#39;1&#39;&gt;&amp;');
  assert.equal(Core.escapeHtml(null), '');
  assert.equal(Core.escapeHtml(undefined), '');
  assert.equal(Core.escapeHtml(0), '0');
});

test('normalizeTextColor：3 位补全、大小写归一、非法值归空', () => {
  assert.equal(Core.normalizeTextColor('#ABC'), '#aabbcc');
  assert.equal(Core.normalizeTextColor('  #112233  '), '#112233');
  assert.equal(Core.normalizeTextColor('red'), '');
  assert.equal(Core.normalizeTextColor('#12345'), '');
  assert.equal(Core.normalizeTextColor(''), '');
  assert.equal(Core.normalizeTextColor(null), '');
});

test('humanBytes / compareVersion', () => {
  assert.equal(Core.humanBytes(0), '0 B');
  assert.equal(Core.humanBytes(2048), '2.0 KB');
  assert.equal(Core.compareVersion('4.7', '4.10'), -1);
  assert.equal(Core.compareVersion('v4.8', '4.8.0'), 0);
  assert.equal(Core.compareVersion('5', '4.99'), 1);
});

/* ---------------- 标题 slug ---------------- */

test('slugify：保留中文 / 假名 / 韩文 / 字母数字，去掉 emoji 与标点', () => {
  assert.equal(Core.slugify('Hello World'), 'hello-world');
  assert.equal(Core.slugify('第一章 开始'), '第一章-开始');
  assert.equal(Core.slugify('あいうえお'), 'あいうえお');
  assert.equal(Core.slugify('한국어 제목'), '한국어-제목');
  assert.equal(Core.slugify('🎉 庆祝一下！'), '庆祝一下');
  assert.equal(Core.slugify('  a   b  '), 'a-b');
  assert.equal(Core.slugify('---'), '');
});

test('createSlugger：同名标题依次编号，绝不产生重复 id', () => {
  const s = Core.createSlugger();
  assert.equal(s('总结'), '总结');
  assert.equal(s('总结'), '总结-2');
  assert.equal(s('总结'), '总结-3');
  assert.equal(s('其他'), '其他');
  assert.equal(s('总结'), '总结-4');
  assert.equal(s(''), '');          // 空标题不占号
  assert.equal(s('总结'), '总结-5');
});

test('stripInlineMd：把行内标记还原成渲染后的纯文本', () => {
  assert.equal(Core.stripInlineMd('**粗体**标题'), '粗体标题');
  assert.equal(Core.stripInlineMd('`code` 说明'), 'code 说明');
  assert.equal(Core.stripInlineMd('[链接](https://a.b) 之后'), '链接 之后');
  assert.equal(Core.stripInlineMd('![图](a.png)标题'), '标题');
  assert.equal(Core.stripInlineMd('a &amp; b'), 'a & b');
  assert.equal(Core.stripInlineMd('~~删~~除'), '删除');
});

test('buildHeadingLineMap：跳过代码块、与 DOM slug 规则一致、同名标题带序号', () => {
  const src = [
    '# 标题一',        // 0
    '',               // 1
    '```js',          // 2
    '# 这不是标题',     // 3  ← 代码块内
    '```',            // 4
    '',               // 5
    '## **粗体**小节', // 6
    '内容',           // 7
    '## 总结',        // 8
    '## 总结',        // 9
  ].join('\n');
  const map = Core.buildHeadingLineMap(src);
  assert.deepEqual([...map.keys()], ['标题一', '粗体小节', '总结', '总结-2']);
  assert.equal(map.get('标题一'), 0);
  assert.equal(map.get('粗体小节'), 6);
  assert.equal(map.get('总结'), 8);
  assert.equal(map.get('总结-2'), 9);
  assert.equal(map.size, 4);
});

test('buildHeadingLineMap：```` 与 ~~~ 围栏都能识别，未闭合时其后全视为代码', () => {
  const a = Core.buildHeadingLineMap(['~~~', '# x', '~~~', '# y'].join('\n'));
  assert.deepEqual([...a.keys()], ['y']);
  const b = Core.buildHeadingLineMap(['```', '# x'].join('\n'));
  assert.equal(b.size, 0);
});

/* ---------------- 行偏移 ---------------- */

test('lineOffsets / posToLineCol：与 split 口径一致', () => {
  const text = 'abc\ndef\n\nghi';
  const off = Core.lineOffsets(text);
  assert.deepEqual(off, [0, 4, 8, 9]);
  assert.equal(off.length, text.split('\n').length);
  assert.deepEqual(Core.posToLineCol(off, 0), { line: 1, col: 1 });
  assert.deepEqual(Core.posToLineCol(off, 3), { line: 1, col: 4 });
  assert.deepEqual(Core.posToLineCol(off, 4), { line: 2, col: 1 });
  assert.deepEqual(Core.posToLineCol(off, 8), { line: 3, col: 1 });
  assert.deepEqual(Core.posToLineCol(off, 9), { line: 4, col: 1 });
  assert.deepEqual(Core.posToLineCol(off, 12), { line: 4, col: 4 });
  assert.deepEqual(Core.posToLineCol(off, 999), { line: 4, col: 991 });   // 越界不崩溃，按末行算
});

test('lineOffsets：以换行结尾时保留末尾空行，空文档为 1 行', () => {
  assert.deepEqual(Core.lineOffsets('a\n'), [0, 2]);
  assert.deepEqual(Core.lineOffsets(''), [0]);
  assert.deepEqual(Core.lineOffsets(null), [0]);
});

/* ---------------- 统计 ---------------- */

test('countWords：中日韩按字、英文按词，与旧实现口径一致', () => {
  assert.deepEqual(Core.countWords('你好世界 hello world 123'),
    { cjk: 4, enWords: 3, words: 7, readMin: 1 });
  assert.equal(Core.countWords('').words, 0);
  assert.equal(Core.countWords('あいう').cjk, 3);
  // 阅读时间：900 词 ≈ 3 分钟（300 词/分）
  assert.equal(Core.countWords('a '.repeat(900)).readMin, 3);
});

/* ---------------- 正则安全 ---------------- */

test('validatePattern：空 / 超长被拒', () => {
  assert.equal(Core.validatePattern('').ok, false);
  assert.equal(Core.validatePattern('a'.repeat(Core.MAX_PATTERN_LEN + 1)).reason, 'too-long');
  assert.equal(Core.validatePattern('\\d+').ok, true);
});

test('safeMatchCount：正常计数', () => {
  const r = Core.safeMatchCount('a1 b2 c3', /\d/g);
  assert.equal(r.count, 3);
  assert.equal(r.truncated, false);
});

test('safeMatchCount：零宽断言不会死循环', () => {
  const r = Core.safeMatchCount('abc', /(?=b)/g);
  assert.equal(r.count, 1);
  assert.equal(r.truncated, false);
});

test('safeMatchCount：匹配次数极多时按预算/上限截断（同步护栏能拦住的那类）', () => {
  const r = Core.safeMatchCount('x'.repeat(5000), /x/g, { maxMatches: 1000 });
  assert.equal(r.count, 1000);
  assert.equal(r.truncated, true);
});

test('safeMatchCount：超长输入 + 简单正则在时间预算内退出', () => {
  const text = ('hello world '.repeat(20000));   // ~240KB
  const t0 = Date.now();
  const r = Core.safeMatchCount(text, /world/g, { budgetMs: 50 });
  assert.ok(Date.now() - t0 < 3000);
  // 预算可能已足够算完，也可能截断；两者都不卡死即达标
  assert.ok(r.count > 0 || r.truncated);
});

/* ---------------- 正则任务执行器（Worker 内运行的那份逻辑） ---------------- */

test('runRegexJob：count / replaceAll / find 三种模式', () => {
  assert.deepEqual(Core.runRegexJob({ mode: 'count', src: 'a1 b2', pattern: '\\d' }), { count: 2, truncated: false });

  const rep = Core.runRegexJob({ mode: 'replaceAll', src: 'a1 b2', pattern: '(\\d)', replacement: '[$1]' });
  assert.equal(rep.text, 'a[1] b[2]');
  assert.equal(rep.count, 2);

  const find = Core.runRegexJob({ mode: 'find', src: 'xx a1 b2', pattern: '\\d', from: 0 });
  assert.equal(find.index, 4);
  assert.deepEqual(find.groups, ['1']);          // groups 供 $1/$& 反向引用解析
  assert.equal(find.wrapped, false);

  const wrapped = Core.runRegexJob({ mode: 'find', src: 'ab', pattern: 'a', from: 1 });
  assert.equal(wrapped.index, 0);
  assert.equal(wrapped.wrapped, true);

  assert.equal(Core.runRegexJob({ mode: 'find', src: 'abc', pattern: 'z' }).index, -1);
});

test('runRegexJob：非法输入给出可区分的错误码', () => {
  assert.throws(() => Core.runRegexJob({ mode: 'count', src: 'a', pattern: '' }), (e) => e.code === 'EMPTY_PATTERN');
  assert.throws(() => Core.runRegexJob({ mode: 'count', src: 'a', pattern: '('.repeat(1) }), (e) => e.code === 'BAD_REGEX');
  assert.throws(() => Core.runRegexJob({ mode: 'count', src: 'a', pattern: 'a'.repeat(201) }), (e) => e.code === 'PATTERN_TOO_LONG');
});

test('runRegexJob：预算截断时 replaceAll 放弃替换，返回原文与标记', () => {
  const r = Core.runRegexJob({ mode: 'replaceAll', src: 'x'.repeat(3000), pattern: 'x', replacement: 'y', maxMatches: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 3000);
  assert.ok(r.text.startsWith('x'));
});

/* ---------------- 替换串语义 ---------------- */

test('processReplacement：转义序列与字面反斜杠', () => {
  assert.equal(Core.processReplacement('a\\nb'), 'a\nb');
  assert.equal(Core.processReplacement('a\\tb'), 'a\tb');
  assert.equal(Core.processReplacement('\\$1'), '$$1');       // \$ → 字面 $
  assert.equal(Core.processReplacement('C:\\\\path'), 'C:\\path');
});

test('evaluateMatchReplacement：$1/$&/$$ 解析', () => {
  const m = ['full', 'A', 'B'];
  assert.equal(Core.evaluateMatchReplacement('x$1y', m), 'xAy');
  assert.equal(Core.evaluateMatchReplacement('[$&]', m), '[full]');
  assert.equal(Core.evaluateMatchReplacement('$$1', m), '$1');
  assert.equal(Core.evaluateMatchReplacement('$9', m), '$9');  // 越界保持原样
  assert.equal(Core.evaluateMatchReplacement('$2', m), 'B');
});

/* ---------------- 中英排版 ---------------- */

test('formatSpacing：中文与拉丁/数字之间补空格，已隔开的不重复补', () => {
  assert.equal(Core.formatSpacing('中文English混排'), '中文 English 混排');
  assert.equal(Core.formatSpacing('中文 English 混排'), '中文 English 混排');
  assert.equal(Core.formatSpacing('第1章'), '第 1 章');
  // CJK 扩展 A 区（㐀）也应被处理
  assert.equal(Core.formatSpacing('㐀x'), '㐀 x');
});

/* ---------------- AI 响应 ---------------- */

test('parseSseLine：delta / message / [DONE] / keepalive', () => {
  assert.equal(Core.parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}'), '你');
  assert.equal(Core.parseSseLine('data: {"choices":[{"message":{"content":"好"}}]}'), '好');
  assert.equal(Core.parseSseLine('data: [DONE]'), '');
  assert.equal(Core.parseSseLine(': keepalive'), '');
  assert.equal(Core.parseSseLine('data: not-json'), '');
});

test('parseAiContent：SSE 与普通 JSON 双兼容', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    'data: {"choices":[{"delta":{"content":"世界"}}]}',
    'data: [DONE]',
  ].join('\n');
  assert.equal(Core.parseAiContent(sse), '你好世界');
  assert.equal(Core.parseAiContent('{"choices":[{"message":{"content":" 整段 JSON "}}]}'), '整段 JSON');
  assert.equal(Core.parseAiContent(''), '');
  assert.equal(Core.parseAiContent('garbage'), '');
});

/* ---------------- 章节 / 字数 ---------------- */

test('cnChapterNum：阿拉伯 / 中文 / 财务大写', () => {
  assert.equal(Core.cnChapterNum('12'), 12);
  assert.equal(Core.cnChapterNum('一'), 1);
  assert.equal(Core.cnChapterNum('十'), 10);
  assert.equal(Core.cnChapterNum('二十五'), 25);
  assert.equal(Core.cnChapterNum('一百零三'), 103);
  assert.equal(Core.cnChapterNum('壹'), 1);
  assert.equal(Core.cnChapterNum('贰拾'), 20);
  assert.equal(Core.cnChapterNum('零'), null);
});

test('parseChapterList：容忍前缀与粗体，按章号去重排序', () => {
  const outline = [
    '## 第3章 收尾',
    '- **第1章** 开端（上）',
    '1. 第2章：发展',
    '第1章 重复条目',
    '## 第壹拾章 大写',
  ].join('\n');
  const list = Core.parseChapterList(outline);
  assert.deepEqual(list.map((x) => x.num), [1, 2, 3, 10]);
  assert.equal(list[0].title, '开端');
  assert.equal(list[1].title, '发展');
  assert.equal(list[3].title, '大写');
});

test('parseWordCount / parseCountValue：中文数字、小数、链式', () => {
  assert.deepEqual(Core.parseWordCount('每章字数目标：3000字'), { count: 3000, cmp: 'min' });
  assert.equal(Core.parseCountValue('1.5万'), 15000);
  assert.equal(Core.parseCountValue('1万五千'), 15000);
  assert.equal(Core.parseCountValue('三千'), 3000);
  assert.equal(Core.parseWordCount('不少于 8000 字').count, 8000);
  assert.equal(Core.parseWordCount('写个 50 字的口号'), null);   // <200 视为噪声
  assert.equal(Core.parseWordCount(''), null);
});

test('writtenChapterNums：识别隐形标记', () => {
  const t = '<!-- ai-chapter:1 --> 正文 <!-- ai-chapter:3 -->';
  assert.deepEqual([...Core.writtenChapterNums(t)].sort(), [1, 3]);
  assert.equal(Core.writtenChapterNums('无标记').size, 0);
});

/* ---------------- 博客 ---------------- */

test('blogSmartCut：按句号截断、超长硬截、空返回 Untitled', () => {
  assert.equal(Core.blogSmartCut('第一句。第二句。', 40), '第一句');
  assert.equal(Core.blogSmartCut('a'.repeat(60), 10), 'a'.repeat(10));
  assert.equal(Core.blogSmartCut('   ', 10), 'Untitled');
});

test('parseBlogMeta：front matter 优先 > H1 > 首行截断', () => {
  const fm = '---\ntitle: FM 标题\ntags: [a, b]\n---\n\n# 正文标题\n内容';
  const r1 = Core.parseBlogMeta(fm);
  assert.equal(r1.title, 'FM 标题');
  assert.deepEqual(r1.tags, ['a', 'b']);
  assert.equal(r1.body.trim(), '# 正文标题\n内容');   // front matter 已剥离

  const r2 = Core.parseBlogMeta('# 正文标题\n内容');
  assert.equal(r2.title, '正文标题');

  const r3 = Core.parseBlogMeta('没有标题的一段话。后面还有。');
  assert.equal(r3.title, '没有标题的一段话');

  const r4 = Core.parseBlogMeta('---\ntitle: "引号标题"\n---\nx');
  assert.equal(r4.title, '引号标题');
});

test('parseBlogMeta：超长标题被智能截断到 40 字内', () => {
  const long = '# ' + '标'.repeat(80);
  assert.ok(Core.parseBlogMeta(long).title.length <= Core.BLOG_TITLE_MAX_LEN);
});

test('blogMdToPlain：去掉代码块、标题井号、链接语法', () => {
  const md = '# 标题\n\n```js\nconst a = 1;\n```\n\n见 [链接](https://x.y) 和 ![图](a.png)\n\n**加粗**';
  const plain = Core.blogMdToPlain(md);
  assert.ok(!plain.includes('#'));
  assert.ok(!plain.includes('const a'));
  assert.ok(plain.includes('链接'));
  assert.ok(!plain.includes('https'));
  assert.ok(!plain.includes('**'));
  assert.equal(plain.includes('\n\n\n'), false);
});

/* ---------------- 历史快照策略 ---------------- */

test('shouldSnapshot：无历史必存；间隔足够必存；小幅改动不存；大幅改动存', () => {
  const now = 1_000_000_000;
  assert.equal(Core.shouldSnapshot({ now }), true);
  assert.equal(Core.shouldSnapshot({ now, lastAt: now - 6 * 60 * 1000, prevLen: 1000, newLen: 1000 }), true);
  assert.equal(Core.shouldSnapshot({ now, lastAt: now - 10_000, prevLen: 1000, newLen: 1010 }), false);
  assert.equal(Core.shouldSnapshot({ now, lastAt: now - 10_000, prevLen: 1000, newLen: 1200 }), true);
  assert.equal(Core.shouldSnapshot({ now, lastAt: now - 10_000, prevLen: 1000, newLen: 800 }), true);
});

/* ---------------- ZIP ---------------- */

test('zipStore / unzipStore：往返一致（文本 + 中文名 + 二进制）', async () => {
  const bin = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const files = [
    { name: 'manifest.json', data: '{"v":1}' },
    { name: 'docs/中文文档.md', data: new TextEncoder().encode('# 标题\n正文') },
    { name: 'images/abc', data: bin },
  ];
  const zip = Core.zipStore(files);
  assert.ok(zip instanceof Uint8Array);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);

  const back = await Core.unzipStore(zip);
  assert.equal(back.length, 3);
  assert.equal(new TextDecoder().decode(back[0].data), '{"v":1}');
  assert.equal(back[1].name, 'docs/中文文档.md');
  assert.equal(new TextDecoder().decode(back[1].data), '# 标题\n正文');
  assert.deepEqual([...back[2].data], [...bin]);
});

test('zipStore：空列表也能产出可解析的 zip', async () => {
  const zip = Core.zipStore([]);
  const back = await Core.unzipStore(zip);
  assert.deepEqual(back, []);
});

test('unzipStore：非 zip 输入报错', async () => {
  await assert.rejects(() => Core.unzipStore(new TextEncoder().encode('not a zip')), /不是有效的 zip/);
});

test('crc32：已知向量', () => {
  // "123456789" 的 CRC32 = 0xCBF43926
  assert.equal(Core.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
