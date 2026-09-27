<script setup lang="ts">
/**
 * 音频节点（工作包 A）
 *
 * 与 VideoNode 同款结构（同一套卡片 / 标题 / 浮层规则，两处不能各写一份观感）：
 *   - 卡片固定 622 × 350（音频没有画面比例概念，直接复用生成类的横版档，见 config/node-size.ts）
 *   - 标题外置：图标 + 名称 + 右侧「时长 · 格式」摘要
 *   - 5 态：空态 / ready-state / 加载 / 有音频（<audio controls>）/ 失败
 *   - 选中后下方浮出 ContentGenerator（initial-creation-type="audio"，参数交给 AudioToolbar）
 *
 * **音频节点是终点节点**：上游只吃文本（当提示词），产出没有任何下游会读
 * （兼容表 `audio: []`，理由见 config/node-suggestions.ts）。所以这里：
 *   · 不收集图片参考（音频请求体不接受图片/音频参考，收了就是假交互）；
 *   · 卡片上不放参数控件（时长/格式由工具栏负责，放第二套就是重复入口）；
 *   · 空态不摆「上传音频 / 生成方式」之类的入口（没有真实实现的一律不摆）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { CopyDocument, Delete, Download, Headset } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import CanvasNodeHoverToolbar, { type NodeToolbarAction } from '@/components/canvas/CanvasNodeHoverToolbar.vue'
import ContentGenerator, { type GeneratorParamsSnapshot } from '@/components/generate/ContentGenerator.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import { useNodeTitleEdit } from '@/composables/useNodeTitleEdit'
import {
  createGenerationTask,
  resolveGenerationTaskModel,
  subscribeGenerationTaskEvents,
  type GenerationTaskStreamEvent,
} from '@/api/generation-tasks'
import { registerNodeRunner, unregisterNodeRunner } from '@/views/workflow/composables/useCanvasNodeRunner'
import {
  clearAgentActiveNodesForIds,
  useAgentActiveNodes,
} from '@/views/workflow/composables/useAgentActiveNodes'
import {
  updateNode,
  removeNode,
  duplicateNode,
  type WorkflowAudioNodeData,
} from '../../composables/useWorkflowCanvas'
import { getDefaultAudioModelKey, loadPublicModelCatalog } from '@/config/models'
import { collectUpstreamPromptText, composePrompt } from '../../composables/upstream-inputs'
import { useNodeInputState } from '../../composables/node-input-requirements'
import { useNodeCollapse } from '../../composables/useNodeCollapse'
import { cardSizeStyle, resolveGenerationCardSize } from '../../config/node-size'
import { useComposerPanel } from '../../composables/useComposerPanel'
import {
  buildAudioRequestBody,
  formatAudioSummary,
  resolveAudioArtifact,
  resolveAudioCardState,
} from './audio-node-model'

const props = defineProps<{
  id: string
  data: WorkflowAudioNodeData & { selected?: boolean }
  selected?: boolean
}>()

const isSelected = computed(() => props.selected || props.data?.selected)
const titleEdit = useNodeTitleEdit(props.id, () => props.data?.label || '音频节点')
const { updateNodeInternals } = useVueFlow()

/** Agent 画布动作高亮（仅 UI 的瞬时描边，不进节点数据）。详见 ImageNode 同款注释 */
const { isAgentCreated, isAgentGenerating, staggerDelayMs } = useAgentActiveNodes()
const agentCreated = computed(() => isAgentCreated(props.id))
const agentGenerating = computed(() => isAgentGenerating(props.id))
const agentHighlightStyle = computed(() => ({
  '--agent-stagger-delay': `${staggerDelayMs(props.id)}ms`,
}))

// 生成终态（loading 落回 false）：收掉本节点的「生成中」高亮（不能用 TTL 猜生成何时结束）
watch(
  () => props.data?.loading,
  (loading) => {
    if (loading === false) clearAgentActiveNodesForIds([props.id])
  },
)

/**
 * 音频卡片尺寸：固定 622 × 350（生成类横版档）。
 * 不传比例 —— 音频没有画面比例概念，写死成常量比每次算一遍更诚实。
 */
const AUDIO_CARD_SIZE = resolveGenerationCardSize()

const showActions = ref(false)
const audioUrl = ref(props.data?.url || '')
const isLoading = ref(!!props.data?.loading)
const errorMsg = ref(props.data?.error || '')
/** 音频生成也可能等一会儿，把上游阶段透出来，别让用户以为卡死了 */
const progressText = ref('')
let taskStreamController: AbortController | null = null

watch(
  [() => props.data?.url, () => props.data?.loading, () => props.data?.error],
  ([url, loading, error]) => {
    if (url !== undefined) audioUrl.value = url
    if (loading !== undefined) isLoading.value = loading
    if (error !== undefined) errorMsg.value = error
  },
)

/** 上游文本节点 → 本节点的提示词（音频的上游只有文本，见文件头） */
const upstreamPromptText = computed(() => collectUpstreamPromptText(props.id))
const composeFinalPrompt = (inline: string) => composePrompt(upstreamPromptText.value, inline)

const inputState = useNodeInputState(() => props.id)
const { collapsed, toggleCollapse } = useNodeCollapse(() => props.id)

/** 卡片状态判定全部交给纯逻辑（可单测），模板只按结果分支 */
const cardState = computed(() => resolveAudioCardState({
  loading: isLoading.value,
  error: errorMsg.value,
  url: audioUrl.value,
  // ready 的判定是「上游真的产出了内容」而不是「有一条边」：连了一个空的文本节点不算已连接
  hasUpstreamInput: inputState.value.satisfied.length > 0,
}))
const showLoading = computed(() => cardState.value === 'loading')
const showError = computed(() => cardState.value === 'error')
const showAudio = computed(() => cardState.value === 'audio')
const showReady = computed(() => cardState.value === 'ready')
const showEmpty = computed(() => cardState.value === 'empty')

/** 标题行右侧摘要「30s · mp3」；两段都没有时为空串（不显示，不瞎猜） */
const titleSummary = computed(() => formatAudioSummary({
  duration: props.data?.duration,
  format: props.data?.format,
}))

// === 参数：时长 / 模型由 AudioToolbar 负责，节点 data 只是持久化处 ===
const resolvedModelKey = computed(() => String(props.data?.model || '').trim() || getDefaultAudioModelKey())
const resolvedDuration = computed(() => {
  const fromNode = Number(props.data?.duration || 0)
  return fromNode > 0 ? String(fromNode) : ''
})
const appliedParams = computed<GeneratorParamsSnapshot>(() => ({
  modelKey: resolvedModelKey.value,
  duration: resolvedDuration.value,
}))

/** 工具栏改了参数就写回节点（值相同不写，避免来回触发） */
const handleParamsChange = (params: GeneratorParamsSnapshot) => {
  const nextModel = String(params.modelKey || '')
  const nextDuration = Number(params.duration) || 0
  if (
    nextModel === String(props.data?.model || '')
    && nextDuration === Number(props.data?.duration || 0)
  ) {
    return
  }
  updateNode(props.id, { model: nextModel, duration: nextDuration })
}

/** 输入框浮层：固定 660 宽 + 不随画布缩放 + 被底部工具栏挡住时自动上移（规则见 useComposerPanel.ts） */
const composerRef = ref<HTMLElement | null>(null)
const { style: composerStyle } = useComposerPanel({
  el: composerRef,
  nodeId: () => props.id,
  cardHeight: () => AUDIO_CARD_SIZE.height,
})

const handleDownload = () => {
  if (!audioUrl.value) return
  const a = document.createElement('a')
  a.href = audioUrl.value
  a.download = `audio_${Date.now()}.${props.data?.format || 'mp3'}`
  a.click()
}

const handleDelete = () => removeNode(props.id)
const handleDuplicate = () => {
  const newId = duplicateNode(props.id)
  if (newId) setTimeout(() => updateNodeInternals([newId]), 50)
}

/**
 * 音频节点的动作条：**只上有真实实现的**（对齐图片 / 视频节点纪律 —— 宁可少放，
 * 也不摆「接入中」的假入口）。复制 / 下载 / 删除，下载只在真的有产物时出现。
 */
const hoverActions = computed<NodeToolbarAction[]>(() => {
  const list: NodeToolbarAction[] = [
    { id: 'duplicate', label: '复制', icon: CopyDocument, onClick: handleDuplicate },
  ]
  if (audioUrl.value) {
    list.push({ id: 'download', label: '下载', icon: Download, onClick: handleDownload })
  }
  list.push({ id: 'delete', label: '删除', icon: Delete, danger: true, onClick: handleDelete })
  return list
})

const handlePromptSend = (
  text: string,
  _type: string,
  options?: GeneratorParamsSnapshot & {
    referenceImages?: string[]
    unresolvedReferences?: string[]
    autoLink?: boolean
  },
) => {
  const prompt = composeFinalPrompt(text)
  if (!prompt) {
    ElMessage.info('请先写提示词，或从上游接一个文本节点')
    return
  }
  // 写错的 token（序号越界 / 资产已失效）不阻塞提交，但要报清楚哪几处没生效，
  // 否则用户以为引用了实际没有，属于静默失败
  const unresolvedRefs = Array.isArray(options?.unresolvedReferences)
    ? options.unresolvedReferences.filter(Boolean)
    : []
  if (unresolvedRefs.length) {
    ElMessage.warning(`有 ${unresolvedRefs.length} 处引用已失效：${unresolvedRefs.join('、')}`)
  }
  const params = options || appliedParams.value
  void runGeneration({
    prompt,
    modelKey: String(params.modelKey || props.data?.model || '').trim(),
    duration: params.duration ? String(params.duration) : '',
  })
}

/** 提交阶段：建任务 → 立刻把 taskId / 参数写回节点。任何失败都抛出（调用方要如实回执，不能吞） */
const submitGeneration = async (input: {
  prompt: string
  modelKey: string
  duration?: string
}) => {
  const { providerId, modelKey } = await resolveGenerationTaskModel({
    modelKey: input.modelKey,
    category: 'AUDIO',
    missingModelMessage: '未匹配到有效的音频模型，请先在后台配置',
  })
  const saved = await createGenerationTask({
    source: 'workflow',
    type: 'audio',
    prompt: input.prompt,
    modelKey,
    duration: input.duration,
    requestBody: buildAudioRequestBody({
      providerId,
      modelKey,
      prompt: input.prompt,
      duration: input.duration,
    }),
  })
  const taskId = String(saved?.id || '').trim()
  if (!taskId) throw new Error('音频任务创建失败')

  // 提交时就落库：提示词/参数给「重试」用，taskId 给「刷新后对账」用（与图片 / 视频节点同一个教训）
  updateNode(props.id, {
    prompt: input.prompt,
    model: modelKey,
    duration: Number(input.duration) || 0,
    taskRecordId: taskId,
    submittedAt: Date.now(),
    loading: true,
    error: '',
  })
  return taskId
}

/**
 * 提交与重试共用：提交 → 等结果（用户手动路径）。
 * 与 VideoNode 刻意保持一致（同一套失败/停止处理），差异只在参数与产物字段。
 */
const runGeneration = async (input: {
  prompt: string
  modelKey: string
  duration?: string
}) => {
  try {
    isLoading.value = true
    errorMsg.value = ''
    const taskId = await submitGeneration(input)
    const controller = new AbortController()
    taskStreamController = controller
    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: applyTaskEvent,
    })
  } catch (err: unknown) {
    console.error('[AudioNode] generation failed', err)
    isLoading.value = false
    errorMsg.value = err instanceof Error ? err.message : '音频生成失败'
    updateNode(props.id, { loading: false, error: errorMsg.value })
  }
}

/** 事件流：进度写到卡片上，完成时把产物（地址 / 时长 / 格式）落回节点 */
const applyTaskEvent = (event: GenerationTaskStreamEvent) => {
  if (event.type === 'progress' || event.type === 'snapshot') {
    const stage = String((event as { message?: string }).message || (event as { stage?: string }).stage || '').trim()
    if (stage && isLoading.value) progressText.value = stage
    return
  }
  if (event.type === 'completed') {
    // 产物解析交给纯逻辑：outputs[].url / mimeType / durationSeconds 全按外部数据收敛
    const artifact = resolveAudioArtifact(
      (event.record || {}) as Record<string, unknown>,
      Number(props.data?.duration) || 0,
    )
    if (artifact) {
      isLoading.value = false
      progressText.value = ''
      updateNode(props.id, {
        url: artifact.url,
        duration: artifact.duration,
        format: artifact.format,
        loading: false,
        error: '',
        executed: true,
        submittedAt: 0,
      })
    }
    // 完成但没拿到音频地址时**不写空成功**：服务端那条记录本身已经是异常，
    // 卡片保持 loading 直到用户重试，比显示一个「成功但没有声音」的节点更诚实。
    return
  }
  if (event.type === 'failed') {
    isLoading.value = false
    errorMsg.value = String((event as { message?: string }).message || (event.record as { error?: string })?.error || '音频生成失败')
    updateNode(props.id, { loading: false, error: errorMsg.value })
    return
  }
  if (event.type === 'stopped') {
    isLoading.value = false
    errorMsg.value = '任务已停止，可以重试'
    updateNode(props.id, { loading: false, error: errorMsg.value })
  }
}

/**
 * 供画布助手调用：用节点当前参数**提交一次音频生成**。
 *
 * 与 ImageNode / VideoNode 同样「提交即返回」（一次 run_node 不该卡到出片），
 * 出片由本节点自己的事件流落回 url。提交阶段失败必须抛出去，工具层据此如实回执。
 */
const runOnceForAgent = async () => {
  // 节点自己存的提示词要当 inline 传进去：composeFinalPrompt 只负责把「上游文本节点的内容」
  // 与 inline 拼起来，不读 data.prompt —— 直接传 '' 会导致明明有提示词却报「还没有提示词」
  const stored = String(props.data?.prompt || '').trim()
  const prompt = composeFinalPrompt(stored) || stored
  if (!prompt) throw new Error('该音频节点还没有提示词，先给它写一个（update_node 的 prompt）')
  isLoading.value = true
  errorMsg.value = ''
  let taskId = ''
  try {
    taskId = await submitGeneration({
      prompt,
      modelKey: String(props.data?.model || '').trim(),
      duration: props.data?.duration ? String(props.data.duration) : '',
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '音频生成提交失败'
    isLoading.value = false
    errorMsg.value = message
    updateNode(props.id, { loading: false, error: message })
    throw err instanceof Error ? err : new Error(message)
  }
  const controller = new AbortController()
  taskStreamController = controller
  void subscribeGenerationTaskEvents(taskId, {
    signal: controller.signal,
    onEvent: applyTaskEvent,
  }).catch((err: unknown) => {
    if ((err as { name?: string })?.name === 'AbortError') return
    isLoading.value = false
    errorMsg.value = err instanceof Error ? err.message : '音频结果订阅中断'
    updateNode(props.id, { loading: false, error: errorMsg.value })
  })
}

onMounted(() => {
  // 音频模型目录也要拉：工具栏的「模型 + 时长」选项全来自它
  void loadPublicModelCatalog()
  registerNodeRunner(props.id, runOnceForAgent)
})

onBeforeUnmount(() => {
  unregisterNodeRunner(props.id)
  taskStreamController?.abort()
  taskStreamController = null
  // 组件卸载（切画布/删节点）：收掉本节点的高亮，别养着一个不再存在的 id
  clearAgentActiveNodesForIds([props.id])
})
</script>

<template>
  <div class="audio-node-wrapper" @mouseenter="showActions = true" @mouseleave="showActions = false">
    <div class="audio-node-title" :title="titleEdit.editing.value ? '' : '双击编辑名称'" @dblclick.stop="titleEdit.start">
      <button
        type="button"
        class="node-collapse-toggle nodrag nopan"
        :class="{ 'is-collapsed': collapsed }"
        :title="collapsed ? '展开节点' : '折叠节点'"
        @click.stop="toggleCollapse"
        @mousedown.stop
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <el-icon class="audio-node-title-icon"><Headset /></el-icon>
      <input
        v-if="titleEdit.editing.value"
        :ref="titleEdit.setInputRef"
        v-model="titleEdit.draft.value"
        class="audio-node-title-input nodrag"
        :maxlength="40"
        @blur="titleEdit.commit"
        @keydown.enter.prevent="titleEdit.commit"
        @keydown.esc.prevent="titleEdit.cancel"
        @mousedown.stop
        @click.stop
      />
      <span v-else>{{ data?.label || '音频节点' }}</span>
      <span v-if="titleSummary" class="audio-node-title-summary">{{ titleSummary }}</span>
    </div>

    <div
      class="audio-node-card"
      :class="{ 'is-selected': isSelected, 'is-collapsed': collapsed, 'is-agent-created': agentCreated, 'is-agent-generating': agentGenerating }"
      :style="[cardSizeStyle(AUDIO_CARD_SIZE), agentHighlightStyle]"
    >
      <div v-if="collapsed" class="node-collapsed-summary">
        <span class="node-collapsed-summary__text">
          {{ inputState.connectedLabel || inputState.emptyLabel }}
        </span>
      </div>

      <template v-else>
        <!-- 空态：按类型声明它需要什么输入（对齐 LibTV：节点自己说清要连什么）。
             这里不摆任何入口 —— 上传 / 生成方式都没有对应的实现，摆了就是假入口。 -->
        <div v-if="showEmpty" class="audio-node-empty">
          <div class="audio-node-empty-hint">{{ inputState.emptyLabel }}</div>
          <div class="audio-node-empty-sub">选中节点后在下方写提示词并生成</div>
        </div>

        <!-- ready-state：上游真的产出了内容（文本），可以开跑 -->
        <div v-else-if="showReady" class="audio-node-ready">
          <el-icon class="audio-node-ready-icon"><Headset /></el-icon>
          <div class="audio-node-ready-text">{{ inputState.connectedLabel }}</div>
          <div class="audio-node-ready-hint">选中节点后在下方写提示词并生成</div>
        </div>

        <div v-else-if="showLoading" class="audio-node-loading">
          <div class="audio-node-spinner" />
          <span>{{ progressText || '生成中…' }}</span>
        </div>

        <!-- 失败态：只陈述事实。音频没有「重新上传」这条出路，所以不挂那个假出口 -->
        <div v-else-if="showError" class="audio-node-error">
          <span>{{ errorMsg }}</span>
        </div>

        <!-- 有产物：直接给能播的播放器（音频只有一个表达方式，就是听） -->
        <div v-else-if="showAudio" class="audio-node-player-wrap">
          <el-icon class="audio-node-player-deco"><Headset /></el-icon>
          <audio
            class="audio-node-player nodrag nopan"
            :src="audioUrl"
            controls
            preload="metadata"
            @mousedown.stop
            @wheel.stop
          />
        </div>
      </template>
    </div>

    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />

    <CanvasNodeHoverToolbar :visible="showActions" :actions="hoverActions" />

    <div
      v-if="isSelected && !showLoading"
      ref="composerRef"
      class="audio-node-prompt-panel nodrag nopan"
      :style="composerStyle"
      @mousedown.stop
    >
      <!-- 提示词一直存在 data.prompt 里（生成 / 重试 / 画布助手都在用），输入框要接它，
           否则「助手已经帮你填好了提示词」在界面上看不出来。
           注意：模板注释必须放在标签**外面**，塞进属性列表会让整个组件编译失败、页面白屏。 -->
      <ContentGenerator
        layout="sidebar"
        :collapsible="false"
        :default-expanded="true"
        initial-creation-type="audio"
        :hide-type-selector="true"
        :hide-image-upload="true"
        :verbose-toolbar="true"
        :external-prompt="String(data?.prompt || '')"
        :prompt-sync-key="String(data?.prompt || '')"
        :initial-params="appliedParams"
        placeholder-override="描述你想生成的音频内容，按 Enter 发送"
        popup-placement="top"
        @params-change="handleParamsChange"
        @send="handlePromptSend"
      />
    </div>
  </div>
</template>

<style scoped>
.audio-node-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

.audio-node-title {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: var(--canvas-node-title-gap);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--canvas-node-title-line);
  padding: 0 8px 0 2px;
  border-radius: 4px;
  color: var(--canvas-node-title-fg);
  font-size: var(--canvas-node-title-size);
  font-weight: var(--canvas-node-title-weight);
  line-height: var(--canvas-node-title-line);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s, color 0.2s;
}
.audio-node-title:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}
.audio-node-title-icon {
  font-size: var(--canvas-node-title-icon);
  color: var(--canvas-node-title-fg);
}
.audio-node-title-input {
  flex: 1 1 0;
  min-width: 80px;
  max-width: 220px;
  background: transparent;
  border: 1px solid var(--brand-main-default);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  outline: none;
  box-sizing: border-box;
}
.audio-node-title-summary {
  /* 贴到标题行最右（对齐 LibTV：名字在左、参数摘要在右），与视频节点的输出尺寸同一规范 */
  margin-left: auto;
  color: var(--canvas-node-meta-fg);
  font-size: var(--canvas-node-meta-size);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.audio-node-card {
  position: relative;
  background: var(--canvas-node-bg);
  border: 1px solid var(--canvas-node-border);
  /* LibTV 实测 12px */
  border-radius: 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  transition: border-color 0.16s;
}
.audio-node-card.is-selected {
  border-color: var(--canvas-node-border-selected);
}
/* Agent 画布动作高亮（仅 UI 的瞬时描边，不进节点数据）：刚创建=实线渐隐，生成中=虚线脉冲 */
.audio-node-card.is-agent-created {
  border-color: var(--canvas-agent-active, #7c5cff);
  animation: canvas-agent-created-fade 4s ease-out forwards;
  animation-delay: var(--agent-stagger-delay, 0ms);
}
.audio-node-card.is-agent-generating {
  border-color: var(--canvas-agent-active, #7c5cff);
  border-style: dashed;
  animation: canvas-agent-generating-pulse 1.6s ease-in-out infinite;
  animation-delay: var(--agent-stagger-delay, 0ms);
}
@keyframes canvas-agent-created-fade {
  0%, 70% { border-color: var(--canvas-agent-active, #7c5cff); }
  100% { border-color: var(--canvas-node-border, #ffffff14); }
}
@keyframes canvas-agent-generating-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(124, 92, 255, 0); }
  50% { box-shadow: 0 0 0 2px rgba(124, 92, 255, 0.22); }
}

.audio-node-empty {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
}
/* 输入需求声明：告诉用户该去连什么才能开始 */
.audio-node-empty-hint {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}
.audio-node-empty-sub {
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}

.audio-node-ready {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  padding: 24px;
}
.audio-node-ready-icon {
  font-size: 40px;
  opacity: 0.6;
}
.audio-node-ready-text {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}
.audio-node-ready-hint {
  color: var(--text-tertiary);
  font-size: 12px;
}

.audio-node-loading,
.audio-node-error {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 0 20px;
  text-align: center;
}
.audio-node-error {
  color: #ef4444;
}
.audio-node-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--stroke-secondary);
  border-top-color: var(--brand-main-default);
  animation: audio-node-spin 0.8s linear infinite;
}
@keyframes audio-node-spin {
  to { transform: rotate(360deg); }
}

.audio-node-player-wrap {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px;
}
.audio-node-player-deco {
  font-size: 44px;
  color: var(--brand-music);
  opacity: 0.85;
}
/* 原生播放器的宽度撑满卡片内容区，不随画布缩放产生的小数宽度抖动 */
.audio-node-player {
  width: 100%;
  max-width: 420px;
  border-radius: var(--lv-border-radius-medium);
}

/* 宽 660、不随画布缩放 —— 都由内联 style 给（见 useComposerPanel），这里只负责挂到卡片正下方 */
.audio-node-prompt-panel {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  z-index: 5;
}
</style>
