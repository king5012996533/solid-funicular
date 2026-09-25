<script setup lang="ts">
/**
 * 视频节点（RunningHUB 风样板）
 *
 * 与 ImageNode 同款结构：
 *   - 卡片 380×280, border-radius 16
 *   - 标题外置
 *   - 4 类状态：空态菜单 / ready-state / 加载 / 有视频
 *   - 选中态：青绿描边 + 流光边框
 *   - 节点外 -56px "+" 按钮
 *   - 选中后下方浮出 CanvasPromptInput（视频模型 + 480p/5s/... chip + ¥3）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import {
  CopyDocument,
  Download,
  Delete,
  VideoCamera,
  Aim,
  Film,
  Upload as UploadIcon,
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import CanvasNodeHoverToolbar, { type NodeToolbarAction } from '@/components/canvas/CanvasNodeHoverToolbar.vue'
import ContentGenerator, { type GeneratorParamsSnapshot } from '@/components/generate/ContentGenerator.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import { useNodeTitleEdit } from '@/composables/useNodeTitleEdit'
import { createGenerationTask, resolveGenerationTaskModel, subscribeGenerationTaskEvents, type GenerationTaskStreamEvent } from '@/api/generation-tasks'
import { registerNodeRunner, unregisterNodeRunner } from '@/views/workflow/composables/useCanvasNodeRunner'
import {
  updateNode,
  removeNode,
  duplicateNode,
  type WorkflowVideoNodeData,
} from '../../composables/useWorkflowCanvas'
import { uploadStorageFile } from '@/api/storage'
import { loadPublicModelCatalog, getModelByName, getDefaultVideoModelKey, type VideoModel } from '@/config/models'
import { describeAspectRatio, pickValidChoice, resolveVideoParamSchema } from '@/config/model-params'
import { collectUpstreamPromptText, composePrompt } from '../../composables/upstream-inputs'
import { useNodeInputState } from '../../composables/node-input-requirements'
import { useNodeCollapse } from '../../composables/useNodeCollapse'
import { inboundEdges, nodeIndex } from '../../composables/workflow-graph-index'
import { collectReferenceableAssets } from '../../composables/reference-resolver'
import { cardSizeStyle, resolveGenerationCardSize } from '../../config/node-size'
import { parseAspectRatio } from '@/config/model-params'
import { useComposerPanel } from '../../composables/useComposerPanel'

const props = defineProps<{
  id: string
  data: WorkflowVideoNodeData & { selected?: boolean }
  selected?: boolean
}>()
const isSelected = computed(() => props.selected || props.data?.selected)
const titleEdit = useNodeTitleEdit(props.id, () => props.data?.label || 'Video')
const { updateNodeInternals } = useVueFlow()

const showActions = ref(false)
const videoUrl = ref(props.data?.url || '')
const isLoading = ref(!!props.data?.loading)
const errorMsg = ref(props.data?.error || '')
/** 视频是长任务（动辄几分钟），必须把上游状态透出来，否则用户以为卡死了 */
const progressText = ref('')
let taskStreamController: AbortController | null = null
const fileInputRef = ref<HTMLInputElement | null>(null)

watch(
  [() => props.data?.url, () => props.data?.loading, () => props.data?.error],
  ([url, loading, error]) => {
    if (url !== undefined) videoUrl.value = url
    if (loading !== undefined) isLoading.value = loading
    if (error !== undefined) errorMsg.value = error
  },
)

/**
 * 上游素材 → 本节点的输入。
 * 文本节点给提示词（content），LLM 节点给它生成的 outputContent；
 * 图片节点给首帧。这些以前是 videoConfig 节点负责收集的，现在视频节点自己收。
 */
const upstreamPromptText = computed(() => collectUpstreamPromptText(props.id))

/** 上游图片节点的出图 → 作为首帧/参考帧 */
const upstreamFrameUrls = computed<string[]>(() => {
  const frames: string[] = []
  for (const edge of inboundEdges.value.get(props.id) || []) {
    const sourceNode = nodeIndex.value.get(edge.source)
    if (sourceNode?.type !== 'image') continue
    const url = String((sourceNode.data as { url?: string })?.url || '').trim()
    if (url) frames.push(url)
  }
  return frames
})

const composeFinalPrompt = (inline: string) => composePrompt(upstreamPromptText.value, inline)

/**
 * 可引用资产清单，喂给 ContentGenerator 的 @ 面板。
 *
 * 必须是 computed：token 里的序号（@图片1）由上游连线顺序决定，连线一变序号含义就变，
 * 面板要跟着画布图实时重算。空数组也要给，面板靠它显示「暂无可引用资产，请连入后操作」。
 */
const referenceableAssets = computed(() => collectReferenceableAssets(props.id))

// === 参数：与 ImageNode 同一套做法，节点 data 是参数的持久化处 ===
//
// 节点 data 里可能为空或失效（目录返回前创建的节点、换了模型后的旧比例等），
// 所以按「节点 data 优先，但要能在当前模型下校验通过，否则用该模型的默认档」解析。
const resolvedModelKey = computed(() => {
  const fromNode = String(props.data?.model || '').trim()
  return fromNode || getDefaultVideoModelKey()
})

const resolvedSchema = computed(() => {
  const model = getModelByName(resolvedModelKey.value) as VideoModel | null
  return resolveVideoParamSchema(model)
})

const resolvedFeature = computed(() => {
  const choices = resolvedSchema.value.features
  return pickValidChoice(choices, props.data?.feature, choices[0]?.key || '')
})

const resolvedRatio = computed(() => {
  const choices = resolvedSchema.value.ratios
  return pickValidChoice(choices, props.data?.ratio, resolvedSchema.value.defaultRatio)
})

const resolvedDuration = computed(() => {
  const choices = resolvedSchema.value.durations
  return pickValidChoice(choices, props.data?.duration, resolvedSchema.value.defaultDuration)
})

const resolvedResolution = computed(() => {
  const choices = resolvedSchema.value.resolutions
  return pickValidChoice(choices, props.data?.resolution, resolvedSchema.value.defaultResolution)
})

/** 卡片尺寸跟着「比例」参数走（对齐 LibTV 实测，见 config/node-size.ts） */
const cardSize = computed(() => resolveGenerationCardSize(resolvedRatio.value))

/**
 * 标题右侧的输出尺寸（LibTV 的「1280 × 720」）。
 *
 * **这是推导值，不是上游回传**：我们的生成记录只存请求的分辨率档（'720p'），
 * 没有产物真实像素；而 LibTV 那组数字正好等于「分辨率档当短边、长边按比例算」
 * （16:9 + 720P → 1280×720），所以按同一条规则推导。
 * 认不出分辨率档（如 '2K' 这种非数字档）时返回空字符串 —— 不显示，而不是瞎猜。
 */
const outputResolutionLabel = computed(() => {
  const tier = Number(String(resolvedResolution.value || '').replace(/[^0-9]/g, ''))
  if (!Number.isFinite(tier) || tier <= 0) return ''
  const aspect = parseAspectRatio(resolvedRatio.value)
  if (aspect === null) return ''
  const short = tier
  const long = Math.round(aspect >= 1 ? short * aspect : short / aspect)
  const width = aspect >= 1 ? long : short
  const height = aspect >= 1 ? short : long
  return `${width} × ${height}`
})

/** 输入框浮层：固定 660 宽 + 不随画布缩放 + 被底部工具栏挡住时自动上移（规则见 useComposerPanel.ts） */
const composerRef = ref<HTMLElement | null>(null)
const { style: composerStyle } = useComposerPanel({
  el: composerRef,
  nodeId: () => props.id,
  cardHeight: () => cardSize.value.height,
})

const appliedParams = computed<GeneratorParamsSnapshot>(() => ({
  modelKey: resolvedModelKey.value,
  ratio: resolvedRatio.value,
  resolution: resolvedResolution.value,
  duration: resolvedDuration.value,
  feature: resolvedFeature.value,
}))

const handleParamsChange = (params: GeneratorParamsSnapshot) => {
  const next = {
    model: params.modelKey || '',
    ratio: params.ratio || '',
    resolution: params.resolution || '',
    duration: Number(params.duration) || 0,
    feature: params.feature || '',
  }
  if (
    next.model === (props.data?.model || '')
    && next.ratio === (props.data?.ratio || '')
    && next.resolution === (props.data?.resolution || '')
    && next.duration === (props.data?.duration || 0)
    && next.feature === (props.data?.feature || '')
  ) {
    return
  }
  updateNode(props.id, next)
}

/** 卡片参数 chip：模型 · 比例 · 时长 · 分辨率 */
const paramChips = computed(() => {
  const chips: string[] = []
  const modelKey = appliedParams.value.modelKey
  if (modelKey) {
    const model = getModelByName(modelKey) as { label?: string } | null
    chips.push(model?.label || modelKey)
  }
  if (appliedParams.value.ratio) chips.push(describeAspectRatio(appliedParams.value.ratio))
  if (appliedParams.value.duration) chips.push(`${appliedParams.value.duration} 秒`)
  if (appliedParams.value.resolution) {
    // 分辨率优先用模型声明里的可读文案（如 1080P），没有就原样大写显示
    const matched = resolvedSchema.value.resolutions.find(
      (item) => item.key === appliedParams.value.resolution,
    )
    chips.push(matched?.label || String(appliedParams.value.resolution).toUpperCase())
  }
  return chips
})

const showLoading = computed(() => isLoading.value)
const showError = computed(() => !isLoading.value && !!errorMsg.value)
/**
 * 这个错能不能靠「重新上传参考图」解决。
 *
 * 不能解决的是「上游取不到这张图」这一类（参考图是本站相对地址、且没有配可被上游访问的公网基址）：
 * 重新上传仍然落在同一个 `/uploads/...`，点了只会再报一次同样的错（实测踩过）。
 * 这类错误必须走「发布到上游可达的位置 / 配置 PUBLIC_ASSET_BASE_URL」，所以不显示那个假出口。
 */
const canFixByReupload = computed(() =>
  !!errorMsg.value && !/无法被上游取到|上游取不到|PUBLIC_ASSET_BASE_URL|不可达/.test(errorMsg.value),
)
const showVideo = computed(() => !isLoading.value && !errorMsg.value && !!videoUrl.value)
const inputState = useNodeInputState(() => props.id)
const { collapsed, toggleCollapse } = useNodeCollapse(() => props.id)

// ready 的判定改成「上游真的产出了内容」而不是「有一条边」：
// 连了一个还没出图的节点不算已连接，否则界面会说谎
const showReady = computed(() => (
  !showLoading.value && !showError.value && !showVideo.value && inputState.value.satisfied.length > 0
))
const showEmpty = computed(() => !showLoading.value && !showError.value && !showVideo.value && !showReady.value)

const triggerUpload = () => fileInputRef.value?.click()
const handleFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    isLoading.value = true
    updateNode(props.id, { loading: true })
    const uploaded = await uploadStorageFile(file, 'asset')
    if (uploaded) {
      videoUrl.value = uploaded.publicUrl
      updateNode(props.id, { url: uploaded.publicUrl, loading: false })
    } else {
      throw new Error('upload returned empty')
    }
  } catch (err) {
    ElMessage.error('视频上传失败')
    updateNode(props.id, { loading: false, error: '上传失败' })
    // eslint-disable-next-line no-console
    console.error('[VideoNode] upload failed', err)
  } finally {
    isLoading.value = false
    input.value = ''
  }
}

const handleDownload = () => {
  if (!videoUrl.value) return
  const a = document.createElement('a')
  a.href = videoUrl.value
  a.download = `video_${Date.now()}.mp4`
  a.click()
}

const handleDelete = () => removeNode(props.id)
const handleDuplicate = () => {
  const newId = duplicateNode(props.id)
  if (newId) setTimeout(() => updateNodeInternals([newId]), 50)
}

const hoverActions = computed<NodeToolbarAction[]>(() => {
  const list: NodeToolbarAction[] = [
    { id: 'duplicate', label: '复制', icon: CopyDocument, onClick: handleDuplicate },
  ]
  if (videoUrl.value) {
    list.push({ id: 'download', label: '下载', icon: Download, onClick: handleDownload })
  }
  list.push({ id: 'delete', label: '删除', icon: Delete, danger: true, onClick: handleDelete })
  return list
})

/**
 * 空态的能力项 = **本节点能做什么**，取自模型声明的生成方式（文生视频 / 图生视频 / 首尾帧）。
 *
 * 为什么是这样：LibTV 的视频节点「尝试」列的就是生成方式
 * （`5分钟超长视频 / 首尾帧生成视频 / 首帧生成视频`），语义是「这个节点的操作模式」。
 * 我们原来这里放的是无实际行为的组合入口——
 * 点了没反应，属于假入口，已删除。
 *
 * 点击效果是真实的：把 feature 写进节点 data，经 initialParams 同步给
 * composer 的工具栏，最终作为参数发给上游。
 */
const emptyMenuItems = computed(() => {
  const iconByFeature: Record<string, typeof VideoCamera> = {
    'text-to-video': VideoCamera,
    'image-to-video': Aim,
    'first-last-frame': Film,
  }
  return resolvedSchema.value.features.map((feature) => ({
    id: feature.key,
    label: feature.label,
    icon: iconByFeature[feature.key] || VideoCamera,
    active: resolvedFeature.value === feature.key,
    onClick: () => updateNode(props.id, { feature: feature.key }),
  }))
})

// 选中态下方浮层：用 ContentGenerator（与 /generate 同款），锁定 video 类型
onMounted(() => {
  void loadPublicModelCatalog()
})

/**
 * 视频生成。
 *
 * 参数与提示词都已经按「节点自带 + 上游输入」组装好了，但服务端目前只有
 * image / agent-chat / agent-workspace / research-report 四种执行策略，
 * 没有 video 策略（见 server/generation-tasks/strategy.ts）。
 * 所以这里如实告知，而不是伪造一个成功回调。
 */
const handlePromptSend = (
  text: string,
  _type: string,
  options?: GeneratorParamsSnapshot & { referenceImages?: string[]; unresolvedReferences?: string[] },
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
  // 显式引用（@）优先：composer 解析出的媒体才是本次真正要提交的参考画面，
  // 上游连线只是「一个 @ 都没敲」时的自动注入，两者不能混着报数
  const explicitRefs = Array.isArray(options?.referenceImages) ? options.referenceImages.filter(Boolean) : []
  const frames = explicitRefs.length ? explicitRefs : upstreamFrameUrls.value

  // 真的提交（2026-09-23）：服务端已补齐 video 执行策略（异步任务制：建单 → 轮询 → 取件），
  // 这里不再只弹「尚未接通」，而是走与图片节点同一条客户端链路。
  void runGeneration({
    prompt,
    modelKey: String(params.modelKey || props.data?.model || '').trim(),
    ratio: params.ratio ? String(params.ratio) : undefined,
    duration: params.duration ? String(params.duration) : undefined,
    resolution: params.resolution ? String(params.resolution) : undefined,
    referenceFrames: frames,
  })
}

/** 提交阶段：建任务 → 立刻把 taskId/参数写回节点。任何失败都抛出（调用方要如实回执，不能吞） */
const submitGeneration = async (input: {
  prompt: string
  modelKey: string
  ratio?: string
  duration?: string
  resolution?: string
  referenceFrames: string[]
}) => {
  const { providerId, modelKey } = await resolveGenerationTaskModel({
    modelKey: input.modelKey,
    category: 'VIDEO',
    missingModelMessage: '未匹配到有效的视频模型，请先在后台配置',
  })
  const requestBody: Record<string, unknown> = {
    providerId,
    model: modelKey,
    prompt: input.prompt,
  }
  if (input.ratio) requestBody.ratio = input.ratio
  if (input.resolution) requestBody.resolution = input.resolution
  if (input.duration) requestBody.duration = Number(input.duration) || input.duration
  if (input.referenceFrames.length) requestBody.image_urls = [...input.referenceFrames]

  const saved = await createGenerationTask({
    source: 'workflow',
    type: 'video',
    prompt: input.prompt,
    modelKey,
    ratio: input.ratio,
    resolution: input.resolution,
    duration: input.duration,
    referenceImages: input.referenceFrames,
    requestBody,
  })
  const taskId = String(saved?.id || '').trim()
  if (!taskId) throw new Error('视频任务创建失败')

  // 提交时就落库：提示词/参数给「重试」用，taskId 给「刷新后对账」用（与图片节点同一个教训）
  updateNode(props.id, {
    prompt: input.prompt,
    model: modelKey,
    ratio: input.ratio || '',
    resolution: input.resolution || '',
    duration: input.duration ? Number(input.duration) : 0,
    taskRecordId: taskId,
    submittedAt: Date.now(),
    loading: true,
    error: '',
  })
  return taskId
}

/**
 * 提交与重试共用：提交 → 等结果（用户手动路径，行为与改动前一致）。
 * 与 ImageNode 刻意保持一致（同一套失败/停止/超时处理），差异只在参数与产物字段。
 */
const runGeneration = async (input: {
  prompt: string
  modelKey: string
  ratio?: string
  duration?: string
  resolution?: string
  referenceFrames: string[]
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
    console.error('[VideoNode] generation failed', err)
    isLoading.value = false
    errorMsg.value = err instanceof Error ? err.message : '视频生成失败'
    updateNode(props.id, { loading: false, error: errorMsg.value })
  }
}

/** 事件流：进度写到节点上（视频是长任务，必须让用户看到它在动），完成时把产物落到 url */
const applyTaskEvent = (event: GenerationTaskStreamEvent) => {
  if (event.type === 'progress' || event.type === 'snapshot') {
    const stage = String((event as { message?: string }).message || (event as { stage?: string }).stage || '').trim()
    if (stage && isLoading.value) progressText.value = stage
    return
  }
  if (event.type === 'completed') {
    const record = (event.record || {}) as Record<string, unknown>
    const outputs = Array.isArray(record.outputs) ? record.outputs as Array<Record<string, unknown>> : []
    const fromOutputs = outputs.map((item) => String(item?.url || '')).filter(Boolean)
    const fallback = Array.isArray(record.images) ? (record.images as string[]).filter(Boolean) : []
    const video = fromOutputs[0] || fallback[0] || String(record.url || '')
    if (video) {
      isLoading.value = false
      updateNode(props.id, { url: video, loading: false, error: '', executed: true, submittedAt: 0 })
    }
    return
  }
  if (event.type === 'failed') {
    isLoading.value = false
    errorMsg.value = String((event as { message?: string }).message || (event.record as { error?: string })?.error || '视频生成失败')
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
 * 供画布助手调用：用节点当前参数**提交一次视频生成**。
 *
 * 与 ImageNode 同样「提交即返回」（2026-09-26，第一刀：手感）：一次 run_node 不该卡到出片，
 * 出片由本节点自己的事件流落回 url。提交阶段失败必须抛出去，工具层据此如实回执。
 */
const runOnceForAgent = async () => {
  // 节点自己存的提示词要当 inline 传进去：composeFinalPrompt 只负责把「上游文本节点的内容」
  // 与 inline 拼起来，不读 data.prompt —— 直接传 '' 会导致明明有提示词却报「还没有提示词」
  const stored = String(props.data?.prompt || '').trim()
  const prompt = composeFinalPrompt(stored) || stored
  if (!prompt) throw new Error('该视频节点还没有提示词，先给它写一个（update_node 的 prompt）')
  isLoading.value = true
  errorMsg.value = ''
  let taskId = ''
  try {
    taskId = await submitGeneration({
      prompt,
      modelKey: String(props.data?.model || '').trim(),
      ratio: String(props.data?.ratio || '') || undefined,
      duration: props.data?.duration ? String(props.data.duration) : undefined,
      resolution: String(props.data?.resolution || '') || undefined,
      referenceFrames: upstreamFrameUrls.value,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '视频生成提交失败'
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
    errorMsg.value = err instanceof Error ? err.message : '视频结果订阅中断'
    updateNode(props.id, { loading: false, error: errorMsg.value })
  })
}

onMounted(() => {
  registerNodeRunner(props.id, runOnceForAgent)
})

onBeforeUnmount(() => {
  unregisterNodeRunner(props.id)
  taskStreamController?.abort()
  taskStreamController = null
})
</script>

<template>
  <div class="video-node-wrapper" @mouseenter="showActions = true" @mouseleave="showActions = false">
    <div class="video-node-title" :title="titleEdit.editing.value ? '' : '双击编辑名称'" @dblclick.stop="titleEdit.start">
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
      <el-icon class="video-node-title-icon"><VideoCamera /></el-icon>
      <input
        v-if="titleEdit.editing.value"
        :ref="titleEdit.setInputRef"
        v-model="titleEdit.draft.value"
        class="video-node-title-input nodrag"
        :maxlength="40"
        @blur="titleEdit.commit"
        @keydown.enter.prevent="titleEdit.commit"
        @keydown.esc.prevent="titleEdit.cancel"
        @mousedown.stop
        @click.stop
      />
      <span v-else>{{ data?.label || 'Video' }}</span>
      <span v-if="outputResolutionLabel" class="video-node-title-resolution">{{ outputResolutionLabel }}</span>
    </div>

    <!-- 参数 chip：模型 · 比例 · 时长 · 分辨率，由工具栏写入节点 data -->
    <div v-if="paramChips.length" class="video-node-params" :title="paramChips.join(' · ')">
      <span v-for="(chip, index) in paramChips" :key="chip" class="video-node-param-chip">
        <span v-if="index > 0" class="video-node-param-divider" aria-hidden="true"></span>
        {{ chip }}
      </span>
    </div>

    <div class="video-node-card" :class="{ 'is-selected': isSelected, 'is-collapsed': collapsed }" :style="cardSizeStyle(cardSize)">

      <div v-if="collapsed" class="node-collapsed-summary">
        <span class="node-collapsed-summary__text">
          {{ inputState.connectedLabel || inputState.emptyLabel }}
        </span>
      </div>

      <template v-else>
      <!-- 空态：按类型声明需要什么输入（对齐 LibTV：节点自己说清要连什么） -->
      <div v-if="showEmpty" class="video-node-empty">
        <div class="video-node-empty-hint">{{ inputState.emptyLabel }}</div>
        <div v-if="emptyMenuItems.length" class="video-node-empty-title">生成方式：</div>
        <div v-if="emptyMenuItems.length" class="video-node-empty-menu">
          <!-- 当前生效的那一种高亮：这几个是互斥的模式选择，不是并列的快捷键 -->
          <button
            v-for="item in emptyMenuItems"
            :key="item.id"
            type="button"
            class="video-node-empty-item nodrag nopan"
            :class="{ 'is-active': item.active }"
            @click.stop="item.onClick"
          >
            <el-icon class="video-node-empty-item-icon">
              <component :is="item.icon" />
            </el-icon>
            <span>{{ item.label }}</span>
          </button>
        </div>
        <button class="video-node-upload-pill nodrag nopan" @click.stop="triggerUpload">
          <el-icon><UploadIcon /></el-icon>
          <span>上传视频</span>
        </button>
      </div>

      <!-- ready-state -->
      <div v-else-if="showReady" class="video-node-ready">
        <div class="video-node-ready-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path d="M10 9l5 3-5 3V9z" fill="currentColor" />
          </svg>
        </div>
        <div class="video-node-ready-text">{{ inputState.connectedLabel }}</div>
        <div class="video-node-ready-hint">选中节点后在下方写提示词并生成</div>
      </div>

      <div v-else-if="showLoading" class="video-node-loading">
        <div class="video-node-spinner" />
        <span>{{ progressText || '生成中…' }}</span>
      </div>
      <!--
        错误态：**只在这个错真的能靠重新上传解决时才提示「点击重新上传」**。
        2026-09-26 实测的坑：参考图不可达时（`/uploads/...` 相对地址 + 未配 PUBLIC_ASSET_BASE_URL），
        重新上传仍然落在同一个 `/uploads/...`，点一次报一次同样的错 —— 用户被这个假出口来回折腾。
        那类错误的正确答案是「把图发布到上游取得到的地方 / 配置公网基址」，不是再传一遍。
      -->
      <div
        v-else-if="showError"
        class="video-node-error"
        :class="{ 'is-clickable': canFixByReupload }"
        @click.stop="canFixByReupload ? triggerUpload() : undefined"
      >
        <span>{{ errorMsg }}<template v-if="canFixByReupload">，点击重新上传</template></span>
      </div>
      <video
        v-else
        :src="videoUrl"
        controls
        class="video-node-player nodrag nopan"
        @mousedown.stop
        @wheel.stop
      />

      <input
        ref="fileInputRef"
        type="file"
        accept="video/*"
        style="display: none"
        @change="handleFileChange"
      />
      </template>
    </div>

    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />

    <CanvasNodeHoverToolbar :visible="showActions" :actions="hoverActions" />

    <div
      v-if="isSelected && !showLoading"
      ref="composerRef"
      class="video-node-prompt-panel nodrag nopan"
      :style="composerStyle"
      @mousedown.stop
    >
      <!-- 把节点上已存的提示词同步进输入框（2026-09-23）：
           提示词一直存在 data.prompt 里（生成、重试、画布助手都在用），但输入框没接它 ——
           于是「画布助手已经帮你把提示词填好了」在界面上完全看不出来，用户会以为它没干活。
           ContentGenerator 自带 externalPrompt + promptSyncKey：两者一起变化时写入输入框。
           注意：模板注释必须放在标签**外面**，塞进属性列表会让整个组件编译失败、页面白屏。 -->
      <ContentGenerator
        layout="sidebar"
        :collapsible="false"
        :default-expanded="true"
        initial-creation-type="video"
        :hide-type-selector="true"
        :verbose-toolbar="true"
        :external-prompt="String(data?.prompt || '')"
        :prompt-sync-key="String(data?.prompt || '')"
        :external-reference-images="upstreamFrameUrls"
        :referenceable-assets="referenceableAssets"
        :initial-params="appliedParams"
        placeholder-override="描述你想生成的视频画面，按 Enter 发送"
        popup-placement="top"
        @params-change="handleParamsChange"
        @send="handlePromptSend"
      />
    </div>
  </div>
</template>

<style scoped>
.video-node-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

/* 参数 chip 行：夹在标题和卡片之间 */
.video-node-params {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  overflow: hidden;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}
.video-node-param-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 20px;
  color: var(--text-tertiary, rgba(224, 245, 255, 0.55));
  flex-shrink: 0;
}
.video-node-param-divider {
  width: 1px;
  height: 10px;
  background: var(--stroke-tertiary, rgba(255, 255, 255, 0.14));
}
.video-node-param-chip:first-child {
  color: var(--text-secondary, rgba(224, 245, 255, 0.72));
  font-weight: 500;
}

.video-node-title-resolution {
  /* 贴到标题行最右（对齐 LibTV：名字在左、输出尺寸在右） */
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.video-node-title {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 0 8px 0 2px;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s, color 0.2s;
}
.video-node-title:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}
.video-node-title-icon {
  font-size: 16px;
  color: var(--text-tertiary);
}
.video-node-title-input {
  flex: 1 1 0;
  min-width: 80px;
  max-width: 220px;
  background: transparent;
  border: 1px solid var(--brand-main-default);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  outline: none;
  box-sizing: border-box;
}

.video-node-card {
  position: relative;
  /* 宽高由 config/node-size.ts 算出后内联绑定（跟比例走），这里不再写死 min-width/min-height */
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
.video-node-card.is-selected {
  border-color: var(--canvas-node-border-selected);
}

.video-node-empty {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  justify-content: center;
  padding: 20px;
}
/* 输入需求声明：告诉用户该去连什么才能开始 */
.video-node-empty-hint {
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 18px;
  padding: 0 8px;
  margin-bottom: 16px;
}
.video-node-empty-title {
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 18px;
  /* 与下面图标列共用一条左边界 */
  padding: 0 8px;
  margin-bottom: 12px;
}
.video-node-empty-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.video-node-empty-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 0.15s, color 0.15s;
}
.video-node-empty-item:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
/* 当前生效的生成方式：用底色与文字色区分，和「可选但未生效」区分开 */
.video-node-empty-item.is-active {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
.video-node-empty-item.is-active .video-node-empty-item-icon {
  color: var(--brand-main-default);
}
.video-node-empty-item-icon {
  font-size: 16px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.video-node-empty-item:hover .video-node-empty-item-icon {
  color: var(--text-primary);
}
.video-node-upload-pill {
  margin-top: auto;
  margin-left: 10px;
  margin-right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 0;
  background: var(--canvas-float-block-default);
  border: 0.5px solid var(--stroke-secondary);
  border-radius: 16px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
.video-node-upload-pill:hover {
  background: var(--canvas-float-block-hover);
  color: var(--brand-main-default);
}

.video-node-ready {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  padding: 24px;
}
.video-node-ready-icon { opacity: 0.6; }
.video-node-ready-text {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}
.video-node-ready-hint {
  color: var(--text-tertiary);
  font-size: 12px;
}

.video-node-loading,
.video-node-error {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
}
.video-node-error.is-clickable { cursor: pointer; }

.video-node-error {
  color: #ef4444;
}
.video-node-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--stroke-secondary);
  border-top-color: var(--brand-main-default);
  animation: video-node-spin 0.8s linear infinite;
}
@keyframes video-node-spin {
  to { transform: rotate(360deg); }
}

.video-node-player {
  width: 100%;
  height: 100%;
  border-radius: var(--lv-border-radius-medium);
  background: #000;
}

.video-node-handle {
  width: 1px !important;
  height: 1px !important;
  opacity: 0 !important;
  pointer-events: none !important;
  border: 0 !important;
  background: transparent !important;
}

.video-node-add-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 56px;
  height: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  border-radius: 50%;
  color: var(--text-tertiary);
  cursor: pointer;
  z-index: 10;
  transition: transform 0.2s, color 0.2s;
}
.video-node-add-btn--left { left: -56px; }
.video-node-add-btn--right { right: -56px; }
.video-node-add-btn__icon {
  width: 20px;
  height: 20px;
  padding: 3px;
  border: 1px solid currentColor;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: content-box;
}
.video-node-add-btn:hover { color: var(--text-primary); }
.video-node-add-btn:active { transform: translateY(-50%) scale(0.95); }

/* 宽 660、不随画布缩放 —— 都由内联 style 给（见 useComposerPanel），这里只负责挂到卡片正下方 */
.video-node-prompt-panel {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  z-index: 5;
}
</style>
