<script setup lang="ts">
/**
 * 画布左下角缩放控件
 *
 * 来自 infinite-canvas/CanvasZoomControls：
 *   小地图开关 / 重置视图 / 缩放滑杆 5–500 / 数字百分比 / 快捷键弹窗
 * 追加：画布外观（弹出 CanvasAppearancePanel） / 清空画布
 */
import { computed, ref } from 'vue'
import { Compass, Aim, MagicStick, Brush } from '@element-plus/icons-vue'
import { useVueFlow } from '@vue-flow/core'
import CanvasAppearancePanel from './CanvasAppearancePanel.vue'

defineProps<{ miniMapOpen: boolean }>()
const emit = defineEmits<{
  (e: 'toggleMiniMap'): void
  (e: 'clear'): void
}>()

const { viewport, zoomTo, fitView } = useVueFlow()

const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100))

const handleSliderInput = (event: Event) => {
  const val = Number((event.target as HTMLInputElement).value)
  zoomTo(val / 100, { duration: 0 })
}

const handleReset = () => {
  fitView({ duration: 200 })
}

/**
 * 缩放档位菜单（对齐 LibTV：点百分比弹出「放大 / 缩小 / 适合屏幕 / 各档位」）。
 *
 * 只放**滑杆量程内**的档位（我们的滑杆是 5–500，LibTV 是 5–800，所以他们最后一档是 800%）。
 * 菜单文案不写快捷键提示 —— 我们没注册 ⌘0 这类快捷键，写了就是假提示。
 */
const ZOOM_PRESETS = [50, 100, 200]

const handleZoomIn = () => zoomTo(Math.min(5, viewport.value.zoom * 1.25), { duration: 150 })
const handleZoomOut = () => zoomTo(Math.max(0.05, viewport.value.zoom / 1.25), { duration: 150 })
const handleZoomTo = (percent: number) => zoomTo(percent / 100, { duration: 150 })

const handleZoomCommand = (command: string | number | object) => {
  const key = String(command)
  if (key === 'in') return handleZoomIn()
  if (key === 'out') return handleZoomOut()
  if (key === 'fit') return handleReset()
  if (key.startsWith('to:')) return handleZoomTo(Number(key.slice(3)))
}

const appearanceOpen = ref(false)
</script>

<template>
  <div class="canvas-zoom-controls" data-canvas-no-zoom @click.stop>
    <button
      type="button"
      class="canvas-zoom-controls__btn"
      :class="{ 'is-active': miniMapOpen }"
      title="小地图"
      @click="emit('toggleMiniMap')"
    >
      <el-icon><Compass /></el-icon>
    </button>
    <button type="button" class="canvas-zoom-controls__btn" title="重置视图" @click="handleReset">
      <el-icon><Aim /></el-icon>
    </button>
    <input
      type="range"
      min="5"
      max="500"
      :value="zoomPercent"
      class="canvas-zoom-controls__slider"
      @input="handleSliderInput"
    />
    <el-dropdown trigger="click" placement="top" @command="handleZoomCommand">
      <button type="button" class="canvas-zoom-controls__percent" title="缩放选项">
        {{ zoomPercent }}%
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="in">放大</el-dropdown-item>
          <el-dropdown-item command="out">缩小</el-dropdown-item>
          <el-dropdown-item command="fit" divided>适合屏幕</el-dropdown-item>
          <el-dropdown-item
            v-for="preset in ZOOM_PRESETS"
            :key="preset"
            :command="`to:${preset}`"
          >
            缩放至 {{ preset }}%
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!-- 分隔线 -->
    <span class="canvas-zoom-controls__divider" aria-hidden="true" />

    <!-- 画布外观（弹出 CanvasAppearancePanel） -->
    <button
      type="button"
      class="canvas-zoom-controls__btn"
      :class="{ 'is-active': appearanceOpen }"
      title="画布外观"
      @click="appearanceOpen = !appearanceOpen"
    >
      <el-icon><MagicStick /></el-icon>
    </button>
    <Transition name="canvas-appearance-pop">
      <div
        v-if="appearanceOpen"
        class="canvas-zoom-controls__appearance"
        @click.stop
      >
        <CanvasAppearancePanel />
      </div>
    </Transition>

    <!-- 清空画布 -->
    <button
      type="button"
      class="canvas-zoom-controls__btn canvas-zoom-controls__btn--danger"
      title="清空画布"
      @click="emit('clear')"
    >
      <el-icon><Brush /></el-icon>
    </button>

    <!-- 快捷键弹窗 -->
<!--    <button type="button" class="canvas-zoom-controls__btn" title="快捷键" @click="showHelp = true">-->
<!--      <el-icon><QuestionFilled /></el-icon>-->
<!--    </button>-->

<!--    <ElDialog-->
<!--      v-model="showHelp"-->
<!--      title="画布快捷键"-->
<!--      width="420px"-->
<!--      align-center-->
<!--      destroy-on-close-->
<!--    >-->
<!--      <div class="canvas-zoom-controls__help">-->
<!--        <div v-for="row in shortcutRows" :key="row[0]" class="canvas-zoom-controls__help-row">-->
<!--          <span class="canvas-zoom-controls__help-key">{{ row[0] }}</span>-->
<!--          <span class="canvas-zoom-controls__help-desc">{{ row[1] }}</span>-->
<!--        </div>-->
<!--      </div>-->
<!--    </ElDialog>-->
  </div>
</template>

<style scoped>
.canvas-zoom-controls {
  position: absolute;
  bottom: 20px;
  left: 20px;
  z-index: 50;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 10px;
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  box-shadow: var(--shadow-generator-float-block);
  color: var(--text-primary);
  user-select: none;
}

.canvas-zoom-controls__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  transition: background-color 0.12s, color 0.12s;
}
.canvas-zoom-controls__btn:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
.canvas-zoom-controls__btn.is-active {
  background: var(--brand-main-block-default);
  color: var(--brand-main-default);
}
.canvas-zoom-controls__btn--danger {
  color: var(--text-secondary);
}
.canvas-zoom-controls__btn--danger:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--functional-error);
}

.canvas-zoom-controls__divider {
  width: 1px;
  height: 20px;
  background: var(--stroke-tertiary);
  margin: 0 2px;
}

.canvas-zoom-controls__slider {
  width: 96px;
  height: 4px;
  accent-color: var(--brand-main-default);
  background: var(--canvas-bg-block-default);
  border-radius: 2px;
  cursor: pointer;
}

/* 百分比现在是菜单触发器：外观保持原样，只补可点性 */
.canvas-zoom-controls__percent {
  min-width: 38px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.canvas-zoom-controls__percent:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}

.canvas-zoom-controls__appearance {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 60;
}

.canvas-appearance-pop-enter-active,
.canvas-appearance-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.canvas-appearance-pop-enter-from,
.canvas-appearance-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.canvas-zoom-controls__help {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
}
.canvas-zoom-controls__help-row {
  display: contents;
}
.canvas-zoom-controls__help-key {
  font-size: 13px;
  color: var(--text-secondary);
}
.canvas-zoom-controls__help-desc {
  font-size: 13px;
  color: var(--text-primary);
}
</style>
