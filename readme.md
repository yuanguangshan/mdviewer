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
* **安全草稿箱**：内置防丢失机制，通过 `localStorage` 实时静默保存未提交的草稿，意外关闭网页也不怕 [app.js]。
* **丰富导出能力**：支持一键复制 HTML、导出 `.html` 文件，或者直接**一键打印/导出为精美 PDF** [app.js]。

### 3. 🎨 极简美学与全功能写作辅助
* **主题自由切换**：支持“自动（跟随系统）”、“明亮白（Light）”与“深邃黑（Dark）”一键切换 [app.js]。
* **多媒体互动**：支持**直接粘贴或拖拽图片**，自动转为 Base64 嵌入光标处 [app.js]。
* **实用小工具**：实时字数统计、预计阅读时间、精确光标定位（行、列）及代码行号显示 [app.js]。

### 4. 🌐 强大的 PWA 离线能力
* **离线可用**：借助 Service Worker 缓存技术，即使在没有网络的环境下，也能像本地原生软件一样独立运行 [sw.js]。
* **一键安装**：支持安装到 Windows、macOS、Android 或 iOS 的桌面与 Dock 栏，享受无边框的沉浸式体验 [manifest.webmanifest]。

---

## 🚀 快速上手指南

1. **快捷键支持**：
   * `Ctrl + S` / `Cmd + S`：保存文件
   * `Ctrl + O` / `Cmd + O`：打开本地 Markdown 文件
   * `Ctrl + Alt + N`：新建文档
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
