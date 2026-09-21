<script setup lang="ts">
/**
 * inheritAttrs: false
 *
 * Vue Flow 会给自定义边组件传入一批内部属性（sourceNode / targetNode / type /
 * updatable / animated …）。我们不需要把它们透传到根 DOM，但如果不声明为 props，
 * Vue 会把它们归为「外部属性」并**每次渲染都警告一次**
 * （[Vue warn]: Extraneous non-props attributes）。
 *
 * 这条警告的代价不小：Vue 的 warn 内部会调 getComponentTrace() 遍历组件栈、
 * 格式化调用链。实测 1000 节点的画布拖拽 2 秒内触发 **977 次**，
 * 占拖拽 CPU 的 ~22%（用 CDP 采样测出来的）。
 * DOM 本身是干净的（这些属性没被真正写进去），纯粹是警告的开销。
 *
 * 关掉透传只是明确「本组件不转发未知属性」，不是掩盖问题 ——
 * sourceNode/targetNode 是对象，本来也不可能作为 DOM 属性使用。
 */
defineOptions({ inheritAttrs: false })

/**
 * Vue Flow 默认连线（hover 时中央显示删除按钮）
 *
 * - 贝塞尔路径，hover 时 stroke-width 2 → 3 + drop-shadow
 * - 中点放 EdgeDeleteButton（复用 3 类语义边的删除组件）
 * - 注册到 workflow/index.vue 的 edgeTypes.default
 */
import { computed, ref } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useVueFlow, type Position } from '@vue-flow/core'
import EdgeDeleteButton from '@/views/workflow/components/EdgeDeleteButton.vue'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  selected?: boolean
  style?: Record<string, unknown>
}>()

const { onEdgeMouseEnter, onEdgeMouseLeave } = useVueFlow()
const isHover = ref(false)

onEdgeMouseEnter(({ edge }) => {
  if (edge.id === props.id) isHover.value = true
})
onEdgeMouseLeave(({ edge }) => {
  if (edge.id === props.id) isHover.value = false
})

const path = computed(() => {
  const [p] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  })
  return p
})

const labelX = computed(() => (props.sourceX + props.targetX) / 2)
const labelY = computed(() => (props.sourceY + props.targetY) / 2)

const isActive = computed(() => isHover.value || Boolean(props.selected))

const edgeStyle = computed(() => ({
  stroke: isActive.value ? 'var(--brand-main-default)' : 'var(--text-tertiary)',
  strokeWidth: isActive.value ? 3 : 2,
  transition: 'stroke 0.18s ease-out, stroke-width 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
  ...props.style,
}))
</script>

<template>
  <BaseEdge :path="path" :style="edgeStyle" />
  <EdgeLabelRenderer>
    <div
      :style="{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        pointerEvents: 'all',
      }"
      class="nodrag nopan canvas-default-edge-label"
      @mouseenter="isHover = true"
      @mouseleave="isHover = false"
    >
      <EdgeDeleteButton :edge-id="id" :visible="isHover || selected" />
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
.canvas-default-edge-label {
  width: 22px;
  height: 22px;
}
</style>
