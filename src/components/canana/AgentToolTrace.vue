<script setup>
/**
 * 画布 Agent 的工具调用轨迹（方案 C · 极简流）。
 *
 * 设计稿：`refund-e2e/mock-c.html`（唯一视觉基准）。一条规则：
 *   - 单一工具 → 一行 30px 细条（状态图标 + 动作名 + · + 摘要 + 耗时 + ⌄）；
 *   - 同一回合 ≥2 个工具 → 合并成一行「N 个步骤 · 名称1、名称2、名称3 · 总耗时」；
 *   - 需要细节时点开，展开区用等宽字体、可滚动、逐条列出。
 *
 * 刻意只做「呈现」：step 的数据形状（index/name/label/summary/ok）一行都不改 ——
 * 耗时是面板侧按到达时间算的显示字段（stepTimes / turnStartedAt），不写回 step 本身。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** 已完成的工具步骤：{ index, name, label, summary, ok }[]（来自桥的 onStep） */
  steps: { type: Array, default: () => [] },
  /** 每个步骤完成时的墙钟（与 steps 一一对应，仅用于显示耗时） */
  stepTimes: { type: Array, default: () => [] },
  /** 这一轮开始的时间（用于算第一步/总耗时） */
  turnStartedAt: { type: Number, default: 0 },
  /** 正在执行、还没回执的那一步的动作名（空串 = 没有在执行） */
  pendingLabel: { type: String, default: '' },
})

const expanded = ref(false)

const isGroup = computed(() => props.steps.length >= 2)
const hasFailure = computed(() => props.steps.some((step) => !step.ok))
const statusGlyph = computed(() => (hasFailure.value ? '!' : '✓'))
const statusClass = computed(() => (hasFailure.value ? 'is-fail' : 'is-ok'))
const groupTitles = computed(() => props.steps.map((step) => step.label).join('、'))

const formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

// 单一工具条上显示这一步自己的耗时；合并条显示整轮总耗时
const totalLabel = computed(() => {
  const times = props.stepTimes || []
  if (!props.turnStartedAt || !times.length) return ''
  const start = props.turnStartedAt
  const last = times[times.length - 1]
  return formatDuration(last - start)
})
</script>

<template>
  <div v-if="steps.length" class="agent-tool-wrap">
    <button
      type="button"
      class="agent-tool-bar"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span :class="['agent-tool-dot', statusClass]">{{ statusGlyph }}</span>
      <span class="agent-tool-name">{{ isGroup ? `${steps.length} 个步骤` : steps[0].label }}</span>
      <template v-if="isGroup">
        <span class="agent-tool-sep">·</span>
        <span class="agent-tool-text">{{ groupTitles }}</span>
      </template>
      <template v-else>
        <span v-if="steps[0].summary" class="agent-tool-sep">·</span>
        <span v-if="steps[0].summary" class="agent-tool-text">{{ steps[0].summary }}</span>
      </template>
      <span v-if="totalLabel" class="agent-tool-time">{{ totalLabel }}</span>
      <span :class="['agent-tool-chev', { 'is-open': expanded }]">⌄</span>
    </button>

    <div v-if="expanded" class="agent-tool-detail">
      <div v-for="step in steps" :key="`${step.index}-${step.name}`" class="agent-tool-detail__row">
        <div class="agent-tool-detail__head">
          <span :class="['agent-tool-detail__mark', step.ok ? 'is-ok' : 'is-fail']">{{ step.ok ? '✓' : '!' }}</span>
          <span>#{{ step.index }} {{ step.label }}</span>
        </div>
        <div v-if="step.summary" class="agent-tool-detail__sum">{{ step.summary }}</div>
      </div>
    </div>
  </div>

  <div v-if="pendingLabel" class="agent-tool-wrap is-running">
    <div class="agent-tool-bar is-static">
      <span class="agent-tool-dot is-run">◌</span>
      <span class="agent-tool-name">{{ pendingLabel }}</span>
      <span class="agent-tool-time">执行中…</span>
      <span class="agent-tool-chev">⌄</span>
    </div>
  </div>
</template>

<style scoped>
/* 颜色/圆角 token 取自设计稿 mock-c.html；定义在面板根节点上，这里只做继承消费 */
.agent-tool-wrap {
  margin: 8px 0;
  border: 1px solid var(--agent-line-soft, #1e2027);
  border-radius: var(--agent-r-sm, 8px);
  background: var(--agent-surface-2, #14161b);
  overflow: hidden;
}
.agent-tool-wrap:hover {
  background: #181a20;
  border-color: var(--agent-line, #24262d);
}
.agent-tool-wrap.is-running {
  border-color: rgba(124, 92, 255, 0.35);
}
.agent-tool-wrap.is-running:hover {
  background: var(--agent-surface-2, #14161b);
  border-color: rgba(124, 92, 255, 0.35);
}

.agent-tool-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--agent-text-2, #9aa0a8);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.agent-tool-bar.is-static {
  cursor: default;
}

.agent-tool-dot {
  display: grid;
  place-items: center;
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 10px;
}
.agent-tool-dot.is-ok {
  background: rgba(61, 220, 151, 0.14);
  color: var(--agent-ok, #3ddc97);
}
.agent-tool-dot.is-fail {
  background: rgba(255, 107, 107, 0.16);
  color: #ff6b6b;
}
.agent-tool-dot.is-run {
  background: rgba(124, 92, 255, 0.16);
  color: #b9a6ff;
  animation: agent-tool-spin 1.1s linear infinite;
}
@keyframes agent-tool-spin {
  to { transform: rotate(360deg); }
}

.agent-tool-name {
  flex: none;
  color: var(--agent-text, #e8eaed);
  font-weight: 500;
}
.agent-tool-sep {
  flex: none;
  color: var(--agent-text-3, #6b7280);
}
.agent-tool-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tool-time {
  flex: none;
  margin-left: auto;
  color: var(--agent-text-3, #6b7280);
  font-size: 11px;
}
.agent-tool-chev {
  flex: none;
  color: var(--agent-text-3, #6b7280);
  font-size: 10px;
  transition: transform 0.15s;
}
.agent-tool-chev.is-open {
  transform: rotate(180deg);
}

.agent-tool-detail {
  max-height: 160px;
  overflow: auto;
  padding: 6px 10px;
  border-top: 1px dashed var(--agent-line-soft, #1e2027);
  background: #101216;
  font: 12px/1.6 ui-monospace, Consolas, monospace;
  color: var(--agent-text-2, #9aa0a8);
}
.agent-tool-detail__row + .agent-tool-detail__row {
  margin-top: 4px;
}
.agent-tool-detail__head {
  display: flex;
  gap: 6px;
  color: var(--agent-text, #e8eaed);
}
.agent-tool-detail__mark.is-ok { color: var(--agent-ok, #3ddc97); }
.agent-tool-detail__mark.is-fail { color: #ff6b6b; }
.agent-tool-detail__sum {
  margin-left: 20px;
  word-break: break-word;
}
</style>
