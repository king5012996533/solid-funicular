<script setup lang="ts">
// 图片生成工具栏
//
// 改造要点：这里不再自带任何尺寸 / 画质清单。
// 可选参数由「当前选中的上游模型」决定（见 src/config/model-params.ts），
// 换模型 → 尺寸表、画质档、单次张数上限一起变。
// 模型没声明画质就不渲染画质控件，没声明尺寸就不渲染尺寸控件 —— 不摆假选项。

import { ref, computed, watch, onMounted } from 'vue'
import SelectPopup from '../common/SelectPopup.vue'
import GeneratorCountStepper from '../GeneratorCountStepper.vue'
import {
  getAllImageModels,
  getDefaultImageModelKey,
  loadPublicModelCatalog,
  getModelByName,
  type ImageModel,
} from '@/config/models'
import { resolveImageParamSchema, type ParamChoice } from '@/config/model-params'

// 弹出方向类型
type Placement = 'top' | 'bottom' | 'auto'

const IMAGE_TOOLBAR_STORAGE_KEY = 'canana:generator:image-toolbar'

// Props 定义
interface Props {
  // 弹出方向：top-向上, bottom-向下, auto-自动计算
  placement?: Placement
  // 是否只显示图标（侧边栏模式）
  iconOnly?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placement: 'auto',
  iconOnly: false
})

// 模型列表：全部来自后台公开模型目录
const modelVersions = computed(() =>
  getAllImageModels().map(model => ({ value: model.key, label: model.label }))
)

const readStoredImageToolbarState = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return JSON.parse(window.localStorage.getItem(IMAGE_TOOLBAR_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

const storedToolbarState = readStoredImageToolbarState()
const validImageModelValues = modelVersions.value.map(item => item.value)

const IMAGE_COUNT_MIN = 1
// 模型未配置 maxImagesPerRequest 时的最保守上限：1。
// 各上游真实上限由 capabilityJson.maxImagesPerRequest 提供，管理员后台可配置。
const IMAGE_COUNT_FALLBACK_MAX = 1
const IMAGE_COUNT_DEFAULT = 1

// 当前选中的模型
const currentModelVersion = ref(
  validImageModelValues.includes(storedToolbarState?.model) ? storedToolbarState.model : getDefaultImageModelKey(),
)

const currentModel = computed<ImageModel | null>(() => {
  const matched = getModelByName(currentModelVersion.value)
  return (matched as ImageModel | null) || null
})

// 画质先于尺寸解析：豆包 Seedream 的 2K / 4K 对应两张不同的像素表，
// 所以尺寸列表是「模型 × 画质」的函数。
const currentQuality = ref(String(storedToolbarState?.quality || ''))
const currentSize = ref(String(storedToolbarState?.size || ''))

const schema = computed(() => resolveImageParamSchema(currentModel.value, currentQuality.value))

const sizeOptions = computed<ParamChoice[]>(() => schema.value.sizes)
const qualityOptions = computed<ParamChoice[]>(() => schema.value.qualities)
const currentImageMax = computed(() => {
  const declared = Number(schema.value.maxCount)
  return Number.isFinite(declared) && declared >= IMAGE_COUNT_MIN
    ? Math.floor(declared)
    : IMAGE_COUNT_FALLBACK_MAX
})

const hasSizeControl = computed(() => sizeOptions.value.length > 0)
const hasQualityControl = computed(() => qualityOptions.value.length > 0)

// 当前生成数量：用户每次打开都从 1 开始，不记忆历史值
const currentCount = ref<number>(IMAGE_COUNT_DEFAULT)

const findChoice = (choices: ParamChoice[], key: string) => choices.find(item => item.key === key) || null

const currentSizeChoice = computed(() => findChoice(sizeOptions.value, currentSize.value))
const currentQualityChoice = computed(() => findChoice(qualityOptions.value, currentQuality.value))
const currentQualityLabel = computed(() => currentQualityChoice.value?.label || '')

// 尺寸按钮文案：`16:9 · 2K`，第二段是分辨率档位（由像素尺寸推导，不是写死的）
const currentSizeLabel = computed(() => {
  const choice = currentSizeChoice.value
  if (!choice) return ''
  return choice.hint ? `${choice.label} · ${choice.hint}` : choice.label
})

const currentModelLabel = computed(() => {
  const model = currentModel.value
  return model?.label || currentModelVersion.value || '未配置模型'
})

const hasModel = computed(() => modelVersions.value.length > 0)

/**
 * 参数摘要：一行页脚文案，格式固定为 `比例 · 画质 · 分辨率 · 数量`。
 * 模型没声明的段直接跳过，不补一个它不支持的假参数。
 */
// 摘要格式对齐 LibTV：`16:9 · 标准画质 · 2K · 1张`
// 数量段**始终显示**（LibTV 的 `1张` 也是始终在的）；
// 能不能改由模型上限决定 —— 上限为 1 时不摆步进器，但摘要里照样交代清楚是 1 张
const paramSummary = computed(() => {
  const parts: string[] = []
  const size = currentSizeChoice.value
  if (size) parts.push(size.label)
  if (currentQualityChoice.value) parts.push(currentQualityChoice.value.label)
  if (size?.hint) parts.push(size.hint)
  parts.push(`${currentCount.value}张`)
  return parts.join(' · ')
})

// 弹窗状态
const isModelSelectOpen = ref(false)
// 参数摘要面板：模型选择以外的维度都收进这里，页脚只留一行摘要
const isSummaryPanelOpen = ref(false)

// 触发器引用
const modelTriggerRef = ref<HTMLElement | null>(null)
const summaryTriggerRef = ref<HTMLElement | null>(null)

const closeAllPopups = () => {
  isModelSelectOpen.value = false
  isSummaryPanelOpen.value = false
}

// 切换模型选择弹窗
const toggleModelSelect = (e: Event) => {
  e.stopPropagation()
  const wasOpen = isModelSelectOpen.value
  closeAllPopups()
  isModelSelectOpen.value = !wasOpen
}

// 切换参数摘要面板
const toggleSummaryPanel = (e: Event) => {
  e.stopPropagation()
  const wasOpen = isSummaryPanelOpen.value
  closeAllPopups()
  isSummaryPanelOpen.value = !wasOpen
}

const selectModelVersion = (version: string) => {
  currentModelVersion.value = version
  isModelSelectOpen.value = false
}

// 面板里的选项：选完保持面板打开，方便连续调多项
const selectSize = (size: string) => {
  currentSize.value = size
}

const selectQuality = (quality: string) => {
  currentQuality.value = quality
}

// 模型列表变化时，保证选中项一定存在于目录里
watch(
  modelVersions,
  (options) => {
    const values = options.map(item => item.value)
    if (!values.length) return
    if (!values.includes(currentModelVersion.value)) {
      currentModelVersion.value = getDefaultImageModelKey() || values[0]
    }
  },
  { immediate: true },
)

// 画质必须是当前模型支持的档位；模型换了或首次渲染时回落到默认档
watch(
  [qualityOptions, currentModelVersion],
  () => {
    if (!qualityOptions.value.length) {
      currentQuality.value = ''
      return
    }
    if (!findChoice(qualityOptions.value, currentQuality.value)) {
      currentQuality.value = schema.value.defaultQuality
    }
  },
  { immediate: true },
)

// 尺寸必须是「当前模型 + 当前画质」下真实存在的选项，否则回落到默认尺寸。
// 这一步同时覆盖了 2K/4K 切换导致的像素表变化。
watch(
  [sizeOptions, currentQuality, currentModelVersion],
  () => {
    if (!sizeOptions.value.length) {
      currentSize.value = ''
      return
    }
    if (!findChoice(sizeOptions.value, currentSize.value)) {
      currentSize.value = schema.value.defaultSize
    }
  },
  { immediate: true },
)

// 单次张数上限跟着模型走，越界自动夹紧，避免提交到上游被 422
watch(currentImageMax, (max) => {
  if (currentCount.value > max) {
    currentCount.value = max
  }
}, { immediate: true })

onMounted(() => {
  void loadPublicModelCatalog()
})

watch(
  [currentModelVersion, currentSize, currentQuality],
  ([model, size, quality]) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(IMAGE_TOOLBAR_STORAGE_KEY, JSON.stringify({ model, size, quality }))
  },
  { immediate: true },
)

// 获取当前尺寸配置。quality 字段必须是画质 key（standard / 4k），
// 调用方会把它作为 resolution 透传到 requestBody.quality。
const currentSizeConfig = () => ({
  value: currentSize.value,
  label: currentSizeChoice.value?.label || currentSize.value,
  hint: currentSizeChoice.value?.hint || '',
  quality: currentQuality.value,
  qualityLabel: currentQualityLabel.value,
})

const currentSizeConfigRef = computed(currentSizeConfig)

defineExpose({
  currentModelVersion,
  currentModelLabel,
  currentSize,
  currentQuality,
  currentQualityLabel,
  currentSizeLabel,
  currentSizeConfig,
  currentSizeConfigRef,
  currentCount,
  paramSummary,
})
</script>

<template>
  <div class="image-toolbar">
    <!-- 目录为空时明确说明，而不是渲染一个空的下拉 -->
    <div v-if="!hasModel" class="toolbar-empty-hint" title="请先在后台「模型厂商」里启用图片模型">
      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="!iconOnly">未配置图片模型</span>
    </div>

    <template v-else>
      <!-- 模型选择 -->
      <div ref="modelTriggerRef"
           :class="['lv-select', 'lv-select-single', 'lv-select-size-default', 'toolbar-select', 'select-joF5y7', 'select-NNOj5P', { 'compact': iconOnly }]"
           role="combobox"
           tabindex="0"
           :aria-expanded="isModelSelectOpen"
           :title="iconOnly ? currentModelLabel : undefined"
           @click.stop="toggleModelSelect">
        <div class="lv-select-view">
          <span class="lv-select-view-selector">
            <span class="lv-select-view-value">
              <svg fill="none" height="16" preserveAspectRatio="xMidYMid meet"
                   role="presentation" viewBox="0 0 24 24" width="16"
                   xmlns="http://www.w3.org/2000/svg">
                <g>
                  <path clip-rule="evenodd"
                        d="M13.25 2.682a2.5 2.5 0 0 0-2.5 0L4.556 6.258a2.5 2.5 0 0 0-1.25 2.165v7.153a2.5 2.5 0 0 0 1.25 2.165l6.194 3.576a2.5 2.5 0 0 0 2.5 0l6.194-3.576a2.5 2.5 0 0 0 1.25-2.165V8.423a2.5 2.5 0 0 0-1.25-2.165L13.25 2.682Zm-1.6 1.559a.7.7 0 0 1 .7 0L17.995 7.5 12 10.96 6.005 7.5l5.645-3.26Zm1.25 8.279v6.92l5.644-3.258a.7.7 0 0 0 .35-.606V9.059l-5.994 3.46ZM5.106 9.059l5.994 3.46v6.922l-5.644-3.259a.7.7 0 0 1-.35-.606V9.059Z"
                        data-follow-fill="currentColor" fill="currentColor"
                        fill-rule="evenodd"></path>
                </g>
              </svg>
              <span v-if="!iconOnly">{{ currentModelLabel }}</span>
            </span>
          </span>
          <div v-if="!iconOnly" aria-hidden="true" class="lv-select-suffix">
            <div class="lv-select-arrow-icon">
              <svg width="1em" height="1em" viewBox="0 0 24 24"
                   preserveAspectRatio="xMidYMid meet" fill="none"
                   role="presentation" xmlns="http://www.w3.org/2000/svg">
                <g>
                  <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
                        d="M21.01 7.982A1.2 1.2 0 0 1 21 9.679l-8.156 8.06a1.2 1.2 0 0 1-1.688 0L3 9.68a1.2 1.2 0 0 1 1.687-1.707L12 15.199l7.313-7.227a1.2 1.2 0 0 1 1.697.01Z"
                        fill="currentColor"></path>
                </g>
              </svg>
            </div>
          </div>
          <div v-else aria-hidden="true" class="lv-select-suffix sf-hidden"></div>
        </div>
      </div>

      <!-- 模型选择弹窗 -->
      <SelectPopup v-model:visible="isModelSelectOpen" :trigger-ref="modelTriggerRef" :placement="placement" title="模型版本">
        <ul class="lv-select-popup-inner">
          <li v-for="version in modelVersions"
              :key="version.value"
              :class="['lv-select-option', { 'lv-select-option-wrapper-selected': currentModelVersion === version.value }]"
              @click.stop="selectModelVersion(version.value)">
            <div class="select-option-label">
              <div class="select-option-label-content">
                <span>{{ version.label }}</span>
              </div>
              <span v-if="currentModelVersion === version.value" class="select-option-check-icon">
                <svg width="1em" height="1em" viewBox="0 0 24 24"
                     preserveAspectRatio="xMidYMid meet" fill="none"
                     role="presentation" xmlns="http://www.w3.org/2000/svg">
                  <g>
                    <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
                          d="M20.774 6.289a1 1 0 0 1 .1 1.41l-9.666 11a1 1 0 0 1-1.447.063l-5.334-5a1 1 0 0 1 1.368-1.458l4.572 4.286 9.002-10.2a1 1 0 0 1 1.405-.101Z"
                          fill="currentColor"></path>
                  </g>
                </svg>
              </span>
            </div>
          </li>
        </ul>
      </SelectPopup>

      <!-- 参数摘要：一行收起，模型未声明的段不出现 -->
      <button
        ref="summaryTriggerRef"
        type="button"
        class="toolbar-summary-trigger"
        :class="{ compact: iconOnly }"
        :aria-expanded="isSummaryPanelOpen"
        :title="paramSummary || '生成参数'"
        @click.stop="toggleSummaryPanel"
      >
        <span class="toolbar-summary-text">{{ paramSummary || '生成参数' }}</span>
        <svg v-if="!iconOnly" class="toolbar-summary-chevron" width="1em" height="1em" viewBox="0 0 24 24"
             preserveAspectRatio="xMidYMid meet" fill="none" aria-hidden="true">
          <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
                d="M21.01 7.982A1.2 1.2 0 0 1 21 9.679l-8.156 8.06a1.2 1.2 0 0 1-1.688 0L3 9.68a1.2 1.2 0 0 1 1.687-1.707L12 15.199l7.313-7.227a1.2 1.2 0 0 1 1.697.01Z"
                fill="currentColor"></path>
        </svg>
      </button>

      <!-- 参数面板：摘要里每一段都能在这里单独改，不藏参数 -->
      <SelectPopup
        v-model:visible="isSummaryPanelOpen"
        :trigger-ref="summaryTriggerRef"
        :placement="placement"
        title="生成参数"
        popup-class="generator-param-popup"
      >
        <div class="generator-param-panel">
          <div v-if="hasQualityControl" class="generator-param-row">
            <div class="generator-param-row-label">画质</div>
            <div class="generator-param-chips">
              <button
                v-for="quality in qualityOptions"
                :key="quality.key"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentQuality === quality.key }"
                @click.stop="selectQuality(quality.key)"
              >{{ quality.label }}</button>
            </div>
          </div>

          <div v-if="hasSizeControl" class="generator-param-row">
            <div class="generator-param-row-label">比例</div>
            <div class="generator-param-chips">
              <button
                v-for="size in sizeOptions"
                :key="size.key"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentSize === size.key }"
                @click.stop="selectSize(size.key)"
              >
                <span>{{ size.label }}</span>
                <span v-if="size.hint" class="generator-param-chip-hint">{{ size.hint }}</span>
              </button>
            </div>
          </div>

          <div v-if="currentImageMax > 1" class="generator-param-row">
            <div class="generator-param-row-label">数量</div>
            <GeneratorCountStepper v-model:value="currentCount" :max="currentImageMax" unit="张" />
          </div>
        </div>
      </SelectPopup>
    </template>
  </div>
</template>

<style>
/* 主要样式在 generate.css 中定义 */
.image-toolbar {
  display: contents;
}

/* 目录为空时的兜底提示 */
.toolbar-empty-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-block-secondary-default);
  border: 1px solid var(--stroke-secondary);
}

/* 生成数量步进器（摘要面板内） */
</style>
