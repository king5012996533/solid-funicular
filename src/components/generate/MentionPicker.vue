<script setup lang="ts">
/**
 * @ 素材引用选择面板（两级）
 *
 * 一级列「有资产的种类 + 数量」，二级列该类资产（展示名 + token）。
 * 只产出纯文本 token（@图片1）：内联 chip 属于下一轮（libtv-reference-spec §2），
 * 所以这里选完只把 asset 抛给上层，token 插到哪、怎么插是 ContentGenerator 的职责。
 *
 * Teleport 目标优先挂在 .workflow-container 上，找不到才退回 body。
 *
 * 为什么不固定挂 body：画布配色 token（--canvas-float-block-default 等）定义在
 * .workflow-container 上，挂 body 会脱离该作用域、取到 styles.css 里的全局旧值 ——
 * 那套值不只色相偏蓝，**不透明度只有 72%**（画布内是 95%），配上 backdrop blur
 * 会让底下的节点内容透上来，面板看着发脏。
 * .workflow-container 只有 position: relative，没有 transform / filter / contain，
 * 所以挂进去以后 position: fixed 仍以视口为基准，也不会被它的 overflow: hidden 裁掉。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { groupReferenceAssets } from './mention-groups'
import type {
  ReferenceKind,
  ReferenceableAsset,
} from '@/views/workflow/composables/reference-resolver'

const props = defineProps<{
  visible: boolean
  assets: ReferenceableAsset[]
  anchor: { x: number; y: number }
}>()

const emit = defineEmits<{
  (e: 'select', asset: ReferenceableAsset): void
  (e: 'close'): void
}>()

// 定位用的常量：面板宽度在样式里是固定的，测量前先用它算，避免首帧闪一下
const PANEL_WIDTH = 200
const ANCHOR_GAP = 8
const VIEWPORT_MARGIN = 8

const panelRef = ref<HTMLElement | null>(null)

/**
 * Teleport 目标：进入画布上下文（存在 .workflow-container）时挂到画布容器上，
 * 以继承画布那套配色 token；否则退回 body。
 * 用字符串而非元素引用：容器是页面级常驻节点，组件挂载时它一定已经在 DOM 里了。
 */
const teleportTarget = ref<string>('body')
onMounted(() => {
  if (document.querySelector('.workflow-container')) {
    teleportTarget.value = '.workflow-container'
  }
})
const placed = ref({ left: 0, top: 0 })
const panelStyle = computed(() => ({
  left: `${placed.value.left}px`,
  top: `${placed.value.top}px`,
}))

const groups = computed(() => groupReferenceAssets(props.assets))
const hasAssets = computed(() => groups.value.length > 0)

const level = ref<'kind' | 'asset'>('kind')
const activeKind = ref<ReferenceKind | null>(null)
const highlight = ref(0)

const activeGroup = computed(() => groups.value.find(group => group.kind === activeKind.value) ?? null)
// 资产可能中途被清空：这时 activeGroup 为空，就退回一级列表，而不是渲染一个空二级页
const showAssets = computed(() => level.value === 'asset' && activeGroup.value !== null)
const optionCount = computed(() =>
  showAssets.value ? (activeGroup.value?.items.length ?? 0) : groups.value.length,
)

const enterKind = (kind: ReferenceKind) => {
  activeKind.value = kind
  level.value = 'asset'
  highlight.value = 0
}

const backToKinds = () => {
  level.value = 'kind'
  highlight.value = 0
}

const activate = (index: number) => {
  if (showAssets.value) {
    const asset = activeGroup.value?.items[index]
    if (asset) emit('select', asset)
    return
  }
  const group = groups.value[index]
  if (group) enterKind(group.kind)
}

const move = (delta: number) => {
  const count = optionCount.value
  if (count === 0) return
  // 环形移动：到最后一项再按 ↓ 回到第一项，键盘不用先「回程」
  highlight.value = (highlight.value + delta + count) % count
}

const place = () => {
  const el = panelRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const width = rect.width || PANEL_WIDTH
  const height = rect.height
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 优先贴在锚点上方：锚点是输入框，往上弹才不会盖住正在输入的那一行
  let top = props.anchor.y - height - ANCHOR_GAP
  if (top < VIEWPORT_MARGIN) top = props.anchor.y + ANCHOR_GAP
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN)
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop)

  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN)
  const left = Math.min(Math.max(props.anchor.x, VIEWPORT_MARGIN), maxLeft)

  placed.value = { left, top }
}

const handlePointerDown = (event: MouseEvent) => {
  if (!props.visible) return
  if (panelRef.value?.contains(event.target as Node)) return
  emit('close')
}

const handleKeydown = (event: KeyboardEvent) => {
  if (!props.visible) return
  switch (event.key) {
    case 'Escape':
      emit('close')
      break
    case 'ArrowDown':
      // 阻止默认行为，否则方向键会同时在底层输入框里移动光标
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Enter':
      // 同理：回车不能再冒泡给输入框，否则会换行/提交
      event.preventDefault()
      activate(highlight.value)
      break
    default:
      break
  }
}

watch(
  () => props.visible,
  async (visible: boolean) => {
    if (!visible) {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeydown)
      return
    }
    // 每次打开都从「种类」重新开始：记住上次的层级和位置只会让人误选
    level.value = 'kind'
    activeKind.value = null
    highlight.value = 0
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeydown)
    await nextTick()
    place()
  },
  { immediate: true },
)

// 锚点跟手（输入框滚动/移动）或层级切换导致列表长度变化时，重新贴靠与夹取
watch(
  () => [props.anchor.x, props.anchor.y, optionCount.value] as const,
  async () => {
    if (highlight.value >= optionCount.value) highlight.value = 0
    if (!props.visible) return
    await nextTick()
    place()
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handlePointerDown)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport :to="teleportTarget">
    <Transition name="mention-picker">
      <div
        v-if="visible"
        ref="panelRef"
        class="mention-picker"
        :style="panelStyle"
        role="menu"
        aria-label="素材引用"
        @mousedown.stop
        @click.stop
      >
        <div class="mention-picker__header">
          <!-- 二级才有返回：一级本来就没有上一级可退 -->
          <button
            v-if="showAssets"
            type="button"
            class="mention-picker__back"
            aria-label="返回种类列表"
            @click="backToKinds"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 5l-7 7 7 7"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <span class="mention-picker__title">{{ showAssets ? activeGroup?.label : '素材引用' }}</span>
        </div>

        <div v-if="hasAssets" class="mention-picker__list">
          <template v-if="showAssets">
            <button
              v-for="(asset, index) in activeGroup?.items ?? []"
              :key="asset.token"
              type="button"
              class="mention-picker__row"
              :class="{ 'is-active': index === highlight }"
              role="menuitem"
              @mouseenter="highlight = index"
              @click="emit('select', asset)"
            >
              <span class="mention-picker__row-name">{{ asset.displayName }}</span>
              <span class="mention-picker__row-token">{{ asset.token }}</span>
            </button>
          </template>

          <template v-else>
            <button
              v-for="(group, index) in groups"
              :key="group.kind"
              type="button"
              class="mention-picker__row"
              :class="{ 'is-active': index === highlight }"
              role="menuitem"
              @mouseenter="highlight = index"
              @click="enterKind(group.kind)"
            >
              <span class="mention-picker__row-name">{{ group.label }}</span>
              <span class="mention-picker__row-token">{{ group.items.length }}</span>
            </button>
          </template>
        </div>

        <div v-else class="mention-picker__empty">暂无可引用资产，请连入后操作</div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mention-picker {
  position: fixed;
  z-index: 220;
  box-sizing: border-box;
  width: 200px;
  padding: 4px;
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--canvas-float-backdrop-blur));
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  box-shadow: var(--shadow-generator-float-block);
  color: var(--text-primary);
  font-size: 13px;
  user-select: none;
}

.mention-picker__header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

.mention-picker__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-picker__back {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.mention-picker__back:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}

.mention-picker__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

/* 键盘高亮与鼠标 hover 共用一套底色：两种操作方式看到的「当前项」必须一致 */
.mention-picker__row.is-active {
  background: var(--bg-block-secondary-hover);
}

.mention-picker__row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-picker__row-token {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-size: 12px;
}

.mention-picker__empty {
  padding: 12px 8px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.mention-picker-enter-active,
.mention-picker-leave-active {
  transition: opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1), transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
}

.mention-picker-enter-from,
.mention-picker-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
