/**
 * 画布图索引
 *
 * 为什么需要这个：
 *   原先每个节点、每条边组件都在自己那层遍历整个 `edges` / `nodes` 数组来查上下游，
 *   单节点时无所谓，节点一多就变成 O(N×E) —— 而拖拽时**每帧**都会重算一遍。
 *   实测 1000 节点 / 950 边时：拖拽只有 24 FPS、渲染稳定要 8.7 秒；
 *   把边全部去掉后渲染稳定时间降到 1.6 秒（5.6 倍差距），可见问题就出在这里。
 *
 * 做法：把「谁连到谁」预先算成几张 Map，每帧只重建一次（O(N+E) 量级），
 * 之后每个节点/边组件的查询都是 O(1)。总量从 ~百万次降到 ~几千次。
 *
 * 注意：这些都是 `computed`，读取时会自动建立依赖 ——
 * 在组件里直接 `nodeIndex.value.get(id)` 即可，不需要额外处理响应式。
 */

import { computed } from 'vue'
import { edges, nodes } from './useWorkflowCanvas'

/** 节点 id → 节点。替代每个组件各自 `nodes.value.find(...)` */
export const nodeIndex = computed(() => {
  const map = new Map<string, (typeof nodes.value)[number]>()
  for (const node of nodes.value) map.set(node.id, node)
  return map
})

/** target 节点 id → 指向它的所有边 */
export const inboundEdges = computed(() => {
  const map = new Map<string, typeof edges.value>()
  for (const edge of edges.value) {
    const list = map.get(edge.target)
    if (list) list.push(edge)
    else map.set(edge.target, [edge])
  }
  return map
})

/** source 节点 id → 从它出发的所有边 */
export const outboundEdges = computed(() => {
  const map = new Map<string, typeof edges.value>()
  for (const edge of edges.value) {
    const list = map.get(edge.source)
    if (list) list.push(edge)
    else map.set(edge.source, [edge])
  }
  return map
})

/**
 * `targetId::edgeType` → 落在该节点的同类边。
 *
 * 边组件要把自己的序号（第几根提示词线 / 第几张参考图）画在线上，
 * 而序号取决于同类边的顺序。索引里按插入顺序 push，与 edges 的原始顺序一致，
 * 所以取出来的顺序也就是渲染顺序。
 */
export const inboundEdgesByTargetType = computed(() => {
  const map = new Map<string, typeof edges.value>()
  for (const edge of edges.value) {
    const key = `${edge.target}::${edge.type || 'default'}`
    const list = map.get(key)
    if (list) list.push(edge)
    else map.set(key, [edge])
  }
  return map
})

/** 取某个节点的入边；没有则返回空数组（不是 undefined，省掉调用方的判空） */
export const readInboundEdges = (nodeId: string) => inboundEdges.value.get(nodeId) || []

/** 取某个节点某类边里的序号（从 1 开始）；找不到时返回 1，与原实现一致 */
export const readEdgeOrder = (edgeId: string, targetId: string, edgeType: string) => {
  const list = inboundEdgesByTargetType.value.get(`${targetId}::${edgeType}`) || []
  const index = list.findIndex(edge => edge.id === edgeId)
  return index >= 0 ? index + 1 : 1
}
