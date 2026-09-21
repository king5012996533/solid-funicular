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
}>(), {
  referenceImages: () => [],
  firstFrame: '',
  lastFrame: '',
  referenceLimit: 9,
  placement: 'auto',
})

const emit = defineEmits<{
  /** 选择了一批参考图：把原始 change 事件交给上层读取与截断 */
  addReferences: [event: Event]
  removeReference: [index: number]
  firstFrameChange: [event: Event]
  clearFirstFrame: []
  lastFrameChange: [event: Event]
  clearLastFrame: []
}>()

const isOpen = ref(false)
const triggerRef = ref<HTMLElement | null>(null)

const showReferences = computed(() => props.mode === 'image' || props.mode === 'agent')
const showFrames = computed(() => props.mode === 'video')
const hasContent = computed(() => showReferences.value || showFrames.value)
const canAddReference = computed(() => props.referenceImages.length < props.referenceLimit)

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
      title="高级设置"
      @click.stop="toggle"
    >
      <span>高级设置</span>
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
      </div>
    </SelectPopup>
  </div>
</template>

<style>
.advanced-params {
  display: contents;
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
