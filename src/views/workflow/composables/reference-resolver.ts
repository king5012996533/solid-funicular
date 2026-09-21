/**
 * 提示词里的 @ 素材引用解析
 *
 * 上游一直是「全自动注入」：连了什么就全用上（文本按 promptOrder 拼进 prompt、
 * 图片全变成参考图），用户没有选择余地。这一版允许在提示词里写 `@图片1` 显式指定，
 * 因此多了一条硬约束：**不引用时必须保持原有行为**，所以没有任何 token 时
 * `resolvePromptReferences` 原样返回入参字符串，绝不重建它。
 *
 * 全部是纯函数；唯一读外部状态的是 `collectReferenceableAssets`（读画布的 nodes/edges），
 * 因为资产清单的来源本来就是画布连线。
 */
import {
  type WorkflowCanvasNode,
  type WorkflowImageNodeData,
  type WorkflowLlmConfigNodeData,
  type WorkflowTextNodeData,
  type WorkflowVideoNodeData,
} from './useWorkflowCanvas'
import { nodeIndex, inboundEdges } from './workflow-graph-index'

export type ReferenceKind = 'image' | 'text' | 'video'

/** 中文种类名：token 与菜单都用它，是「token 文案」的唯一来源 */
const KIND_LABEL: Record<ReferenceKind, string> = { image: '图片', text: '文本', video: '视频' }

/**
 * 对外展示的固定分组顺序（图片 → 文本 → 视频）。
 * LibTV 的一级菜单里第一个是图片，习惯上先图后文；这里不包含音频 ——
 * 我们没有音频节点类型，摆一个永远空的种类只会误导用户。
 */
const KIND_ORDER: ReferenceKind[] = ['image', 'text', 'video']

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

/**
 * token 全格式：@ + 种类名 + 序号，如 '@图片1'。捕获组 1 = 种类名，2 = 序号。
 *
 * 故意不带 `g` 标记：带 g 的正则 `.test()` 会因 lastIndex 变成有状态的，
 * 调用方（输入框判定「光标前是不是刚敲出 token」）会踩到「真真假假」的坑。
 * 解析器需要扫全部命中，用同一份 source 派生带 g 的副本 —— 两边不会漂。
 */
export const REFERENCE_TOKEN_PATTERN = /@(图片|文本|视频)(\d+)/

/** 上游节点能贡献的资产：种类 + 原始值 + 展示名 */
interface UpstreamAsset {
  kind: ReferenceKind
  value: string
  label: string
}

/**
 * 一个节点能对外贡献的引用资产。
 *   text      用 content（用户写的）
 *   llmConfig 用 outputContent（LLM 生成的）
 *   image     用 url
 *   video     用 url
 * 其余情况不贡献资产。
 */
const readNodeAsset = (node: WorkflowCanvasNode): UpstreamAsset | null => {
  const label = String(node.data.label || '').trim()
  if (node.type === 'text') {
    return { kind: 'text', value: String((node.data as WorkflowTextNodeData).content || ''), label }
  }
  if (node.type === 'llmConfig') {
    return { kind: 'text', value: String((node.data as WorkflowLlmConfigNodeData).outputContent || ''), label }
  }
  if (node.type === 'image') {
    return { kind: 'image', value: String((node.data as WorkflowImageNodeData).url || ''), label }
  }
  if (node.type === 'video') {
    return { kind: 'video', value: String((node.data as WorkflowVideoNodeData).url || ''), label }
  }
  return null
}

/** 节点没起名时给一个能区分的兜底展示名，避免菜单里出现两行空标题 */
const displayNameFor = (nodeLabel: string, kindLabel: string, index: number) => {
  return nodeLabel || `${kindLabel} ${index}`
}

/**
 * 从上游节点收集可引用资产。
 *
 * 按 (kind, 连线顺序) 编号，所以同一个画布每次算出来的 token 都一样 ——
 * 提示词里存的是 `@图片1` 这种纯文本，序号一旦漂移，历史提示词就会指向别的图。
 */
export const collectReferenceableAssets = (nodeId: string): ReferenceableAsset[] => {
  const seen = new Set<string>()
  const counters: Record<ReferenceKind, number> = { image: 0, text: 0, video: 0 }
  const buckets: Record<ReferenceKind, ReferenceableAsset[]> = { image: [], text: [], video: [] }

  for (const edge of inboundEdges.value.get(nodeId) || []) {
    // 历史快照里可能存在指向已删节点的悬挂边，读不到就跳过
    const sourceNode = nodeIndex.value.get(edge.source)
    if (!sourceNode) continue

    const entry = readNodeAsset(sourceNode)
    if (!entry) continue

    // 上游还没产出内容时不进列表：引用一个空值只会让提示词多出空白
    const value = entry.value.trim()
    if (!value) continue

    // 同一个上游连了两条边（或两个节点内容相同）只算一个资产，否则序号里会出现空洞
    const dedupKey = `${entry.kind}:${value}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const index = ++counters[entry.kind]
    const kindLabel = KIND_LABEL[entry.kind]
    buckets[entry.kind].push({
      index,
      kind: entry.kind,
      sourceNodeId: sourceNode.id,
      kindLabel,
      token: `${kindLabel}${index}`,
      displayName: displayNameFor(entry.label, kindLabel, index),
      value,
    })
  }

  return KIND_ORDER.flatMap((kind) => buckets[kind])
}

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

/**
 * 把提示词里的 `@` 引用解析成「正文 + 有序参考图」。
 *
 * 语义（规格 §3 的表，实现必须逐条一致）：
 *   @图片1 / @视频1 → 正文换成 `【图片1】`，url 进 media（走请求体，不是提示词的一部分）
 *   @文本1          → 正文换成该文本的正文，内容进 texts
 *   无效 token      → 原文保留在正文里并记进 unresolved，绝不静默吞掉
 * 同一个 token 出现多次时每处都替换，但 url / 正文只记一次。
 */
export const resolvePromptReferences = (
  prompt: string,
  assets: ReferenceableAsset[],
): ResolvedPrompt => {
  const assetsByToken = new Map(assets.map((asset) => [asset.token, asset]))
  const pattern = new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g')
  const media: string[] = []
  const texts: string[] = []
  const unresolved: string[] = []
  const mediaSeen = new Set<string>()
  const textSeen = new Set<string>()
  const unresolvedSeen = new Set<string>()

  let text = ''
  let cursor = 0
  let matchedAny = false

  for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
    matchedAny = true
    const token = match[0].slice(1)
    const asset = assetsByToken.get(token)
    // 先补上两个 token 之间的原样片段，token 前后的字（含中文）因此不会被吞
    text += prompt.slice(cursor, match.index)
    cursor = match.index + match[0].length

    if (!asset) {
      text += match[0]
      if (!unresolvedSeen.has(match[0])) {
        unresolvedSeen.add(match[0])
        // 存带 @ 的原文：调用方要按它从提示词里删掉这一处引用，去掉 @ 就定位不到了
        unresolved.push(match[0])
      }
      continue
    }

    if (asset.kind === 'text') {
      // 文本引用直接嵌入正文，读起来就是一句正常的话
      text += asset.value
      if (!textSeen.has(asset.value)) {
        textSeen.add(asset.value)
        texts.push(asset.value)
      }
      continue
    }

    // 图片/视频进请求体，正文里留一个可读标记，让人看得出这里引用了哪一张
    text += `【${token}】`
    if (!mediaSeen.has(asset.value)) {
      mediaSeen.add(asset.value)
      media.push(asset.value)
    }
  }

  // 一个 token 都没有：连字符串都不重建，保证「不引用 = 行为零变化」
  if (!matchedAny) return { text: prompt, media, texts, unresolved }

  text += prompt.slice(cursor)
  return { text, media, texts, unresolved }
}

/**
 * 在光标处插入 token（token 后补一个空格，免得紧接着敲的下一个字粘进 token 里）。
 * 返回的新光标位置落在空格之后，接着打字就是正常输入。
 */
export const insertReferenceToken = (
  prompt: string,
  caret: number,
  token: string,
): { prompt: string; caret: number } => {
  const source = String(prompt ?? '')
  // 光标可能来自失焦前的旧值，夹到合法区间，否则 slice 位置会错乱
  const raw = Number.isFinite(caret) ? Math.trunc(caret) : source.length
  const at = Math.min(Math.max(raw, 0), source.length)
  const inserted = `@${token} `
  return {
    prompt: source.slice(0, at) + inserted + source.slice(at),
    caret: at + inserted.length,
  }
}
