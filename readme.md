> ## 🛠️ 极客宣言
>
> **极客风，服务于朴素场景。**
> 不堆框架、不炫技术，只把真正好用的底层能力，打磨成顺手的一键。
>
> - **零依赖的倔强** —— 一个 `app.js` 撑起全部，原生 JS + IndexedDB + Service Worker，不靠重型框架，打开即用。
> - **本地优先的执念** —— 文档与图片都先落本机，离线能写、断网能用，云端只是可选项而非前提。
> - **工程感的细节** —— 正则查找支持捕获组与零宽断言、粘贴图片自动回收孤儿、播客 feed 智能回插……每个功能都为了解决一个具体痛点而存在。
> - **克制即美德** —— 能本地做就不上云，能静默就不打扰，能一键就不弹窗。
>
> 这是我们的工具，也是我们的态度。
>
> ---

# 📝 欢迎使用全新升级的 Markdown 编辑器

> 一个集**高颜值、零配置、本地优先、完整 PWA 离线支持**于一体的现代网页版 Markdown 写作工具。

---

## ✨ 核心特性一览

### 1. ⚡ 沉浸式双栏与多视图模式
* **分屏预览**：左侧专注输入，右侧实时渲染，支持平滑的**同步滚动**。
* **多视图切换**：一键切换 **“双栏分屏”**、**“纯编辑模式”**、**“纯预览模式”**，适应不同的写作场景 [app.js]。
* **窄屏自适应**：在手机或平板等移动端设备上完美适配，支持软换行与精简工具栏 [styles.css]。

### 2. 📁 本地优先的文件与草稿管理
* **原生文件读写**：基于现代 Web API (`File System Access API`)，可直接打开本地 `.md` 文件并执行**原地保存（Ctrl+S）** [app.js]。
* **外部文档浏览（`?open=`）**：同源部署时（例如配套 `serve-web.js` 提供容器目录），可用 `/mdviewer/index.html?open=/path/to/x.md` 直接以排版阅读一个既有 `.md`——不写入文库、不占用索引库，`Ctrl/Cmd+S` 才会另存；跨源地址会被拒绝（外部内容请走 `?share_r2=` 分享链路）。详见 `docs/2026-11-01-v4.9.1-外部文档浏览.md`。
* **安全草稿箱**：内置防丢失机制，通过 `localStorage` 实时静默保存未提交的草稿，意外关闭网页也不怕 [app.js]。
* **丰富导出能力**：支持一键复制 HTML、导出 `.html` 文件，或者直接**一键打印/导出为精美 PDF** [app.js]。

### 2.5 ↩️ 可靠的撤销栈
* 程序化改写（**全部替换、AI 应用、中英排版、插入图片**）之后，`Ctrl+Z` / `Ctrl+Shift+Z` 依然有效。
* 原生输入仍交给浏览器自己的撤销栈；切换文档时自动重置，不会把 A 文档的快照套到 B 文档上。

### 3. 🎨 极简美学与全功能写作辅助
* **主题自由切换**：支持“自动（跟随系统）”、“明亮白（Light）”与“深邃黑（Dark）”一键切换 [app.js]。
* **正文外观自定义**：右上角「⋯ → 🌗 主题设置 → 🔠 正文字号与颜色」可实时调整预览正文的**字号（12–32 px）**与**字体颜色**（预设色板 + 取色器），设置保存在本机、导出 HTML 时自动沿用；不修改 Markdown 源文件 [app.js]。
* **多媒体互动**：支持**直接粘贴或拖拽图片**，自动转为 Base64 嵌入光标处 [app.js]。
* **实用小工具**：实时字数统计、预计阅读时间、精确光标定位（行、列）及代码行号显示 [app.js]。

### 4. 🌐 强大的 PWA 离线能力
* **离线可用**：借助 Service Worker 缓存技术，即使在没有网络的环境下，也能像本地原生软件一样独立运行 [sw.js]。
* **一键安装**：支持安装到 Windows、macOS、Android 或 iOS 的桌面与 Dock 栏，享受无边框的沉浸式体验 [manifest.webmanifest]。

### 5. 💾 保存到 IMA 笔记（腾讯 ima AI 笔记）
在右上角「⋯」菜单或左上方 logo 快捷菜单里选择 **「💾 保存到 IMA 笔记」**，即可把当前文档一键存入腾讯 ima AI 笔记，并拿到可分享的笔记链接。
* **安全模型**：腾讯 ima 的 OpenAPI 需要 `ima-openapi-clientid` / `ima-openapi-apikey` 两个自定义请求头，且这两个头不在 ima 的浏览器 CORS 白名单里，因此**前端不能直连**。本功能走「浏览器 → 自托管代理（`api.yuangs.cc/api/ima/import`）→ ima.qq.com」的链路，**密钥只保存在服务端**（`/home/ubuntu/.env` 的 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`），浏览器端不接触、也不配置任何密钥。
* **端点写死**：前端只需写死一个代理端点（`app.js` 里的 `IMA_PROXY_URL`），与 `BLOG_PUBLISH_URL` / `R2_WORKER_URL` 同属「唯一后端耦合点」约定。若代理部署到别处，改这一行即可（需与代理同步）。
* **与「发布到博客」互补**：博客用于公开分享，IMA 用于私有笔记沉淀，二者互不影响。

### 6. 🗄️ 全库备份与恢复
* 「⋯ → **🗄️ 备份全库（.zip）**」把整个文库（正文 + 元信息 + 图片 Blob）打包成 zip 下载。
* 「📥 从备份恢复」可直接导入：同名 id 覆盖，不删除现有文档。
* ZIP 读写是零依赖自研实现（`lib/md-core.js` 的 `zipStore` / `unzipStore`），支持 store 与 deflate。

### 7. 🩺 诊断与可观测
* `Ctrl + Alt + Shift + D`（或「⋯ → 🩺 诊断信息」）一键导出：版本、视口、文库统计、存储占用、最近 50 条错误。
* 页面与脚本版本不一致（SW 缓存错位）时会主动提示强刷，而不是让你对着「点了没反应」猜。

---

## 🚀 快速上手指南

1. **快捷键支持**：
   * `Ctrl + S` / `Cmd + S`：保存文件
   * `Ctrl + O` / `Cmd + O`：打开本地 Markdown 文件
   * `Ctrl + Alt + N`：新建文档
   * `Ctrl + Z` / `Ctrl + Shift + Z`：撤销 / 重做（含程序化改写）
   * `Ctrl + Alt + Shift + D`：诊断信息
2. **格式排版**：支持标准的 GFM（GitHub Flavored Markdown）语法，包括表格、任务列表、代码块高亮等。

---

## 💻 代码块与语法高亮演示

编辑器内置了高性能的代码高亮功能，支持多种主流编程语言：

```javascript
// JavaScript 示例
function initMarkdownEditor() {
  console.log("欢迎体验极致的 Markdown 写作乐趣！");
}
initMarkdownEditor();
```

```python
# Python 示例
def calculate_words(text):
    return len(text.split())

print(calculate_words("Hello Markdown!"))
```

---

> **“开始你的极简写作之旅吧……”** 
> 💡 *提示：你可以随时点击右上角的 `...` 菜单按钮导出你的文档或切换主题！*

---

## 🧪 工程与测试（v4.8）

项目仍然保持**零构建、零运行时依赖**，但不再「只能靠手测」：

| 层 | 位置 | 说明 |
|---|---|---|
| 纯函数内核 | `lib/md-core.js` | 标题 slug / 行偏移 / 字数 / 章节解析 / 博客元数据 / AI SSE 解析 / 正则安全 / ZIP 读写。**不碰 DOM**，浏览器挂 `window.MdCore`，Node 里 `require` 即可 |
| 正则线程 | `lib/md-regex-worker.js` | 用户输入的正则放进 Worker 跑，超时直接 `terminate()`——ReDoS 只会中断，不会冻住页面 |
| 分享接口闸门 | `lib/share-guard.mjs` | 只收 `text/markdown`、拒绝 `Content-Encoding`、2MB 上限、id 格式校验，挡掉扫描器与攻击载荷（见 `docs/2026-11-01-分享接口加固-runbook.md`） |
| 单元/集成测试 | `tests/*.test.js` | `node --test`，**67 个用例**：md-core 纯逻辑 + 分享接口写入闸门 + Worker 集成（假 R2 桶真跑 handler） |
| 端到端测试 | `tests/e2e_smoke.py` | Playwright + 真 Chromium，33 项断言：渲染、同名标题去重、撤销栈、ReDoS 中断、文库持久化、历史快照策略、zip 备份往返、弹窗焦点陷阱、菜单方向键、控制台零报错 |
| 版本一致性 | `scripts/sync-version.mjs` / `scripts/check-version.mjs` | 版本号单一来源（`VERSION`），脚本同步 + CI 校验 + SW 预缓存清单覆盖率检查 |

```bash
npm test                                  # 单元测试
npm run check                             # 单测 + 版本一致性 + 全量语法检查

python3 -m http.server 8137 --bind 127.0.0.1 &
python3 tests/e2e_smoke.py                # 端到端（需 playwright + chromium）

node scripts/sync-version.mjs             # 发布前：按 VERSION 同步所有版本标记
```

CI：`.github/workflows/test.yml` 在每次 push / PR 上跑单测 + 版本校验 + 语法检查。
