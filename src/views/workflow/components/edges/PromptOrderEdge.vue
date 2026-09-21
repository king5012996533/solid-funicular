<script setup lang="ts">
/**
 * 提示词顺序边 - 显示序号标签，点击可切换顺序
 */
import { ref, computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useVueFlow } from '@vue-flow/core'
import { inboundEdgesByTargetType } from '../../composables/workflow-graph-index'
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
  data?: { promptOrder?: number }
  markerEnd?: string
  style?: Record<string, unknown>
  selected?: boolean
}>()

const showMenu = ref(false)
const isHover = ref(false)

onEdgeMouseEnter(({ edge }) => { if (edge.id === props.id) isHover.value = true })
onEdgeMouseLeave(({ edge }) => { if (edge.id === props.id) isHover.value = false })

const orderLabels = [
  { label: '① 第一个', key: 1 },
  { label: '② 第二个', key: 2 },
  { label: '③ 第三个', key: 3 },
  { label: '④ 第四个', key: 4 },
  { label: '⑤ 第五个', key: 5 }
]

const orderOptions = computed(() => {
  // 走共享索引：原先每条边组件都要遍历整个 edges（950 条边时就是每帧 90 万次操作），
  // 这是画布在节点多时掉帧的主因
  const count = (inboundEdgesByTargetType.value.get(`${props.target}::${'promptOrder'}`) || []).length || 1
  return orderLabels.slice(0, count)
})

const currentOrder = computed(() => props.data?.promptOrder || 1)

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

const readPromptOrder = (data: unknown) => (data && typeof data === 'object' && 'promptOrder' in data
  ? Number((data as { promptOrder?: number }).promptOrder) || 1
  : 1)

const handleSelect = (newOrder: number) => {
  const sameEdges = inboundEdgesByTargetType.value.get(`${props.target}::${'promptOrder'}`) || []
  const conflict = sameEdges.find(e => e.id !== props.id && readPromptOrder(e.data) === newOrder)
  if (conflict) updateEdgeData(conflict.id, { promptOrder: currentOrder.value })
  updateEdgeData(props.id, { promptOrder: newOrder })
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
        style="width: 24px; height: 24px; border-radius: 50%; background: var(--brand-main-default); color: var(--canvas-workflow-bg); border: 2px solid var(--canvas-bg); font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform 0.15s;"
        @mouseenter="$el.style.transform='scale(1.15)'" @mouseleave="$el.style.transform='scale(1)'"
      >{{ currentOrder }}</button>
      <EdgeDeleteButton :edge-id="id" :visible="isHover" />
      <div v-if="showMenu" style="position: absolute; top: 28px; left: 50%; transform: translateX(-50%); background: var(--canvas-float-block-default); backdrop-filter: blur(20px); border: 1px solid var(--stroke-secondary); border-radius: 8px; padding: 4px; z-index: 100; min-width: 100px;">
        <div
          v-for="opt in orderOptions" :key="opt.key"
          @click="handleSelect(opt.key)"
          style="padding: 6px 10px; font-size: 12px; color: var(--text-primary); border-radius: 6px; cursor: pointer; white-space: nowrap;"
          @mouseenter="$el.style.background='var(--bg-block-primary-hover)'" @mouseleave="$el.style.background='transparent'"
        >{{ opt.label }}</div>
      </div>
    </div>
  </EdgeLabelRenderer>
</template>
