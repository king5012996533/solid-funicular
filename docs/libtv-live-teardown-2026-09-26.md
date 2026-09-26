# LibTV 真机增量取证（2026-09-26，已登录）

> 这份文档**不是**重写对照清单，而是对既有三份文档的**增量补正**：
> `libtv-refactor-checklist.md`（9/21–9/22 登录后实测）、`libtv-interaction-spec.md`（画布交互规格）、
> `canvas-theme-mapping.md`（主题映射）。
>
> 本次取证的**新增手段**（前几轮没有的）：直接读**服务端节点数据模型**与**全量设计 token 原值**，
> 而不是只看渲染出来的 UI。前几轮靠肉眼看图，尺寸/颜色是估的；这次是量的。
>
> **同批次还有一份看图版对照**：`docs/libtv-canvas-benchmark.md`（同一天、以截图裁切为主、带 P1/P2/P3 分档）。
> 两份是互补的：那份告诉你「看起来是什么样」，这份告诉你「量出来、以及服务端到底存了什么」。
> 两者有 3 处结论不一致，**以本文档为准**（理由见那份文档自己的 §6.1：它明确说明那几处它没能在图上看到，
> 只能引 DOM 或历史抓取）：
> 1. `TV Director` 在**底部中央 dock**，不在顶栏（本文档曾据 DOM 顺序记错，已在下文更正）；
> 2. 节点动作条的**归属与位置**：是**视频节点**的浮层、位于卡片**上方**（本文档有坐标证据）；
>    那份文档把它记在「图片组下方」，它自己也标注了不确定；
> 3. 带「下载 / 设为主图」的是**图片卡片**上的按钮，不是视频节点的动作条。

## 0. 取证方式与证据清单

在用户**已登录**的专用 Chrome 窗口（独立 user-data-dir，调试端口 9333）上，用 CDP 直连其真实画布
`liblib.tv/canvas?spaceId=9888405&projectId=4438f7c4…`。**只做"看"和"选中"，未触发任何生成、未消耗其积分。**

工具：`refund-e2e/liblib-explore.mjs`（模式 `dom / tree / chain / css / click-sel / eval / net`）。

| 证据 | 位置 |
|---|---|
| 画布全屏截图 | `refund-e2e/liblib-canvas.png`、`liblib-after-click.png` |
| 首页产品矩阵截图 | `refund-e2e/liblib-home.png` |
| 角色造型室截图 | `refund-e2e/liblib-charlib.png` |
| 结构化 DOM 轮廓 | `refund-e2e/liblib-dom.png` + `ex.log` |
| 面板/动作条组件树 | `refund-e2e/tree-panel.log`、`tree-actionbar.log`、`tree-char.log` |
| 计算样式（颜色/圆角/字号） | `refund-e2e/css-node.log`、`css-canvas.log` |
| 设计 token 原值（936 个） | session 日志（见本文 §5 摘录） |
| **服务端项目详情 JSON** | `refund-e2e/liblib-net-1.json` |
| API 请求清单（76 条） | `refund-e2e/ex.log` |

---

## 1. 结论先行：我们该抄的是"结构"，而且大部分已经抄对了

**三个发现，按重要性排序：**

1. **他们画布也是 React Flow**（`react-flow__nodes` / `react-flow__node-video` / `node-shell`）。
   我们用 VueFlow（React Flow 的 Vue 移植）。**同一套坐标系、同一套 handle/measured/viewport 模型。**
   这意味着节点结构、连线、缩放、拖拽的**行为语义可以直接对齐**，不存在范式冲突。
2. **我们的设计 token 值是抄对的**。他们画布底 `#141414`、卡片底 `#262626`、品牌色 `#13d5ff`
   —— 与 `styles/libtv-tokens.css` 里的定义逐一吻合。**配色不需要重做，只需要补没覆盖到的语义槽。**
3. **真正没抄的不是皮，是三样"里子"**：节点动作条（把节点当工作台）、规范化节点数据模型
   （`nodeList`/`connectionList`/`_resourceMeta`）、角色一致性资产。前两样是产品结构，第三样是漫剧刚需。

---

## 2. 节点卡片解剖（实测，非估算）

### 2.1 尺寸：卡片是**固定 625×350**，不是自适应

| 项 | 实测值 | 来源 |
|---|---|---|
| 卡片 CSS 尺寸 | **625×350**（图片节点）/ 622×350（视频节点） | `getComputedStyle` + 服务端 `measured` |
| 画布缩放 | 40%（用户可调） | 左下缩放控件 |
| 服务端存的 `measured` | `{width:"625", height:"350"}` | `nodeList[].measured` |
| 卡片圆角 | `rounded-xl` = 12px | ✓ 与我们一致 |

`measured` 存的是 **100% 缩放下的尺寸**，不是屏幕像素 —— 我们若照抄数据结构，别把屏幕像素存进去。

### 2.2 标题行：紧贴卡片上方，**13px/400/灰色**，不是 14px/500

```
[icon 14×14] 图片节点 - 副本 (13px, cursor-text) [icon 14×14]        1456 × 816 (11px, tabular-nums, opacity .8)
────────── 间隙 2px ──────────
┌────────────────────────────────┐
│        卡片主体 625×350          │
└────────────────────────────────┘
```

| 项 | 我们的规格（`libtv-interaction-spec.md` §2） | **实测** | 差 |
|---|---|---|---|
| 标题字号/字重 | 14px / 500 | **13px / 400** | 偏大偏重 |
| 标题颜色 | 一级文字 `#ffffff` | **`#919191`（三级/muted）** | 我们太亮 |
| 标题行高 | 22px | **19px**（font-size 13 + line-height 20.15） | 偏大 |
| 标题与卡片间距 | `margin-bottom: 8px` | **2px** | 我们太空 |
| 尺寸标签 | — | 11px + `tabular-nums` + `opacity:.8`，右对齐 | **我们没有** |
| 标题可编辑 | 双击 | `cursor-text` + `pointer-events-auto` | ✓ 一致 |

标题行上还有一个 14×14 的**类型图标**（图片/视频），且左图标可点（`cursor-pointer` 包着一层 div）。

**动效**：标题行是 `transition-[transform,opacity] duration-150 ease-out` —— 悬停/选中才淡入，
不是常驻。我们目前是常驻，属于可接受的简化，但要意识到差异。

### 2.3 参数 chip 行：**不在卡片上方，在卡片下方的面板里**

我们的规格写「参数 chip 行 absolute, bottom:100%, margin-bottom:30px」。**实测他们卡片上方只有标题行，
没有参数 chip 行**；参数（`2.5 · 全能参考 · 16:9 · 720P · 30s · 1个` + `1380`）全部在**点击后从卡片下方
浮出的面板**里（见 §4）。卡片标题行右侧只有 `1280 × 720` 和 `4张` 两个摘要。

→ **建议**：参数摘要应当出现在**点击后从卡片下方浮出的面板**里，卡片上方只留标题 + 尺寸 + 数量。
（`libtv-interaction-spec.md` §2 把参数 chip 行放在卡片上方 —— 那份规格在此点上与实测不符，
**动手前先核对我们当前实际渲染**，不要照规格直接改。）

### 2.4 连接点（handle）

| 项 | 实测 |
|---|---|
| 方向 | **只有左/右**（`react-flow__handle-left` / `-right`），无上下 |
| 垂直位置 | 卡片正中（卡片 402–544，handle 在 473） |
| 命中区 | 子元素 **32×32**，挂在卡片外侧（左 handle 的子元素 x=999，卡片左边界 1032） |
| 类名 | `nodrag nopan` 双写（React Flow 的拖拽/平移抑制） |

---

## 3. 节点动作条：**这是我们缺得最多的一块**（选中时从卡片上方浮出）

选中节点后，卡片上方浮出一条 **909×42** 的横向动作条（`node-floating-ui`，与标题行同一套浮层机制）。

```
[高清] [片段重拍▾] [逐帧拉片▾•] [智能去字幕▾] [音视频分离▾] [主体消除▾] [创意片头▾•] │ [icon][icon][icon]
```

| 项 | 实测 |
|---|---|
| 按钮高度 | **h-8 = 32px**，圆角，`gap-1`（4px） |
| 按钮内部 | **icon 16×16 + 文字 + 可选 chevron 12×12**，三段结构 |
| 带 chevron（有二级菜单） | 片段重拍 / 逐帧拉片 / 智能去字幕 / 音视频分离 / 主体消除 / 创意片头 |
| 不带 chevron（直接执行） | 高清 |
| **角标** | `absolute -right-0.5 -top-0.5` **12×12** 圆点 + `bg-nt-icon-brand`，出现在 **逐帧拉片** 与 **创意片头** 上（新品/独家标记） |
| 分隔线 | `mx-1 h-5`（1×20） |
| 尾部 3 个 | 纯图标按钮 32×32 |
| 颜色 token | `text-canvas-controls-text` / `hover:bg-canvas-controls-hover` / `aria-expanded:bg-canvas-controls-hover` |
| 宽度分布 | 高清 70 · 片段重拍 112 · 逐帧拉片 112 · 智能去字幕 125 · 音视频分离 125 · 主体消除 112 · 创意片头 98 |

**产品含义**：这是"**节点即工作台**"。每个产出物节点自身就能发起二次加工（重拍/拉片/去字幕/分离音轨/
消除主体/生成片头），不需要回到对话框描述。

> **⚠️ 两处更正（本文档初稿引用了旧文档与我的转述，都不准）**：
>
> 1. **「ImageNode 有 9 个『接入中』假入口」已不成立**（旧 `libtv-interaction-spec.md` §7.6 的说法）。
>    实测：`ImageNode.vue:367` 的 `toolbarItems` = **高清 / 全景 / 多角度▾ / 打光▾ / 裁剪**
>    —— 5 个**真实动作**，由通用组件 `CanvasNodeTopToolbar.vue` 渲染；
>    `ImageNode.vue:364` 还明确写着「宁可少放，也不摆『接入中』那种假入口」。
> 2. **「我们的动作条在卡片下方」也是错的**：`useNodeToolbar.ts:132` 是
>    `bottom: calc(100% + gap/zoom)` —— 我们的节点动作条本来就在**卡片上方**，
>    与 LibTV **同侧**（LibTV 实测动作条 y=328..370、卡片 y=402）。不存在这个差异。
>
> **真正的空白是视频节点的「内容加工动作」**：它只有悬浮的 `复制 / 下载 / 删除`
> （`CanvasNodeHoverToolbar`），**没有任何针对产出的加工动作** —— 而图片节点有 5 个。
> 这轮已按结构补齐：给视频节点接上 `CanvasNodeTopToolbar`，第一个真实动作是
> **抽帧（截取当前帧 / 首帧 / 尾帧 → 生成新图片节点）**，见 §10。
> 其余动作（去字幕 / 分离音轨 / 主体消除…）都要新上游，**不做**（同「宁可少放」的纪律）。

**视频节点专属的第二条**：动作条之外还有一条**时间轴 + 抽帧**浮层
（`高清 / 片段重拍 / …` 之上的另一组）：`播放 · 0:01 / 0:30 · 音量 · 全屏` +
`截取当前帧 / 截取首帧 / 截取尾帧`。
→ **从视频节点直接抽帧成新图片节点**，这是把"视频→图片"的往返闭环做进画布的关键动作，我们完全没有。

---

## 4. 参数面板：**660×275，挂在选中节点下方**（不是右侧固定栏）

我们的画布右侧有一个**固定的助手面板**（`RightPanel.vue`，从 canana 视图复用的 2806 行组件，
`index.vue:2362` 以 fixed + translateX 动画挂载，入口标签「Agent创作」）；他们的参数是
**跟随选中节点的浮层**。这是本次最明确的架构级差异 —— 我们的是"全局一栏"，他们的是"就地一层"。

容器：`node-floating-ui` 定位在卡片下方（卡片止于 544，面板始于 550 —— **间隙 6px**），
内部 `bg-panel-background` **660×275**，六段结构（全部实测坐标，卡片左上角对齐 x=1032 / 面板 x=828）：

| # | 段 | 高度 | 结构 |
|---|---|---|---|
| 0 | 工具标签行 | 30 | 5 个 `rounded-full` pill：**参考 / 标记 / 特效 / 角色库 / 运镜**；每个 `icon 12×12 + 文字 12px`，高 26，宽 54–66 |
| 1 | 参考图行 | 55 | **48×48 可拖拽排序缩略图**（`cursor-grab` / `active:cursor-grabbing`，`flex-wrap`） |
| 2 | 提示词区 | 116 | `rounded-xl p-2` + 内部 `generator-prompt-scroll-region`（滚动区），`min-h-20` |
| 3 | 参数行 | 32 | 见下 |
| 4 | 高级设置 | 折叠 | `grid-rows-[0fr]` + `transition-[grid-template-rows]`，见下 |
| 5 | 关闭按钮 | 28×28 | `absolute right-2 top-2`，icon 14 |

### 4.1 参数行（32px 高，左组 + 右组）

```
[模型 ▾ 91×32] [⚙ 全能参考 ▾ 108×32] │ [16:9 · 720P · 30s · 1个 ▾ 212×32]      [icon 32] [icon 32] [icon 32]  [1380]  [⬛发送 32×32]
```

- 分段用 `h-3.5 w-px` 的 1×14 竖线。
- **积分数字紧贴发送按钮左侧**（`min-w-[85px] justify-end`），内部 `flex gap-[2px]` —— 花钱金额就在点击位置旁边，不是藏在角落。**建议直接对齐。**
- 发送按钮是 `bg-btn-invert-bg` 的 32×32 反色方块（黑底白图标风格）。

### 4.2 高级设置：**用 CSS grid 行数动画折叠，不是 max-height**

```
div.transition-[margin] .-mt-2
  div.grid.transition-[grid-template-rows].grid-rows-[0fr]    ← 折叠时 0fr，展开 1fr
    div.min-h-0.overflow-hidden
      div.border-t-hair                                     ← 1px hairline 分隔
      div "高级设置"（text-xs font-bold text-neutral-500）
      div.flex.flex-col.gap-1（内容，展开后 128 高）
```

展开后内容实测有 4 项：**高级设置 / 联网搜索 / 自动校验素材 / 智能引用 AutoLink**。
后三项在服务端存为 `advancedSettings: {search_enabled:1, autoCompliance:1}`，
**AutoLink 对应 `mixedListOrder` / `imageListOrder`（自动把上游节点当参考）**。

→ `grid-template-rows: 0fr → 1fr` 这个折叠手法值得抄：**不需要知道内容高度**，比 max-height 干净。

---

## 5. 设计 token 原值（对比我们的 `libtv-tokens.css`）

他们 :root 上共 **936 个 CSS 变量**（含 Mantine 50 个、VIP 138 个、Team 78 个、Power 63 个）。
画布相关我们已覆盖的部分**全部对得上**：

| 语义 | 他们的值 | 我们的 token | 结论 |
|---|---|---|---|
| 画布底 | `#141414` | `--canvas-workflow-bg` | ✓ |
| 卡片底 | `#262626` | `--canvas-node-bg` | ✓ |
| 品牌主色 | `--nt-bg-brand: #13d5ff` | `--brand-main-default` | ✓ |
| 品牌 hover | `--nt-bg-brand-hover: #5ddcff` | — | **缺** |
| 品牌 active | `--nt-bg-brand-active: #05a3c5` | — | **缺** |
| 三级文字 | `#919191`（= 我们的 `#ffffff4d` 语义不同！） | `--text-tertiary: #ffffff4d` | **不一致，见下** |

**新发现的语义槽（我们完全没有）**：

| Token | 值 | 用途 |
|---|---|---|
| `--nt-bg-brand-overlay / -hover / -active` | `#13d5ff14 / #13d5ff1a / #13d5ff1f` | 品牌色低透明叠加（选中态、tag 底） |
| `--credit-gap-strong / -medium / -none` | `#f53f3f / #ff7d00 / #5ddcff` | **积分缺口三级色**（严重/中等/充足）—— 对应我们刚做的"余额不足拦下" |
| `--credit-gap-ring-track` | `#525252` | 积分环形进度底 |
| `--generation-confirm-*` | 底 `#242424`、边 `#ffffff14`、品牌 `#3fdafd` | **生成确认弹层**（= 我们的付费确认卡） |
| `--color-neutral-*` | 完整 11 级灰度 | 他们的中性色阶梯（我们只有零散值） |
| `--libtv-header-height` | `64px` | 顶栏高度 |
| `--points-store-*` | `#5ddcff1a / #5ddcff / #5ddcff` | 积分超市入口 |

**一处需要重新核对的语义冲突**：他们的 `#919191` 是**不透明灰**（用于深色底上的弱文字），
我们的 `--text-tertiary: #ffffff4d` 是**半透明白**。两者在深底上视觉接近，但在浅底/图片上表现不同。
LibTV 的做法是**不透明灰 + `text-fg-muted` 语义名**，配合 `canvas-light:` 变体类切换主题。
建议我们把「三级文字」拆成 `--text-muted`（实色 `#919191`）与 `--text-on-media`（半透明）两个槽。

**技术栈线索（token 命名空间暴露的）**：Mantine（50 个 `--mantine-*`，含自定义断点 b640…b2240）、
Swiper、Lightning CSS、**CopilotKit（`--copilot-kit-*` 16 个）** —— 他们的画布 Agent 聊天 UI
是**用 CopilotKit 搭的，不是自研**。这一条值得单独评估（省掉大量聊天 UI 自研成本）。

---

## 6. 服务端节点数据模型（本次最有价值的"里子"）

`GET https://api.liblib.tv/api/canvas/project/detail-by-space` 返回的完整结构（原文存
`refund-e2e/liblib-net-1.json`）：

```
data.projectDetail
  ├─ projectMeta    {id, uuid, name, visibility, ownerId, createdAtMs, updatedAtMs, folderId,
  │                  projectSpaceId, projectType, bizScene, source,
  │                  accessConfig{accessPolicy, publishable, assetLocation, allowCopy, shareAgentConversation},
  │                  effective{canRead, canEdit, canManage, canPublish, canShare, canCopy}}
  ├─ projectDraft   {uuid, projectUuid, draftData, viewportX, viewportY, viewportZoom, lastEditedAtMs}
  ├─ nodeList[]     ← 节点（规范化表，不是 JSON blob）
  └─ connectionList[] ← 连线（独立表）
```

### 6.1 `nodeList[]` 字段（逐字）

| 字段 | 实测样例 | 说明 / 我们的差距 |
|---|---|---|
| `nodeKey` | `"i-IV8VjrEm1o"` / `"v-NZHlosX9rd"` | **前缀编码类型**（`i-` 图片、`v-` 视频、`e-` 连线）。人类可读、调试友好 —— 我们用的是纯 UUID/cuid |
| `type` | `2` / `3` | **数字枚举**（2=图片 3=视频），不是字符串 |
| `toolId` / `toolKey` | `0` / `""` | **工具注册表**位：每个节点是某个"工具"的实例（对应他们首页的 视频/图片/音频/剧本/智能剪辑）。我们无此概念 |
| `position` | `{positionX:"2.5", positionY:"240"}` | **字符串数字**；画布坐标 |
| `measured` | `{width:"625", height:"350"}` | 100% 缩放下的尺寸 |
| `data` | **JSON 字符串**（不是对象） | 前端节点完整 payload，见 6.2 |
| `parentKey` | `""` | **父子/分组支持**。我们无 |
| `status` | `1` | **节点级任务状态**（节点自己知道在跑/成功/失败） |
| `workflowUuid` / `workflowRoot` | `""` / `0` | **工作流归属**：节点属于哪次工作流、是不是根。我们无 |
| `createdAtMs` / `updatedAtMs` | `1790420228000` | 毫秒时间戳 |

### 6.2 `data`（解析后）关键字段

图片节点：
```
{type:"image", url:[4 张], action:"image_generate", generatorType:"default",
 params:{prompt:"", model:"mj-v8.2", count:4, settings:{quality:"auto", ratio:"16:9"},
         advancedSettings:{personalisation:"", stylize:100, weird:50, chaos:5},
         fineTuneType:"template", fineTuneModels:[], textList:[], imageList:[], videoList:[], audioList:[],
         modeType:"text2image"},
 contentWidth:625, contentHeight:350,
 portraitAssetId:"asset-20260729224623-d8dxt", portraitCertifiedInPlace:true,
 _updatedAtMs, _lastAppliedFullyAtMs, isStale:false, protectionType:"",
 _resourceMeta:{items:[{kind:"image", width:1456, height:816} ×4]}}
```

视频节点：
```
{type:"video", url:[mp4], poster:"", action:"video_generate",
 params:{prompt:"<1435 字符，含「负面提示」段>", model:"star-video2.5", modeType:"mixed2video",
   count:1,
   imageList:[{nodeId:"i-IV8VjrEm1o", url, label:"图片节点 - 副本", width:1456, height:816,
               assetId:"asset-…", sourceCreatedAtMs}],
   videoList:[], audioList:[],
   settings:{ratio:"16:9", resolution:"720p", duration:30, enableSound:"on"},
   advancedSettings:{search_enabled:1, autoCompliance:1},
   imageListOrder:["i-IV8VjrEm1o"], mixedListOrder:["i-IV8VjrEm1o"], textList:[], mixedList:[…]},
 ratio:"adaptive", resolution:"720p", duration:5, enableSound:"on",
 _resourceMeta:{items:[{kind:"video", byteSize:30673652, width:1280, height:720, durationSec:30.048}]}}
```

**六条必须抄的结构决策：**

1. **参考图以「节点」为单位引用，不是文件**：`imageList[].nodeId` + `label`（上游节点名）+ `width/height` +
   `assetId` + `sourceCreatedAtMs`（上游产出时间，用于判断是否过期）。
   `imageListOrder` / `mixedListOrder` **就是提示词里 `@图1 @图2` 的顺序**。
   → 我们的 `references` 是文件路径列表，缺少 **nodeId（溯源）** 与 **顺序（对应 @ 序号）**。
2. **产物真实元数据回填**：`_resourceMeta.items[].durationSec = 30.048`。
   服务端知道产物的**真实**时长/宽高/字节数。
   → **直接可用于修我们的 `duration-clamp` 问题**：`src/shared/model-pricing-rules.ts` 的
   `normalizeVideoSeconds` 现在**主动把 30 秒砍成 20 秒**（`scripts/tests/test-model-pricing-rules.mjs:36`
   的断言原文就是 `normalizeVideoSeconds(30) === 20`）。正确做法不是钳制用户输入，
   而是**用 `_resourceMeta.durationSec` 回填上游真实值**。
3. **UI 当前参数 vs 上次生效参数分开存**：`params.settings.duration = 30`（上次生成用的）
   vs `data.duration = 5`（UI 现在选的）。配合 `isStale` + `_lastAppliedFullyAtMs`，
   节点能自己判断"参数改了但没重跑"。→ 我们的"参数已改需重跑"目前靠前端比对，没有服务端字段。
4. **`prompt` 里自带「负面提示」段**（`\n\n负面提示\n\n…`），不是独立字段。
   我们若要做负面提示，可以照此拼（也可拆成独立字段，但要知道他们没拆）。
5. **肖像认证**：`portraitAssetId` + `portraitCertifiedInPlace`。
   这正是用户遇到的「Seedance 对真人人脸有顾虑」的**上游解法**：把真人做成受认证的肖像资产再引用。
   → 相关：角色库（§7）。
6. **`shareAgentConversation`**（项目级）：**Agent 会话可跟随画布分享**。我们无。

### 6.3 `connectionList[]`

```
{projectUuid, connectionId:"e-oy5KQvQoDm", source:"i-IV8VjrEm1o", target:"v-NZHlosX9rd",
 sourceHandle:"source", targetHandle:"target", type:"default", deletable:true, selectable:true,
 createdAtMs, updatedAtMs}
```
连线独立成表，带 `deletable` / `selectable` 细粒度权限位。

### 6.4 API 地图（76 条请求中与画布相关的）

| 端点 | 次数 | 用途 |
|---|---|---|
| `GET /api/canvas/project/detail-by-space` | 1 | 画布全量（上面这份） |
| `POST /api/canvas/project/draft/update` | 2 | **草稿保存**（含 viewport） |
| `POST /api/canvas/project/heartbeat` | 4 | **心跳保活**（多端在线/协同） |
| `POST /api/task/generation/progress/batch` | 1 | **批量任务进度**（一次查多个任务 —— 对比我们每个任务一条 SSE） |
| `POST /api/canvas/media-asset/tags/list` | 1 | 资产管理标签 |
| `POST /api/canvas/user-config/get` | 1 | 用户画布偏好 |
| `GET im.liblib.tv/api/v1/project/session/list` | 1 | **项目级会话列表**（Agent 会话挂在项目上） |
| `POST /api/agreement/check` | 1 | 协议合规 |

**注意 `progress/batch`**：他们用**轮询批量查**，我们用 **SSE 长连接**。
我们刚修完 SSE 的 429/终态不关流问题 —— 这个选择本身没错（实时性更好），但要知道对方是轮询，
所以"每个任务一条长连接"的额度压力他们压根没有。

---

## 7. 我们完全没有的两块（本次新发现）

### 7.1 角色造型室 `CharacterStudioModal`（1200×760）

他们首页列为「独家」，从节点面板的「角色库」pill 进入。**不是列表，是一个 3D 建模工作台**：

```
CharacterStudioModal 1200×760  (z-modal, bg-black/60 遮罩)
├─ header h-70      「我的角色库」(active) │ 「官方角色库」
├─ 筛选栏 h-32       性别 / 年龄段 / 文化区域（<details><summary> 原生下拉，面板 180 宽，行高 36）
│                   右侧：视图切换 pill（两个 26×26 圆钮 + 1px 分隔）
├─ 主体 h-552       横向 carousel（内层 w-max = 6150px）
│                   ← 28×28 左右箭头（.carouselArrow，垂直居中）
│                   input.carouselScrollbar 1158×12  ← **用 <input> 当自定义滚动条**
│                   角色卡 246×434（竖版）
├─ footer h-88      主按钮「创建新角色」116×40（bg-btn-primary）
└─ 关闭 26×26（right-19 top-6）
```

**真正的技术含量在动效层**（DOM 里与内容层并列）：
```
motionLayer.motionPhaseLibrary
├─ canvas.motionDotField        1200×602  ← 点阵粒子动画
└─ motionModelSlot / Hitbox / Host / Stage
   └─ canvas.motionModelCanvas 575×734  ← **WebGL 3D 角色模型**（可旋转/摆姿势）
        motionPhaseLibrary = 动作库
```

另有 **24 个专属 token**：`--character-studio-*`（含 `bg-canvas #f5f5f5`、`bg-float #fff`、
`text-default #171717`、`icon-filter: invert(0)`）—— **角色造型室是浅色主题**，
与画布的 `#141414` 深色**并存**，靠 `icon-filter` 切换图标颜色。

> **判断**：这是他们最重的一块投入（3D + 动作库），**短期不该抄**。但"角色 = 一等资产、
> 有官方库 + 我的库 + 性别/年龄/文化筛选 + 创建角色"这个**信息架构**，对漫剧（人物一致性）是刚需，
> 建议**只抄 IA**：角色资产 + 角色库面板 + 引用角色到节点。3D 舞台不抄。

### 7.2 资产管理与积分超市（大盘侧）

- `资产管理 / 40%`（左下）：配额进度。
- `TV Director`：他们的 Agent 总入口品牌名。**注意位置是「底部中央 dock」不是顶栏** ——
  本文档初稿曾据 `scan.log` 的 DOM 顺序把它记成顶栏，经二次核对（本次 `click` 模式命中元素为
  `fixed bottom-[52px]`，中心点 y=963/1000）**更正为底部居中**。
- `积分超市`：`--points-store-*` 三个 token，品牌青 `#5ddcff`。
- 会员体系：`--vip-*` **138 个 token**、`--team-*` 78 个、`--power-*` 63 个、`--sku-*` 8 个、
  `--cashier-*`、`--purchase-first-order-*`、`--nup-*`（新用户弹窗）。
- 首页导航：首页 / 项目 / 资产 / 插件与扩展 / 社区 / TV Show / 全网爆款 / 创作者挑战赛 / 王者大赛 /
  版本更新记录；生成品类：视频 / 图片 / **音频** / **剧本** / **智能剪辑**。

→ **不抄**。这是他们的**运营大盘**，与我们"Agent 主导的生产线"定位不同。
但两个数字要记住：他们公开锚点 **Seedance 2.5 720P 低至 0.36 元/秒**；首页在打 **年会员立减 1000**。

---

## 8. 复刻清单（按我们的口径排序）

### A. 立刻抄（结构级、成本可控、直接改善手感）

| # | 事项 | 为什么 | 对应文件（预估） |
|---|---|---|---|
| A1 | **节点尺寸固定化**：卡片 625×350，标题行 13px/400/`#919191`、间隙 2px、右侧补 `宽 × 高` + `N张` 摘要 | 一行常量 + 两个 span，立刻让画布"看起来对" | `ImageNode.vue` / `VideoNode.vue` / `libtv-tokens.css` |
| A2 | **参数摘要从"卡片上方 chip 行"迁到"卡片下方面板"** | 卡片上方只留标题，画布立刻变干净（符合用户选定的「C 极简流」） | `nodes/*.vue`、`ContentGenerator.vue` |
| A3 | **`grid-template-rows: 0fr→1fr` 折叠动画**（替换 max-height） | 6 行 CSS，不需要知道内容高度 | `AdvancedParamsPopover.vue` |
| A4 | **积分数字移到发送按钮左侧**（`min-w-85px justify-end`） | 花钱金额紧贴点击位置 | `toolbars/*.vue` |
| A5 | **补 token**：`--nt-bg-brand-hover/active`、`--credit-gap-strong/medium/none`、`--generation-confirm-*` | 我们刚做"余额不足拦下"，缺缺口三级色 | `libtv-tokens.css` |
| A6 | **给视频节点补节点级动作条**（复用已有的 `CanvasNodeTopToolbar`）：只摆**有实现的**动作（抽帧、首尾帧、重跑…） | 图片节点已有 5 个真实动作，视频节点是**零**，这个不对称最刺眼 | `VideoNode.vue` |
| A7 | **视频节点抽帧 → 生成新图片节点**（截取当前帧 / 首帧 / 尾帧） | 视频→图片闭环，我们完全没有；`<video>` + canvas 本地抽帧即可，**不需要新上游、不花钱** | `VideoNode.vue` + 建节点逻辑 |

### B. 结构级、值得做但要动服务端（本轮第二批）

| # | 事项 | 为什么 |
|---|---|---|
| B1 | **`nodeKey` 前缀编码**（`i-` / `v-` / `e-`） | 调试成本立降；迁移可兼容 |
| B2 | **`_resourceMeta` 回填真实产物元数据** | **顺手解决 `duration-clamp`**（30 秒被记成 20 秒）—— 不 clamp 输入，回填真值 |
| B3 | **参考图引用带 `nodeId` + 顺序序位** | 我们缺溯源与 `@图N` 的显式顺序；漫剧多参考图会立刻需要 |
| B4 | **`isStale` + `_lastAppliedFullyAtMs`**（UI 当前参数 vs 上次生效参数分离） | "参数改了但没重跑"变成服务端事实，而不是前端猜 |
| B5 | **`parentKey`（分组）+ `workflowUuid`（工作流归属）** | 导演控制台批次4 的"工作流卡片"最终需要它 |
| B6 | **`heartbeat` + `draft/update`（含 viewport）** | 多端/断线恢复；我们已有"回上次画布"，但 viewport 未持久化 |
| B7 | **角色资产（只抄 IA，不抄 3D）**：角色库面板 + 角色引用到节点 | 漫剧人物一致性刚需；也是 Seedance 真人人脸顾虑的正解 |

### C. 以后再说 / 需单独评估

- **CopilotKit** 替代自研聊天 UI（省成本，但要评估与 Pi 运行时的契合度、消息模型是否能承载我们的
  导演控制台事件）。**单独一轮评估，不混在这次里。**
- `progress/batch` 批量轮询 vs 我们的 SSE：**不改**（我们实时性更好，问题已修）。
- 音频生成 / 剧本生成 / 智能剪辑三个节点类型：他们首页有，我们服务端没有对应任务策略，
  与 `libtv-refactor-checklist.md` §5 的结论一致 —— **等 M3 链路（剧本→分镜）落地时一起做**。

### D. 明确不抄

| 不抄 | 原因 |
|---|---|
| 3D 角色舞台 + 动作库（`motionModelCanvas` / `motionPhaseLibrary`） | 重资产，与我们的差异化（Agent 生产线）无关 |
| 会员 / 积分超市 / TV Show / 创作者挑战赛 / 王者大赛 | 运营大盘，非产品内核 |
| 其独家命名与文案（逐帧拉片 / 角色造型室 / TV Show / star-video2.5） | 品牌与法务风险，且要保留辨识度 |
| 936 个 token 里的 900 个（VIP 138 / Team 78 / Power 63…） | 我们没这些业务面 |
| `<input>` 当滚动条、`<details>` 当下拉 | 可复用性差，我们用组件库 |

---

## 9. 本轮动手记录（A 组七条）

| 项 | 结果 | 说明 |
|---|---|---|
| A1 卡片尺寸固定 625×350 | **早已有** | `config/node-size.ts` 在 9/22 就量过（622×350 且随比例走），无需改 |
| A1 标题行规格 | **已改** | 图片/视频/文本节点统一到 13px / 400 / `#919191` / 行高 20 / 间隙 2px / 间距 4px / 图标 14px；**图片节点此前根本没有标题行**（也改不了名），本轮补上 |
| A2 参数 chip 行下移 | **已改** | 只有视频节点有那行（`bottom:100% + margin 30px`），已整块删除；参数本来就在下方面板里 |
| A3 高级设置改 grid 折叠 | **已做后回退** | 前提不成立：我们的「高级设置」不是内联折叠段，而是浮层弹窗（`SelectPopup`，`v-if` 装卸 DOM）。硬套 grid 行高要**复制一份弹窗定位逻辑**（实测 diff +283/−141），属于用可维护性换一个动画 → 改动留档在 `refund-e2e/a3-advanced-params.patch`，建议留到 B 组做「参数面板内联化」时一起做 |
| A4 积分贴发送按钮 | **已改**（性质变了） | 位置上**早就有**价格块，但读的是**客户端配置的单位价**：图片渲染 `6 / 张`、视频渲染一个**没有单位的裸数字**。改成服务端估算总额：`预估 6 分`，并按余额上色（`--credit-gap-*`）。**视频故意不估** —— 估算接口不收时长，按秒计费会算出偏低的假数字，宁可不说 |
| A5 补 token | **已改**（缩减为 2 档） | 补了 `--brand-main-hover/active`（LibTV 实测 `#5ddcff` / `#05a3c5`）、节点标题行 token、积分缺口 token。LibTV 的第三档「充足」与我们「拿不到余额」的状态必须区分开，所以档位是 `ok / medium / strong / unknown` 四态 |
| A6 视频节点动作条 | **已改** | 复用 `CanvasNodeTopToolbar`，接上「抽帧」下拉（当前帧/首帧/尾帧） |
| A7 抽帧 → 新图片节点 | **已改** | 取帧（`videoWidth/Height` 尺寸的 canvas）→ 上传（复用 `uploadStorageFile`）→ 建图片节点 → 连边。**本地截图，不扣积分**（真机验过余额不变） |

### 9.1 顺带发现并修掉的两个真 bug

这两个都不是「对齐 LibTV」的产物，而是为了让 A7 真的能用才挖出来的：

**① `uploadStorageFile` 漏了 `credentials: 'include'` → 所有素材上传在跨源部署下稳定 401**

`buildApiUrl` 在配了 `VITE_API_BASE_URL` 时会产出**跨源绝对地址**（开发环境 `http://localhost:5409`，页面在 5010），
而 `fetch` 默认 `same-origin` —— **跨源时不带 cookie**，于是上传返回 401，
界面上表现为新建的节点显示「当前未登录或登录已失效 重试 放弃」。

- 影响面：上传参考图、裁剪生成新节点、视频抽帧……**所有走 `/api/storage/upload` 的素材上传**。
- 同类接口（`points` / `auth` / `asset-items` …）本来就都带这个字段，属于漏写。
- **`src/api/account.ts` 也有同样的缺失，但不能照抄修**：它请求的是**第三方主机**的 `/uploadCookie`，
  给它加上 `credentials` 等于把我们的 cookie 送给第三方。已在该文件外留说明，不动。

**② `server/index.ts` 的 `getContentTypeByFilePath` 没有 `.mp4` 等媒体分支 → 落到 `application/octet-stream`**

`<video>` 的加载是**强类型检查**的，Content-Type 不对会直接拒绝。已补 `video/mp4`、`video/webm`、
`video/quicktime`、`audio/mpeg`、`audio/mp4`、`audio/wav`。

> **诚实标注证据强度**：我最初观察到「`/uploads` 的 mp4 在 Chrome 里打不开」
> （`DEMUXER_ERROR_COULD_NOT_OPEN`），但追下去发现**那个文件本身是坏的** ——
> 2048 字节、内容全是 `0x07`，早期测试残留。换用同目录真实的 45MB 产物后，
> 修复前的 MIME 是否单独就能导致浏览器拒绝播放，**我没有做对照实验证明**。
> 所以这条按「正确性修复」记，不按「修复了某个用户可见故障」记。

---

## 10. 三句话结论

1. **能复刻，而且范式同源**（他们 React Flow，我们 VueFlow），
   配色 token 早就抄对了 —— **缺的不是皮，是"节点即工作台"的动作条、规范化的节点数据模型、
   以及角色一致性资产这三样里子。**
2. **A 组七条已按序做完并真机验收**（类型检查 0 报错、全量单测 53 个文件全绿、
   画布 + `/generate` + 首页三处页面实测 33/33、抽帧全链路 14/14）——
   其中 A1 的尺寸、A4 的位置**本来就有**，真正补上的是**图片节点缺失的标题行**、
   **视频节点的加工动作条（抽帧）**、以及页脚从「客户端单位价」换成「服务端预估总额」。
3. **服务端里最该抄的是 `_resourceMeta`**：它顺手解决我们挂了很久的 `duration-clamp`
   （30 秒视频被写成 20 秒）—— 思路从"钳制用户输入"改成"用上游真实元数据回填"。
