<script setup lang="ts">
// 音频生成工具栏（视频工具栏的简化版）
//
// 音频没有比例 / 清晰度，只有「时长」与「格式」两个维度。
// 与图片 / 视频工具栏同一套原则：可选参数全部来自当前选中的上游模型
// （capabilityJson.seconds / formats），模型没声明就不渲染对应控件，不摆假选项。

import { ref, computed, watch, onMounted } from 'vue'
import SelectPopup from '../common/SelectPopup.vue'
import {
  getAllAudioModels,
  getDefaultAudioModelKey,
  loadPublicModelCatalog,
  notifyModelSelectionFallback,
  reconcileModelSelection,
  resolveModelLabel,
  type AudioModel,
} from '@/config/models'

// 弹出方向类型
type Placement = 'top' | 'bottom' | 'auto'

const AUDIO_TOOLBAR_STORAGE_KEY = 'canana:generator:audio-toolbar'

// 模型未声明 seconds 时的兜底档位（秒）
const AUDIO_DURATION_FALLBACK = [5, 10]

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

const modelVersions = computed(() =>
  getAllAudioModels().map(model => ({ value: model.key, label: model.label }))
)

const readStoredAudioToolbarState = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return JSON.parse(window.localStorage.getItem(AUDIO_TOOLBAR_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

const storedAudioToolbarState = readStoredAudioToolbarState()

// 首选模型：先原样采用存值（没有存值才用默认）；目录到货后由下面的 watch 校验，
// 与图片 / 视频工具栏同一条规则，不在首屏拿空目录校验存值。
const currentModelVersion = ref(
  String(storedAudioToolbarState?.model || '').trim() || getDefaultAudioModelKey(),
)
const currentDuration = ref(String(storedAudioToolbarState?.duration ?? ''))
const currentFormat = ref(String(storedAudioToolbarState?.format || ''))

const currentModel = computed<AudioModel | null>(() =>
  getAllAudioModels().find(model => model.key === currentModelVersion.value) || null
)

const durationOptions = computed<number[]>(() => {
  const declared = currentModel.value?.seconds || []
  return declared.length ? declared : AUDIO_DURATION_FALLBACK
})
const formatOptions = computed<string[]>(() => currentModel.value?.formats || [])

const hasModel = computed(() => modelVersions.value.length > 0)
const hasFormatControl = computed(() => formatOptions.value.length > 0)
const currentModelLabel = computed(() =>
  currentModel.value?.label || currentModelVersion.value || '未配置模型'
)

/** 页脚摘要：`5s · mp3`；格式段只在模型声明了 formats 时出现 */
const paramSummary = computed(() => {
  const parts: string[] = []
  const duration = String(currentDuration.value || '').trim()
  if (duration) {
    parts.push(/s$/i.test(duration) ? duration : `${duration}s`)
  }
  const format = String(currentFormat.value || '').trim()
  if (format) {
    parts.push(format)
  }
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

const togglePopup = (target: typeof isModelSelectOpen, e: Event) => {
  e.stopPropagation()
  const wasOpen = target.value
  closeAllPopups()
  target.value = !wasOpen
}

const toggleModelSelect = (e: Event) => togglePopup(isModelSelectOpen, e)
const toggleSummaryPanel = (e: Event) => togglePopup(isSummaryPanelOpen, e)

const selectModelVersion = (version: string) => {
  currentModelVersion.value = version
  isModelSelectOpen.value = false
}

// 面板里的选项：选完保持面板打开，方便连续调多项
const selectDuration = (duration: number) => {
  currentDuration.value = String(duration)
}

const selectFormat = (format: string) => {
  currentFormat.value = format
}

/**
 * 模型列表（或外部写入的选中值）变化时，保证选中项一定存在于目录里：
 * 目录未到（列表为空）时不下判断；原选模型确实不在目录里（下架 / 被禁用）时
 * 回落默认模型**并提示**用户，不静默替换。
 */
watch(
  [modelVersions, currentModelVersion],
  ([options, current]) => {
    if (!options.length) return
    const values = options.map(item => item.value)
    if (values.includes(current)) return
    const reconciled = reconcileModelSelection(current, 'AUDIO')
    const next = reconciled.key || values[0]
    currentModelVersion.value = next
    notifyModelSelectionFallback(current, resolveModelLabel(next, 'AUDIO'))
  },
  { immediate: true },
)

// 时长 / 格式必须落在「当前模型真实支持的档位」里，否则回落到该模型的默认值。
// 模型换了以后旧参数自动失效，不会带着上一个模型的参数去提交。
const alignDimension = (
  choices: string[],
  current: typeof currentDuration,
) => {
  if (!choices.length) {
    current.value = ''
    return
  }
  if (!choices.includes(current.value)) {
    current.value = choices[0]
  }
}

watch([durationOptions, currentModelVersion], () => {
  alignDimension(durationOptions.value.map(item => String(item)), currentDuration)
}, { immediate: true })

watch([formatOptions, currentModelVersion], () => {
  alignDimension(formatOptions.value, currentFormat)
}, { immediate: true })

onMounted(() => {
  void loadPublicModelCatalog()
})

watch(
  [currentModelVersion, currentDuration, currentFormat],
  ([model, duration, format]) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(AUDIO_TOOLBAR_STORAGE_KEY, JSON.stringify({ model, duration, format }))
  },
  { immediate: true },
)

defineExpose({
  currentModelVersion,
  currentModelLabel,
  currentDuration,
  currentFormat,
  hasModel,
  paramSummary,
})
</script>

<template>
  <div class="audio-toolbar">
    <!-- 目录为空时明确说明，并让发送入口保持不可用，不渲染一个空的下拉 -->
    <div v-if="!hasModel" class="toolbar-empty-hint" title="请先在后台「模型厂商」里启用音频模型">
      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="!iconOnly">未配置音频模型</span>
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
              <svg width="1em" height="1em" viewBox="0 0 24 24"
                   preserveAspectRatio="xMidYMid meet" fill="none"
                   role="presentation" xmlns="http://www.w3.org/2000/svg">
                <g>
                  <path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
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
          <div class="generator-param-row">
            <div class="generator-param-row-label">时长</div>
            <div class="generator-param-chips">
              <button
                v-for="duration in durationOptions"
                :key="duration"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentDuration === String(duration) }"
                @click.stop="selectDuration(duration)"
              >{{ duration }}s</button>
            </div>
          </div>

          <div v-if="hasFormatControl" class="generator-param-row">
            <div class="generator-param-row-label">格式</div>
            <div class="generator-param-chips">
              <button
                v-for="format in formatOptions"
                :key="format"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentFormat === format }"
                @click.stop="selectFormat(format)"
              >{{ format }}</button>
            </div>
          </div>
        </div>
      </SelectPopup>
    </template>
  </div>
</template>

<style>
/* 主要样式在 generate.css 中定义 */
.audio-toolbar {
  display: contents;
}

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
</style>
