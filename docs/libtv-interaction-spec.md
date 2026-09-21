# 画布交互与视觉规格（LibTV 对齐）

> 这份文档是并行开发的**契约**。多个 agent 同时改这个仓库，文件所有权必须严格互斥，
> 跨模块的接口必须冻结。任何人不许改本文档定义好的接口签名 —— 要改先改文档，再统一改。

---

## 0. 当前进度（已落地，不要重做）

| 项 | 状态 | 位置 |
|---|---|---|
| 参数由上游模型决定 | ✅ | `src/config/model-params.ts` |
| 删掉中转配置节点，参数并入生成节点 | ✅ | `useWorkflowCanvas.ts` / `workflows.ts` |
| 旧画布迁移（imageConfig → image） | ✅ | `legacy-config-node-migration.ts` |
| 拖端口落空 → 弹候选节点菜单 | ✅ | `index.vue` + `config/node-suggestions.ts` |
| 画布配色 token（LibTV 实测值） | ✅ | `styles/libtv-tokens.css` |
| 图片/视频卡片：12px 圆角、#262626、1px 描边选中、去掉流光 | ✅ | `ImageNode.vue` / `VideoNode.vue` |

---

## 1. 设计 token（唯一色彩来源）

所有颜色**必须**走 `styles/libtv-tokens.css` 里定义的变量，**禁止在组件里写死色值**。
这个文件的作用域是 `.workflow-container`，只覆盖画布，不影响 `/generate` 等页面。

| 用途 | Token | 深色值 |
|---|---|---|
| 画布底 | `--canvas-workflow-bg` | `#141414` |
| 点阵 | `--canvas-grid-dot` | `#474747` |
| 网格线 | `--canvas-grid-line` | `#2a2a2a` |
| 卡片底 | `--canvas-node-bg` | `#262626` |
| 卡片描边（未选中） | `--canvas-node-border` | `#ffffff14` |
| 卡片描边（选中） | `--canvas-node-border-selected` | `#a8a8a8` |
| 悬浮件底 | `--canvas-float-block-default` | `#1f1f1ff2` |
| 一级文字 | `--text-primary` | `#ffffff` |
| 二级文字 | `--text-secondary` | `#ffffff9a` |
| 三级文字 | `--text-tertiary` | `#ffffff4d` |
| 描边一级 | `--stroke-secondary` | `#ffffff14` |
| 品牌色 | `--brand-main-default` | `#13d5ff` |

**选中态规则（LibTV 的核心取舍）**：只把 1px 描边从 `--canvas-node-border` 换成
`--canvas-node-border-selected`。**不加外发光、不加动效、不加渐变环。**
节点尺寸不能因为选中而跳动 —— 所以描边必须常驻，不能靠 `box-shadow` 补。

**圆角**：节点卡片 `12px`；卡片内的小块（按钮、chip、缩略图）`8px`。

**字号**：节点标题 `14px / 500`；卡片内正文与菜单 `13px`；chip 与摘要 `11–12px`。

---

## 2. 节点卡片解剖（自上而下）

```
        ┌─ 参数 chip 行（absolute，bottom:100%，margin-bottom:30px）
        │  模型 · 尺寸 · 画质       ← 节点 data 驱动，见 model-params
        ├─ 标题行（absolute，bottom:100%，margin-bottom:8px，高 22px）
        │  [icon] 名称（双击可改名）
    ┌───┴──────────────────────────────┐
    │                                  │
    │   卡片主体（bg #262626，radius 12，border 1px）  │
    │                                  │
    └──────────────────────────────────┘
              ⊕ 左连接点            ⊕ 右连接点
```

**状态优先级**（`ImageNode` / `VideoNode` 同一套）：
`showLoading` > `showError` > `showImage/showVideo` > `showReady`（有上游但自身空）> `showEmpty`

**空态（showEmpty）必须给出「尝试：」能力列表**，对齐 LibTV 的
`尝试： / 图生图 / 图片高清 / …` 形态：一行 `尝试：` 小标题 + 若干「图标 + 文案」项，
每项 13px，行高 32px，hover 时底色 `--bg-block-secondary-hover`，圆角 8px。
列表底部可以是「上传图片 / 上传视频」的 pill 按钮。

---

## 3. 冻结接口（跨模块依赖，禁止改签名）

### 3.1 `src/views/workflow/config/node-suggestions.ts`

```ts
export interface NodeTypePresentation {
  type: WorkflowNodeType
  name: string
  color: string
  /** SVG path 的 d 属性。保持字符串，不要把图标换成组件 —— 图标模块要能独立演进 */
  icon: string
}

export const NODE_TYPE_PRESENTATION: NodeTypePresentation[]
export const getNodeTypePresentation: (type: WorkflowNodeType) => NodeTypePresentation | null
export const suggestNodeTypes: (originType: WorkflowNodeType, direction: 'downstream' | 'upstream') => WorkflowNodeType[]
```

**约束**：`icon` 永远是 `viewBox="0 0 24 24"` 的 path `d`。
图标模块提供 `stroke-width`、`stroke-linecap` 等由使用方决定，path 本身不自带样式。
`NODE_TYPE_PRESENTATION` 的**顺序**是 `text, image, video, llmConfig`，不允许重排 ——
菜单顺序稳定性依赖它。

### 3.2 `src/views/workflow/composables/upstream-inputs.ts`

```ts
export const readNodePromptText: (node?: WorkflowCanvasNode) => string
export const collectUpstreamPromptText: (nodeId: string) => string
export const composePrompt: (upstreamText: string, inline: string) => string
```

### 3.3 参数解析 `src/config/model-params.ts`

```ts
export interface ParamChoice { label: string; key: string; hint?: string }
export const resolveImageParamSchema: (model: ImageModel | null | undefined, quality: string) => ImageParamSchema
export const resolveVideoParamSchema: (model: VideoModel | null | undefined) => VideoParamSchema
export const describeResolutionTier: (key: string) => string
export const describeAspectRatio: (key: string) => string
export const pickValidChoice: (choices: ParamChoice[], candidate: unknown, fallback: string) => string
export const SIZE_2K / SIZE_4K / SEEDREAM_QUALITIES / BANANA_SIZES / GENERIC_RATIOS / DURATIONS_5_10: ParamChoice[]
```

### 3.4 `ContentGenerator` 的对外契约

```ts
interface GeneratorParamsSnapshot {
  modelKey?: string; ratio?: string; resolution?: string
  count?: number; duration?: string; feature?: string
}
// props
initialParams?: GeneratorParamsSnapshot
// emits
'paramsChange': [params: GeneratorParamsSnapshot]
// expose
getCurrentParams: () => GeneratorParamsSnapshot | null
```

节点侧用法（**不要改这段调用约定**）：
```vue
<ContentGenerator
  :initial-params="appliedParams"
  @params-change="handleParamsChange"
  @send="handlePromptSend"
/>
```

---

## 4. 交互契约（手势 / 菜单 / 键盘）

| 手势 | 行为 |
|---|---|
| 从「＋」拖到空白处松手 | 在落点弹候选节点菜单（已实现，不要动） |
| 从「＋」拖到另一个节点的手柄 | 直接连线，不弹菜单（已实现） |
| 从「＋」拖到节点卡片中间 | 什么都不发生（已实现） |
| 双击画布空白处 | **弹节点类型菜单**（本轮新增，见工作包 D） |
| 单击节点 | 选中，卡片下方浮出输入面板（已实现） |
| 单击空白 | 取消选中，关闭所有弹出层 |
| 右键空白 | 画布右键菜单：新建文本/图片/视频、粘贴 |
| 右键节点 | 节点右键菜单：复制、删除 |
| Esc | 关闭当前弹出层（菜单 / 弹窗） |
| Cmd/Ctrl+Z / Shift+Z | 撤销 / 重做（已实现） |
| 双击卡片外标题 | 重命名节点（已实现） |

**互斥规则**：同一时刻只允许一个弹出层可见。新开一个必须先关掉其它。
`CanvasContextMenu` 自带点击外部关闭 + Esc 关闭，可以复用。

---

## 5. 工作包与文件所有权（严格互斥）

**规则：只改自己名下的文件。需要别人文件里的能力，通过 §3 的冻结接口调用。**
**不要动 `ImageNode.vue` / `VideoNode.vue` 的卡片基础样式** —— 那部分已对齐完成。
**不要新增节点类型**（音频/剧本/智能剪辑是本轮之后的事）。

### 工作包 A：画布视觉收口
- `src/views/workflow/components/nodes/TextNode.vue`
- `src/views/workflow/components/nodes/LlmConfigNode.vue`
- `src/components/canvas/CanvasNodeHoverToolbar.vue`
- `src/components/canvas/CanvasNodeTopToolbar.vue`
- `src/components/canvas/CanvasNodeAddHandle.vue`
- `src/components/canvas/CanvasMiniMap.vue`
- `src/components/canvas/CanvasZoomControls.vue`
- `src/components/canvas/CanvasConnectionLine.vue`
- `src/views/workflow/components/edges/*.vue`
- `src/views/workflow/styles/workflow.css`

任务：让文本节点与 LLM 节点卡片和图片/视频卡片**看起来是同一套东西** ——
同 `#262626` 底、同 `12px` 圆角、同 1px 常驻描边、选中只换描边颜色、同标题字号。
工具条与画布控件统一到 LibTV 的悬浮件样式（`--canvas-float-block-default`、8px 圆角、
`--text-secondary` 图标色、hover 底色 `--bg-block-secondary-hover`）。
连线颜色统一到 `--text-tertiary`（普通）/ `--brand-main-default`（选中），
清掉任何写死的绿色 `#02dba3`。

### 工作包 B：参数面板（composer 页脚）
- `src/components/generate/ContentGenerator.vue`
- `src/components/generate/toolbars/ImageToolbar.vue`
- `src/components/generate/toolbars/VideoToolbar.vue`
- 新增 `src/components/generate/AdvancedParamsPopover.vue`

任务：把参数摘要做成 LibTV 那种**一行页脚**：
`[模型名 ▾] [比例 · 画质 · 分辨率 · 数量 ▾] ⟶ [价格] [高级设置 ▾]`
- 摘要文案格式固定为 `比例 · 画质 · 分辨率 · 数量`（有哪段显示哪段，用 ` · ` 连接）
- 「高级设置」是个 popover，放次要参数（参考图、生成方式、随机种子等已存在的参数）；
  **没有实现的参数不要摆进去**，宁可少
- 保持 §3.4 的 props/emits/expose 契约不变
- 工具栏在 `iconOnly` 模式下要给出一行摘要（已实现 `paramSummary`，继续沿用）

### 工作包 C：图标体系
- 新增 `src/components/icons/canvas-icons.ts`
- `src/views/workflow/config/node-suggestions.ts`

任务：建立画布图标模块，统一风格为 **24×24 viewBox、stroke 1.5、`fill: none`、
`stroke-linecap: round`、`stroke-linejoin: round`、`currentColor`**。
导出 6 个语义图标（文本、图片、视频、LLM、上传、复制/删除等）以及
`renderIconPath(name)` 之类的取用方式。**自己画 path，不要抄第三方站点的 SVG 数据。**
把 `NODE_TYPE_PRESENTATION` 的 `icon` 换成新模块的 path，保持 §3.1 签名与顺序不变。
`LlmConfigNode` 的图标引用也一并换（但不要动该文件的其它样式 —— 那属于工作包 A；
**因此 C 不改 LlmConfigNode，只提供图标**）。

### 工作包 D：交互功能
- `src/views/workflow/index.vue`
- `src/views/workflow/components/nodes/ImageNode.vue`
- `src/views/workflow/components/nodes/VideoNode.vue`

任务：
1. **双击画布空白处 → 弹节点类型菜单**（与拖端口落空的菜单复用同一个 `CanvasContextMenu`，
   候选用 `suggestNodeTypes` 推导；空白处没有起点，所以给全部类型）。
   位置 = 双击点，建出的节点落在双击点。
2. 节点空态能力列表按 §2 的形态重排（`尝试：` + 图标 + 文案，行高 32、13px）。
   保留现有能力项，**不要新增没实现的**「接入中」项。
3. 只动本包列出的三个文件；卡片颜色/圆角/描边已经对齐，不要改。

---

## 7. 收口记录（并行开发之后由集成方补齐，下一轮请以此为准）

并行四路各写各的，各自的自测都是绿的，但合起来暴露了三处不一致。以下是最终定论：

### 7.1 图标颜色必须在「画布作用域」里解析后才能交给菜单
`CanvasContextMenu` 会 Teleport 到 `body`，落在 `.workflow-container` 之外，
而画布配色 token 定义在 `.workflow-container` 上。所以在菜单里直接写
`var(--brand-*)` 会取到根的全局值；其中品牌色会被运行时主题
（`utils/theme-runtime.ts` 按后台配置的 `primary`）改写成品牌紫，
于是同一类节点在菜单里和画布上颜色对不上。

**定论**：`index.vue` 的 `resolveCanvasToken()` 在拼菜单项时把 `var(--x)` 解析成
`.workflow-container` 上的实际值，再作为 `iconColor` 传给菜单。
**新增消费方若不在画布作用域内渲染，必须走这条路，不要直接传 `var()`。**

### 7.2 图标规格：stroke 1.5，且必须是 style 绑定
`NODE_TYPE_PRESENTATION.color` 的值是**完整 CSS 颜色表达式**，只能绑到 `style` 上：
```vue
<!-- 对 -->
<path :d="icon" :style="{ stroke: color }" stroke-width="1.5" ... />
<!-- 错：SVG 表现属性不解析 var()，会直接失效 -->
<path :d="icon" :stroke="color" stroke-width="2" ... />
```
`--brand-llm` 是画布内专用 token（定义在 `libtv-tokens.css`）。
**不要用 `--brand-bright-*` 当节点类型色** —— 它会被运行时主题接管，颜色会漂。

### 7.3 建节点菜单只有一份构造
`index.vue` 的 `buildNodeTypeMenuItems(types, idPrefix, onClickFor?)` 是
拖线落空 / 双击空白 / 右键空白三类菜单的唯一构造入口。不要再各写一份。
附带影响：右键空白菜单的文案由「新建文本 / 新建图片生成 / 新建视频生成」
统一成了「文本节点 / 图片生成 / 视频生成」，与另外两个菜单一致。

### 7.4 菜单项接口扩展
`ContextMenuItem`（`types/canvas-interaction.ts`）新增两个可选字段：
```ts
iconPath?: string    // SVG path 的 d（24×24）
iconColor?: string   // 完整 CSS 颜色值，走 style 绑定
```
原来的 `icon?: string`（组件库图标名）字段仍然保留、仍未被消费。

### 7.5 已改动的文件（本轮全量）
```
新增  src/views/workflow/styles/libtv-tokens.css       画布配色 token（LibTV 实测值）
新增  src/components/icons/canvas-icons.ts             画布图标模块（13 个图标）
新增  src/components/generate/AdvancedParamsPopover.vue 高级设置（参考图 / 视频首尾帧）
新增  docs/libtv-interaction-spec.md                   本文档
新增  tests/canvas-icons.test.ts                       23 项
新增  tests/e2e/double-click-create.mjs                27 项
新增  tests/e2e/route-sweep.mjs                        15 项（跨路由巡检）

改    src/config/models.ts / model-params.ts / node-suggestions.ts
改    src/types/canvas-interaction.ts
改    src/components/canvas/{CanvasMiniMap,CanvasZoomControls,CanvasContextMenu,
        CanvasConnectionLine,CanvasDefaultEdge,CanvasNodeHoverToolbar,
        CanvasNodeTopToolbar}.vue
改    src/components/generate/{ContentGenerator.vue,toolbars/*.vue}
改    src/views/workflow/{index.vue,styles/workflow.css}
改    src/views/workflow/components/nodes/*.vue
改    src/views/workflow/components/edges/*.vue
改    src/views/workflow/composables/*（迁移/编排/上游输入）
```

### 7.6 仍然没做的（下一轮）
- **节点类型只有 4 类**。LibTV 有 6 类：图片生成 / 视频生成 / **音频生成** / **剧本生成** /
  **智能剪辑** / **资产管理**。音频与剧本对漫剧是刚需，但都需要各自的后端任务策略
  （现在服务端只有 image / agent-chat / agent-workspace / research-report）。
- **视频生成后端不存在**，视频节点发不出去（前端已按模型组装好参数，只是如实报错）。
- **智能引用 AutoLink**（LibTV 的「高级设置」里唯一一项）没做，它需要引用解析规则。
- 左侧工具栏 `tools` 数组里的图标仍是 index.vue 内联 path，没换成 `canvas-icons`。
- `ImageNode` 顶部工具栏仍有 9 处「接入中」占位（全景图 / HD 增强 / 编辑元素 / 角度 /
  打光 / 更多 / 裁剪）。

---

## 8. 验收标准（每个工作包自己跑）

```bash
cd ~/CanvasMind
export PATH="$HOME/.local/lib/nodejs/bin:$PATH"

# 1. 类型检查：只允许 art-design/ArtForm.vue 的 3 个既有报错
npx vue-tsc --noEmit 2>&1 | grep -E '^src/.*error TS' | grep -v 'art-design/ArtForm'

# 2. 全量单测必须全绿（当前 6 个文件 / 187 项）
for f in tests/*.test.ts; do npx tsx "$f" | tail -1; done

# 3. 浏览器实测（三层，共 60 项）
#    drag-to-create 18 · double-click-create 27 · route-sweep 15
#    需要一个有效的登录 session：临时造一个（用完记得删）
for s in drag-to-create double-click-create route-sweep; do
  SESSION_TOKEN=<token> node tests/e2e/$s.mjs | tail -1
done
```

**硬性要求**
- 不许留下 `console.log`
- 不许写死色值（走 §1 的 token）
- 不许改 §3 的接口签名
- 不许碰别人名下的文件
- 新逻辑要有单测（放 `tests/`，文件名不要和别人重名）
- 浏览器实测：`SESSION_TOKEN=bVyW4s0utTDGoJewS8StAgxcCcVhL_2G node tests/e2e/drag-to-create.mjs`
  必须 18 项全绿（这条同时验证了拖线菜单没被改坏）
