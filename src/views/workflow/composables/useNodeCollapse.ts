/**
 * 节点折叠
 *
 * 对齐 LibTV：节点标题前有个 ▶，点一下收起卡片主体，只留标题与一行摘要。
 * 节点一多，折叠是最主要的降噪手段。
 *
 * 折叠状态存在节点 data 上（而不是组件局部 ref），原因有三个：
 *   1. 它是画布形态的一部分，要跟画布一起保存
 *   2. 要能撤销（撤销栈监听的是 nodes 数组）
 *   3. 复制节点时应该跟着一起复制
 */

import { computed, nextTick } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { updateNode } from './useWorkflowCanvas'
import { nodeIndex } from './workflow-graph-index'

export const useNodeCollapse = (nodeId: () => string) => {
  const { updateNodeInternals } = useVueFlow()

  const collapsed = computed(() => {
    const node = nodeIndex.value.get(nodeId())
    return Boolean((node?.data as { collapsed?: boolean } | undefined)?.collapsed)
  })

  const toggleCollapse = () => {
    const id = nodeId()
    updateNode(id, { collapsed: !collapsed.value })
    // 卡片高度变了，必须让 Vue Flow 重新量一次节点尺寸，
    // 否则连线仍然按折叠前的锚点画，看起来像"线断在半空"
    nextTick(() => updateNodeInternals([id]))
  }

  return { collapsed, toggleCollapse }
}
