/**
 * 上游输入收集
 *
 * 图片节点和视频节点都需要「把上游连过来的文本当提示词」，
 * 这段逻辑原来在两个组件里各写了一遍，且都只认 text 节点 ——
 * 导致 LLM 节点生成的提示词（outputContent）连过去之后没人读，
 * 看起来连上了、实际是个静默空操作。
 * 这里统一成一处，顺手把 LLM 节点也接上。
 */

import { edges, nodes, type WorkflowCanvasNode } from './useWorkflowCanvas'

/**
 * 一个节点能对外贡献的提示词文本。
 *   text      用 content（用户写的）
 *   llmConfig 用 outputContent（LLM 生成的）
 * 其他类型不贡献文本。
 */
export const readNodePromptText = (node?: WorkflowCanvasNode): string => {
  if (node?.type === 'text') {
    return String((node.data as { content?: string })?.content || '').trim()
  }
  if (node?.type === 'llmConfig') {
    return String((node.data as { outputContent?: string })?.outputContent || '').trim()
  }
  return ''
}

/**
 * 收集连到某个节点的全部上游提示词，按 promptOrder 排序后用换行拼接。
 * 多路提示词的排序规则与模板里的一致：边上的 promptOrder 值，缺省为 1。
 */
export const collectUpstreamPromptText = (nodeId: string): string => {
  const entries: Array<{ order: number; content: string }> = []

  for (const edge of edges.value.filter((item) => item.target === nodeId)) {
    const sourceNode = nodes.value.find((item) => item.id === edge.source)
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
