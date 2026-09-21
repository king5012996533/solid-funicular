<script setup lang="ts">
/**
 * 画布小地图（包装 @vue-flow/minimap）
 *
 * 加位置、开关、节点颜色映射（按 type 取 lv-theme brand 色）。
 * 默认位置：bottom-24 left-6，240×160。
 */
import { MiniMap } from '@vue-flow/minimap'
import type { Node } from '@vue-flow/core'
import { ref } from 'vue'

defineProps<{
  visible: boolean
}>()

const wrapperRef = ref<HTMLElement | null>(null)

/** 从画布作用域读取 token —— 画布配色定义在 .workflow-container 上，body 上取不到 */
const readToken = (name: string): string => {
  const el = wrapperRef.value
  if (!el || typeof window === 'undefined') return ''
  return getComputedStyle(el).getPropertyValue(name).trim()
}

/** 根据节点类型映射小色块颜色（全部走 token，与设计文档对照） */
const nodeColor = (node: Node) => {
  switch (node.type) {
    case 'image':
      return readToken('--brand-image') || readToken('--brand-main-default')
    case 'video':
      return readToken('--brand-video') || readToken('--brand-main-default')
    case 'llmConfig':
      return readToken('--brand-main-default') || readToken('--text-secondary')
    default:
      return readToken('--text-tertiary') || readToken('--text-primary')
  }
}
</script>

<template>
  <Transition name="canvas-minimap">
    <div v-if="visible" ref="wrapperRef" class="canvas-minimap-wrapper" data-canvas-no-zoom @click.stop>
      <MiniMap
        position="bottom-left"
        :pannable="true"
        :zoomable="true"
        :node-color="nodeColor"
        :node-stroke-width="2"
      />
    </div>
  </Transition>
</template>

<style scoped>
.canvas-minimap-wrapper {
  position: absolute;
  left: 24px;
  bottom: 96px;
  width: 240px;
  height: 160px;
  z-index: 49;
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  overflow: hidden;
  pointer-events: auto;
}

/** Vue Flow MiniMap 内部根容器适配玻璃风 */
.canvas-minimap-wrapper :deep(.vue-flow__minimap) {
  position: absolute;
  inset: 0;
  margin: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

/** 视口外的遮罩：走 token（SVG 表现属性会被这里的 CSS 覆盖） */
.canvas-minimap-wrapper :deep(.vue-flow__minimap-mask) {
  fill: var(--canvas-bg-block-default);
}

.canvas-minimap-enter-active,
.canvas-minimap-leave-active {
  transition: opacity 0.16s, transform 0.16s;
}
.canvas-minimap-enter-from,
.canvas-minimap-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}
</style>
