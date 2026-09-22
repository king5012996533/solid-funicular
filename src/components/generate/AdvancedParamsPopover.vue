<script setup lang="ts">
// 高级设置：只收「已实现、且真的会提交给上游」的次要参数。
// 目前只有两组：
//   - 参考图（图片 / Agent 模式，走 send 的 referenceImages）
//   - 视频首帧 / 尾帧（同样落到 referenceImages）
// 随机种子、负面提示词这类上游没接的参数一律不摆 —— 摆一个点了没反应的控件比不摆更糟。

import { computed, ref } from 'vue'
import SelectPopup from './common/SelectPopup.vue'
import type { CreationType } from './selectors'

type Placement = 'top' | 'bottom' | 'auto'

const props = withDefaults(defineProps<{
  /** 当前创作类型：决定展示参考图还是首尾帧 */
  mode: CreationType
  /** 图片 / Agent 模式的参考图 */
  referenceImages?: string[]
  /** 视频首帧 */
  firstFrame?: string
  /** 视频尾帧 */
  lastFrame?: string
  /** 参考图数量上限 */
  referenceLimit?: number
  placement?: Placement
  /** 提交前校验参考素材（开关，原来是放在页脚那一行里的） */
  autoValidateReferences?: boolean
  /** 智能引用 AutoLink：上游连入而没被 @ 的素材自动进本次提交 */
  autoLinkEnabled?: boolean
  /** 本次会自动引用几个（用来在触发器上点一个小圆点，不占宽度） */
  autoLinkedCount?: number
}>(), {
  referenceImages: () => [],
  firstFrame: '',
  lastFrame: '',
  referenceLimit: 9,
  placement: 'auto',
  autoValidateReferences: true,
  autoLinkEnabled: true,
  autoLinkedCount: 0,
})

const emit = defineEmits<{
  /** 选择了一批参考图：把原始 change 事件交给上层读取与截断 */
  addReferences: [event: Event]
  removeReference: [index: number]
  firstFrameChange: [event: Event]
  clearFirstFrame: []
  lastFrameChange: [event: Event]
  clearLastFrame: []
  'update:autoValidateReferences': [value: boolean]
  'update:autoLinkEnabled': [value: boolean]
}>()

const isOpen = ref(false)
const triggerRef = ref<HTMLElement | null>(null)

const showReferences = computed(() => props.mode === 'image' || props.mode === 'agent')
const showFrames = computed(() => props.mode === 'video')
const hasContent = computed(() => showReferences.value || showFrames.value)
const canAddReference = computed(() => props.referenceImages.length < props.referenceLimit)
const triggerTitle = computed(() => {
  if (props.autoLinkEnabled && props.autoLinkedCount) {
    return `高级设置 · 智能引用会带上 ${props.autoLinkedCount} 个上游素材`
  }
  return '高级设置'
})

const toggle = (e: Event) => {
  e.stopPropagation()
  isOpen.value = !isOpen.value
}
</script>

<template>
  <div v-if="hasContent" class="advanced-params">
    <button
      ref="triggerRef"
      type="button"
      class="advanced-params-trigger"
      :aria-expanded="isOpen"
      :title="triggerTitle"
      @click.stop="toggle"
    >
      <span>高级设置</span>
      <!-- 智能引用开着且真有素材会被自动带上时点一个小圆点：
           这条信息原先占着一整行的地方，现在压缩成 6px，不占宽度 -->
      <span v-if="autoLinkEnabled && autoLinkedCount" class="advanced-params-dot" aria-hidden="true" />
      <svg class="advanced-params-chevron" width="1em" height="1em" viewBox="0 0 24 24"
           preserveAspectRatio="xMidYMid meet" fill="none" aria-hidden="true">
        <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
              d="M21.01 7.982A1.2 1.2 0 0 1 21 9.679l-8.156 8.06a1.2 1.2 0 0 1-1.688 0L3 9.68a1.2 1.2 0 0 1 1.687-1.707L12 15.199l7.313-7.227a1.2 1.2 0 0 1 1.697.01Z"
              fill="currentColor"></path>
      </svg>
    </button>

    <SelectPopup
      v-model:visible="isOpen"
      :trigger-ref="triggerRef"
      :placement="placement"
      title="高级设置"
      popup-class="generator-param-popup"
    >
      <div class="generator-param-panel advanced-params-panel">
        <!-- 参考图：图片 / Agent 模式 -->
        <div v-if="showReferences" class="generator-param-row">
          <div class="generator-param-row-label">参考图</div>
          <div class="advanced-params-grid">
            <div v-for="(url, index) in referenceImages"
                 :key="`${index}-${String(url).slice(0, 24)}`"
                 class="advanced-params-thumb">
              <img :src="url" alt="参考图" draggable="false">
              <button type="button" class="advanced-params-thumb-remove" aria-label="移除参考图"
                      @click.stop="emit('removeReference', index)">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>
                </svg>
              </button>
            </div>

            <label v-if="canAddReference" class="advanced-params-thumb advanced-params-thumb-add" title="添加参考图">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
              </svg>
              <input
                type="file"
                accept="image/jpeg,.jpeg,image/jpg,.jpg,image/png,.png,image/webp,.webp,image/bmp,.bmp"
                multiple
                class="sf-hidden"
                @change="emit('addReferences', $event)">
            </label>
          </div>
        </div>

        <!-- 首尾帧：视频模式 -->
        <template v-if="showFrames">
          <div class="generator-param-row">
            <div class="generator-param-row-label">首帧</div>
            <div class="advanced-params-grid">
              <div v-if="firstFrame" class="advanced-params-thumb">
                <img :src="firstFrame" alt="首帧" draggable="false">
                <button type="button" class="advanced-params-thumb-remove" aria-label="清除首帧"
                        @click.stop="emit('clearFirstFrame')">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>
                  </svg>
                </button>
              </div>
              <label v-else class="advanced-params-thumb advanced-params-thumb-add" title="上传首帧">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
                </svg>
                <input
                  type="file"
                  accept="image/jpeg,.jpeg,image/jpg,.jpg,image/png,.png,image/webp,.webp,image/bmp,.bmp"
                  class="sf-hidden"
                  @change="emit('firstFrameChange', $event)">
              </label>
            </div>
          </div>

          <div class="generator-param-row">
            <div class="generator-param-row-label">尾帧</div>
            <div class="advanced-params-grid">
              <div v-if="lastFrame" class="advanced-params-thumb">
                <img :src="lastFrame" alt="尾帧" draggable="false">
                <button type="button" class="advanced-params-thumb-remove" aria-label="清除尾帧"
                        @click.stop="emit('clearLastFrame')">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>
                  </svg>
                </button>
              </div>
              <label v-else class="advanced-params-thumb advanced-params-thumb-add" title="上传尾帧">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
                </svg>
                <input
                  type="file"
                  accept="image/jpeg,.jpeg,image/jpg,.jpg,image/png,.png,image/webp,.webp,image/bmp,.bmp"
                  class="sf-hidden"
                  @change="emit('lastFrameChange', $event)">
              </label>
            </div>
          </div>
        </template>

        <!-- 提交开关：与上面的次要参数同属「高级设置」。
             它们原先挤在页脚那一行里 —— 那一行是 `flex: 1 1; overflow: hidden`，
             两个开关要 269px 而整行只剩 128px，右边的直接被裁（实测溢出 172px）。
             LibTV 的开关本来也不在页脚，而在输入框下方的整行区域里。 -->
        <div class="generator-param-row advanced-params-switch-row">
          <div class="generator-param-row-label"
               title="提交前会校验参考素材的格式与可访问性，不通过则拦下">
            自动校验素材
          </div>
          <button
            type="button"
            class="generator-switch is-track-only"
            :class="{ 'is-on': autoValidateReferences }"
            role="switch"
            :aria-checked="autoValidateReferences"
            :title="autoValidateReferences
              ? '提交前会校验参考素材的格式与可访问性，不通过则拦下'
              : '已关闭：不校验参考素材，直接提交'"
            @click.stop="emit('update:autoValidateReferences', !autoValidateReferences)"
          >
            <span class="generator-switch__track" aria-hidden="true">
              <span class="generator-switch__thumb" />
            </span>
          </button>
        </div>

        <div class="generator-param-row advanced-params-switch-row">
          <div class="generator-param-row-label"
               title="上游连入、而你没 @ 的素材会自动引用进本次提交；关掉后只提交你显式 @ 的素材">
            智能引用 AutoLink
          </div>
          <button
            type="button"
            class="generator-switch is-track-only"
            :class="{ 'is-on': autoLinkEnabled }"
            role="switch"
            :aria-checked="autoLinkEnabled"
            :title="autoLinkEnabled
              ? '上游连入、而你没 @ 的素材会自动引用进本次提交；关掉后只提交你显式 @ 的素材'
              : '已关闭：只提交你在提示词里显式 @ 的素材'"
            @click.stop="emit('update:autoLinkEnabled', !autoLinkEnabled)"
          >
            <span class="generator-switch__track" aria-hidden="true">
              <span class="generator-switch__thumb" />
            </span>
          </button>
        </div>
        <!-- 开着且有素材时把「会带几个」写清楚，别让用户在看不见的情况下被塞素材 -->
        <div v-if="autoLinkEnabled && autoLinkedCount" class="advanced-params-switch-hint">
          本次会自动引用 {{ autoLinkedCount }} 个上游素材（在「已引用」里以「自动」标出）
        </div>
      </div>
    </SelectPopup>
  </div>
</template>

<style>
.advanced-params {
  display: contents;
}

/* 触发器上的小圆点：AutoLink 开着且有素材会被自动带上时才出现 */
.advanced-params-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand-main-default);
  flex-shrink: 0;
}

/* 开关行：标签在左、开关在右（与上面的次要参数同一套排版语言） */
.advanced-params-switch-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.advanced-params-switch-row .generator-switch__track {
  flex-shrink: 0;
}

.generator-switch.is-track-only {
  height: auto;
  padding: 0;
}

.generator-switch.is-track-only:hover {
  background: transparent;
}

.advanced-params-switch-hint {
  margin-top: -4px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 16px;
}

.advanced-params-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 450;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.advanced-params-trigger:hover,
.advanced-params-trigger:focus-visible {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}

.advanced-params-trigger:active {
  background: var(--bg-block-secondary-pressed);
}

.advanced-params-chevron {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
}

.advanced-params-panel {
  min-width: 240px;
}

.advanced-params-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.advanced-params-thumb {
  position: relative;
  box-sizing: border-box;
  width: 48px;
  height: 48px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  background: var(--bg-block-primary-default);
  overflow: hidden;
}

.advanced-params-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.advanced-params-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--canvas-float-block-default);
  color: var(--text-primary);
  cursor: pointer;
}

.advanced-params-thumb-remove:hover {
  color: var(--brand-main-default);
}

.advanced-params-thumb-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.advanced-params-thumb-add:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
</style>
