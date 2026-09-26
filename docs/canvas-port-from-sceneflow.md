# 从 SceneFlow 抄画布：完整清单与分工（2026-09-26）

> 参照对象：`C:\Users\Administrator\AppData\Local\hermes\infinite-canvas`（**上线运营中的老项目**，React + antd + zustand，画布自研 SVG）。
> 目标项目：本仓库（Vue 3 + Element Plus + Vue Flow）。
>
> **为什么不整包搬**：老项目画布 109 个文件 / 21,895 行，牵着它自己的 5 个 store、3 层 service
> 与后端契约（`/canvas/api/sync`、`agent/codex/turn`、`canvas/state`、`canvas/result` + `lib/` 里的
> auth / billing / credit-ledger / credit-pricing / 媒体存储）。整包搬进来是**双系统**（两套 UI 库、
> 两套状态层、两套积分），不是双栈。所以这里只抄**被验证过的交互与数据形状**，在 Vue Flow 上复刻。

---

## 0. 已经做完的（勿重做）

| # | 项 | 提交 |
|---|---|---|
| P1 | 边上的「第 N 张」(`imageOrder`) 真的被消费：参考图顺序 + `@图片N` 编号 | `a740dcf` |
| P2 | 边上的「首帧/尾帧」(`imageRole`) 真的被消费：输入画面按 首帧→尾帧→参考图 排 | `a740dcf` |
| P3 | **拖到卡片身上即连线**（老项目「卡片全身是落点」）+ 拒绝时给人话 | `a8ee556` |

---

## 1. 本轮要抄的清单（按"文件所有权"分组，便于并行）

### 工作包 A —— 画布壳（owner：`index.vue` + `useWorkflowCanvas.ts`）

| # | 抄什么 | 老项目证据 | 我们要做成什么 | 验收 |
|---|---|---|---|---|
| A1 | **连线上的"插中间节点"** | `use-canvas-image-tools.ts:72-109`（反推提示词会自动插 文本+Config 两个中间节点） | 边的右键菜单加「插入节点」：在 A→B 之间插入 N，变成 A→N→B，且**原边不残留** | 插完只有两条边；N 的输入/输出类型合法 |
| A2 | **成组 / 拆组** | `canvas-client-page.tsx:1146-1177`（Ctrl+G / Ctrl+Shift+G）、`canvas-utils.ts:176-193 createCanvasGroup`、`use-canvas-node-drag.ts:70`（拖组框带走子节点） | 新增 `group` 节点类型 + 快捷键 + 拖拽联动 + 渲染层级（组在最底层） | Ctrl+G 出组框；拖组框带动子节点；拆组后子节点保留 |
| A3 | **落点的自连拦截** | `canvas-client-page.tsx:460-461,518-519` | 拖到自己身上**给提示**（现在 UI 路径无拦截，只有 Agent 侧有） | 拖到自己 handle/卡片上松手 → 提示「不能连到节点自己身上」 |
| A4 | **砍重复入口**（用户点名的"功能重叠"） | 老项目**没有**空白右键建节点菜单、也**没有**空白双击建节点菜单（它只有工具栏直达 + 连线落空菜单） | 删掉**双击空白**那套菜单（与右键重复）；右键空白只留 Agent 创作 / 粘贴（建节点交给工具栏与连线落空菜单） | 双击空白不再弹菜单；右键空白不含 4 类节点；工具栏与连线菜单仍能建节点 |
| A5 | 消费"定位到节点"的请求 | 老项目也无 | 见我预置的 `selectOnlyNode` / `requestCenterOnNode`，供工作包 C 的"点引用跳回上游"用 | 见 C1 |

### 工作包 B —— 节点动作（owner：`ImageNode.vue` / `VideoNode.vue` / `TextNode.vue` / `AssetNode.vue`）

| # | 抄什么 | 老项目证据 | 我们要做成什么 | 验收 |
|---|---|---|---|---|
| B1 | **上游已变 / 需重跑标记** | 老项目**也没有**（两端都缺，属新增） | 下游卡片记录"本次提交时上游的产出指纹（url）"，上游 url 变化时在卡片上出角标「上游已更新，建议重跑」 | 上游重跑出新图 → 下游出现提示；重跑下游后提示消失 |
| B2 | **图片卡片补齐可用动作** | `canvas-image-toolbar-tools.tsx:47-147`：复制提示词、反推提示词、替换图片、锁比例/自由比例、局部编辑、裁剪、切图、放大、多角度、查看大图（超分**老项目也未实现**） | 挑**已经有管线**的接上：复制提示词、替换图片、锁比例、查看大图、局部编辑（`ImageMaskBrushDialog.vue` 已存在） | 每项点下去都有真实动作；**不出现假入口**（本仓库明确反对「接入中」占位） |
| B3 | **hover 工具条四类节点一致** | 老项目四类节点都有 hover 条（`canvas-node-hover-toolbar.tsx:140-160`） | 图片节点**没有** hover 条（其它三类有）→ 补齐复制/下载/删除；再删掉右键菜单里重复的复制/删除（避免误删） | 四类节点 hover 条动作集合一致 |

### 工作包 C —— 卡片间传参收敛 + 跳回上游（owner：`ContentGenerator.vue` + `reference-resolver.ts` + `auto-link.ts`）

| # | 抄什么 | 老项目证据 | 我们要做成什么 | 验收 |
|---|---|---|---|---|
| C1 | **点引用跳回上游卡片** | 老项目**也没有**（两端都缺，属新增） | 「已引用」缩略图与 @ 菜单项可点击 → 选中并居中上游卡片（用我预置的 `selectOnlyNode` / `requestCenterOnNode`） | 点缩略图 → 画布选中并把上游移到视野中央 |
| C2 | **传参四通道收敛成一份显式清单** ← **本轮最重要** | `canvas-node-generation.ts:30-53`：上游文本拼进 prompt、图片/视频/音频进 `referenceImages/...` 数组；**顺序 = connections 顺序**；`canvas-resource-references.ts:44-98` 统一收集与编号 | 现在上游素材有**四条**通道叠加：① 连线自动注入（`upstreamReferenceUrls`/`upstreamFrameUrls`）② `@` 显式引用 ③ AutoLink ④ 手动参考图。要收敛为：**一份可见、可删的下游清单**（= 老项目的 `references[]` 语义），AutoLink 降级为"默认填充"而不是第四套机制；**同一素材只进一次** | 关掉 AutoLink 后行为可预测；面板上能看到"本次实际会用哪些素材"并逐条删除；同一张图不会重复进请求 |

---

## 2. 下一轮（要动服务端 / 数据模型，本轮不做）

| # | 项 | 说明 |
|---|---|---|
| P9 | **产物真实宽高入库** | 服务端在生成结果里返回产物像素；卡片标题旁显示真实尺寸（现在图片节点明确"拿不到就宁缺毋滥"）。顺带能修 `duration-clamp`（用 `_resourceMeta.durationSec` 回填真实时长） |
| P10 | **画布上的音频节点** | 服务端音频链路已通（`a1949cc`），差画布侧：`audio` 节点类型 + 规格表 + `reference-resolver` 加 audio kind + 能被视频节点当参考。（老项目有：`CanvasNodeType.Audio` + `use-canvas-audio-generation.ts`） |
| P11 | **持久化新字段** | A2 的 group 节点、B1 的指纹字段进快照/版本序列化，保证保存/加载/切版本不丢 |

---

## 3. 明确**不抄**的

| 不抄 | 为什么 |
|---|---|
| 整包搬 React 画布 | 见文首：那是双系统，且要连带它的后端契约与积分体系 |
| 老项目的**边数据模型**（`{id, fromNodeId, toNodeId}` 无边类型/顺序/角色） | 我们在这一层**领先**：顺序与角色是显式字段、且用户可在边上直接改。老项目是隐式顺序、改不了 |
| 老项目的**引用顺序机制**（隐式 = connections 数组顺序，前端不能调序） | 同上，我们的更好；本轮只是把它**接通**（P1/P2 已完成） |
| **shot-pack 分镜包** | 老项目这块是**半成品**：`ShotPackPanel` 与 `composeShotPackBlob` 全仓无调用点（未接线）。不宜照搬 |
| 老项目的 **antd / Tailwind / zustand / canvasThemes** | 技术栈不同，抄了就是双栈 |
| 老项目的**超分**动作 | 老项目自己也没实现（`canvas-image-dialogs-host.tsx:85-87` 显示「暂未实现」） |

---

## 4. 验收口径（每个工作包自己跑）

```bash
# 类型检查（必须 0 报错）
cmd.exe /c "C:\Users\Administrator\refund-e2e\tsc.bat"

# 全量单测（当前 55 个文件全绿，不许掉）
cmd.exe /c "C:\Users\Administrator\refund-e2e\run-all.bat"
```

浏览器实测由集成方（我）在合并后统一做：临时画布 + CDP 驱动，验**行为**（连线真被消费、动作真有结果、拒绝有提示），
并**清理临时画布**。参考脚本：`refund-e2e/verify-edge-order.mjs`、`refund-e2e/verify-drag-connect.mjs`。
