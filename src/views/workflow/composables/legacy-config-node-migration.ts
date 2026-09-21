/**
 * 旧画布兼容：把「配置节点」形态迁移成「生成节点自带参数」形态
 *
 * 背景：改造前，文本和出图之间夹着一个 imageConfig / videoConfig 节点专门放
 * 模型与尺寸，链路是「文本 → 配置 → 图片」。改造后参数写在图片 / 视频节点自己身上，
 * 配置节点这两个类型已经从注册表里删掉。
 *
 * 但数据库里已经存了带配置节点的画布。如果不迁移，这些节点会因为类型未注册而
 * 渲染成一团空壳，链路断掉。所以读取时统一做一次折叠：
 *
 *   文本 ──promptOrder──▶ [imageConfig] ──▶ (image 输出节点)
 *                              ↓ 迁移
 *   文本 ──promptOrder──────────────────▶ (image 节点，参数已合并进来)
 *
 * 规则：
 *  1. 配置节点如果有下游的同类型生成节点（imageConfig → image / videoConfig → video），
 *     就把参数合并到那个下游节点，把上游连线改指到它，然后删掉配置节点；
 *  2. 没有下游节点时（模板里的裸配置节点），原地把类型改成生成节点类型即可。
 *
 * 迁移是幂等的：输出里不再有配置节点，跑第二遍不会有任何变化。
 */

import type { WorkflowCanvasEdge, WorkflowCanvasNode } from './useWorkflowCanvas'

/** 旧类型 → 新类型 */
const LEGACY_TYPE_MAP: Record<string, 'image' | 'video'> = {
  imageConfig: 'image',
  videoConfig: 'video',
}

/** 每个生成类型关心的参数键，迁移时只搬这些，避免把旧节点的运行时状态也带过去 */
const PARAM_KEYS = ['model', 'size', 'quality', 'ratio', 'duration', 'resolution', 'feature', 'prompt'] as const

/** 只在配置节点上有意义的运行时字段，迁移后必须清掉 */
const RUNTIME_KEYS = ['loading', 'error', 'taskRecordId', 'autoExecute', 'executed', 'outputNodeId'] as const

export interface LegacyMigrationOutcome {
  nodes: WorkflowCanvasNode[]
  edges: WorkflowCanvasEdge[]
  /** 被迁移掉的配置节点数，0 表示这份画布本来就是新形态 */
  migratedCount: number
}

export const migrateLegacyConfigNodes = (
  inputNodes: WorkflowCanvasNode[],
  inputEdges: WorkflowCanvasEdge[],
): LegacyMigrationOutcome => {
  const legacyNodes = inputNodes.filter(node => node.type && LEGACY_TYPE_MAP[node.type])
  if (!legacyNodes.length) {
    return { nodes: inputNodes, edges: inputEdges, migratedCount: 0 }
  }

  const legacyIds = new Set(legacyNodes.map(node => node.id))
  const nodeById = new Map(inputNodes.map(node => [node.id, node]))

  const edgesAfterMigration: WorkflowCanvasEdge[] = []
  // 被丢弃的配置节点 → 它折叠成的目标节点 id（用于重接上游连线）
  const redirect = new Map<string, string>()

  for (const legacyNode of legacyNodes) {
    const targetType = LEGACY_TYPE_MAP[legacyNode.type as string]

    // 找下游同类型生成节点：那就是原来承接输出的节点
    const downstreamEdge = inputEdges.find((edge) => {
      if (edge.source !== legacyNode.id) return false
      const target = nodeById.get(edge.target)
      return target?.type === targetType && !legacyIds.has(target.id)
    })

    if (!downstreamEdge) continue

    const destination = nodeById.get(downstreamEdge.target)
    if (!destination) continue

    const legacyData = (legacyNode.data || {}) as Record<string, unknown>
    const destinationData = { ...((destination.data || {}) as Record<string, unknown>) }

    for (const key of PARAM_KEYS) {
      const value = legacyData[key]
      if (value === undefined || value === null || value === '') continue
      // 下游已经有了就不覆盖：出图节点自己的参数比上游配置更晚也更有意
      const current = destinationData[key]
      if (current !== undefined && current !== null && current !== '') continue
      destinationData[key] = value
    }
    for (const key of RUNTIME_KEYS) {
      delete destinationData[key]
    }

    destination.data = destinationData as typeof destination.data
    redirect.set(legacyNode.id, destination.id)
  }

  const migratedNodes: WorkflowCanvasNode[] = []
  for (const node of inputNodes) {
    if (!legacyIds.has(node.id)) {
      migratedNodes.push(node)
      continue
    }
    // 有下游可折叠 → 直接丢掉配置节点；否则原地改成生成节点类型
    if (redirect.has(node.id)) continue
    const targetType = LEGACY_TYPE_MAP[node.type as string]
    const data = { ...((node.data || {}) as Record<string, unknown>) }
    for (const key of RUNTIME_KEYS) {
      delete data[key]
    }
    migratedNodes.push({
      ...node,
      type: targetType,
      data: data as typeof node.data,
    } as WorkflowCanvasNode)
  }

  for (const edge of inputEdges) {
    // 指向被折叠掉的配置节点的边，改指到它折叠成的生成节点
    if (redirect.has(edge.target)) {
      const nextTarget = redirect.get(edge.target) as string
      if (nextTarget === edge.source) continue // 自环，丢掉
      edgesAfterMigration.push({ ...edge, target: nextTarget })
      continue
    }
    // 配置节点自己的出边（配置 → 输出）不再需要，链路已经接上了
    if (redirect.has(edge.source)) continue
    edgesAfterMigration.push(edge)
  }

  // 上游改指之后可能出现重复边（两条 text 指向同一目标的不同序号）——按 id 去重
  const seenEdgeIds = new Set<string>()
  const dedupedEdges = edgesAfterMigration.filter((edge) => {
    if (seenEdgeIds.has(edge.id)) return false
    seenEdgeIds.add(edge.id)
    return true
  })

  return {
    nodes: migratedNodes,
    edges: dedupedEdges,
    migratedCount: legacyIds.size - (migratedNodes.filter(n => legacyIds.has(n.id)).length),
  }
}
