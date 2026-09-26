/**
 * Agent 画布动作高亮的响应式单例（批次 3「画布动作可视化」）。
 *
 * 职责很窄：把 `agent-active-nodes-state.ts` 里的纯状态迁移接到一个**模块级 ref** 上，
 * 供节点组件（读）与工具桥（写）共用。状态本身是纯 UI 的瞬时量 ——
 * **不进 node.data、不进 nodesJson、不进快照/版本、也不进会话/转录**（见纯逻辑模块头注释）。
 *
 * 清理是这个模块最要紧的事（留一个「永远发光」的节点比不做高亮更糟），出口有四个：
 *   1. 刚创建 → TTL 到期自动清（只清 created，不碰 generating）；
 *   2. 生成中 → 该节点生成终态（节点组件 watch loading=false）或**回合结束**时清；
 *   3. 切换画布/切会话/组件卸载 → resetAgentActiveNodes() 全清并取消所有定时器；
 *   4. 节点被删除/卸载 → clearAgentActiveNodesForIds()。
 */
import { ref } from 'vue'
import {
  AGENT_CREATED_TTL_MS,
  agentStaggerDelayMs,
  clearAgentCreatedNodes as clearCreatedState,
  clearAgentGeneratingNodes as clearGeneratingState,
  clearAgentNodesForIds as clearStateForIds,
  createAgentActiveNodesState,
  isAgentCreated as isCreatedState,
  isAgentGenerating as isGeneratingState,
  markAgentCreatedNodes as markCreatedState,
  markAgentGeneratingNodes as markGeneratingState,
  normalizeAgentNodeIds,
  resolveAgentNodeMarks,
  type AgentActiveNodesState,
} from './agent-active-nodes-state'

/** 模块级单例：整个页面（画布 + 助手面板）共用一份高亮状态 */
const state = ref<AgentActiveNodesState>(createAgentActiveNodesState())

/** 「刚创建」的 TTL 定时器：id → timer；重置/清除时必须一并取消，否则会误删新一轮的同 id */
const ttlTimers = new Map<string, ReturnType<typeof setTimeout>>()

const applyState = (next: AgentActiveNodesState) => {
  if (next !== state.value) state.value = next
}

const cancelTtlTimer = (id: string) => {
  const timer = ttlTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    ttlTimers.delete(id)
  }
}

const cancelAllTtlTimers = () => {
  for (const timer of ttlTimers.values()) clearTimeout(timer)
  ttlTimers.clear()
}

/** 标记「刚创建」：错开点亮 + TTL 后自动清除（只清 created，绝不碰 generating） */
export const markAgentCreatedNodes = (
  ids: readonly string[],
  ttlMs = AGENT_CREATED_TTL_MS,
): void => {
  const clean = normalizeAgentNodeIds(ids)
  if (!clean.length) return
  applyState(markCreatedState(state.value, clean, { now: Date.now(), ttlMs }))
  for (const id of clean) {
    cancelTtlTimer(id)
    ttlTimers.set(
      id,
      setTimeout(() => {
        ttlTimers.delete(id)
        applyState(clearCreatedState(state.value, [id]))
      }, ttlMs),
    )
  }
}

/** 标记「生成中」：无 TTL；同 id 若还挂着「刚创建」，一并收掉（避免两个高亮样式打架） */
export const markAgentGeneratingNodes = (ids: readonly string[]): void => {
  const clean = normalizeAgentNodeIds(ids)
  if (!clean.length) return
  applyState(clearCreatedState(state.value, clean))
  for (const id of clean) cancelTtlTimer(id)
  applyState(markGeneratingState(state.value, clean))
}

/** 清「生成中」：给 id 清指定节点（生成终态），不给就全清（回合结束） */
export const clearAgentGeneratingNodes = (ids?: readonly string[]): void => {
  applyState(clearGeneratingState(state.value, ids))
}

/** 把某几个 id 的高亮全收掉（节点被删除/组件卸载） */
export const clearAgentActiveNodesForIds = (ids: readonly string[]): void => {
  const clean = normalizeAgentNodeIds(ids)
  if (!clean.length) return
  for (const id of clean) cancelTtlTimer(id)
  applyState(clearStateForIds(state.value, clean))
}

/** 全清并取消所有定时器：新一轮开始、切换画布/会话、面板卸载时调用 */
export const resetAgentActiveNodes = (): void => {
  cancelAllTtlTimers()
  applyState(createAgentActiveNodesState())
}

/**
 * 工具回执 → 高亮动作。
 *
 * 由客户端工具桥在每次工具执行完调用（它手里才有刚创建/刚提交的真实 id 与回执）。
 * 只认成功项（见 resolveAgentNodeMarks），失败不回执高点。
 */
export const applyAgentToolMarks = (
  toolName: string,
  resultText: string | undefined,
): void => {
  const marks = resolveAgentNodeMarks(toolName, resultText)
  if (marks.created.length) markAgentCreatedNodes(marks.created)
  if (marks.generating.length) markAgentGeneratingNodes(marks.generating)
  if (marks.cleared.length) clearAgentActiveNodesForIds(marks.cleared)
}

/**
 * 节点组件用的只读句柄。
 *
 * 返回的函数在读 `state.value` 时会建立响应式依赖，所以放进 computed/模板里即可自动重渲染。
 */
export const useAgentActiveNodes = () => ({
  isAgentCreated: (id: string): boolean => isCreatedState(state.value, id, Date.now()),
  isAgentGenerating: (id: string): boolean => isGeneratingState(state.value, id),
  staggerDelayMs: (id: string): number => agentStaggerDelayMs(state.value, id),
})
