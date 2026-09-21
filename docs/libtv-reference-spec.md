# 素材引用（@ 上游）规格

> 并行开发的契约文档。**接口签名冻结**，改之前先改本文档。
> 前置阅读：`docs/libtv-interaction-spec.md`（配色 token、通用约定、验收命令）

---

## 0. LibTV 的原始行为（线上实测）

在节点的提示词输入框里敲 `@`，弹出面板（DOM 标记 `data-script-mention-dropdown`）：

```
素材引用
├─ 图片     data-reference-kind="image"
├─ 视频     data-reference-kind="video"
├─ 音频     data-reference-kind="audio"
└─ 文本     data-reference-kind="text"
```

**两级**：先选种类，再选具体资产。没有可引用资产时第二级显示：

```
暂无可引用资产，请连入后操作
```

选中后作为一个**内联 chip** 插进提示词文本里。

## 1. 我们的现状（为什么需要这个）

现在上游是**全自动注入**，不需要 @，也没有选择余地：

| 上游 | 行为 | 实测证据 |
|---|---|---|
| 文本 / LLM 节点 | 按 `promptOrder` 拼进 prompt，`\n` 连接 | `"一只金毛…。\n，请用水彩风格"` |
| 图片节点 | 全部变成参考图 | `requestMode: "image-edit"`, `referenceImages: [...]` |

做不到的三件事：
1. 同类上游多个时无法挑选（连 3 张图 = 3 张全用）
2. 无法区分角色（「A 当主体、B 只参考配色」）
3. 无法在句子里定位引用（引用走请求体，不是提示词的一部分）

## 2. 本轮范围（明确不做什么）

**做**：两级选择面板 + token 插入 + 提交时解析成「文本 + 有序参考图」。
显式引用**覆盖**自动注入（不引用则保持现在的全自动行为，向后兼容）。

**不做**（下一轮，见 §7）：内联可视化 chip（需要把 `<textarea>` 换成
`contenteditable`，中文 IME 风险高）。本轮 token 是**纯文本** `@图片1`，
但它旁边的缩略图行会把实际资产显示出来，且数据模型与内联 chip 方案完全一致 ——
将来只换渲染层，不动解析层。

**种类只做 3 个**：`图片` / `文本` / `视频`。
LibTV 的 `音频` 我们没有对应节点类型（我们只有 text / image / video / llmConfig），
不摆空种类。

---

## 3. 冻结接口（工作包 A 拥有实现，其他人只调用）

文件：`src/views/workflow/composables/reference-resolver.ts`

```ts
export type ReferenceKind = 'image' | 'text' | 'video'

/** 一个可被引用的上游资产 */
export interface ReferenceableAsset {
  /** 同类内序号，从 1 开始 —— token 里用的就是它 */
  index: number
  kind: ReferenceKind
  /** 来源节点 id，解析时靠它定位 */
  sourceNodeId: string
  /** 中文种类名，用于 token 与菜单，如 '图片'/'文本'/'视频' */
  kindLabel: string
  /** token 文案，等于 `${kindLabel}${index}`，如 '图片1' */
  token: string
  /** 展示名（菜单里显示的副标题），如节点标题 '产品图' */
  displayName: string
  /** 图片/视频为 url，文本为正文。空值资产不会出现在列表里 */
  value: string
}

/** token 全格式：@ + token，如 '@图片1'。解析用的正则必须与它一致 */
export const REFERENCE_TOKEN_PATTERN: RegExp

/** 从上游节点收集可引用资产。按 kind 分组前先按 (kind, 连线顺序) 排序，序号稳定 */
export const collectReferenceableAssets: (nodeId: string) => ReferenceableAsset[]

/** 在光标处插入 token（token 后补一个空格），返回新文本与新光标位置 */
export const insertReferenceToken: (
  prompt: string,
  caret: number,
  token: string,
) => { prompt: string; caret: number }

export interface ResolvedPrompt {
  /** 正文：文本引用被替换成它的正文，媒体引用被替换成【图片1】这种可读标记 */
  text: string
  /** 按出现顺序、去重的图片/视频 url */
  media: string[]
  /** 出现过的文本引用内容，按出现顺序去重 */
  texts: string[]
  /** 解析失败的 token 原文（资产已失效或写了不存在的序号） */
  unresolved: string[]
}

export const resolvePromptReferences: (
  prompt: string,
  assets: ReferenceableAsset[],
) => ResolvedPrompt
```

**解析语义（工作包 A 必须按这个实现，测试要覆盖）**

| 输入 token | 有对应资产 | 无对应资产 |
|---|---|---|
| `@图片1` | 正文里替换为 `【图片1】`，url 进 `media` | 进 `unresolved`，正文里**保留原 token**（不静默吞掉） |
| `@文本1` | 正文里替换为**该文本的正文**，内容进 `texts` | 同上 |
| `@视频1` | 正文里替换为 `【视频1】`，url 进 `media` | 同上 |

- 同一个 token 出现多次 → `media` / `texts` 里只记一次，但正文里每处都替换
- token 前后不加空格也算命中（`把@图片1的背景` 要能解析）
- 一个都不引用时，`resolvePromptReferences` 返回的 `text` 必须**等于原 prompt**（保证不引用时行为零变化）

---

## 4. 工作包与文件所有权（严格互斥）

**只改自己名下的文件。** 不要动 `docs/`、`styles/`、`node-suggestions.ts`、
`model-params.ts`、`upstream-inputs.ts`。

### 工作包 A：引用解析器（纯逻辑）
- **新增** `src/views/workflow/composables/reference-resolver.ts`
- **新增** `tests/reference-resolver.test.ts`

`collectReferenceableAssets(nodeId)` 从 `useWorkflowCanvas` 的 `nodes`/`edges`
读上游：`text` 节点 → 文本引用（值取 `content`）；`llmConfig` 节点 → 文本引用
（值取 `outputContent`）；`image` 节点 → 图片引用（值取 `url`）；
`video` 节点 → 视频引用（值取 `url`）。**值为空的资产不出现**。
序号按上游节点在 `edges` 里的出现顺序稳定编号。

测试要覆盖 §3 的整张语义表，外加：空 prompt、无 token、重复 token、
token 相邻、序号越界、值为空的资产被过滤、不引用时 text 恒等于原 prompt。

### 工作包 B：@ 选择面板组件
- **新增** `src/components/generate/MentionPicker.vue`
- **新增** `src/components/generate/mention-groups.ts`（纯分组逻辑，单独一个文件是为了能被
  测试直接 import —— `<script setup>` 里的函数 tsx 拿不到）
- **新增** `tests/mention-groups.test.ts`

两级面板，视觉对齐 LibTV：宽 200px、圆角与画布悬浮件一致
（`--canvas-float-block-default` / `--stroke-secondary` / 8px 圆角 / 13px 字号）。
第一级列出**有资产的**种类（种类名 + 数量），第二级列出该类资产（展示名 + 序号）。
没有资产的种类**不显示**。整体没有资产时显示 `暂无可引用资产，请连入后操作`。

`mention-groups.ts` 的冻结导出：
```ts
export interface ReferenceKindGroup { kind: ReferenceKind; label: string; items: ReferenceableAsset[] }
/** 按固定顺序 图片 → 文本 → 视频 分组；没有资产的种类直接不出现；全空返回 [] */
export const groupReferenceAssets: (assets: ReferenceableAsset[]) => ReferenceKindGroup[]
```

Props/emits（冻结）：
```ts
defineProps<{
  visible: boolean
  assets: ReferenceableAsset[]
  /** 触发点在屏幕上的位置，面板据此定位（输入框上方，对齐 LibTV 的 bottom 定位）*/
  anchor: { x: number; y: number }
}>()
defineEmits<{
  (e: 'select', asset: ReferenceableAsset): void
  (e: 'close'): void
}>()
```
支持键盘：`Esc` 关闭、`↑/↓` 移动、`Enter` 选中。点击外部关闭。

### 工作包 C：composer 接入
- `src/components/generate/ContentGenerator.vue`

1. 新增 prop（冻结）：
   ```ts
   referenceableAssets?: ReferenceableAsset[]   // 默认 []
   ```
2. 图片/视频类型的输入框里监听内容变化：**光标前刚敲下的字符是 `@`**
   （且不在构成 `@token` 的中间）→ 打开 `MentionPicker`，anchor 取输入框左上角。
3. `select` → 用 `insertReferenceToken` 把 token 插到光标处、恢复焦点与光标位置。
4. 输入框下方渲染「已引用」行：把 `resolvePromptReferences` 的结果里
   `media` 对应资产以缩略图展示（可点击移除：移除即从文本里删掉对应 token）。
5. 提交时（`handleSubmit` 的 `send` 载荷）：
   - `prompt` 用 `resolved.text`
   - `referenceImages` = `resolved.media`（**显式引用时覆盖**）
   - 若无任何 token（`resolved.media` 为空且 `texts` 为空）→ 保持现有行为不变
   - `unresolved` 非空时，不阻塞提交，但要在返回值或事件里带出去（`send` 载荷里
     加一个可选 `unresolvedReferences?: string[]`），由调用方决定是否提示
6. **不要改 §3 的任何签名**，也不要改既有的 `initialParams` / `paramsChange` /
   `getCurrentParams` 契约（见 libtv-interaction-spec §3.4）。

### 工作包 D：节点侧提供资产清单 + 消费解析结果
- `src/views/workflow/components/nodes/ImageNode.vue`
- `src/views/workflow/components/nodes/VideoNode.vue`

1. 把 `:referenceable-assets="collectReferenceableAssets(props.id)"` 传给 `ContentGenerator`。
2. `handlePromptSend` 里：若 `options.unresolvedReferences` 非空，用
   `ElMessage.warning` 提示「有 N 处引用已失效」。
3. 若 `options` 里带了显式引用（`referenceImages` 与自动收集的不同），
   **以显式为准**（工作包 C 已经把顺序算好了，D 只负责不要再用
   `upstreamReferenceUrls` 覆盖回去）。
4. **不要改卡片样式**（已经对齐完成），不要动 `upstream-inputs.ts`。

---

## 5. 验收（每个工作包自己跑）

```bash
cd ~/CanvasMind
export PATH="$HOME/.local/lib/nodejs/bin:$PATH"

# 类型检查：只允许 art-design/ArtForm.vue 的 3 个既有报错
npx vue-tsc --noEmit 2>&1 | grep -E '^src/.*error TS' | grep -v 'art-design/ArtForm'

# 全量单测必须全绿（当前 6 个文件 187 项，加上你的新文件）
for f in tests/*.test.ts; do npx tsx "$f" | tail -1; done
```

浏览器 e2e（需要一个有效 session；脚本会自己灌 cookie）：
```bash
for s in route-sweep drag-to-create double-click-create; do
  SESSION_TOKEN=<token> node tests/e2e/$s.mjs | tail -1
done
```
现状基准：`12 / 0`、`18 / 0`、`27 / 0`，**不许退化**。

**硬性要求**：不留 `console.log`；不写死颜色（走 token）；
不改冻结签名；不碰别人名下的文件；新逻辑必须有单测；中文注释，
解释「为什么」而不是复述代码。

---

## 6. 提交载荷的最终形状（C 与 D 必须一致）

```ts
// 'send' 事件的第三个参数
interface GeneratorSendOptions {
  model?: string
  modelKey?: string
  ratio?: string
  resolution?: string
  count?: number
  duration?: string
  feature?: string
  referenceImages?: string[]
  /** 新增：解析失败的引用 token 原文，供调用方提示 */
  unresolvedReferences?: string[]
}
```

## 7. 下一轮（不在本轮范围）

- **内联可视化 chip**：把 `<textarea>` 换成 `contenteditable`，token 渲染成带缩略图的
  chip。数据模型不变，只换渲染层。需要处理中文 IME（`compositionstart/end`）。
- **智能引用 AutoLink**：LibTV「高级设置」里唯一的一项，把显式引用切成自动全引用。
  我们现在等于常开。
- **音频生成节点**：LibTV 有，我们没有，需要新的后端任务策略。
