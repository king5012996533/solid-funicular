/**
 * 画布状态摘要（纯函数，可单测）
 *
 * 为什么要它：助手面板以前对画布**一无所知** —— 它拿不到节点、连线、选中项，
 * 所以只能空对空地写提示词，用户问"我这个画布还缺什么"它只能瞎猜。
 * 这里把画布压成一段很短的文本，作为 system 消息发给模型。
 *
 * 刻意做得很短：
 *   - 节点数与总字符都有上限，避免长画布把上下文吃光（对话模型按 token 计费，
 *     而且这里的模型是思考型的，上下文越长首字越慢）。
 *   - 文本内容只取开头一小段 —— 让模型知道"这条在讲什么"足够，不需要全文。
 *   - 不输出坐标：位置对"帮我改提示词"这类请求没用，纯占 token。
 */

export interface BriefNode {
  id: string
  type?: string
  position?: { x?: number; y?: number }
  data?: Record<string, unknown>
}

export interface BriefEdge {
  source: string
  target: string
  type?: string
  data?: Record<string, unknown>
}

/** 最多描述多少个节点 */
export const BRIEF_NODE_LIMIT = 40
/** 摘要总长度上限（字符） */
export const BRIEF_CHAR_LIMIT = 2600
/** 文本类节点内容截取长度 */
const TEXT_SNIPPET = 60

const TYPE_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  llmConfig: 'LLM文本',
  asset: '素材',
}

/** 边上类型 → 人话（节点之间那根线到底在传什么） */
const EDGE_LABEL: Record<string, string> = {
  promptOrder: '提示词',
  imageOrder: '参考图',
  imageRole: '素材角色',
}

const readString = (value: unknown, fallback = ''): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

const readText = (node: BriefNode): string => {
  const data = node.data || {}
  // text 节点存 content，llmConfig 节点的产物在 outputContent
  return readString(data.content) || readString(data.outputContent)
}

const describeNode = (node: BriefNode): string => {
  const data = node.data || {}
  const kind = TYPE_LABEL[String(node.type || '')] || node.type || '节点'
  const label = readString(data.label) || '(未命名)'
  const parts = [`${node.id} [${kind}] "${label}"`]

  if (node.type === 'image' || node.type === 'video') {
    const model = readString(data.model)
    if (model) parts.push(`模型=${model}`)
    const size = readString(data.size) || readString(data.ratio)
    if (size) parts.push(`尺寸=${size}`)
    const hasOutput = Boolean(readString(data.url)) || Array.isArray(data.batchChildren) && data.batchChildren.length > 0
    parts.push(hasOutput ? '已出图' : '还没有产物')
  }

  if (node.type === 'llmConfig') {
    const model = readString(data.model)
    if (model) parts.push(`模型=${model}`)
    parts.push(readString(data.outputContent) ? '已产出文本' : '尚未执行')
  }

  const text = readText(node)
  if (text) {
    const snippet = text.length > TEXT_SNIPPET ? `${text.slice(0, TEXT_SNIPPET)}…` : text
    parts.push(`内容="${snippet.replace(/\s+/g, ' ')}"`)
  }

  return parts.join(' ')
}

/**
 * @param nodes      画布节点
 * @param edges      画布连线
 * @param selectedIds 当前选中的节点 id（让模型知道"用户指的是哪个"）
 */
export const buildCanvasBrief = (
  nodes: BriefNode[] = [],
  edges: BriefEdge[] = [],
  selectedIds: string[] = [],
): string => {
  if (!Array.isArray(nodes) || nodes.length === 0) return ''

  const lines: string[] = []
  const truncated = nodes.length > BRIEF_NODE_LIMIT
  const shown = truncated ? nodes.slice(0, BRIEF_NODE_LIMIT) : nodes

  lines.push(`当前画布有 ${nodes.length} 个节点、${edges.length} 条连线。`)
  for (const node of shown) {
    lines.push(`- ${describeNode(node)}`)
  }
  if (truncated) {
    lines.push(`- （其余 ${nodes.length - BRIEF_NODE_LIMIT} 个节点略）`)
  }

  const idSet = new Set(shown.map(node => node.id))
  const edgeText = edges
    .filter(edge => idSet.has(edge.source) && idSet.has(edge.target))
    .map(edge => `${edge.source}→${edge.target}(${EDGE_LABEL[String(edge.type || '')] || '连接'})`)
  if (edgeText.length) lines.push(`连线：${edgeText.join('，')}`)

  const selected = selectedIds.filter(id => idSet.has(id))
  if (selected.length) lines.push(`用户当前选中：${selected.join('，')}`)

  const brief = lines.join('\n')
  if (brief.length <= BRIEF_CHAR_LIMIT) return brief
  return `${brief.slice(0, BRIEF_CHAR_LIMIT)}\n（画布内容较长，此处已截断）`
}
