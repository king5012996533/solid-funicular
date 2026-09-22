<script setup lang="ts">
/**
 * 比例选择器：图形单选卡（对齐 LibTV 实测）
 *
 * LibTV 的参数面板里，比例不是文字 chip，而是**按真实比例画出来的小矩形**：
 * 4 列换行、选中项高亮描边；`Auto` 用虚线方框表示「不指定」。
 * 7 档比例（Auto / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9）在文字形式下几乎要逐字读，
 * 图形化之后一眼就能挑出朝向。
 *
 * 为什么单独一个组件：图片节点（像素档如 `2048x2048`）与视频节点（比例档如 `16x9`）
 * 都要用同一套规则，各写一份必然漂移。
 */
import { computed } from 'vue'
import { parseAspectRatio } from '@/config/model-params'

interface RatioChoice {
  key: string
  label: string
  /** 分辨率档位提示（图片节点的 1K/2K/4K） */
  hint?: string
}

const props = withDefaults(defineProps<{
  options: RatioChoice[]
  modelValue: string
  /** 每行几列（LibTV 实测 4 列） */
  columns?: number
}>(), { columns: 4 })

const emit = defineEmits<{ (event: 'select', key: string): void }>()

/** 图形框的最大尺寸：够看清朝向，又不至于把面板撑高 */
const GLYPH_MAX_WIDTH = 30
const GLYPH_MAX_HEIGHT = 22

const isAuto = (key: string) => parseAspectRatio(key) === null

/**
 * 把比例画成等比例小矩形：**同时**适配宽高的上限（等比缩放）。
 *
 * 只夹宽不夹高会在 1:1 上出事 —— 正方形按宽算出来是 30×30，直接顶破 22px 的图形区，
 * 那一格比同排的更高（实测复现过）。等比缩放到 30×22 的框里就没这个问题。
 */
const glyphStyle = (key: string) => {
  const aspect = parseAspectRatio(key)
  if (aspect === null) {
    // 认不出比例（Auto 之类）：虚线方框表达「不指定」，用最小边做一个正方形
    return { width: `${GLYPH_MAX_HEIGHT}px`, height: `${GLYPH_MAX_HEIGHT}px` }
  }
  const width = Math.min(GLYPH_MAX_WIDTH, GLYPH_MAX_HEIGHT * aspect)
  const height = width / aspect
  return { width: `${Math.round(width)}px`, height: `${Math.round(height)}px` }
}

const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }))
</script>

<template>
  <div class="ratio-choice-grid" :style="gridStyle">
    <button
      v-for="option in options"
      :key="option.key"
      type="button"
      class="ratio-choice"
      :class="{ 'is-active': modelValue === option.key, 'is-auto': isAuto(option.key) }"
      :title="option.hint ? `${option.label} · ${option.hint}` : option.label"
      @click.stop="emit('select', option.key)"
    >
      <span class="ratio-choice__glyph-box">
        <span class="ratio-choice__glyph" :style="glyphStyle(option.key)" />
      </span>
      <span class="ratio-choice__label">{{ option.label }}</span>
      <span v-if="option.hint" class="ratio-choice__hint">{{ option.hint }}</span>
    </button>
  </div>
</template>

<style scoped>
.ratio-choice-grid {
  display: grid;
  gap: 6px;
}

.ratio-choice {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 4px 6px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.ratio-choice:hover,
.ratio-choice:focus-visible {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}

.ratio-choice.is-active {
  border-color: var(--brand-main-default);
  background: var(--bg-block-secondary-default);
  color: var(--brand-main-default);
}

/* 图形区固定高度：各行卡片高度一致，换行后不会参差 */
.ratio-choice__glyph-box {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22px;
}

.ratio-choice__glyph {
  /* border-box：边框算进上面算好的尺寸里，否则每格都会大 2px、比例也偏 */
  box-sizing: border-box;
  border: 1px solid currentColor;
  border-radius: 2px;
  opacity: 0.85;
}

/* Auto：虚线方框 —— 表达「不指定比例」而不是某个具体形状 */
.ratio-choice.is-auto .ratio-choice__glyph {
  border-style: dashed;
  opacity: 0.6;
}

.ratio-choice__label {
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}

.ratio-choice__hint {
  font-size: 11px;
  line-height: 1;
  color: var(--text-tertiary);
}

.ratio-choice.is-active .ratio-choice__hint {
  color: var(--brand-main-default);
}
</style>
