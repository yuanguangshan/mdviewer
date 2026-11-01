"""
端到端冒烟测试（真实 Chromium + 本地 HTTP 服务，覆盖 Service Worker / Worker / IndexedDB）

运行：
    python3 -m http.server 8137 --bind 127.0.0.1 &     # 或任意静态服务器
    python3 tests/e2e_smoke.py                          # 默认连 http://127.0.0.1:8137

为什么单独写：md-core 的单测覆盖纯逻辑，但「弹窗焦点陷阱 / 撤销栈 / Worker 超时 /
文库 IndexedDB / 备份下载」这些只有真浏览器能验。
"""
import json
import os
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("MDVIEWER_BASE", "http://127.0.0.1:8137/").rstrip("/") + "/"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  ✓ " if cond else "  ✗ ") + name + (("  → " + detail) if detail and not cond else ""))
    return cond


def wait_server(timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(BASE + "index.html", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def new_page(browser, errors):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text)
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.goto(BASE, wait_until="load")
    page.wait_for_selector("#editor")
    return ctx, page


def set_editor(page, text):
    page.evaluate(
        """(t) => {
            const ed = document.getElementById('editor');
            ed.value = t;
            ed.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        text,
    )


def main():
    if not wait_server():
        print("✗ 服务器未就绪：" + BASE)
        return 1

    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ---------- 1. 启动无报错 ----------
        print("\n[1] 启动与渲染")
        errors = []
        ctx, page = new_page(browser, errors)
        check("页面标题正确", page.title() == "雨轩编辑器", page.title())
        check("md-core 已加载", page.evaluate("!!window.MdCore") is True)
        meta = page.get_attribute('meta[name="app-version"]', "content")
        app_ver = page.evaluate("document.querySelector('.version').textContent")
        check("版本标记一致（无混合缓存告警）", meta == app_ver.lstrip("v"),
              f"meta={meta} footer={app_ver}")

        set_editor(page, "# 你好\n\n这是一段**正文**。\n\n```js\nconst a = 1;\n```\n")
        page.wait_for_timeout(400)
        check("预览渲染标题", page.inner_text("#preview h1") == "你好")
        check("代码块高亮生效", page.eval_on_selector("#preview pre code", "el => el.className").find("hljs") >= 0)
        check("字数统计更新", "字" in page.inner_text("#stat"), page.inner_text("#stat"))

        # ---------- 2. 重复标题去重 ----------
        print("\n[2] 同名标题不产生重复 id")
        set_editor(page, "## 总结\n\n第一节\n\n## 总结\n\n第二节\n")
        page.wait_for_timeout(400)
        ids = page.eval_on_selector_all("#preview h2", "els => els.map(e => e.id)")
        check("两个同名标题 id 唯一", len(set(ids)) == 2 and ids == ["总结", "总结-2"], str(ids))
        toc = page.eval_on_selector_all(".toc-item", "els => els.map(e => e.dataset.slug)")
        check("目录条目 slug 与 DOM 一致", toc == ["总结", "总结-2"], str(toc))
        check("重复 id 检查（document 全局唯一）",
              page.evaluate("""() => {
                  const all = [...document.querySelectorAll('[id]')].map(e => e.id);
                  return all.length === new Set(all).size;
              }""") is True)

        # ---------- 3. 撤销栈 ----------
        print("\n[3] 程序化改写后可 Ctrl+Z")
        set_editor(page, "foo foo foo")
        page.wait_for_timeout(200)
        page.keyboard.press("Control+f")
        page.fill("#frFind", "foo")
        page.fill("#frReplace", "bar")
        page.click("#frReplaceAll")
        page.wait_for_timeout(300)
        after = page.eval_on_selector("#editor", "e => e.value")
        check("全部替换生效", after == "bar bar bar", after)
        page.keyboard.press("Escape")
        page.eval_on_selector("#editor", "e => e.focus()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(300)
        undone = page.eval_on_selector("#editor", "e => e.value")
        check("Ctrl+Z 撤回替换（旧版此处无效）", undone == "foo foo foo", undone)
        page.keyboard.press("Control+Shift+z")
        page.wait_for_timeout(300)
        redo = page.eval_on_selector("#editor", "e => e.value")
        check("Ctrl+Shift+Z 重做", redo == "bar bar bar", redo)

        # ---------- 4. 正则护栏（Worker + 硬超时） ----------
        print("\n[4] ReDoS 护栏：Worker 超时中断，页面不卡死")
        set_editor(page, "a" * 3000)
        page.wait_for_timeout(300)
        page.keyboard.press("Control+f")
        page.check("#frRe")
        page.fill("#frFind", "a+a+a+a+a+a+a+a+a+a+a+a+b")
        t0 = time.time()
        page.click("#frNext")
        page.wait_for_timeout(4000)
        elapsed = time.time() - t0
        txt = page.inner_text("#frCount")
        alive = page.evaluate("() => { const t = Date.now(); for (let i=0;i<2e7;i++); return Date.now()-t; }")
        check("页面在护栏触发后仍可响应", alive < 2000, f"同步循环耗时 {alive}ms")
        check("给出明确反馈（超时/未找到）", ("中断" in txt) or ("未找到" in txt), txt)
        check("不会无限挂起", elapsed < 20, f"{elapsed:.1f}s")
        page.keyboard.press("Escape")
        check("Esc 关闭查找面板", page.query_selector("#findReplacePanel") is None)

        # ---------- 5. 文库 + 持久化 ----------
        print("\n[5] 文库写入与重载恢复")
        set_editor(page, "# 文库测试\n\n内容 ABC\n")
        page.click("#btnLibrary")
        page.wait_for_timeout(400)
        page.click("#libNew")
        page.wait_for_timeout(300)
        set_editor(page, "# 文库测试\n\n内容 XYZ 持久化\n")
        page.wait_for_timeout(1200)          # 等 800ms 回写去抖
        state = page.inner_text("#saveState")
        check("状态显示已存文库", "文库" in state, state)
        count = page.eval_on_selector("#libFootCount", "e => e.textContent")
        check("文库计数为 1", count == "1", count)

        page.reload(wait_until="load")
        page.wait_for_timeout(900)
        restored = page.eval_on_selector("#editor", "e => e.value")
        check("重载后自动打开上次文库文档", "XYZ" in restored, restored[:40])

        # 历史快照策略：同一分钟内反复编辑不应刷满 20 条
        for i in range(6):
            set_editor(page, "# 文库测试\n\n内容 XYZ 持久化 " + str(i) + "\n")
            page.wait_for_timeout(900)
        snaps = page.evaluate("""async () => {
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('md-library');
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            const id = localStorage.getItem('md-lib-current');
            const list = await new Promise((res, rej) => {
                const r = db.transaction('history', 'readonly').objectStore('history').index('byDoc').getAll(id);
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            return list.length;
        }""")
        check("短时间连续编辑不会刷满 20 条快照", snaps <= 3, f"{snaps} 条")

        # ---------- 6. 全库备份 / 恢复 ----------
        print("\n[6] 全库备份（zip）")
        with page.expect_download(timeout=15000) as dl:
            page.evaluate("() => document.querySelector('[data-act=backup-export]').click()")
        download = dl.value
        fn = download.suggested_filename
        check("下载文件名符合备份命名", re.match(r"mdviewer-backup-\d{8}-\d{4}\.zip$", fn) is not None, fn)
        path = "/tmp/" + fn
        download.save_as(path)
        size = os.path.getsize(path)
        check("zip 体积合理（>200B）", size > 200, f"{size}B")
        with open(path, "rb") as f:
            head = f.read(4)
        check("是合法 zip（PK\\x03\\x04）", head == b"PK\x03\x04", str(head))

        # 恢复：同名覆盖，不报错
        page.set_input_files("input[type=file][accept*='zip']", path)
        page.wait_for_timeout(600)
        if page.is_visible("#confirmModal"):
            page.evaluate("() => document.querySelector('#confirmModalOk').click()")
        page.wait_for_timeout(1500)
        toast = page.eval_on_selector("#toast", "e => e.textContent")
        check("恢复成功提示", "已恢复" in toast, toast)

        # ---------- 7. 弹窗可访问性 ----------
        print("\n[7] 弹窗焦点陷阱 + 背景 inert")
        page.evaluate("() => document.querySelector('[data-act=diagnostics]').click()")
        page.wait_for_timeout(300)
        check("诊断弹窗打开", page.is_visible("#diagModal"))
        check("背景 .app 已 inert", page.evaluate("() => document.querySelector('.app').inert") is True)
        inside = page.evaluate("() => !!document.activeElement.closest('#diagModal')")
        check("焦点自动进入弹窗", inside)
        # Tab 循环：连续 8 次 Tab 后仍在弹窗内
        for _ in range(8):
            page.keyboard.press("Tab")
        still_inside = page.evaluate("() => !!document.activeElement.closest('#diagModal')")
        check("Tab 被限制在弹窗内", still_inside)
        check("诊断内容含版本与错误段",
              "mdviewer 诊断信息" in page.eval_on_selector("#diagText", "e => e.value"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("Esc 关闭后背景恢复可交互", page.evaluate("() => document.querySelector('.app').inert") is False)

        # ---------- 8. 菜单键盘导航 ----------
        print("\n[8] 菜单方向键导航")
        page.click("#btnMore")
        page.wait_for_timeout(300)
        page.eval_on_selector("#moreMenu button[role=menuitem]", "e => e.focus()")
        first = page.evaluate("() => document.activeElement.textContent")
        page.keyboard.press("ArrowDown")
        second = page.evaluate("() => document.activeElement.textContent")
        check("ArrowDown 移动焦点", first != second, f"{first!r} → {second!r}")
        page.keyboard.press("ArrowUp")
        back = page.evaluate("() => document.activeElement.textContent")
        check("ArrowUp 回到上一条", back == first, f"{back!r}")
        page.keyboard.press("Escape")
        page.evaluate("() => { const m = document.querySelector('#moreMenu'); if (!m.hidden) m.hidden = true; }")

        # ---------- 8.5 AI 流式（拦截端点，验证解析 + 超时机制改造没破坏正常路径） ----------
        print("\n[8.5] AI 流式输出（mock 端点）")
        page.evaluate("""() => {
            localStorage.setItem('md-ai-config', JSON.stringify({
                apiKey: 'test-key',
                endpoint: 'https://wx.want.biz/v1/chat/completions',
                model: 'mock-model'
            }));
        }""")
        page.reload(wait_until="load")
        page.wait_for_timeout(500)

        sse = b'data: {"choices":[{"delta":{"content":"\u4f60\u597d"}}]}\n\ndata: {"choices":[{"delta":{"content":"\uff0c\u4e16\u754c"}}]}\n\ndata: [DONE]\n\n'
        page.route("https://wx.want.biz/**", lambda route: route.fulfill(
            status=200, headers={"content-type": "text/event-stream"}, body=sse))

        set_editor(page, "# 测试文档\n\n这是用来触发 AI 摘要的正文内容。\n")
        page.wait_for_timeout(300)
        page.evaluate("() => document.querySelector('[data-action=aiSummary]').click()")
        page.wait_for_selector("#aiStreamPanel:not([hidden])", timeout=10000)
        page.wait_for_timeout(1200)
        body = page.inner_text("#aspBody")
        check("流式内容正确拼接", "你好" in body and "世界" in body, body.replace("\n", " ")[:60])
        page.click("#aspApply")
        page.wait_for_timeout(400)
        val = page.eval_on_selector("#editor", "e => e.value")
        check("应用后写回编辑器", "你好，世界" in val, val[:60])
        page.unroute("https://wx.want.biz/**")

        # ---------- 8.8 导出 HTML：文库图必须内联成 data URL ----------
        print("\n[8.8] 导出 HTML（含文库图片内联）")
        page.evaluate("""async () => {
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('md-library');
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            await new Promise((res, rej) => {
                const tx = db.transaction('images', 'readwrite').objectStore('images')
                    .put({ id: 'e2eimg1', name: 't.png', type: 'image/png', blob: new Blob([bytes], { type: 'image/png' }) });
                tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error);
            });
        }""")
        set_editor(page, "# 导出测试\n\n正文一段。\n\n![图](libimg://e2eimg1)\n")
        page.wait_for_timeout(1200)          # 等渲染 + resolveImages 把 libimg 换成 blob:
        with page.expect_download(timeout=15000) as dl2:
            page.evaluate("() => document.querySelector('[data-act=html]').click()")
        d2 = dl2.value
        html_path = "/tmp/e2e-export.html"
        d2.save_as(html_path)
        html_text = open(html_path, encoding="utf-8", errors="replace").read()
        check("导出 HTML 含正文", "导出测试" in html_text)
        check("文库图已内联为 data URL（旧实现在此会丢图）", "data:image/png;base64," in html_text,
              "未找到 data:image")
        check("导出 HTML 不含临时 blob: 引用", "blob:" not in html_text)

        # ---------- 9. 无报错 ----------
        print("\n[9] 控制台健康度")
        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("无 console.error / pageerror", not real_errors, "; ".join(real_errors[:3]))

        ctx.close()
        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{'='*60}\n{passed}/{len(results)} 项通过")
    if passed != len(results):
        print("\n失败项：")
        for name, ok, detail in results:
            if not ok:
                print("  ✗ " + name + ("  → " + detail if detail else ""))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
