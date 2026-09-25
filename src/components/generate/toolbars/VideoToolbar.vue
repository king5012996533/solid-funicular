<script setup lang="ts">
// 视频生成工具栏
//
// 与图片工具栏同一套原则：比例 / 时长 / 分辨率 / 输入模式（文生视频、图生视频、首尾帧）
// 都由当前选中的上游模型决定，组件内不再写死任何清单。

import { ref, computed, watch, onMounted } from 'vue'
import SelectPopup from '../common/SelectPopup.vue'
import GeneratorCountStepper from '../GeneratorCountStepper.vue'
import RatioChoiceGrid from '../RatioChoiceGrid.vue'
import {
  getAllVideoModels,
  getDefaultVideoModelKey,
  loadPublicModelCatalog,
  getModelByName,
  notifyModelSelectionFallback,
  reconcileModelSelection,
  resolveModelLabel,
  type VideoModel,
} from '@/config/models'
import { describeAspectRatio, resolveVideoParamSchema, type ParamChoice } from '@/config/model-params'

// 弹出方向类型
type Placement = 'top' | 'bottom' | 'auto'

const VIDEO_TOOLBAR_STORAGE_KEY = 'canana:generator:video-toolbar'

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
  getAllVideoModels().map(model => ({ value: model.key, label: model.label }))
)

const readStoredVideoToolbarState = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return JSON.parse(window.localStorage.getItem(VIDEO_TOOLBAR_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

const storedVideoToolbarState = readStoredVideoToolbarState()

// 当前选中状态
/**
 * 首选模型：与图片工具栏同一条规则 —— 先原样采用存值，**不要在首屏拿目录校验它**。
 *
 * 原来这里是 `validVideoModelValues.includes(stored) ? stored : 默认`，而首屏的
 * `modelVersions` 还是空数组（目录是异步拉的），于是任何存过的模型都会被判成「不在目录里」
 * 而静默换成默认模型 —— 用户选的视频模型刷新一次就没了，界面上没有任何提示。
 * 真正的校验交给下面的 watch：它只在目录到货后动手，且一定会给出提示。
 */
const currentModelVersion = ref(
  String(storedVideoToolbarState?.model || '').trim() || getDefaultVideoModelKey(),
)
const currentFeature = ref(String(storedVideoToolbarState?.feature || ''))
const currentSize = ref(String(storedVideoToolbarState?.size || ''))
const currentDuration = ref(String(storedVideoToolbarState?.duration ?? ''))
const currentResolution = ref(String(storedVideoToolbarState?.resolution || ''))
const currentCount = ref<number>(1)

const currentModel = computed<VideoModel | null>(() => {
  const matched = getModelByName(currentModelVersion.value)
  return (matched as VideoModel | null) || null
})

const schema = computed(() => resolveVideoParamSchema(currentModel.value))

const ratioOptions = computed<ParamChoice[]>(() => schema.value.ratios)
const durationOptions = computed<ParamChoice[]>(() => schema.value.durations)
const resolutionOptions = computed<ParamChoice[]>(() => schema.value.resolutions)
const featureOptions = computed<ParamChoice[]>(() => schema.value.features)

const hasModel = computed(() => modelVersions.value.length > 0)
const hasFeatureControl = computed(() => featureOptions.value.length > 1)
const hasRatioControl = computed(() => ratioOptions.value.length > 0)
const hasDurationControl = computed(() => durationOptions.value.length > 1)
const hasResolutionControl = computed(() => resolutionOptions.value.length > 1)

const currentVideoMax = computed(() => {
  const declared = Number(schema.value.maxCount)
  return Number.isFinite(declared) && declared >= 1 ? Math.floor(declared) : 1
})

const findChoice = (choices: ParamChoice[], key: string) => choices.find(item => item.key === key) || null

const currentRatioChoice = computed(() => findChoice(ratioOptions.value, currentSize.value))
const currentDurationChoice = computed(() => findChoice(durationOptions.value, currentDuration.value))
const currentResolutionChoice = computed(() => findChoice(resolutionOptions.value, currentResolution.value))
const currentFeatureChoice = computed(() => findChoice(featureOptions.value, currentFeature.value))

/**
 * 视频时长滑杆：档位是**模型声明的离散值**（5 秒 / 10 秒…），所以滑杆走「下标」而不是秒数。
 *
 * 直接绑秒数会在模型只认 5/10 两档时给出 7 秒这种上游不认的值；下标映射能保证
 * 拖出来的永远是声明过的档位（对齐 LibTV 的「滑杆 + 单位 s」，但不给模型留猜的余地）。
 */
const durationIndex = computed(() => {
  const index = durationOptions.value.findIndex(item => item.key === currentDuration.value)
  return index >= 0 ? index : 0
})
const durationValueLabel = computed(() => {
  const key = String(currentDurationChoice.value?.key || '').trim()
  // 档位 key 就是秒数（'5' / '10'）；声明成别的写法时退回标签，别显示成空白
  return /^\d+$/.test(key) ? key : String(currentDurationChoice.value?.label || '').replace(/\s*秒$/, '')
})
const selectDurationByIndex = (index: number) => {
  const choice = durationOptions.value[Math.round(Number(index) || 0)]
  if (choice) selectDuration(choice.key)
}

const getCurrentModelLabel = () => currentModel.value?.label || currentModelVersion.value || '未配置模型'
const getCurrentFeatureLabel = () => currentFeatureChoice.value?.label || ''
const getCurrentDurationLabel = () => currentDurationChoice.value?.label || ''
const getCurrentResolutionLabel = () => currentResolutionChoice.value?.label || ''

/** 比例 · 分辨率，用于尺寸按钮的第二段文案 */
const getCurrentSizeConfig = () => ({
  value: currentSize.value,
  label: currentRatioChoice.value?.label || currentSize.value,
  quality: currentResolution.value,
  qualityLabel: getCurrentResolutionLabel(),
})

/** 页脚摘要：`比例 · 时长 · 分辨率 · 数量`；模型没声明的段直接跳过（视频无画质维度） */
/**
 * 摘要格式对齐 LibTV：`16:9 · 720P · 5s · 1个`
 *
 * 三个细节和原来的写法不同，都是照着 LibTV 的实测格式来的：
 *   1. 顺序是「比例 · 分辨率 · 时长 · 数量」—— 原来把时长排在了分辨率前面
 *   2. 比例用紧凑写法（`16:9` 而不是选项里的 `16:9 横版`）
 *   3. 时长用 `5s` 而不是 `5 秒`；数量段**始终显示**，单位是「个」
 */
const compactDuration = computed(() => {
  const key = currentDurationChoice.value?.key || ''
  if (!key) return ''
  return /s$/i.test(key) ? key : `${key}s`
})

const paramSummary = computed(() => {
  const parts: string[] = []
  if (currentRatioChoice.value) parts.push(describeAspectRatio(currentRatioChoice.value.key))
  if (currentResolutionChoice.value) parts.push(currentResolutionChoice.value.label)
  if (compactDuration.value) parts.push(compactDuration.value)
  parts.push(`${currentCount.value}个`)
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
const selectFeature = (feature: string) => {
  currentFeature.value = feature
}

const selectSize = (size: string) => {
  currentSize.value = size
}

const selectDuration = (duration: string) => {
  currentDuration.value = duration
}

const selectResolution = (resolution: string) => {
  currentResolution.value = resolution
}

/**
 * 模型列表（或外部写入的选中值）变化时，保证选中项一定存在于目录里。
 *
 * 目录未到（列表为空）时不下判断；原选模型确实不在目录里（下架 / 被禁用）时
 * 回落默认模型**并提示**用户。一并监听 currentModelVersion：
 * 工作流节点的 initialParams 也会把节点上存着的模型写进来。
 */
watch(
  [modelVersions, currentModelVersion],
  ([options, current]) => {
    if (!options.length) return
    const values = options.map(item => item.value)
    if (values.includes(current)) return
    const reconciled = reconcileModelSelection(current, 'VIDEO')
    const next = reconciled.key || values[0]
    currentModelVersion.value = next
    notifyModelSelectionFallback(current, resolveModelLabel(next, 'VIDEO'))
  },
  { immediate: true },
)

// 每个维度都必须落在「当前模型真实支持的选项」里，否则回落到该模型的默认值。
// 模型换了以后旧参数自动失效，不会带着上一个模型的参数去提交。
const alignDimension = (
  choices: ParamChoice[],
  current: typeof currentSize,
  fallbackDefault: string,
) => {
  if (!choices.length) {
    current.value = ''
    return
  }
  if (!findChoice(choices, current.value)) {
    current.value = fallbackDefault
  }
}

watch([featureOptions, currentModelVersion], () => {
  alignDimension(featureOptions.value, currentFeature, schema.value.features[0]?.key || '')
}, { immediate: true })

watch([ratioOptions, currentModelVersion], () => {
  alignDimension(ratioOptions.value, currentSize, schema.value.defaultRatio)
}, { immediate: true })

watch([durationOptions, currentModelVersion], () => {
  alignDimension(durationOptions.value, currentDuration, schema.value.defaultDuration)
}, { immediate: true })

watch([resolutionOptions, currentModelVersion], () => {
  alignDimension(resolutionOptions.value, currentResolution, schema.value.defaultResolution)
}, { immediate: true })

onMounted(() => {
  void loadPublicModelCatalog()
})

watch(
  [currentModelVersion, currentFeature, currentSize, currentDuration, currentResolution],
  ([model, feature, size, duration, resolution]) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(VIDEO_TOOLBAR_STORAGE_KEY, JSON.stringify({ model, feature, size, duration, resolution }))
  },
  { immediate: true },
)

defineExpose({
  currentModelVersion,
  currentFeature,
  currentSize,
  currentDuration,
  currentResolution,
  currentCount,
  getCurrentModelLabel,
  getCurrentFeatureLabel,
  getCurrentDurationLabel,
  getCurrentResolutionLabel,
  getCurrentSizeConfig,
  paramSummary,
  hasModel,
})
</script>

<template>
  <div class="video-toolbar">
    <div v-if="!hasModel" class="toolbar-empty-hint" title="请先在后台「模型厂商」里启用视频模型">
      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="!iconOnly">未配置视频模型</span>
    </div>

    <template v-else>
      <!-- 模型选择 -->
      <div ref="modelTriggerRef"
           :class="['lv-select', 'lv-select-single', 'lv-select-size-default', 'toolbar-select', 'select-joF5y7', 'select-NNOj5P', { 'compact': iconOnly }]"
           role="combobox"
           tabindex="0"
           :aria-expanded="isModelSelectOpen"
           :title="iconOnly ? getCurrentModelLabel() : undefined"
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
              <span v-if="!iconOnly">{{ getCurrentModelLabel() }}</span>
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
          <div v-if="hasFeatureControl" class="generator-param-row">
            <div class="generator-param-row-label">生成方式</div>
            <div class="generator-param-chips">
              <button
                v-for="feature in featureOptions"
                :key="feature.key"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentFeature === feature.key }"
                @click.stop="selectFeature(feature.key)"
              >{{ feature.label }}</button>
            </div>
          </div>

          <!-- 比例：LibTV 是图形单选卡（按真实比例画小矩形），不是文字 chip -->
          <div v-if="hasRatioControl" class="generator-param-row">
            <div class="generator-param-row-label">比例</div>
            <RatioChoiceGrid
              :options="ratioOptions"
              :model-value="currentSize"
              @select="selectSize"
            />
          </div>

          <!-- 视频时长：LibTV 是「滑杆 + 单位 s」，这里对齐；档位仍只取模型声明的离散值 -->
          <div v-if="hasDurationControl" class="generator-param-row">
            <div class="generator-param-row-label">视频时长</div>
            <div class="generator-duration-slider">
              <el-slider
                :model-value="durationIndex"
                :min="0"
                :max="Math.max(0, durationOptions.length - 1)"
                :step="1"
                :show-tooltip="false"
                :show-stops="false"
                size="small"
                @update:model-value="selectDurationByIndex"
              />
              <span class="generator-duration-value">
                {{ durationValueLabel }}<em>s</em>
              </span>
            </div>
          </div>

          <div v-if="hasResolutionControl" class="generator-param-row">
            <div class="generator-param-row-label">分辨率</div>
            <div class="generator-param-chips">
              <button
                v-for="resolution in resolutionOptions"
                :key="resolution.key"
                type="button"
                class="generator-param-chip"
                :class="{ 'is-active': currentResolution === resolution.key }"
                @click.stop="selectResolution(resolution.key)"
              >{{ resolution.label }}</button>
            </div>
          </div>

          <!-- 数量：只在模型声明上限 > 1 时出现。
               上游只支持单条却摆一个按不动的控件是噪音，但摘要里照样交代「1个」 -->
          <div v-if="currentVideoMax > 1" class="generator-param-row">
            <div class="generator-param-row-label">数量</div>
            <GeneratorCountStepper v-model:value="currentCount" :max="currentVideoMax" unit="个" />
          </div>
        </div>
      </SelectPopup>
    </template>
  </div>
</template>

<style>
/* 主要样式在 generate.css 中定义 */
.video-toolbar {
  display: contents;
}

/* 视频时长滑杆行：滑杆占满，右侧固定显示「值 + s」 */
.generator-duration-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
}
.generator-duration-slider .el-slider {
  flex: 1;
  min-width: 120px;
}
.generator-duration-value {
  flex-shrink: 0;
  min-width: 34px;
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.generator-duration-value em {
  margin-left: 2px;
  font-style: normal;
  color: var(--text-tertiary);
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
