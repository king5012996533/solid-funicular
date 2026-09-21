<script setup lang="ts">
/**
 * 生成数量步进器（图片 / 视频共用）
 *
 * 抽出来的原因：图片工具栏和视频工具栏都需要它，而 LibTV 两边的摘要格式
 * 都带数量段（图片 `1张`、视频 `1个`）。与其复制一份样式和增减逻辑，
 * 不如共用 —— 否则将来改交互要改两处，容易走偏。
 *
 * 显隐由调用方决定：只在「模型声明了上限 > 1」时才渲染。
 * 上游只支持单张却摆一个按不动的控件，是噪音。
 */

const props = withDefaults(defineProps<{
  /** 当前值 */
  value: number
  /** 模型声明的上限 */
  max: number
  min?: number
  /** 侧栏收起态：只显示数字，不显示输入框 */
  compact?: boolean
  /** 用于 title 提示的单位，如 '张' / '个' */
  unit?: string
}>(), {
  min: 1,
  compact: false,
  unit: '张',
})

const emit = defineEmits<{
  (e: 'update:value', value: number): void
}>()

const clamp = (input: number) => {
  if (!Number.isFinite(input)) return props.min
  return Math.min(props.max, Math.max(props.min, Math.floor(input)))
}

const decrease = (e: Event) => {
  e.stopPropagation()
  emit('update:value', clamp(props.value - 1))
}

const increase = (e: Event) => {
  e.stopPropagation()
  emit('update:value', clamp(props.value + 1))
}

const handleInput = (e: Event) => {
  emit('update:value', clamp(Number((e.target as HTMLInputElement).value)))
}
</script>

<template>
  <div
    class="generator-count-stepper"
    :class="{ compact }"
    :title="`单次生成数量（该模型上限 ${max} ${unit}）`"
    @click.stop
  >
    <button
      type="button"
      class="generator-count-step-btn"
      :disabled="value <= min"
      :aria-label="`减少生成数量`"
      @click="decrease"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>
    <input
      v-if="!compact"
      type="number"
      class="generator-count-value"
      :min="min"
      :max="max"
      :step="1"
      :value="value"
      @input="handleInput"
      @click.stop
    />
    <span v-else class="generator-count-value generator-count-value-readonly">{{ value }}</span>
    <button
      type="button"
      class="generator-count-step-btn"
      :disabled="value >= max"
      :aria-label="`增加生成数量`"
      @click="increase"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style>
.generator-count-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--bg-block-secondary-default, rgba(204, 221, 255, 0.04));
  border: 0.5px solid var(--stroke-tertiary, rgba(255, 255, 255, 0.12));
}

.generator-count-stepper.compact {
  height: 28px;
  gap: 0;
  padding: 0 2px;
}

.generator-count-step-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.generator-count-step-btn:hover:not(:disabled) {
  background: var(--bg-block-primary-hover);
}

.generator-count-step-btn:active:not(:disabled) {
  background: var(--bg-block-primary-pressed);
}

.generator-count-step-btn:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.generator-count-value {
  width: 28px;
  height: 22px;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  -moz-appearance: textfield;
}

.generator-count-value::-webkit-outer-spin-button,
.generator-count-value::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.generator-count-value-readonly {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
</style>
