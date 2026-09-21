/**
 * 工作流执行辅助工具
 * 统一管理 watcher、超时等待与节点完成判定逻辑。
 *
 * 改造说明：以前是两段等待 —— 先等「配置节点」把 executed 置位并吐出 outputNodeId，
 * 再等它产出的那个图片节点拿到 url。现在生成节点自己就是产出节点，
 * 两段合并成一次 waitForNodeReady，少一次 watch、少一个中间状态。
 */

import { watch } from 'vue'
import { nodes, type WorkflowCanvasNode } from './useWorkflowCanvas'

type WorkflowWatcherStop = () => void

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000

type OutputNode = WorkflowCanvasNode<'image' | 'video'>

const hasNodeOutputUrl = (
  node: WorkflowCanvasNode,
): node is OutputNode => 'url' in node.data && typeof node.data.url === 'string'

/**
 * 等待某个生成节点产出结果。
 * 判定顺序：先看错误 → 再看是否已有 url 且不在 loading —— 与节点自身状态机一致。
 */
export const clearWorkflowWatchers = (activeWatchers: WorkflowWatcherStop[]) => {
  activeWatchers.forEach((stop) => stop())
  activeWatchers.length = 0
}

export const waitForWorkflowNodeReady = (
  nodeId: string,
  activeWatchers: WorkflowWatcherStop[],
) => {
  return new Promise<WorkflowCanvasNode>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('执行超时')), EXECUTION_TIMEOUT_MS)
    let stopWatcher: WorkflowWatcherStop | null = null

    const checkNode = (node?: WorkflowCanvasNode) => {
      if (!node) return false
      if (node.data?.error) {
        clearTimeout(timeout)
        stopWatcher?.()
        reject(new Error(node.data.error))
        return true
      }
      if (hasNodeOutputUrl(node) && node.data.url && !node.data.loading) {
        clearTimeout(timeout)
        stopWatcher?.()
        resolve(node)
        return true
      }
      return false
    }

    const node = nodes.value.find((item) => item.id === nodeId)
    if (checkNode(node)) return

    stopWatcher = watch(
      () => nodes.value.find((item) => item.id === nodeId),
      (node) => checkNode(node),
      { deep: true },
    )
    activeWatchers.push(stopWatcher)
  })
}
