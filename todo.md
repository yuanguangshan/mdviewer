
alias cy="cd /Users/ygs/ygs"
alias cy="cd /Users/ygs/ygs"
` 中的 `AI_ACTIONS`

找到 `app.js` 中的 `const AI_ACTIONS = { ... }` 对象，在里面添加一个新的方法 `aiBookOutline`：

```javascript
const AI_ACTIONS = {
  // ... (保留原有的 aiSummary, aiPolish 等方法)

  // 新增：书籍大纲撰写
  aiBookOutline() {
    const s = editor.selectionStart, e = editor.selectionEnd;
    let selected = editor.value.slice(s, e).trim();
    
    // 如果用户没有选中文本，弹窗询问主题
    if (!selected) {
      selected = window.prompt('请输入你想撰写的书籍主题：', '');
      if (!selected) { toast('已取消', 'info'); return; }
    }
    
    aiRunStream({
      label: 'AI 策划书籍大纲',
      systemPrompt: `你是一名资深的图书策划人和畅销书作者。请根据用户提供的主题，构思一本专业、逻辑严密、结构清晰的书籍大纲。
要求如下：
1. 规划 8 到 10 章的内容结构，并包含每章的核心要点简述。
2. 为每一章设定建议的预期字数（标准要求为：每章 3000-5000 字）。
3. 在大纲末尾，单独提供一份针对该主题的具体写作技巧、素材收集建议与避坑指南。
请全部使用优雅的 Markdown 格式输出。`,
      promptText: selected,
      onApply: (full) => {
        // 构造插入文本：带上标题，并包裹换行
        const insertText = `\n\n## 《${selected}》书籍大纲\n\n${full}\n\n`;
        
        if (e > s) {
          // 如果用户是划词触发的，把大纲追加在选中文字的后面
          editor.value = editor.value.slice(0, e) + insertText + editor.value.slice(e);
          editor.selectionStart = editor.selectionEnd = e + insertText.length;
        } else {
          // 如果是弹窗输入的，直接插入在光标处
          insertAtCursor(insertText);
        }
        afterChange();
        toast('📖 书籍大纲已生成并插入', 'ok');
      }
    });
  },

  // ... (保留原有的 aiSettings 等方法)
};
```

### 第二步：修改 `index.html` 增加 UI 入口

我们需要在两个地方暴露这个功能：一是右上角的**「⋯」更多菜单**，二是选中文字后弹出的**「AI 悬浮气泡条」**。

**1. 添加到「⋯」更多菜单的 AI 子菜单中：**
打开 `index.html`，搜索 `id="sub-ai"`，在原有的 AI 按钮列表中追加一行：

```html
<!-- 二级菜单：AI 智能助理 -->
<div class="menu sub" id="sub-ai" role="menu" aria-label="AI 智能助理" hidden>
  <button role="menuitem" data-action="aiSummary">📝 全文总结摘要</button>
  <button role="menuitem" data-action="aiPolish">✨ 润色选中文字</button>
  <button role="menuitem" data-action="aiExpand">📈 扩写选中文字</button>
  <button role="menuitem" data-action="aiTranslate">🌐 翻译为英文</button>
  <button role="menuitem" data-action="aiGenerate">💡 按提示词生成</button>
  
  <!-- 下面是新增的这行 👇 -->
  <button role="menuitem" data-action="aiBookOutline">📖 策划书籍大纲</button> 
  
  <div class="menu-sep"></div>
  <button role="menuitem" data-action="aiSettings">⚙️ AI 设置（BYOK）</button>
</div>
```

**2. 添加到选中文本的「悬浮气泡条」中：**
打开 `index.html`，搜索 `id="aiFloatingToolbar"`，在里面追加一个按钮，方便用户选中一个词后一键生成：

```html
<!-- 选中文字后浮动的 AI 气泡菜单 -->
<div id="aiFloatingToolbar" class="floating-toolbar" hidden role="toolbar" aria-label="AI 工具">
  <button type="button" data-ai="aiPolish" title="润色选中文字">✨ 润色</button>
  <button type="button" data-ai="aiExpand" title="扩写选中文字">📈 扩写</button>
  <button type="button" data-ai="aiTranslate" title="翻译为英文">🌐 翻译</button>
  <button type="button" data-ai="aiSummary" title="全文总结摘要">📝 总结</button>
  
  <!-- 下面是新增的这行 👇 -->
  <button type="button" data-ai="aiBookOutline" title="按主题策划书籍大纲">📖 策划大纲</button>
</div>
```

### 这个新增功能的体验亮点（UX 细节）：
1. **智能追尾插入**：不像“润色”会覆盖掉你选中的词，这个功能会判定，如果是划词触发的，它会在你选中的“书名/主题”**下一行**把大纲渲染出来，保证你的原稿不被破坏。
2. **容错机制**：如果你没有选中任何文本，直接在菜单点击了「策划书籍大纲」，它不会把全文发给 AI 乱作一通，而是优雅地弹出一个原生 `prompt`，问你：“*请输入你想撰写的书籍主题*”。
3. **角色预设（System Prompt 优化）**：通过设定 `你是一名资深的图书策划人和畅销书作者` 的身份，以及明确告知约束（8-10章，每章 3000-5000字，附带写作技巧），AI 输出的质量会比直接问“帮我写个大纲”高出非常多，而且天然契合你编辑器的 Markdown 排版体系。lias cy="cd /Users/ygs/ygs"
