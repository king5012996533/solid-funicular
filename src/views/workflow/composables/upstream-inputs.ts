/**
 * 上游输入收集
 *
 * 图片节点和视频节点都需要「把上游连过来的文本当提示词」，
 * 这段逻辑原来在两个组件里各写了一遍，且都只认 text 节点 ——
 * 导致 LLM 节点生成的提示词（outputContent）连过去之后没人读，
 * 看起来连上了、实际是个静默空操作。
 * 这里统一成一处，顺手把 LLM 节点也接上。
 */

import { type WorkflowCanvasNode } from './useWorkflowCanvas'
import { nodeIndex, inboundEdges } from './workflow-graph-index'

/**
 * 一个节点能对外贡献的提示词文本。
 *   text      用 content（用户写的）
 *   文本节点用 content
 * 其他类型不贡献文本。
 */
export const readNodePromptText = (node?: WorkflowCanvasNode): string => {
  if (node?.type === 'text') {
    return String((node.data as { content?: string })?.content || '').trim()
  }
  return ''
}

/**
 * 收集连到某个节点的全部上游提示词，按 promptOrder 排序后用换行拼接。
 * 多路提示词的排序规则与模板里的一致：边上的 promptOrder 值，缺省为 1。
 */
export const collectUpstreamPromptText = (nodeId: string): string => {
  const entries: Array<{ order: number; content: string }> = []

  // 走共享索引：每次调用是 O(入边数)，不再各自遍历整个 edges / nodes
  for (const edge of inboundEdges.value.get(nodeId) || []) {
    const sourceNode = nodeIndex.value.get(edge.source)
    const content = readNodePromptText(sourceNode)
    if (!content) continue
    const order = Number((edge.data as { promptOrder?: number })?.promptOrder) || 1
    entries.push({ order, content })
  }

  entries.sort((a, b) => a.order - b.order)
  return entries.map((entry) => entry.content).join('\n')
}

/** 上游 + 节点内输入，合并成最终提交的提示词 */
export const composePrompt = (upstreamText: string, inline: string) => {
  return [String(upstreamText || '').trim(), String(inline || '').trim()].filter(Boolean).join('\n')
}

/* ============================================================================
 * 入边排序与图片角色（2026-09-26）
 *
 * 背景：边上一直有两种用户可见的控件 —— 「第 N 张」（imageOrder，图片→图片）
 * 与「首帧/尾帧/参考图」（imageRole，图片→视频）。但**生成链路从来没读它们**：
 *   - 提示词顺序（promptOrder）有消费者（上面 collectUpstreamPromptText）；
 *   - 参考图顺序只按连线**插入顺序**算（ImageNode / reference-resolver 都是）；
 *   - 角色完全没人读，下游是按**数组位置**猜首尾帧的。
 * 结果是：用户在边上点出来的 ③、选出来的「尾帧」全是空操作。
 * 这里把两条规则做成纯函数，让所有取上游的地方都从同一处拿值。
 * ========================================================================== */

/** 边 data 里可能出现的顺序键：文本边用 promptOrder，图片边用 imageOrder */
export type UpstreamOrderKey = 'promptOrder' | 'imageOrder'

/** 图片角色：与 ImageRoleEdge 的选项一一对应 */
export type UpstreamImageRole = 'first_frame_image' | 'last_frame_image' | 'input_reference'

/** 读边的显式序号。没写、写了非数字、或 <= 0 都算「没编号」 */
export const readEdgeOrder = (
  edge: { data?: unknown },
  key: UpstreamOrderKey,
): number | null => {
  const raw = (edge.data as Record<string, unknown> | undefined)?.[key]
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 按边的「第 N 位」稳定排序。
 *
 * 三条规则（都是刻意的）：
 *   1. **显式编号的排在没编号的前面** —— 用户点了 ③ 就是把那张往前放，不能让没编号的插队；
 *   2. 都编号了就按编号；
 *   3. 都没编号（或编号相同）**保持连线插入顺序** —— 否则用户什么都没改，顺序却会自己跳。
 * 这个函数对 text 边也安全：text 边没有 imageOrder，全部落到第 3 条，等价于原样返回。
 */
export const sortEdgesByExplicitOrder = <T extends { data?: unknown }>(
  edges: readonly T[],
  key: UpstreamOrderKey,
): T[] => {
  return edges
    .map((edge, index) => ({ edge, index, order: readEdgeOrder(edge, key) }))
    .sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order || a.index - b.index
      if (a.order !== null) return -1
      if (b.order !== null) return 1
      return a.index - b.index
    })
    .map((item) => item.edge)
}

/** 读图片角色。**未标注按「首帧」处理** —— 与 ImageRoleEdge 的默认值一致，保证老画布行为不变 */
export const readEdgeImageRole = (edge: { data?: unknown }): UpstreamImageRole => {
  const raw = String((edge.data as { imageRole?: unknown } | undefined)?.imageRole || '').trim()
  if (raw === 'last_frame_image' || raw === 'input_reference') return raw
  return 'first_frame_image'
}

/**
 * 把上游图片按**角色**排成一份有语义的顺序：首帧 → 尾帧 → 其余（参考图）。
 *
 * 为什么必须按角色而不是按位置：下游（视频节点 → 请求体的 `image_urls`）是
 * **按位置理解**这组图的（首尾帧模式下第 1 张=首帧、第 2 张=尾帧），
 * 而位置原来是连线插入顺序 —— 于是用户在边上选的「尾帧」根本不生效。
 *
 * 组内仍按显式序号、再按插入顺序（复用 sortEdgesByExplicitOrder）。
 * 未标注的边归入首帧组：老画布上「第一张=首帧、第二张=尾帧」的既有表现因此不变。
 */
export const orderImageEdgesByRole = <T extends { data?: unknown }>(
  edges: readonly T[],
): T[] => {
  const buckets: Record<UpstreamImageRole, T[]> = {
    first_frame_image: [],
    last_frame_image: [],
    input_reference: [],
  }
  for (const edge of edges) {
    buckets[readEdgeImageRole(edge)].push(edge)
  }
  return [
    ...sortEdgesByExplicitOrder(buckets.first_frame_image, 'imageOrder'),
    ...sortEdgesByExplicitOrder(buckets.last_frame_image, 'imageOrder'),
    ...sortEdgesByExplicitOrder(buckets.input_reference, 'imageOrder'),
  ]
}
