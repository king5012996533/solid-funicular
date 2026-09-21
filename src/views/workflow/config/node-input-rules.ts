/**
 * 节点输入需求的**纯规则层**
 *
 * 对齐 LibTV 的这条机制：**节点自己声明它需要什么输入、现在已经有什么**。
 * LibTV 的智能剪辑节点空态写「空空如也，请连接视频节点后操作」，
 * 逐帧拉片写「上传视频后开始」—— 按类型说清楚，而不是一句笼统的「已连接参考图片」。
 *
 * 我们原来的问题：图片节点不管上游连的是文本还是图片，就绪态一律显示
 * 「已连接参考图片」，用户看不出「还差什么才能生成」。
 *
 * 为什么把规则单独放一个文件、不直接写在 composable 里：
 *   这里全是纯函数，可以在 Node 里直接跑单测；真正的 composable 只负责把
 *   Vue 的响应式 ref 喂进来。混在一起的话，单测会连带把 `@/` 别名、Vue 运行时
 *   一起拖进来，跑不动。
 */

import type { WorkflowNodeType } from '../composables/useWorkflowCanvas'

/** 节点能消费的上游输入种类 */
export type NodeInputKind = 'text' | 'image' | 'video'

/** 固定顺序：文案拼接与去重都依赖它保持稳定 */
export const NODE_INPUT_KINDS: NodeInputKind[] = ['text', 'image', 'video']

/** 每种输入在界面上的说法（用于拼「已连接提示词与参考图」） */
export const INPUT_KIND_LABEL: Record<NodeInputKind, string> = {
  text: '提示词',
  image: '参考图',
  video: '视频素材',
}

/**
 * 每类节点的输入声明。
 *
 * required：缺了就没法生成 —— 决定空态提示怎么写，也决定能力项能不能点
 * optional：有更好，没有也能跑
 * emptyHint：什么都没有时告诉用户该去连什么（LibTV 的空态就是这个作用）
 */
export interface NodeInputSpec {
  required: NodeInputKind[]
  optional: NodeInputKind[]
  emptyHint: string
}

export const NODE_INPUT_SPECS: Record<WorkflowNodeType, NodeInputSpec> = {
  // 文本节点不消费上游：内容由用户输入或导入解析而来
  text: {
    required: [],
    optional: [],
    emptyHint: '直接输入内容，或上传文档解析文本',
  },
  // 图片节点：文本当提示词、图片当参考图，都是可选 —— 空节点也能纯文字生图
  image: {
    required: [],
    optional: ['text', 'image'],
    emptyHint: '连接文本节点写提示词，或直接输入文字生图',
  },
  // 视频节点：至少要有一帧画面或一段文字描述才能出片
  video: {
    required: [],
    optional: ['text', 'image'],
    emptyHint: '连接图片节点作为首帧，或直接描述画面生成',
  },
  llmConfig: {
    required: [],
    optional: ['text'],
    emptyHint: '连接文本节点作为输入，或直接写系统提示词',
  },
}

/** 上游节点的最小形状，避免纯规则层依赖完整的 Vue Flow 类型 */
export interface UpstreamNodeLike {
  id: string
  type?: string
  data?: unknown
}

export interface EdgeLike {
  source: string
  target: string
}

/**
 * 一个上游节点能给下游提供哪种输入；给不出就返回 null。
 *
 * 判定标准是**上游真的产出了内容**，不是「有一条边」：
 * 连了一个还没出图的图片节点，不算已连接参考图 —— 否则界面会说谎，
 * 用户以为接上了、一生成才发现没有素材。
 */
export const readUpstreamKind = (node?: UpstreamNodeLike): NodeInputKind | null => {
  if (!node) return null

  if (node.type === 'text' || node.type === 'llmConfig') {
    // 文本节点看 content，LLM 节点看它生成的 outputContent
    const value = node.type === 'text'
      ? String((node.data as { content?: string } | undefined)?.content || '').trim()
      : String((node.data as { outputContent?: string } | undefined)?.outputContent || '').trim()
    return value ? 'text' : null
  }

  if (node.type === 'image' || node.type === 'video') {
    const url = String((node.data as { url?: string } | undefined)?.url || '').trim()
    if (!url) return null
    return node.type === 'image' ? 'image' : 'video'
  }

  return null
}

/** 收集某个节点**实际可用**的上游输入种类（去重、按固定顺序） */
export const collectUpstreamKinds = (
  nodesList: UpstreamNodeLike[],
  edgesList: EdgeLike[],
  nodeId: string,
): NodeInputKind[] => {
  const byId = new Map(nodesList.map((node) => [node.id, node]))
  const kinds = new Set<NodeInputKind>()

  for (const edge of edgesList) {
    if (edge.target !== nodeId) continue
    const kind = readUpstreamKind(byId.get(edge.source))
    if (kind) kinds.add(kind)
  }

  return NODE_INPUT_KINDS.filter((kind) => kinds.has(kind))
}

export interface NodeInputState {
  /** 已经具备的输入种类 */
  satisfied: NodeInputKind[]
  /** 还缺的必需输入种类（声明里 required 为空的节点恒为空） */
  missing: NodeInputKind[]
  /** 必需输入是否到齐 */
  ready: boolean
  /** 就绪文案：`已连接提示词与参考图`；什么都没有时是空串 */
  connectedLabel: string
  /** 空态文案：按节点类型告诉用户该连什么 */
  emptyLabel: string
}

/** 由「声明 + 实际上游输入」推导界面文案。纯函数，单测直接覆盖 */
export const deriveNodeInputState = (
  spec: NodeInputSpec,
  upstreamKinds: NodeInputKind[],
): NodeInputState => {
  const satisfiedSet = new Set(upstreamKinds)
  const satisfied = NODE_INPUT_KINDS.filter((kind) => satisfiedSet.has(kind))
  const missing = spec.required.filter((kind) => !satisfiedSet.has(kind))
  const joined = satisfied.map((kind) => INPUT_KIND_LABEL[kind]).join('与')

  return {
    satisfied,
    missing,
    ready: missing.length === 0,
    // 整句都在这里拼好，组件直接渲染：文案只有一处，将来要改措辞/做多语言不用满仓找
    connectedLabel: joined ? `已连接${joined}` : '',
    emptyLabel: spec.emptyHint,
  }
}
