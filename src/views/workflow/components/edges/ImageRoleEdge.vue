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
 * 图片角色边 - 首帧/尾帧/参考图选择
 */
import { ref, computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useVueFlow } from '@vue-flow/core'
import { edges } from '../../composables/useWorkflowCanvas'
import EdgeDeleteButton from '../EdgeDeleteButton.vue'

const { updateEdgeData, onEdgeMouseEnter, onEdgeMouseLeave } = useVueFlow()

const props = defineProps<{
  id: string
  source?: string
  target?: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: any
  targetPosition: any
  data?: { imageRole?: string }
  markerEnd?: string
  style?: Record<string, unknown>
  selected?: boolean
}>()

const showMenu = ref(false)
const isHover = ref(false)

onEdgeMouseEnter(({ edge }) => { if (edge.id === props.id) isHover.value = true })
onEdgeMouseLeave(({ edge }) => { if (edge.id === props.id) isHover.value = false })

const roleOptions = [
  { label: '首帧', key: 'first_frame_image' },
  { label: '尾帧', key: 'last_frame_image' },
  { label: '参考图', key: 'input_reference' }
]

const currentRole = computed(() => props.data?.imageRole || 'first_frame_image')
const currentRoleLabel = computed(() => roleOptions.find(o => o.key === currentRole.value)?.label || '首帧')

const path = computed(() => {
  const [p] = getBezierPath({ sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY, sourcePosition: props.sourcePosition, targetPosition: props.targetPosition })
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

const readImageRole = (data: unknown) => (data && typeof data === 'object' && 'imageRole' in data
  ? String((data as { imageRole?: string }).imageRole || 'first_frame_image')
  : 'first_frame_image')

const handleSelect = (role: string) => {
  if (role === 'first_frame_image' || role === 'last_frame_image') {
    edges.value
      .filter(e => e.target === props.target && e.id !== props.id && readImageRole(e.data) === role)
      .forEach(e => {
        updateEdgeData(e.id, { imageRole: role === 'first_frame_image' ? 'last_frame_image' : 'first_frame_image' })
      })
  }
  updateEdgeData(props.id, { imageRole: role })
  showMenu.value = false
}
</script>

<template>
  <BaseEdge :path="path" :style="edgeStyle" />
  <EdgeLabelRenderer>
    <div
      :style="{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }"
      class="nodrag nopan"
      @mouseenter="isHover = true"
      @mouseleave="isHover = false"
    >
      <button
        @click="showMenu = !showMenu"
        style="padding: 3px 10px; border-radius: 8px; background: var(--canvas-float-block-default); backdrop-filter: blur(20px); border: 1px solid var(--stroke-secondary); color: var(--text-primary); font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: transform 0.15s;"
        @mouseenter="$el.style.transform='scale(1.05)'" @mouseleave="$el.style.transform='scale(1)'"
      >
        {{ currentRoleLabel }}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <EdgeDeleteButton :edge-id="id" :visible="isHover" />
      <div v-if="showMenu" style="position: absolute; top: 28px; left: 50%; transform: translateX(-50%); background: var(--canvas-float-block-default); backdrop-filter: blur(20px); border: 1px solid var(--stroke-secondary); border-radius: 8px; padding: 4px; z-index: 100; min-width: 80px;">
        <div
          v-for="opt in roleOptions" :key="opt.key"
          @click="handleSelect(opt.key)"
          style="padding: 6px 10px; font-size: 12px; color: var(--text-primary); border-radius: 6px; cursor: pointer; white-space: nowrap;"
          @mouseenter="$el.style.background='var(--bg-block-primary-hover)'" @mouseleave="$el.style.background='transparent'"
        >{{ opt.label }}</div>
      </div>
    </div>
  </EdgeLabelRenderer>
</template>
