<script setup lang="ts">
/**
 * 编组框节点（对齐 SceneFlow 的 CanvasNodeType.Group）
 *
 * 它跟其它四类节点有本质区别：不产内容、不连边、没有卡片内容 —— 只是在**底层**
 * 画一个框，把一组节点框在一起。框的 zIndex 由 index.vue 压到最低（GROUP_NODE_Z_INDEX），
 * 所以它永远在子节点下面，不会挡住子节点的点击与拖拽。
 *
 * 拖动框带走子节点由 index.vue 的 onNodeDrag 处理（子节点是画布绝对坐标，
 * 不是 Vue Flow 的父子节点 —— 这样拆组后子节点原地保留，不必反算相对坐标）。
 */

import { computed } from 'vue'
import {
  GROUP_MIN_SIZE,
  expandGroupChildIds,
  nodes,
  type WorkflowGroupNodeData,
} from '../../composables/useWorkflowCanvas'

const props = defineProps<{
  id: string
  data: WorkflowGroupNodeData
  selected?: boolean
}>()

const frameWidth = computed(() => Math.max(GROUP_MIN_SIZE, Number(props.data?.groupWidth) || 0))
const frameHeight = computed(() => Math.max(GROUP_MIN_SIZE, Number(props.data?.groupHeight) || 0))
const title = computed(() => String(props.data?.label || '编组'))
/** 实时统计框内还有几个节点：子节点可能已被删除，用当前画布算而不是信任存下来的名单长度 */
const childCount = computed(() => expandGroupChildIds(nodes.value, props.id).length)
</script>

<template>
  <div
    class="group-node"
    :class="{ 'is-selected': selected }"
    :style="{ width: `${frameWidth}px`, height: `${frameHeight}px` }"
  >
    <div class="group-node__label">
      <span class="group-node__name">{{ title }}</span>
      <span class="group-node__count">{{ childCount }} 个节点</span>
    </div>
  </div>
</template>

<style scoped>
.group-node {
  position: relative;
  box-sizing: border-box;
  border: 1px dashed var(--canvas-node-border);
  border-radius: var(--lv-border-radius-large);
  /* 透明填充：框内空处仍能看到画布背景点阵，不像一块实心面板 */
  background: transparent;
  transition: border-color 0.16s ease;
}

.group-node.is-selected {
  border-color: var(--canvas-node-border-selected);
}

.group-node__label {
  position: absolute;
  top: 8px;
  left: 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: var(--lv-border-radius-small);
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur, 8px));
  -webkit-backdrop-filter: blur(var(--canvas-float-backdrop-blur, 8px));
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}

.group-node__name {
  color: var(--text-primary);
  font-weight: 500;
}

.group-node__count {
  color: var(--text-tertiary);
}
</style>
