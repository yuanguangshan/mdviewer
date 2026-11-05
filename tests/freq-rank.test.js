'use strict';
/**
 * tests/freq-rank.test.js —— 「常用功能」排序
 * 关键不变量：次数相同的项必须按 key 稳定排序，否则每次打开菜单顺序都在跳，
 * 用户会以为菜单在乱动（这类"看起来没 bug 但很难受"的问题只能靠测试钉住）。
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/md-core.js');

test('按次数降序', () => {
  assert.deepEqual(C.rankFreq({ a: 1, b: 5, c: 3 }, 3), ['b', 'c', 'a']);
});

test('只取前 N 个', () => {
  const m = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 };
  assert.deepEqual(C.rankFreq(m, 5), ['a', 'b', 'c', 'd', 'e']);
});

test('次数相同按 key 字典序（结果稳定）', () => {
  assert.deepEqual(C.rankFreq({ z: 2, a: 2, m: 2 }, 3), ['a', 'm', 'z']);
});

test('排除指定 key、过滤非法计数', () => {
  assert.deepEqual(C.rankFreq({ 'act:commandPalette': 99, x: 1, y: 0, z: -3 }, 5, ['act:commandPalette']), ['x']);
});

test('空/脏输入不炸', () => {
  assert.deepEqual(C.rankFreq(null, 5), []);
  assert.deepEqual(C.rankFreq({}, 5), []);
  assert.deepEqual(C.rankFreq({ a: '3' }, 5), [], '字符串计数视为非法');
});

test('prefer：次数相同时按给定顺序，而不是字母序', () => {
  const m = { 'act:txt': 1, 'act:addtolib': 1, 'act:nas-upload': 1 };
  const prefer = ['act:nas-upload', 'act:addtolib', 'act:txt'];
  assert.deepEqual(C.rankFreq(m, 5, [], prefer), ['act:nas-upload', 'act:addtolib', 'act:txt']);
});

test('prefer 只影响平手，不影响次数排序', () => {
  const m = { 'act:txt': 5, 'act:nas-upload': 1 };
  assert.deepEqual(C.rankFreq(m, 5, [], ['act:nas-upload', 'act:txt']), ['act:txt', 'act:nas-upload']);
});
