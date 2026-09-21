<script setup lang="ts">
/**
 * 局部重绘：涂抹要修改的区域 + 写一句改动要求
 *
 * 输出两份东西：
 *   1. 蒙版 PNG —— 按**原图分辨率**导出，未涂抹处不透明、涂抹处完全透明。
 *      透明 = 允许重绘（这是上游的约定，实测生效：圆内改动量是圆外的 3.9 倍）。
 *   2. 用户写的改动要求（提示词）。
 *
 * 为什么在显示层画「半透明红」而不是直接画黑色：用户需要看见自己涂了哪儿，
 * 真正给上游的蒙版在确认时用同一批笔画、按原图尺寸重画一遍（见 exportMask）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  modelValue: boolean
  src: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm', payload: { mask: Blob; prompt: string }): void
}>()

const innerVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 一笔 = 一条归一化坐标的折线（x/y 都是 0~1，与图片显示尺寸无关） */
interface Stroke {
  radius: number
  points: Array<{ x: number; y: number }>
}

const strokes = ref<Stroke[]>([])
const brushSize = ref(48)
const instruction = ref('')
const previewCanvasRef = ref<HTMLCanvasElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
const naturalSize = ref({ width: 0, height: 0 })
const submitting = ref(false)

const hasStroke = computed(() => strokes.value.length > 0)

const reset = () => {
  strokes.value = []
  instruction.value = ''
  naturalSize.value = { width: 0, height: 0 }
}

watch(() => props.modelValue, (visible) => {
  if (visible) reset()
})

const onImageLoad = () => {
  const img = imgRef.value
  if (!img) return
  naturalSize.value = { width: img.naturalWidth, height: img.naturalHeight }
  syncPreviewCanvas()
  redrawPreview()
}

/** 预览画布与图片显示尺寸对齐（含 devicePixelRatio，避免涂抹边缘发虚） */
const syncPreviewCanvas = () => {
  const img = imgRef.value
  const canvas = previewCanvasRef.value
  if (!img || !canvas) return
  const rect = img.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
}

const redrawPreview = () => {
  const canvas = previewCanvasRef.value
  const img = imgRef.value
  if (!canvas || !img) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const rect = img.getBoundingClientRect()
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(255, 64, 64, 0.45)'
  ctx.strokeStyle = 'rgba(255, 64, 64, 0.45)'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const stroke of strokes.value) {
    // 半径按"相对图宽的比例"存，所以这里乘以显示宽度即可
    const radiusPx = stroke.radius * rect.width
    ctx.lineWidth = radiusPx * 2
    if (stroke.points.length === 1) {
      const p = stroke.points[0]
      ctx.beginPath()
      ctx.arc(p.x * rect.width, p.y * rect.height, radiusPx, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    stroke.points.forEach((p, index) => {
      const x = p.x * rect.width
      const y = p.y * rect.height
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
}

let drawing = false
const current = ref<Stroke | null>(null)

const toNormalized = (event: PointerEvent) => {
  const img = imgRef.value
  if (!img) return null
  const rect = img.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  }
}

const onPointerDown = (event: PointerEvent) => {
  const point = toNormalized(event)
  if (!point) return
  drawing = true
  current.value = { radius: brushSize.value / 2 / (naturalSize.value.width || 1024), points: [point] }
  strokes.value = [...strokes.value, current.value]
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  redrawPreview()
  event.preventDefault()
}

const onPointerMove = (event: PointerEvent) => {
  if (!drawing || !current.value) return
  const point = toNormalized(event)
  if (!point) return
  current.value.points.push(point)
  redrawPreview()
}

const onPointerUp = (event: PointerEvent) => {
  if (!drawing) return
  drawing = false
  current.value = null
  ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
}

const undo = () => {
  strokes.value = strokes.value.slice(0, -1)
  redrawPreview()
}

const clearAll = () => {
  strokes.value = []
  redrawPreview()
}

/**
 * 导出蒙版：按原图分辨率重画一遍笔画。
 * 未涂抹 = 不透明（保留），涂抹 = 完全透明（可重绘）—— 用 destination-out 打洞实现。
 */
const exportMask = async (): Promise<Blob> => {
  const { width, height } = naturalSize.value
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas')

  // 先铺满不透明，再用 destination-out 把涂抹处擦成透明
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const stroke of strokes.value) {
    const radiusPx = stroke.radius * width
    ctx.lineWidth = radiusPx * 2
    if (stroke.points.length === 1) {
      const p = stroke.points[0]
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, radiusPx, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    stroke.points.forEach((p, index) => {
      const x = p.x * width
      const y = p.y * height
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('蒙版导出失败')
  return blob
}

const confirm = async () => {
  if (!hasStroke.value) {
    ElMessage.info('先用画笔涂抹要修改的区域')
    return
  }
  if (!instruction.value.trim()) {
    ElMessage.info('再写一句要改成什么')
    return
  }

  submitting.value = true
  try {
    const mask = await exportMask()
    emit('confirm', { mask, prompt: instruction.value.trim() })
    innerVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '蒙版导出失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="innerVisible"
    title="编辑元素（局部重绘）"
    width="760px"
    align-center
    :close-on-click-modal="false"
    append-to-body
    @opened="syncPreviewCanvas"
  >
    <div class="mask-toolbar">
      <span class="mask-toolbar__label">画笔</span>
      <el-slider v-model="brushSize" :min="8" :max="200" :step="4" class="mask-toolbar__slider" />
      <span class="mask-toolbar__size">{{ brushSize }}px</span>
      <button type="button" class="mask-btn" :disabled="!hasStroke" @click="undo">撤销一笔</button>
      <button type="button" class="mask-btn" :disabled="!hasStroke" @click="clearAll">清空</button>
      <span class="mask-toolbar__hint">
        {{ naturalSize.width ? `原图 ${naturalSize.width} × ${naturalSize.height}` : '加载中…' }}
      </span>
    </div>

    <div class="mask-stage">
      <img
        ref="imgRef"
        :src="src"
        alt="待编辑图片"
        class="mask-image"
        draggable="false"
        @load="onImageLoad"
      />
      <canvas
        ref="previewCanvasRef"
        class="mask-preview"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>

    <el-input
      v-model="instruction"
      type="textarea"
      :rows="2"
      maxlength="200"
      show-word-limit
      placeholder="涂抹区域要改成什么？例如：把这里换成一只白色的陶瓷杯"
      class="mask-instruction"
    />

    <template #footer>
      <button type="button" class="mask-btn" @click="innerVisible = false">取消</button>
      <button type="button" class="mask-btn is-primary" :disabled="submitting" @click="confirm">
        {{ submitting ? '处理中…' : '重绘并生成新节点' }}
      </button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mask-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.mask-toolbar__label {
  color: var(--text-secondary);
  font-size: 12px;
}
.mask-toolbar__slider {
  width: 180px;
}
.mask-toolbar__size {
  color: var(--text-tertiary);
  font-size: 12px;
  min-width: 44px;
}
.mask-toolbar__hint {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

.mask-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  user-select: none;
  touch-action: none;
}
.mask-image {
  display: block;
  max-width: 100%;
  max-height: 56vh;
  border-radius: 6px;
  pointer-events: none;
}
.mask-preview {
  position: absolute;
  left: 0;
  top: 0;
  cursor: crosshair;
}

.mask-instruction {
  margin-top: 12px;
}

.mask-btn {
  height: 30px;
  padding: 0 14px;
  background: transparent;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.mask-btn.is-primary {
  background: var(--brand-main-default);
  border-color: var(--brand-main-default);
  color: #fff;
}
.mask-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
