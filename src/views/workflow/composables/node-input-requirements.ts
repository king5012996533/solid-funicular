/**
 * 节点输入需求 —— 读取画布状态的薄包装
 *
 * 规则全在 config/node-input-rules.ts（纯函数、可单测）；
 * 这里只做一件事：把 Vue 的响应式 `nodes` / `edges` 喂给纯函数，
 * 让节点组件能直接 `describeNodeInputs(props.id)` 拿到当前状态。
 */

import { computed, type ComputedRef } from 'vue'
import { edges, nodes, type WorkflowNodeType } from './useWorkflowCanvas'
import {
  NODE_INPUT_SPECS,
  collectUpstreamKinds,
  deriveNodeInputState,
  type NodeInputState,
} from '../config/node-input-rules'

export * from '../config/node-input-rules'

/**
 * 某个节点当前的输入状态（响应式）。
 *
 * 用 computed 而不是普通函数：节点模板里会直接读它，
 * 上游出图、连线增删都要能立刻反映到文案上。
 */
export const useNodeInputState = (nodeId: () => string): ComputedRef<NodeInputState> =>
  computed(() => {
    const id = nodeId()
    const node = nodes.value.find((item) => item.id === id)
    const spec = NODE_INPUT_SPECS[(node?.type as WorkflowNodeType) || 'text'] || NODE_INPUT_SPECS.text
    const kinds = collectUpstreamKinds(
      nodes.value as unknown as Parameters<typeof collectUpstreamKinds>[0],
      edges.value as unknown as Parameters<typeof collectUpstreamKinds>[1],
      id,
    )
    return deriveNodeInputState(spec, kinds)
  })
