/*!
 * md-regex-worker.js —— 正则任务执行线程
 *
 * 为什么需要它：浏览器的正则引擎是同步的，`exec()` 一旦进入灾难性回溯就无法从外部打断。
 * 把用户输入的查找/替换正则放到 Worker 里跑，主线程只管起一个硬超时，
 * 超时就 `worker.terminate()` —— 页面永不卡死。
 *
 * 逻辑本体在 lib/md-core.js 的 runRegexJob()，这里只做消息收发，因此逻辑可被 node --test 覆盖。
 */
'use strict';

importScripts('./md-core.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  const id = msg.id;
  try {
    const out = self.MdCore.runRegexJob(msg.job || {});
    self.postMessage({ id: id, ok: true, out: out });
  } catch (err) {
    self.postMessage({
      id: id,
      ok: false,
      code: (err && err.code) || 'ERROR',
      error: (err && err.message) || String(err),
    });
  }
};
