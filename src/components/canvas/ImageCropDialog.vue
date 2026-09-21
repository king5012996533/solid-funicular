<script setup lang="ts">
/**
 * 图片裁剪对话框（纯前端，不调上游）
 *
 * 为什么自己画而不是用三方裁剪库：只为一个裁剪拉一个依赖不值当，而且
 * 需要的只是"框 + 8 个把手 + 比例预设"，几何计算全部在
 * `config/crop-geometry.ts` 里（纯函数、有单测），这里只负责鼠标事件与渲染。
 *
 * 输出：confirm 事件带一个 PNG Blob（按**原图分辨率**裁剪，不是屏幕上看到的缩放尺寸）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  applyAspect,
  cropToPixels,
  dragRect,
  type CropHandle,
  type CropRect,
} from '@/views/workflow/config/crop-geometry'

const props = defineProps<{
  modelValue: boolean
  src: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm', blob: Blob): void
}>()

const innerVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 比例预设：null = 自由 */
const ASPECTS: Array<{ key: string; label: string; ratio: number | null }> = [
  { key: 'free', label: '自由', ratio: null },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
]

const aspectKey = ref('free')
const activeRatio = computed(() => ASPECTS.find(item => item.key === aspectKey.value)?.ratio ?? null)

const rect = ref<CropRect>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 })
const stageRef = ref<HTMLElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
const naturalSize = ref({ width: 0, height: 0 })
const submitting = ref(false)

// 每次打开都重置：上一次的框留着会让人以为这是"记住的默认值"
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  rect.value = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
  aspectKey.value = 'free'
  naturalSize.value = { width: 0, height: 0 }
})

const onImageLoad = () => {
  const img = imgRef.value
  if (!img) return
  naturalSize.value = { width: img.naturalWidth, height: img.naturalHeight }
}

const selectAspect = (key: string, ratio: number | null) => {
  aspectKey.value = key
  rect.value = applyAspect(rect.value, ratio)
}

/** 屏幕上这根框的位置（百分比，跟着图片显示尺寸走） */
const boxStyle = computed(() => ({
  left: `${rect.value.x * 100}%`,
  top: `${rect.value.y * 100}%`,
  width: `${rect.value.width * 100}%`,
  height: `${rect.value.height * 100}%`,
}))

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

let dragState: {
  handle: CropHandle
  startX: number
  startY: number
  startRect: CropRect
  stageWidth: number
  stageHeight: number
} | null = null

const beginDrag = (event: PointerEvent, handle: CropHandle) => {
  const stage = stageRef.value
  if (!stage) return
  const bounds = stage.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return

  dragState = {
    handle,
    startX: event.clientX,
    startY: event.clientY,
    startRect: { ...rect.value },
    stageWidth: bounds.width,
    stageHeight: bounds.height,
  }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  event.preventDefault()
  event.stopPropagation()
}

const onPointerMove = (event: PointerEvent) => {
  if (!dragState) return
  const dx = (event.clientX - dragState.startX) / dragState.stageWidth
  const dy = (event.clientY - dragState.startY) / dragState.stageHeight
  rect.value = dragRect(dragState.startRect, dragState.handle, dx, dy, activeRatio.value)
}

const endDrag = (event: PointerEvent) => {
  if (!dragState) return
  ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
  dragState = null
}

const confirm = async () => {
  const img = imgRef.value
  if (!img || !naturalSize.value.width || !naturalSize.value.height) {
    ElMessage.info('图片还没加载完')
    return
  }

  submitting.value = true
  try {
    const { sx, sy, sw, sh } = cropToPixels(rect.value, naturalSize.value.width, naturalSize.value.height)
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持 canvas 裁剪')
    // 用原图画，保证输出是原分辨率而不是屏幕上的缩放尺寸
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('裁剪结果导出失败')
    emit('confirm', blob)
    innerVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '裁剪失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="innerVisible"
    title="裁剪图片"
    width="720px"
    align-center
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="crop-aspects">
      <button
        v-for="item in ASPECTS"
        :key="item.key"
        type="button"
        class="crop-aspect-btn"
        :class="{ 'is-active': aspectKey === item.key }"
        @click="selectAspect(item.key, item.ratio)"
      >
        {{ item.label }}
      </button>
      <span class="crop-size-hint">
        {{ naturalSize.width && naturalSize.height
          ? `原图 ${naturalSize.width} × ${naturalSize.height}`
          : '加载中…' }}
      </span>
    </div>

    <div
      ref="stageRef"
      class="crop-stage"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <img
        ref="imgRef"
        :src="src"
        alt="待裁剪图片"
        class="crop-image"
        draggable="false"
        @load="onImageLoad"
      />
      <!-- 裁剪框：本身可拖动，8 个把手各自拖动对应边/角 -->
      <div class="crop-box" :style="boxStyle" @pointerdown="beginDrag($event, 'move')">
        <div
          v-for="handle in HANDLES"
          :key="handle"
          class="crop-handle"
          :class="`is-${handle}`"
          @pointerdown="beginDrag($event, handle)"
        />
      </div>
    </div>

    <template #footer>
      <button type="button" class="crop-btn" @click="innerVisible = false">取消</button>
      <button type="button" class="crop-btn is-primary" :disabled="submitting" @click="confirm">
        {{ submitting ? '处理中…' : '裁剪并生成新节点' }}
      </button>
    </template>
  </el-dialog>
</template>

<style scoped>
.crop-aspects {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}
.crop-aspect-btn {
  height: 26px;
  padding: 0 10px;
  background: var(--bg-block-secondary, transparent);
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.crop-aspect-btn:hover {
  color: var(--text-primary);
}
.crop-aspect-btn.is-active {
  border-color: var(--brand-main-default);
  color: var(--brand-main-default);
}
.crop-size-hint {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

.crop-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  /* 裁剪框要能拖出图外，所以舞台自己不能裁切；拖动靠几何夹取兜底 */
  user-select: none;
  touch-action: none;
}
.crop-image {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  border-radius: 6px;
  pointer-events: none;
}

.crop-box {
  position: absolute;
  border: 1px solid var(--brand-main-default);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  cursor: move;
}
.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 1px solid var(--brand-main-default);
  border-radius: 2px;
}
.crop-handle.is-nw { left: -5px; top: -5px; cursor: nwse-resize; }
.crop-handle.is-n  { left: calc(50% - 5px); top: -5px; cursor: ns-resize; }
.crop-handle.is-ne { right: -5px; top: -5px; cursor: nesw-resize; }
.crop-handle.is-e  { right: -5px; top: calc(50% - 5px); cursor: ew-resize; }
.crop-handle.is-se { right: -5px; bottom: -5px; cursor: nwse-resize; }
.crop-handle.is-s  { left: calc(50% - 5px); bottom: -5px; cursor: ns-resize; }
.crop-handle.is-sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
.crop-handle.is-w  { left: -5px; top: calc(50% - 5px); cursor: ew-resize; }

.crop-btn {
  height: 30px;
  padding: 0 14px;
  background: transparent;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.crop-btn.is-primary {
  background: var(--brand-main-default);
  border-color: var(--brand-main-default);
  color: #fff;
}
.crop-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
