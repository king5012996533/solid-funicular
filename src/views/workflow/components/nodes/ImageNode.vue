<script setup lang="ts">
/**
 * 图片节点
 *
 * 形态对齐 LibTV 实测（2026-09-22）：
 *   - 卡片尺寸**跟「比例」参数走**：横版 622×350、竖版 350×622（见 config/node-size.ts）
 *   - 图上不摆任何控件：没有标题、参数行、工具条（标题在卡外，由 Vue Flow 的标签层负责）
 *   - 「AI生成」角标（LibTV 卡片左上角那个）只在**生成产物**上显示，上传的图不显示
 *   - 4 类状态：空态「尝试」列表 / 加载 / 错误 / 有图
 *   - 有图时双击放大预览；删除走 Delete 键与右键菜单
 *   - 选中后卡片下方浮出输入框（ContentGenerator，与 /generate 同款）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { ElMessage } from 'element-plus'
import { Aim, Crop, MagicStick, Picture, Sunny } from '@element-plus/icons-vue'
import CanvasNodeTopToolbar, { type NodeTopToolbarItem } from '@/components/canvas/CanvasNodeTopToolbar.vue'
import ImageCropDialog from '@/components/canvas/ImageCropDialog.vue'
import ContentGenerator, { type GeneratorParamsSnapshot } from '@/components/generate/ContentGenerator.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import {
  updateNode,
  addNode,
  addEdge,
  nodes,
  type WorkflowImageNodeData,
} from '../../composables/useWorkflowCanvas'
import { uploadStorageFile } from '@/api/storage'
import { loadPublicModelCatalog, getModelByName, getDefaultImageModelKey, type ImageModel } from '@/config/models'
import { pickSizeByAspect, pickValidChoice, resolveImageParamSchema } from '@/config/model-params'
import {
  ANGLE_PRESETS,
  ENHANCE_PRESET,
  LIGHT_PRESETS,
  PANORAMA_PRESET,
  type ImageEditPreset,
} from '../../config/image-edit-presets'
import { cardSizeStyle, resolveGenerationCardSize } from '../../config/node-size'
import { useComposerPanel } from '../../composables/useComposerPanel'
import { useNodeToolbar } from '../../composables/useNodeToolbar'
import { useNodeTitleEdit } from '@/composables/useNodeTitleEdit'
import { isRasterReferenceUrl } from '@/config/reference-validation'
import { collectUpstreamPromptText, composePrompt } from '../../composables/upstream-inputs'
import { inboundEdges, nodeIndex } from '../../composables/workflow-graph-index'
import { collectReferenceableAssets } from '../../composables/reference-resolver'
import {
  createGenerationTask,
  getGenerationTask,
  subscribeGenerationTaskEvents,
  resolveGenerationTaskModel,
  type GenerationTaskStreamEvent,
} from '@/api/generation-tasks'
import {
  BACKGROUND_POLL_FIRST_DELAY_MS,
  BACKGROUND_POLL_INTERVAL_MS,
  BACKGROUND_POLL_MAX_DURATION_MS,
  decideBackgroundDelivery,
} from '@/shared/background-delivery-poll'
import { appendImageReferencesToRequestBody } from '@/shared/image-generation-request'
import { registerNodeRunner, unregisterNodeRunner } from '@/views/workflow/composables/useCanvasNodeRunner'
import {
  clearAgentActiveNodesForIds,
  useAgentActiveNodes,
} from '@/views/workflow/composables/useAgentActiveNodes'

const props = defineProps<{
  id: string
  data: WorkflowImageNodeData & { selected?: boolean }
  selected?: boolean
}>()
const isSelected = computed(() => props.selected || props.data?.selected)
/** 标题行双击改名（composable 见 @/composables/useNodeTitleEdit） */
const titleEdit = useNodeTitleEdit(props.id, () => props.data?.label || '图片')
/**
 * 标题行右侧的产出信息（LibTV 是「1456 × 816 · 4张」）。
 *
 * 这里只放**拿得到真值**的那部分：数量取自节点 data 的批量生图组 —— 只有组首挂
 * `batchChildren`，里面的每一项就是本节点实际产出的图（含主图），长度即产出张数。
 *
 * 产出图的**真实宽高拿不到**：节点 data 与组件状态里没有任何字段承载产物像素
 * （`data.size` 是用户选的「计划尺寸」，不是产物尺寸；batchChildren 也只存 {id, url}），
 * 所以这一段不显示 —— 宁缺毋滥，绝不拿计划尺寸或写死数字冒充。
 */
const outputMeta = computed(() => {
  const children = props.data?.batchChildren
  if (props.data?.isBatchRoot && Array.isArray(children) && children.length > 1) {
    return `${children.length}张`
  }
  return ''
})

/**
 * Agent 画布动作高亮（批次 3）：仅 UI 的瞬时描边，**不是节点数据**。
 * `is-agent-created`（刚创建，实线渐隐，TTL 自动清）与 `is-agent-generating`（生成中，虚线脉冲，
 * 等生成终态/回合结束清）。错开延迟由 `--agent-stagger-delay` 驱动批量铺开的节奏。
 */
const { isAgentCreated, isAgentGenerating, staggerDelayMs } = useAgentActiveNodes()
const agentCreated = computed(() => isAgentCreated(props.id))
const agentGenerating = computed(() => isAgentGenerating(props.id))
const agentHighlightStyle = computed(() => ({
  '--agent-stagger-delay': `${staggerDelayMs(props.id)}ms`,
}))

// 生成终态（loading 落回 false）时收掉本节点的「生成中」高亮 —— 不能靠 TTL 猜生成何时结束
watch(
  () => props.data?.loading,
  (loading) => {
    if (loading === false) clearAgentActiveNodesForIds([props.id])
  },
)
const { updateNodeInternals } = useVueFlow()
const imageUrl = ref(props.data?.url || '')
const isLoading = ref(!!props.data?.loading)
const errorMsg = ref(props.data?.error || '')
/**
 * 「不等了，让它后台跑完」的节点态（本地镜像，真源在 data.backgroundPending）。
 * 为真时：不转圈、不骨架屏，只显示一句轻量状态，客户端轮询任务记录把结果接回来。
 */
const backgroundPending = ref(!!props.data?.backgroundPending)
const fileInputRef = ref<HTMLInputElement | null>(null)

watch(
  [() => props.data?.url, () => props.data?.loading, () => props.data?.error, () => props.data?.backgroundPending],
  ([url, loading, error, background]) => {
    if (url !== undefined) imageUrl.value = url
    if (loading !== undefined) isLoading.value = loading
    if (error !== undefined) errorMsg.value = error
    if (background !== undefined) backgroundPending.value = background
  },
)

/**
 * 「AI生成」角标：只在**生成产物**上出现（对齐 LibTV）。
 * 判据用节点 data 里的 `executed` —— 上传（图生图）与裁剪都不置它，
 * 所以用户自己传进去的图不会被标成 AI 生成。
 */
const isGenerated = computed(() => props.data?.executed === true)

const showLoading = computed(() => isLoading.value)
const showError = computed(() => !isLoading.value && !!errorMsg.value)
/**
 * 后台生成中：不转圈，只给一句状态 + 「刷新看看」按钮。
 * 优先级在错误之后、有图/空态之前 —— 它是「没有在等、但也没结束」的独立形态。
 */
const showBackground = computed(() => !isLoading.value && !errorMsg.value && backgroundPending.value)
const showImage = computed(() => !isLoading.value && !errorMsg.value && !backgroundPending.value && !!imageUrl.value)
/** 空态：既没在跑、也没报错、也没进后台、也还没图 —— 才摆「尝试」两项能力 */
const showEmpty = computed(() => !showLoading.value && !showError.value && !showBackground.value && !showImage.value)

/**
 * 卡片尺寸跟着「比例」参数走（对齐 LibTV 实测，见 config/node-size.ts）：
 * 横版 622×350、竖版 350×622、方版 350×350。图用 object-cover 填满这张框。
 */
const cardSize = computed(() => resolveGenerationCardSize(appliedParams.value.ratio))

/** 输入框浮层：固定 660 宽 + 不随画布缩放 + 被底部工具栏挡住时自动上移（规则见 useComposerPanel.ts） */
/**
 * 生成中的「已等待时长」。
 *
 * 用户原话：「一直在转圈，没结果返回，用户会很焦虑」。服务端任务接口**没有暴露排队位置**
 * （用 API 实测过，返回里没有任何 queue/wait/progress 字段），所以做不到「前面还有 N 个」；
 * 能做的是把**已等待时长**显示出来（时间在走，用户知道系统没死），外加「比平时慢」的提示。
 *
 * **这里曾经有一个「取消」按钮，2026-09-26 按产品要求删掉了。** 原因与钱有关：
 * 任务一旦提交，上游就已经在生成（钱已经付给对方，而且结果是有保证的）；此时用户点取消，
 * 我们按 abort 走退款（refundTaskPointsIfNeeded('task_aborted')）—— 退给用户、上游照付、
 * 成果还拿不到，净亏三头。所以付费生成没有「取消」这个出口，等它出结果即可。
 * 真卡死时由 GENERATION_DEADLINE_MS 兜底落到可重试的失败态，不需要也不该由用户主动中断。
 * 免积分的那类任务（对话 / 研究 / Agent 回合）仍然可以停 —— 停它们不花钱。
 */
const generationElapsed = ref(0)
/**
 * 本次运行的起点（毫秒）。
 *
 * 为什么不能只信节点 data 里的 `submittedAt`：实测提交时写进节点的 `prompt`/`submittedAt`
 * **在保存后读回是空**（`taskRecordId` 却留着），所以刷新后拿不到起点、计时会是 00:00。
 * 这里以「内存里的本次起点」为主，缺了再退回 data，最后退回任务记录的 createdAt（见对账逻辑）。
 */
const runStartedAt = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const stopElapsedTimer = () => {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

const startElapsedTimer = (submittedAt?: number) => {
  stopElapsedTimer()
  const startedAt = Number(submittedAt) > 0 ? Number(submittedAt) : (runStartedAt.value || Date.now())
  if (!runStartedAt.value) runStartedAt.value = startedAt
  /**
   * 每秒把秒数写进 `generationElapsed` —— **它是唯一数据源**。
   *
   * 踩过的坑：早先我做成「computed 里有起点就直接用 Date.now() 算、不读这个 ref」，
   * 结果计时器每秒更新的是 ref，而 computed 的依赖没变 → 界面**永远停在 00:00**
   * （看着像「计时坏了」，其实是响应式没被触发）。现在 tick 统一算好写进 ref，模板只读它。
   */
  const tick = () => {
    const base = runStartedAt.value || startedAt
    generationElapsed.value = Math.max(0, Math.floor((Date.now() - base) / 1000))
  }
  tick()
  elapsedTimer = setInterval(tick, 1000)
}

const formattedElapsed = computed(() => {
  const total = generationElapsed.value
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
})

/** 超过这个时长给一句解释：实测快时 1 分钟内出图，慢时十几分钟 */
const SLOW_HINT_SECONDS = 90
const showSlowHint = computed(() => generationElapsed.value >= SLOW_HINT_SECONDS)

/**
 * 计时由 **loading 状态**驱动，而不是在各调用点埋 start/stop。
 *
 * 理由：调用点有四处（提交 / 对账重订阅 / 终态 / 失败），漏一处就出现「转圈但计时不动」；
 * 挂在 loading 上则无论谁把节点置为生成中都必然计时，且以数据里的 submittedAt 为基准。
 */
watch(
  () => [props.data?.loading, props.data?.submittedAt] as const,
  ([loading, submittedAt]) => {
    if (loading) startElapsedTimer(Number(submittedAt) || Date.now())
    else stopElapsedTimer()
  },
  { immediate: true },
)

const composerRef = ref<HTMLElement | null>(null)
const { style: composerStyle } = useComposerPanel({
  el: composerRef,
  nodeId: () => props.id,
  cardHeight: () => cardSize.value.height,
})

const triggerUpload = () => fileInputRef.value?.click()
const handleFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    isLoading.value = true
    updateNode(props.id, { loading: true, error: '' })
    const uploaded = await uploadStorageFile(file, 'asset')
    if (!uploaded) throw new Error('upload returned empty')
    imageUrl.value = uploaded.publicUrl
    updateNode(props.id, { url: uploaded.publicUrl, loading: false, error: '' })
  } catch (err) {
    ElMessage.error('图片上传失败')
    updateNode(props.id, { loading: false, error: '上传失败' })
    // eslint-disable-next-line no-console
    console.error('[ImageNode] upload failed', err)
  } finally {
    isLoading.value = false
    input.value = ''
  }
}

/**
 * 「图片高清」：拿本节点这张图 + 一句固定指令走图生图（image-edit），结果落到**新节点**。
 *
 * 与 LibTV 空图片节点上的「尝试：图片高清」同名同义。两条刻意的决定沿用旧版：
 *  1. 结果不覆盖原图 —— 高清重绘是可以对比、可以回退的操作，覆盖掉就找不回来了；
 *  2. 提示词与尺寸都来自预设（config/image-edit-presets），档位只从模型声明的列表里取，
 *     模型不认的值绝不会透传上去。
 */
const runImageEditJob = async (preset: ImageEditPreset) => {
  const sourceUrl = String(imageUrl.value || '').trim()
  if (!sourceUrl) {
    ElMessage.info('这个节点还没有图，先上传一张')
    return
  }
  if (isGenerating.value) return

  const sourceNode = nodes.value.find((n) => n.id === props.id)
  if (!sourceNode) return

  isGenerating.value = true
  taskStreamController.value?.abort()

  // 先建结果节点：用户点下去立刻能看到「活干起来了」，而不是等几秒才出现
  const targetId = addNode('image', { x: sourceNode.position.x + 640, y: sourceNode.position.y }, {
    label: preset.label,
    loading: true,
    prompt: preset.prompt,
  })
  addEdge({
    source: props.id,
    target: targetId,
    sourceHandle: 'right',
    targetHandle: 'left',
    type: 'imageOrder',
    data: { imageOrder: 1 },
  })

  try {
    const fallbackKey = String(props.data?.model || '').trim()
    const { providerId, modelKey } = await resolveGenerationTaskModel({
      modelKey: fallbackKey,
      fallbackModelKey: fallbackKey,
      category: 'IMAGE',
      missingModelMessage: '未匹配到有效图片模型，请先在后台配置模型',
    })

    const model = getModelByName(modelKey) as ImageModel | null
    const schema = resolveImageParamSchema(model, String(props.data?.quality || 'standard'))
    const size = preset.sizeIntent
      ? (pickSizeByAspect(schema.sizes, preset.sizeIntent) || schema.defaultSize)
      : schema.defaultSize

    const requestBody: Record<string, unknown> = {
      model: modelKey,
      prompt: preset.prompt,
      n: 1,
      providerId,
    }
    if (size) requestBody.size = size

    const saved = await createGenerationTask({
      source: 'workflow',
      type: 'image',
      requestMode: 'image-edit',
      prompt: preset.prompt,
      modelKey,
      resolution: String(props.data?.quality || '').trim() || undefined,
      referenceImages: [sourceUrl],
      requestBody: appendImageReferencesToRequestBody(requestBody, [sourceUrl]),
    })
    const taskId = String(saved?.id || '').trim()
    if (!taskId) throw new Error('图片任务创建失败')

    const controller = new AbortController()
    taskStreamController.value = controller
    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'snapshot' || event.type === 'completed') {
          const urls = Array.isArray(event.record?.images) ? event.record.images.filter(Boolean) : []
          if (urls.length) {
            updateNode(targetId, { url: urls[0], loading: false, error: '', executed: true, taskRecordId: taskId })
            isGenerating.value = false
          }
        }
        if (event.type === 'failed') {
          updateNode(targetId, { loading: false, error: String(event.message || event.record?.error || '高清处理失败') })
          isGenerating.value = false
        }
        if (event.type === 'stopped') {
          updateNode(targetId, { loading: false, error: '任务已停止' })
          isGenerating.value = false
        }
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '高清处理失败'
    ElMessage.error(message)
    updateNode(targetId, { loading: false, error: message })
    isGenerating.value = false
  } finally {
    setTimeout(() => updateNodeInternals([targetId]), 50)
  }
}

const handleEnhance = () => runImageEditJob(ENHANCE_PRESET)

/** 节点工具栏：固定屏幕尺寸 + 贴边收敛（规则见 composables/useNodeToolbar.ts） */
const toolbarRef = ref<HTMLElement | null>(null)
const { style: toolbarStyle } = useNodeToolbar({
  el: toolbarRef,
  nodeId: () => props.id,
  cardWidth: () => cardSize.value.width,
})

/**
 * 工具栏条目：**只放已经接线的能力**，每一项点下去都会真的产出新节点。
 *
 * 与 LibTV 对照：他们图片节点是 9 项 + 4 个图标按钮，我们只放得起这 5 项 ——
 * 「九宫格 / 元素编辑 / 图层分离 / 宫格切分」这些我们还没有对应管线，
 * 宁可少放，也不摆「接入中」那种假入口（上一轮刚因为假入口砍过一遍）。
 * 标签用 LibTV 的叫法：全景 / 多角度 / 打光 / 高清。
 */
const toolbarItems = computed<NodeTopToolbarItem[]>(() => [
  { id: 'hd', label: '高清', icon: MagicStick, onClick: handleEnhance },
  { id: 'panorama', label: '全景', icon: Picture, onClick: () => runImageEditJob(PANORAMA_PRESET) },
  {
    id: 'angle',
    label: '多角度',
    icon: Aim,
    hasDropdown: true,
    dropdownItems: ANGLE_PRESETS.map(preset => ({
      id: preset.key,
      label: preset.label,
      description: preset.description,
      onClick: () => runImageEditJob(preset),
    })),
  },
  {
    id: 'light',
    label: '打光',
    icon: Sunny,
    hasDropdown: true,
    dropdownItems: LIGHT_PRESETS.map(preset => ({
      id: preset.key,
      label: preset.label,
      description: preset.description,
      onClick: () => runImageEditJob(preset),
    })),
  },
  { type: 'divider' },
  { id: 'crop', label: '裁剪', icon: Crop, onClick: () => { cropVisible.value = true } },
])

// 裁剪是纯本地操作（不上上游）：裁完直接把结果上传成一个新节点
const cropVisible = ref(false)
const handleCropConfirm = async (blob: Blob) => {
  const sourceNode = nodes.value.find(item => item.id === props.id)
  if (!sourceNode) return
  const targetId = addNode('image', { x: sourceNode.position.x + 640, y: sourceNode.position.y }, {
    label: '裁剪',
    loading: true,
  })
  try {
    const file = new File([blob], `crop-${Date.now()}.png`, { type: 'image/png' })
    const uploaded = await uploadStorageFile(file, 'asset')
    if (!uploaded) throw new Error('裁剪结果上传失败')
    updateNode(targetId, { url: uploaded.publicUrl, loading: false, error: '', executed: true })
    ElMessage.success('已裁剪并生成新节点')
  } catch (error) {
    const message = error instanceof Error ? error.message : '裁剪结果上传失败'
    ElMessage.error(message)
    updateNode(targetId, { loading: false, error: message })
  } finally {
    setTimeout(() => updateNodeInternals([targetId]), 50)
  }
}

const previewVisible = ref(false)
const previewTarget = ref('')

const openImagePreview = (url?: unknown) => {
  // 只认字符串：工具栏那份是 `item.onClick()`（无参），但悬停工具栏是
  // `@click.stop="action.onClick"` —— 那样 Vue 会把 MouseEvent 当第一个参数传进来，
  // 于是 `String(event)` 会变成 "[object MouseEvent]" 把预览打坏。
  const explicit = typeof url === 'string' ? url.trim() : ''
  const target = explicit || String(imageUrl.value || '').trim()
  if (!target) return
  previewTarget.value = target
  previewVisible.value = true
}

// 选中态下方浮层：用 ContentGenerator（与 /generate 同款），锁定 image 类型
onMounted(() => {
  void loadPublicModelCatalog()
})

// 节点卸载时清掉计时器（含后台轮询），避免后台空转。
// 注意：清掉的只是**客户端**定时器；服务端任务与节点 data 上的 backgroundPending 都不动，
// 重新挂载后会接着把结果接回来。
onBeforeUnmount(() => {
  stopElapsedTimer()
  stopBackgroundPolling()
})

/**
 * 对账必须**观察 loading 的变化**，不能在 onMounted 里跑一次就完。
 *
 * 工作流定义是异步加载的：定义一到达就会整体替换 nodes，把挂载时的改动冲掉
 * （实测：node_3 的对账结果就这么被覆盖，节点回到空态、用户依旧看不到任何解释）。
 * 这里按 taskId 去重，避免同一个任务反复对账。
 */
const reconciledTaskKey = ref('')
watch(
  () => [props.data?.loading, props.data?.taskRecordId, props.data?.submittedAt] as const,
  ([loading, taskId, submittedAt]) => {
    if (!loading) return
    const key = `${String(taskId || '')}#${Number(submittedAt || 0)}`
    if (reconciledTaskKey.value === key) return
    reconciledTaskKey.value = key
    // 判断与对账都放到下一个 tick：
    //   · `isGenerating` / `taskStreamController` 在本文件里声明得更晚，
    //     在 immediate 回调里同步读会撞上 TDZ —— **实测把整个节点组件 setup 打挂、节点从画布上消失**；
    //   · 顺手让工作流定义先加载完（异步到达的定义会整体替换 nodes）。
    setTimeout(() => {
      if (isGenerating.value || taskStreamController.value) return
      void reconcileInterruptedRun()
    }, 200)
  },
  { immediate: true, flush: 'post' },
)
// 上游图片素材 → 作为图生图参考图（直接拿 url 数组）
// 注意：上游图生图模型（如 gpt-image-2）只接受栅格格式，SVG/PDF/HEIC 等会让 PIL 在
// BytesIO 解码时报 "cannot identify image file"，必须在客户端过滤掉。
const droppedNonRasterRefsHint = ref(false)
const upstreamReferenceUrls = computed<string[]>(() => {
  const refs: string[] = []
  let droppedCount = 0
  for (const edge of inboundEdges.value.get(props.id) || []) {
    const sourceNode = nodeIndex.value.get(edge.source)
    if (!sourceNode) continue
    if (sourceNode.type === 'image') {
      const url = (sourceNode.data as { url?: string })?.url
      if (!url) continue
      if (isRasterReferenceUrl(url)) {
        refs.push(url)
      } else {
        droppedCount += 1
      }
    }
  }
  if (droppedCount > 0 && !droppedNonRasterRefsHint.value) {
    droppedNonRasterRefsHint.value = true
    ElMessage.warning(`已忽略 ${droppedCount} 张非栅格格式（SVG 等）的参考图，图生图模型不支持`)
    // 下一次重新出现时再次提示
    setTimeout(() => { droppedNonRasterRefsHint.value = false }, 3000)
  }
  return refs
})

/**
 * 可引用资产清单，喂给 ContentGenerator 的 @ 面板。
 *
 * 必须是 computed 而不是快照：token 里的序号（@图片1）是按上游连线顺序算出来的，
 * 连线一变序号的含义就变，面板必须跟着画布图实时重算。
 * 空数组也要给 —— 面板靠它显示「暂无可引用资产，请连入后操作」。
 */
const referenceableAssets = computed(() => collectReferenceableAssets(props.id))

/**
 * 上游文本 / LLM 节点 → 本节点的提示词。
 *
 * 以前这一步是「配置节点」干的活：配置节点把上游文本收集起来当 prompt。
 * 现在图片节点自己收，所以文本可以直连图片节点，中间不用再插一个节点。
 * 文本节点取 content，LLM 节点取它生成的 outputContent —— 后者是这次补上的：
 * 之前只认 text 节点，LLM 的输出连过来不会被读取，看起来连上了实际是个空操作。
 */
const upstreamPromptText = computed(() => collectUpstreamPromptText(props.id))

/** 上游提示词 + 节点内输入，合并成最终提交的提示词 */
const composeFinalPrompt = (inline: string) => composePrompt(upstreamPromptText.value, inline)

// === 参数：卡片 chip 显示的是节点 data，工具栏是编辑入口，两边同步 ===
//
// 节点 data 里的 model / size / quality 可能为空或失效：
//   · 目录请求返回之前创建的节点
//   · 早期版本在目录为空时把占位值（如 size '1x1'）写进了画布
//   · 用户换了模型，旧尺寸在新模型里不存在
// 所以这里按「节点 data 优先，但要能在当前模型下校验通过，否则用该模型的默认档」解析。
const resolvedModelKey = computed(() => {
  const fromNode = String(props.data?.model || '').trim()
  return fromNode || getDefaultImageModelKey()
})

const currentModel = computed<ImageModel | null>(() => {
  const matched = getModelByName(resolvedModelKey.value)
  return (matched as ImageModel | null) || null
})

const resolvedQuality = computed(() => {
  const model = currentModel.value
  const schema = resolveImageParamSchema(model, '')
  const fromModel = String(model?.defaultParams?.quality || '').trim()
  const fallback = schema.qualities.some(item => item.key === fromModel)
    ? fromModel
    : schema.defaultQuality
  return pickValidChoice(schema.qualities, props.data?.quality, fallback)
})

const resolvedSize = computed(() => {
  const model = currentModel.value
  const fromModel = String(model?.defaultParams?.size || '').trim()
  const schemaWithModelDefault = resolveImageParamSchema(model, resolvedQuality.value)
  const schemaForDefaultQuality = resolveImageParamSchema(model, schemaWithModelDefault.defaultQuality)
  const fallback = pickValidChoice(
    schemaWithModelDefault.sizes,
    fromModel,
    // 模型自己的默认尺寸在「当前画质」下不存在时（如 4K 表里没有 1440x2560），
    // 再用该模型默认画质下的默认尺寸兜一层
    pickValidChoice(schemaForDefaultQuality.sizes, fromModel, schemaWithModelDefault.defaultSize),
  )
  return pickValidChoice(schemaWithModelDefault.sizes, props.data?.size, fallback)
})

const appliedParams = computed<GeneratorParamsSnapshot>(() => ({
  modelKey: resolvedModelKey.value,
  ratio: resolvedSize.value,
  resolution: resolvedQuality.value,
}))

const handleParamsChange = (params: GeneratorParamsSnapshot) => {
  const nextModel = params.modelKey || ''
  const nextSize = params.ratio || ''
  const nextQuality = params.resolution || ''
  if (
    nextModel === (props.data?.model || '')
    && nextSize === (props.data?.size || '')
    && nextQuality === (props.data?.quality || '')
  ) {
    return
  }
  // 参数落在节点自己身上：刷新页面、复制节点、导出模板都能带走
  updateNode(props.id, { model: nextModel, size: nextSize, quality: nextQuality })
}

// ContentGenerator 发送：用上游图作为参考 + 用户 prompt 调图生图，结果回填到当前节点
const isGenerating = ref(false)
const taskStreamController = ref<AbortController | null>(null)
/**
 * 生成等待上限。
 *
 * 超过就判失败 —— 节点**绝不能永远转圈**：用户看着一个不动的圈，既不知道要不要继续等、
 * 也没法重试，比直接看到失败更焦虑。失败态是可操作的（下面给了「重试 / 放弃」）。
 */
const GENERATION_DEADLINE_MS = 15 * 60 * 1000
let deadlineTimer: ReturnType<typeof setTimeout> | null = null
const clearDeadline = () => {
  if (deadlineTimer) {
    clearTimeout(deadlineTimer)
    deadlineTimer = null
  }
}

/**
 * 后台轮询的定时器与起点。
 *
 * 为什么不塞进 shared 的判定模块：那里只做纯判定、可单测；定时器与副作用归组件。
 *
 * 铁律 3（状态要持久化）：进入后台态时把 `backgroundPending` 写进节点 data，
 * 刷新后由挂载期的观察重新启动轮询 —— 这里的内存变量只服务于当前这次挂载。
 */
let backgroundPollTimer: ReturnType<typeof setTimeout> | null = null
let backgroundPollStartedAt = 0
const stopBackgroundPolling = () => {
  if (backgroundPollTimer) {
    clearTimeout(backgroundPollTimer)
    backgroundPollTimer = null
  }
}
/** 收口后台态：停轮询 + 清本地标记（节点 data 由各自落结果的 updateNode 一并清） */
const clearBackgroundState = () => {
  stopBackgroundPolling()
  backgroundPending.value = false
}

/** 统一失败出口：停订阅、停计时、停后台轮询、落可重试的错误态 */
const failRun = (message: string) => {
  clearDeadline()
  stopElapsedTimer()
  stopBackgroundPolling()
  taskStreamController.value?.abort()
  isGenerating.value = false
  isLoading.value = false
  backgroundPending.value = false
  errorMsg.value = message
  updateNode(props.id, { loading: false, backgroundPending: false, error: message })
}

/**
 * 终态与快照统一落盘：提交路径与「刷新后对账」共用同一份判断，
 * 两处各写一遍必然漂移（这也是这次 bug 的成因之一）。
 */
const applyTaskEvent = (event: GenerationTaskStreamEvent) => {
  if (event.type === 'snapshot' || event.type === 'completed') {
    const urls = Array.isArray(event.record?.images) ? event.record.images.filter(Boolean) : []
    if (urls.length) {
      clearDeadline()
      stopElapsedTimer()
      // 后台轮询也可能走到这里（复用同一个落结果形态）：一并收口后台态
      stopBackgroundPolling()
      backgroundPending.value = false
      updateNode(props.id, {
        url: urls[0],
        loading: false,
        error: '',
        executed: true,
        submittedAt: 0,
        backgroundPending: false,
        ...(urls.length > 1
          ? {
              isBatchRoot: true,
              primaryImageId: 'primary',
              batchChildren: urls.map((url, index) => ({ id: index === 0 ? 'primary' : `child_${index}`, url })),
            }
          : {}),
      })
      isGenerating.value = false
    } else if (event.done && event.type === 'completed') {
      // 完成了却一张图都没有：不能留个永远转圈的节点，按同一个口径落可重试的失败态
      failRun('生成任务已结束但没有产出图片，可以重试')
      return
    }
    /**
     * 任务已经结束就把本次订阅主动关掉。
     *
     * 服务端不会在任务终态时结束这条 SSE（它只发事件），不主动 abort 的话这条长连接会一直挂到
     * 服务端的寿命上限 —— 每个节点占一个「用户级实时订阅」额度，攒到 20 就全线 429。
     * 只在 done 时才 abort：运行中的 snapshot（event.done=false）不能掐，否则订阅会立刻断。
     */
    if (event.done) {
      taskStreamController.value?.abort()
    }
    return
  }
  if (event.type === 'failed') {
    failRun(String(event.message || event.record?.error || '图片生成失败'))
    return
  }
  if (event.type === 'stopped') failRun('任务已停止，可以重试')
}

const startDeadline = (submittedAt: number) => {
  clearDeadline()
  const remaining = submittedAt + GENERATION_DEADLINE_MS - Date.now()
  deadlineTimer = setTimeout(
    () => failRun('生成等待超时（长时间没有任何结果），可以重试'),
    Math.max(1000, remaining),
  )
}

/**
 * 「不等了，让它后台跑完」—— 只解除**客户端的等待**，绝不停止服务端任务。
 *
 * 三条铁律的落点：
 *   1. 绝不调用 stopGenerationTask（本函数一次都不碰它，只 abort 本地订阅）；
 *   2. 绝不 abort 服务端任务 —— `taskStreamController.abort()` 断的是浏览器这条 SSE，
 *      服务端任务照常跑到底、照常写记录与资产；
 *   3. 状态写进节点 data（`backgroundPending: true` 且保留 `taskRecordId`），
 *      刷新后由下面的观察重新启动轮询，把结果接回来。
 *
 * `submittedAt` 必须置 0：否则节点重挂载时 `reconcileInterruptedRun` 会把它当成一次新的等待，
 * 又挂上 15 分钟超时并抢先对账。
 */
const handleWaitInBackground = () => {
  if (!isLoading.value) return
  taskStreamController.value?.abort()
  taskStreamController.value = null
  clearDeadline()
  stopElapsedTimer()
  isLoading.value = false
  isGenerating.value = false
  backgroundPending.value = true
  // 保留 taskRecordId —— 轮询与刷新后回填都靠它
  updateNode(props.id, { loading: false, backgroundPending: true, submittedAt: 0, error: '' })
  backgroundPollStartedAt = Date.now()
  scheduleBackgroundPoll(BACKGROUND_POLL_FIRST_DELAY_MS)
  ElMessage.info('已不再等待，任务会在后台跑完，完成后自动出现在这里')
}

/** 按节奏排下一次轮询（首次用首查延迟，之后用间隔） */
const scheduleBackgroundPoll = (delay: number) => {
  stopBackgroundPolling()
  backgroundPollTimer = setTimeout(() => { void runBackgroundPoll() }, delay)
}

/**
 * 轮询一次任务记录并按判定落地。
 *
 * 判定交给 shared 的纯函数（画布节点与生成页共用），这里只做「查询 → 落地状态」。
 * 单次查询失败不放弃：网络抖动很常见，继续按节奏重试，直到预算用尽。
 */
const runBackgroundPoll = async () => {
  if (!backgroundPending.value) return
  const taskId = String(props.data?.taskRecordId || '').trim()
  if (!taskId) {
    failRun('后台任务信息不完整，可以重试')
    return
  }
  if (!backgroundPollStartedAt) backgroundPollStartedAt = Date.now()
  try {
    const record = await getGenerationTask(taskId)
    const decision = decideBackgroundDelivery(record, Date.now() - backgroundPollStartedAt)
    if (decision === 'keep-waiting') {
      scheduleBackgroundPoll(BACKGROUND_POLL_INTERVAL_MS)
      return
    }
    if (decision === 'completed') {
      // 复用 completed 的落结果形态（applyTaskEvent 内部会一并清掉后台态）
      applyTaskEvent({ type: 'completed', record } as GenerationTaskStreamEvent)
      return
    }
    if (decision === 'stopped') {
      failRun('任务已停止，可以重试')
      return
    }
    if (decision === 'failed') {
      failRun(record?.done ? '生成任务已结束但没有产出图片，可以重试' : String(record?.error || '图片生成失败'))
      return
    }
    // give-up：客户端不再等（服务端任务仍会跑完并入库），落可重试失败态
    failRun('后台生成等待超时，可以重试（任务仍会在服务端完成）')
  } catch {
    if (Date.now() - backgroundPollStartedAt >= BACKGROUND_POLL_MAX_DURATION_MS) {
      failRun('后台生成等待超时，可以重试（任务仍会在服务端完成）')
      return
    }
    scheduleBackgroundPoll(BACKGROUND_POLL_INTERVAL_MS)
  }
}

/** 「刷新看看」：立刻查一次（不重置预算，手动刷新绕不过 30 分钟上限） */
const refreshBackgroundNow = () => {
  if (!backgroundPending.value) return
  stopBackgroundPolling()
  void runBackgroundPoll()
}

/**
 * 挂载期观察后台态：`data.backgroundPending` 为真就开始轮询 —— 刷新页面后继续接结果。
 *
 * 为什么先等 200ms 再启动：工作流定义是异步加载的，定义到达会整体替换 nodes，
 * 把挂载时的状态冲掉（reconcileInterruptedRun 那段注释里踩过同样的坑）。
 */
watch(
  () => [props.data?.backgroundPending, props.data?.taskRecordId] as const,
  ([pending, taskId]) => {
    if (!pending || !String(taskId || '').trim()) return
    if (backgroundPollStartedAt) return // 本次挂载已在轮询，别重复启动
    setTimeout(() => {
      if (!backgroundPending.value) return
      backgroundPollStartedAt = Date.now()
      scheduleBackgroundPoll(BACKGROUND_POLL_FIRST_DELAY_MS)
    }, 200)
  },
  { immediate: true, flush: 'post' },
)

/** 生成参数（提交与重试共用） */
interface GenerationInput {
  prompt: string
  refImages: string[]
  modelKey: string
  ratio?: string
  resolution?: string
  count?: number
}

/**
 * **提交阶段**：建任务 → 立刻把 taskId/参数落进节点 data → 返回 taskId。
 *
 * 单独抽出来的原因（2026-09-26，画布 Agent 第一刀）：提交与「等结果」是两件事。
 *   · 用户手动点生成 → 走 runGeneration，提交后继续等出图（体验不变）；
 *   · Agent 调 run_node/run_nodes → 只走这一段，**提交即回执**，不把一轮工具调用卡在出图上。
 * 这里**任何失败都直接抛**（不吞）—— 调用方要如实回执，「没提交成功」绝不能被说成「已提交」。
 */
const submitGeneration = async (input: GenerationInput, submittedAt: number) => {
  const { providerId, modelKey } = await resolveGenerationTaskModel({
    modelKey: input.modelKey,
    fallbackModelKey: input.modelKey,
    category: 'IMAGE',
    missingModelMessage: '未匹配到有效图片模型，请先在后台配置模型',
  })
  const requestBody: Record<string, unknown> = {
    model: modelKey,
    prompt: input.prompt,
    n: Math.max(1, Math.min(8, Number(input.count) || 1)),
    providerId,
  }
  // 尺寸与画质都来自模型能力，这里只负责透传
  if (input.ratio) requestBody.size = input.ratio
  if (input.resolution) requestBody.quality = input.resolution
  const hasRef = input.refImages.length > 0
  const finalBody = hasRef ? appendImageReferencesToRequestBody(requestBody, input.refImages) : requestBody

  const saved = await createGenerationTask({
    source: 'workflow',
    type: 'image',
    requestMode: hasRef ? 'image-edit' : 'image-generation',
    prompt: input.prompt,
    modelKey,
    ratio: input.ratio,
    resolution: input.resolution,
    referenceImages: hasRef ? [...input.refImages] : [],
    requestBody: finalBody,
  })
  const taskId = String(saved?.id || '').trim()
  if (!taskId) throw new Error('图片任务创建失败')

  // 提交时就落库：id 用于「刷新后对账」，提示词与参数用于「重试」。
  // 早先只在完成时才写 id —— 生成中刷新一次，节点就永远转圈（实测两次都这样）。
  updateNode(props.id, {
    prompt: input.prompt,
    referenceImages: hasRef ? [...input.refImages] : [],
    model: modelKey,
    size: input.ratio,
    quality: input.resolution,
    taskRecordId: taskId,
    submittedAt,
    loading: true,
    error: '',
  })
  return taskId
}

/** **等待阶段**：订阅一条已提交的任务流，直到终态。落结果仍由 applyTaskEvent 写回节点 */
const attachGenerationStream = async (taskId: string, submittedAt: number) => {
  const controller = new AbortController()
  taskStreamController.value = controller
  startDeadline(submittedAt)
  startElapsedTimer(submittedAt)
  await subscribeGenerationTaskEvents(taskId, {
    signal: controller.signal,
    onEvent: applyTaskEvent,
  })
}

/** 提交与重试共用的核心：提交 → 等结果（用户手动路径，行为与改动前一致） */
const runGeneration = async (input: GenerationInput) => {
  isGenerating.value = true
  taskStreamController.value?.abort()
  // 重新提交就退出后台态：停掉上一轮的轮询，避免旧任务的结果覆盖新一轮
  clearBackgroundState()
  updateNode(props.id, { loading: true, backgroundPending: false, error: '' })
  const submittedAt = Date.now()
  runStartedAt.value = submittedAt
  try {
    const taskId = await submitGeneration(input, submittedAt)
    await attachGenerationStream(taskId, submittedAt)
  } catch (err: unknown) {
    console.error('[ImageNode] generation failed', err)
    failRun(err instanceof Error ? err.message : '图片生成失败')
  }
}

/**
 * 刷新页面后对账：节点上残留的 loading 是**持久化下来的**，不对账就永远转圈。
 *
 * 实测：两次生成在服务端都是 `done: true` 且图片已存好，画布上却一直转 ——
 * 因为订阅随刷新丢了，而节点既没留任务 id、也没人去查。
 */
const reconcileInterruptedRun = async () => {
  if (!isLoading.value) return
  const taskId = String(props.data?.taskRecordId || '').trim()
  const submittedAt = Number(props.data?.submittedAt || 0)
  /**
   * 只信任「提交时写下的」id，也就是带 submittedAt 的那种。
   *
   * 遗留数据里可能有**上一次**生成留下的 id（旧版只在完成时写 id），
   * 拿它对账会把上一轮的结果落到这一轮上 —— 实测发生过：节点凭空显示了一张旧图。
   * 宁可给出可重试的失败态，也不要落一张来路不对的图。
   */
  if (!taskId || !submittedAt) {
    failRun('上次生成中断了（任务信息不完整），可以重试')
    return
  }
  if (Date.now() - submittedAt > GENERATION_DEADLINE_MS) {
    failRun('上次生成等待超时，可以重试')
    return
  }
  try {
    const record = await getGenerationTask(taskId)
    // 任务记录里的 createdAt 是**权威的提交时间**：节点 data 里的 submittedAt 可能已丢失
    const recordStartedAt = Date.parse(String(record?.createdAt || ''))
    if (Number.isFinite(recordStartedAt)) runStartedAt.value = recordStartedAt

    /**
     * 自愈：把任务记录里的 prompt / submittedAt 回填到节点 data。
     *
     * 为什么要这么做：实测提交时写进节点的 `prompt`/`submittedAt` 在**保存后读回是空**
     * （`taskRecordId` 却留着），用户因此会觉得「重试还要重新输一遍提示词」——
     * 等于白写一次。任务记录里存着那次提交的原文与时间，是权威来源，
     * 加载时发现节点上缺了就用它补回去；补完这次保存就是干净的，之后不再丢。
     */
    const missingPrompt = !String(props.data?.prompt || '').trim()
    const missingSubmittedAt = !(Number(props.data?.submittedAt) > 0)
    if (missingPrompt || missingSubmittedAt) {
      updateNode(props.id, {
        ...(missingPrompt && record?.prompt ? { prompt: String(record.prompt) } : {}),
        ...(missingSubmittedAt && Number.isFinite(recordStartedAt) ? { submittedAt: recordStartedAt } : {}),
      })
    }
    if (record?.done) {
      const urls = Array.isArray(record.images) ? record.images.filter(Boolean) : []
      if (urls.length) {
        applyTaskEvent({ type: 'completed', record } as GenerationTaskStreamEvent)
        return
      }
      failRun('上次生成没有产出结果，可以重试')
      return
    }
    if (record?.stopped) { failRun('任务已停止，可以重试'); return }
    if (record?.error) { failRun(String(record.error)); return }
    // 还在跑：重新订阅跟着它走，并挂上超时兜底（而不是干等）
    const controller = new AbortController()
    taskStreamController.value = controller
    startDeadline(submittedAt || runStartedAt.value || Date.now())
    startElapsedTimer(submittedAt || runStartedAt.value || Date.now())
    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: applyTaskEvent,
    })
  } catch (err: unknown) {
    failRun(err instanceof Error ? err.message : '无法获取任务状态，可以重试')
  }
}

/**
 * 供画布助手调用：用节点当前已配置的参数**提交一次生成**。
 *
 * 为什么单独抽出来：runGeneration 在组件内部，画布这一层原本没有入口 ——
 * 助手只能说「你可以点一下生成」，做不了「我替你跑」。注册到 useCanvasNodeRunner 后，
 * Agent 的 run_node 工具就能真的提交它（缺提示词时抛错，由工具层转成可读原因回给模型）。
 *
 * **提交即返回**（2026-09-26，第一刀：手感）：以前这里 await 到出图，于是一次 run_node 要卡几分钟，
 * 面板只剩「执行中…」，模型又不甘心就只能反复读画布等 —— 那一整轮就烧在等待上。
 * 现在提交成功立刻返回，出图仍由本节点自己的事件流落回画布（applyTaskEvent 一个字没改）。
 * 代价是：提交之后才失败（上游拒绝）不再由这次回执体现，而是落在节点的 generationStatus=error 上，
 * 模型读单节点就能看到 —— 这与「提交/完成分离」是同一件事的两面。
 */
const runOnceForAgent = async () => {
  const prompt = String(props.data?.prompt || '').trim()
  if (!prompt) throw new Error('该图片节点还没有提示词，先给它写一个（update_node 的 prompt）')
  isGenerating.value = true
  taskStreamController.value?.abort()
  clearBackgroundState()
  updateNode(props.id, { loading: true, backgroundPending: false, error: '' })
  const submittedAt = Date.now()
  runStartedAt.value = submittedAt
  let taskId = ''
  try {
    taskId = await submitGeneration({
      prompt,
      refImages: (Array.isArray(props.data?.referenceImages) ? props.data.referenceImages : []).filter(isRasterReferenceUrl),
      modelKey: String(props.data?.model || '').trim(),
      ratio: String(props.data?.size || '') || undefined,
      resolution: String(props.data?.quality || '') || undefined,
      count: 1,
    }, submittedAt)
  } catch (err: unknown) {
    /**
     * 提交阶段就失败（模型解析不到、建任务被拒）：落失败态，并把**真实原因抛给工具层**。
     * 这里绝不能吞 —— 吞了工具层就会把「没提交成功」说成「已提交，正在生成」，
     * 那正是之前专门修过的「提交了但马上失败被报成成功」。
     */
    const message = err instanceof Error ? err.message : '图片生成提交失败'
    failRun(message)
    throw err instanceof Error ? err : new Error(message)
  }
  // 提交成功即返回；等结果交给后台这条订阅（节点卸载时它自己会随 taskStreamController 断掉）
  void attachGenerationStream(taskId, submittedAt).catch((err: unknown) => {
    if ((err as { name?: string })?.name === 'AbortError') return
    failRun(err instanceof Error ? err.message : '生成结果订阅中断')
  })
}

onMounted(() => {
  registerNodeRunner(props.id, runOnceForAgent)
})

onBeforeUnmount(() => {
  unregisterNodeRunner(props.id)
  // 组件卸载（切画布/删节点）：收掉本节点的高亮，别让状态在内存里养着一个不再存在的 id
  clearAgentActiveNodesForIds([props.id])
})

/**
 * 失败后重试：用**任务记录里那次真实提交的正文**与参数原样重跑。
 *
 * 为什么以记录为准而不是节点上的 `prompt`：实测发现节点上那份可能被清成空串
 * （同一批写入里 `taskRecordId` 落盘了、`prompt` 是空，原因未查明），
 * 而任务记录里存的永远是那次提交的原文 —— 拿它重试才是「原样重跑」。
 *
 * 另外**不再走 composeFinalPrompt**：那份正文已经合并过上游文本，再拼一次会说两遍。
 */
const retryLastRun = async () => {
  const taskId = String(props.data?.taskRecordId || '').trim()
  let prompt = String(props.data?.prompt || '').trim()
  let refImages = (Array.isArray(props.data?.referenceImages) ? props.data.referenceImages : [])
    .filter(isRasterReferenceUrl)

  if ((!prompt || !refImages.length) && taskId) {
    try {
      const record = await getGenerationTask(taskId)
      if (!prompt) prompt = String(record?.prompt || '').trim()
      const media = Array.isArray(record?.referenceImages) ? record.referenceImages.filter(Boolean) : []
      if (!refImages.length && media.length) refImages = media.filter(isRasterReferenceUrl)
    } catch {
      // 取不到就退回下面的「请重新输入」，不静默失败
    }
  }

  if (!prompt) {
    dismissError()
    ElMessage.info('没有可重试的提示词，请重新输入')
    return
  }
  void runGeneration({
    prompt,
    refImages,
    modelKey: String(props.data?.model || '').trim(),
    ratio: String(props.data?.size || '') || undefined,
    resolution: String(props.data?.quality || '') || undefined,
    count: 1,
  })
}

/** 放弃这次生成：回到空态，用户可以重新写提示词 */
const dismissError = () => {
  errorMsg.value = ''
  updateNode(props.id, { error: '', loading: false, taskRecordId: '', submittedAt: 0 })
}

const handlePromptSend = async (
  message: string,
  _type?: string,
  options?: {
    modelKey?: string
    ratio?: string
    resolution?: string
    count?: number
    referenceImages?: string[]
    unresolvedReferences?: string[]
    /** 「智能引用 AutoLink」开关状态：关掉时不再兜底注入上游素材 */
    autoLink?: boolean
  },
) => {
  // 上游文本节点连过来的提示词 + 节点内输入，合并后提交
  const prompt = composeFinalPrompt(message)
  if (!prompt || isGenerating.value) {
    if (!prompt) ElMessage.info('请先写提示词，或从上游接一个文本节点')
    return
  }
  // 写错的 token（序号越界 / 资产已失效）不阻塞提交，但要说清楚哪几处没生效，
  // 否则用户以为引用了实际没有，属于静默失败
  const unresolvedRefs = Array.isArray(options?.unresolvedReferences)
    ? options.unresolvedReferences.filter(Boolean)
    : []
  if (unresolvedRefs.length) {
    ElMessage.warning(`有 ${unresolvedRefs.length} 处引用已失效：${unresolvedRefs.join('、')}`)
  }
  // 参考图来源优先级（显式引用必须赢）：
  //   · 用户在提示词里敲了 @ 引用 → composer 已把解析出的媒体按出现顺序放进
  //     options.referenceImages，这里原样使用，绝不能用「上游图片全量注入」覆盖回去，
  //     否则用户挑出来的那张会被整条上游覆盖，显式引用等于失效；
  //   · 一个 @ 都没敲（或解析结果为空）→ 走「上游全量注入」的兜底，
  //     但**只有 AutoLink 开着时才兜底**：关掉开关就是「只提交我显式引用的」，
  //     这时再兜底等于开关没生效（这条由 composer 通过 options.autoLink 带过来）。
  const autoLinkEnabled = options?.autoLink !== false
  const rawRefImages = Array.isArray(options?.referenceImages) && options.referenceImages.length
    ? options.referenceImages
    : (autoLinkEnabled ? upstreamReferenceUrls.value : [])
  // 再做一次栅格过滤，防止用户直接通过 ContentGenerator 上传 SVG/PDF 等
  const refImages = rawRefImages.filter(isRasterReferenceUrl)
  if (rawRefImages.length > refImages.length) {
    ElMessage.warning('已忽略非栅格格式（SVG 等）的参考图，图生图模型不支持')
  }
  isGenerating.value = true
  taskStreamController.value?.abort()
  // 重新提交就退出后台态：停掉上一轮的轮询，避免旧任务的结果覆盖新一轮
  clearBackgroundState()
  updateNode(props.id, { loading: true, backgroundPending: false, error: '' })
  try {
    const fallbackKey = String(options?.modelKey || '').trim() || String(props.data?.model || '').trim()
    const { providerId, modelKey } = await resolveGenerationTaskModel({
      modelKey: fallbackKey,
      fallbackModelKey: fallbackKey,
      category: 'IMAGE',
      missingModelMessage: '未匹配到有效图片模型，请先在后台配置模型',
    })
    const requestBody: Record<string, unknown> = {
      model: modelKey,
      prompt,
      n: Math.max(1, Math.min(8, Number(options?.count) || 1)),
      providerId,
    }
    // 尺寸与画质都来自模型能力，这里只负责透传
    if (options?.ratio) requestBody.size = options.ratio
    if (options?.resolution) requestBody.quality = options.resolution
    const hasRef = refImages.length > 0
    const finalBody = hasRef ? appendImageReferencesToRequestBody(requestBody, refImages) : requestBody

    const saved = await createGenerationTask({
      source: 'workflow',
      type: 'image',
      requestMode: hasRef ? 'image-edit' : 'image-generation',
      prompt,
      modelKey,
      ratio: options?.ratio,
      resolution: options?.resolution,
      referenceImages: hasRef ? [...refImages] : [],
      requestBody: finalBody,
    })
    const taskId = String(saved?.id || '').trim()
    if (!taskId) throw new Error('图片任务创建失败')

    const controller = new AbortController()
    taskStreamController.value = controller
    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'snapshot' || event.type === 'completed') {
          const urls = Array.isArray(event.record?.images) ? event.record.images.filter(Boolean) : []
          if (urls.length) {
            // 出多张时把首张作为主图、其余收进批量组，卡片可以叠卡展示
            updateNode(props.id, {
              url: urls[0],
              loading: false,
              error: '',
              executed: true,
              taskRecordId: taskId,
              ...(urls.length > 1
                ? {
                  isBatchRoot: true,
                  primaryImageId: 'primary',
                  batchChildren: urls.map((url, index) => ({ id: index === 0 ? 'primary' : `child_${index}`, url })),
                }
                : {}),
            })
            isGenerating.value = false
          }
        }
        if (event.type === 'failed') {
          updateNode(props.id, { loading: false, error: String(event.message || event.record?.error || '图片生成失败') })
          isGenerating.value = false
        }
        if (event.type === 'stopped') {
          updateNode(props.id, { loading: false, error: '任务已停止' })
          isGenerating.value = false
        }
      },
    })
  } catch (err: unknown) {
    console.error('[ImageNode] generation failed', err)
    const msg = err instanceof Error ? err.message : '图片生成失败'
    updateNode(props.id, { loading: false, error: msg })
    isGenerating.value = false
  }
}

// 自动执行：上游连线建立后，或模板/编排器把 autoExecute 置位时，自动跑一次生成
watch(
  () => props.data?.autoExecute,
  (shouldExecute) => {
    if (shouldExecute && !isGenerating.value) {
      updateNode(props.id, { autoExecute: false })
      const autoPrompt = upstreamPromptText.value
      if (autoPrompt) {
        setTimeout(() => handlePromptSend(autoPrompt), 200)
      }
    }
  },
)
</script>

<template>
  <div class="image-node-wrapper">
    <!-- 标题行（卡外，位于卡片上方）：双击改名。无折叠按钮 —— 图片节点没有 collapsed 态 -->
    <div class="image-node-title" :title="titleEdit.editing.value ? '' : '双击编辑名称'" @dblclick.stop="titleEdit.start">
      <el-icon class="image-node-title-icon"><Picture /></el-icon>
      <input
        v-if="titleEdit.editing.value"
        :ref="titleEdit.setInputRef"
        v-model="titleEdit.draft.value"
        class="image-node-title-input nodrag"
        :maxlength="40"
        @blur="titleEdit.commit"
        @keydown.enter.prevent="titleEdit.commit"
        @keydown.esc.prevent="titleEdit.cancel"
        @mousedown.stop
        @click.stop
      />
      <span v-else>{{ data?.label || '图片' }}</span>
      <span v-if="outputMeta" class="image-node-title-meta">{{ outputMeta }}</span>
    </div>

    <div
      class="image-node-card"
      :class="{ 'is-selected': isSelected, 'is-agent-created': agentCreated, 'is-agent-generating': agentGenerating }"
      :style="[cardSizeStyle(cardSize), agentHighlightStyle]"
    >
      <div v-if="showLoading" class="image-node-loading" aria-label="图片生成中">
        <div class="image-node-spinner" />
        <div class="image-node-loading-meta">
          <span class="image-node-loading-elapsed">生成中 {{ formattedElapsed }}</span>
          <span v-if="showSlowHint" class="image-node-loading-hint">比平时慢，可能在上游排队</span>
          <!-- 「不等了」只解除本地等待：断订阅、停计时，服务端任务照常跑完并交付。
               这里绝不调 stop 接口 —— 上游钱已付、结果有保证，取消会退款却拿不到成果，净亏。见脚本区注释。 -->
          <button type="button" class="image-node-background-wait-btn nodrag nopan" @click.stop="handleWaitInBackground">
            不等了，让它后台跑完
          </button>
        </div>
      </div>
      <!-- 失败态必须可操作：一直转圈会让用户既不敢走也不知道能不能等（用户反馈原话） -->
      <div v-else-if="showError" class="image-node-error" role="alert">
        <div class="image-node-error-text">{{ errorMsg }}</div>
        <div class="image-node-error-actions">
          <button type="button" class="image-node-error-btn is-primary nodrag nopan" @click.stop="retryLastRun">重试</button>
          <button type="button" class="image-node-error-btn nodrag nopan" @click.stop="dismissError">放弃</button>
        </div>
      </div>
      <!-- 后台生成中：轻量状态，不转圈、不骨架屏 —— 任务在服务端继续跑，这里只等结果自动回来 -->
      <div v-else-if="showBackground" class="image-node-background">
        <div class="image-node-background-text">后台生成中，完成后会出现在这里</div>
        <button type="button" class="image-node-background-btn nodrag nopan" @click.stop="refreshBackgroundNow">刷新看看</button>
      </div>
      <img v-else-if="showImage" :src="imageUrl" alt="生成图片" class="image-node-image" @dblclick.stop="openImagePreview()" />

      <!-- 角标盖在图上，不吃鼠标事件（不挡双击预览与拖拽） -->
      <span v-if="showImage && isGenerated" class="image-node-ai-badge">AI生成</span>

      <!-- 空态：照抄 LibTV 的「尝试」写法（空图片节点上就是这两项）。
           两项都必须有真实行为 —— 图生图落到本节点上传，图片高清走已验证的 image-edit 管线。 -->
      <div v-else-if="showEmpty" class="image-node-empty">
        <div class="image-node-empty-title">尝试：</div>
        <div class="image-node-empty-menu">
          <button type="button" class="image-node-empty-item nodrag nopan" @click.stop="triggerUpload">
            <el-icon class="image-node-empty-item-icon"><Picture /></el-icon>
            <span>图生图</span>
          </button>
          <button type="button" class="image-node-empty-item nodrag nopan" @click.stop="handleEnhance">
            <el-icon class="image-node-empty-item-icon"><MagicStick /></el-icon>
            <span>图片高清</span>
          </button>
        </div>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        style="display: none"
        @change="handleFileChange"
      />
    </div>
    <!-- 节点工具栏：只在有图时出现（LibTV 同款规则 —— 空节点给的是卡内「尝试」列表） -->
    <div class="image-node-toolbar-anchor">
      <!-- 这一层必须紧包住工具栏本身：贴边收敛要按**工具栏的真实宽度**算，
           挂在撑满卡片的锚点层上会量到卡片宽度（622），收敛位置就会偏 -->
      <div ref="toolbarRef" class="image-node-toolbar-box" :style="toolbarStyle">
        <CanvasNodeTopToolbar :visible="isSelected && showImage && !isLoading" :items="toolbarItems" />
      </div>
    </div>

    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />
    <ImageCropDialog v-model="cropVisible" :src="imageUrl" @confirm="handleCropConfirm" />

    <el-image-viewer v-if="previewVisible" :url-list="[previewTarget]" :z-index="4000" :scale="0.86" teleported hide-on-click-modal @close="previewVisible = false" />
    <div
      v-if="isSelected && !showLoading"
      ref="composerRef"
      class="image-node-prompt-panel nodrag nopan"
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
        initial-creation-type="image"
        :hide-type-selector="true"
        :verbose-toolbar="true"
        :external-prompt="String(data?.prompt || '')"
        :prompt-sync-key="String(data?.prompt || '')"
        :external-reference-images="upstreamReferenceUrls"
        :referenceable-assets="referenceableAssets"
        :initial-params="appliedParams"
        placeholder-override="可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜"
        popup-placement="top"
        @params-change="handleParamsChange"
        @send="handlePromptSend"
      />
    </div>
  </div>
</template>

<style scoped>
.image-node-wrapper { position: relative; width: 100%; height: 100%; }
/* 标题行：位于卡片上方（bottom:100% 相对 .image-node-wrapper 定位）。
   样式与 video/text 节点同构，只少了折叠按钮。色值一律走 token，不写死。 */
.image-node-title {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: var(--canvas-node-title-gap);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--canvas-node-title-fg);
  font-size: var(--canvas-node-title-size);
  font-weight: var(--canvas-node-title-weight);
  line-height: var(--canvas-node-title-line);
  cursor: pointer;
  user-select: none;
}
.image-node-title-icon {
  font-size: var(--canvas-node-title-icon);
  color: var(--canvas-node-title-fg);
}
.image-node-title-input {
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
.image-node-title-meta {
  margin-left: auto;
  font-size: var(--canvas-node-meta-size);
  font-variant-numeric: tabular-nums;
  color: var(--canvas-node-meta-fg);
  white-space: nowrap;
}
/* 尺寸由 config/node-size.ts 算出后内联绑定（跟比例走），这里不再写死 min-width/min-height */
.image-node-card { position: relative; overflow: hidden; border: 1px solid var(--canvas-node-border); border-radius: 12px; box-sizing: border-box; background: var(--canvas-node-bg); }
.image-node-card.is-selected { border-color: var(--canvas-node-border-selected); }
/* Agent 画布动作高亮（仅 UI 的瞬时描边，不进节点数据）。
   刚创建=实线描边渐隐；生成中=虚线脉冲。都克制：只加一圈细描边，不发光不放缩。
   错开延迟来自内联的 --agent-stagger-delay，让批量创建的节点依次点亮。 */
.image-node-card.is-agent-created {
  border-color: var(--canvas-agent-active, #7c5cff);
  animation: canvas-agent-created-fade 4s ease-out forwards;
  animation-delay: var(--agent-stagger-delay, 0ms);
}
.image-node-card.is-agent-generating {
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
.image-node-loading, .image-node-error { display: grid; place-items: center; width: 100%; height: 100%; }
.image-node-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  color: #ef4444;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  box-sizing: border-box;
}
.image-node-error-text { max-width: 100%; word-break: break-word; }
.image-node-error-actions { display: inline-flex; align-items: center; gap: 8px; }
.image-node-error-btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--canvas-node-border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.image-node-error-btn:hover { background: var(--bg-block-secondary-hover); color: var(--text-primary); }
.image-node-error-btn.is-primary {
  border-color: transparent;
  background: var(--brand-main-default);
  color: #fff;
}
.image-node-error-btn.is-primary:hover { filter: brightness(1.08); color: #fff; }
.image-node-loading-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.image-node-loading-elapsed {
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.image-node-loading-hint { color: var(--text-tertiary); font-size: 11px; }
/* 「不等了」：生成中卡片上唯一的出口 —— 只解除本地等待，不停止服务端任务。
   这里曾有 .image-node-cancel（真取消按钮），2026-09-26 按产品要求删除（见脚本区注释）。 */
.image-node-background-wait-btn {
  margin-top: 2px;
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--canvas-node-border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.image-node-background-wait-btn:hover { background: var(--bg-block-secondary-hover); color: var(--text-primary); }
/* 后台生成中：轻量状态（不转圈、不骨架屏），让用户知道任务还在跑、只是自己不等了 */
.image-node-background {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 16px;
  box-sizing: border-box;
  text-align: center;
}
.image-node-background-text { color: var(--text-secondary); font-size: 12px; line-height: 18px; }
.image-node-background-btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--canvas-node-border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.image-node-background-btn:hover { background: var(--bg-block-secondary-hover); color: var(--text-primary); }
.image-node-spinner { width: 18px; height: 18px; border: 2px solid var(--stroke-secondary); border-top-color: var(--brand-main-default); border-radius: 50%; animation: image-node-spin 0.8s linear infinite; }
@keyframes image-node-spin { to { transform: rotate(360deg); } }
/* cover 而不是 contain：LibTV 的图片节点就是 object-cover —— 非当前比例的图被裁切，
   而不是让卡片变形（空节点也一样是 622×350 的固定框） */
.image-node-image { display: block; width: 100%; height: 100%; object-fit: cover; }

/* 空态「尝试」列表：与 LibTV 一致的分组标题 + 竖排列 */
.image-node-empty { display: flex; flex-direction: column; justify-content: center; height: 100%; padding: 20px; box-sizing: border-box; }
.image-node-empty-title { padding: 0 8px; margin-bottom: 12px; color: var(--text-tertiary); font-size: 13px; line-height: 18px; }
.image-node-empty-menu { display: flex; flex-direction: column; gap: 2px; }
.image-node-empty-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 13px; text-align: left; cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease; }
.image-node-empty-item:hover { background: var(--bg-block-secondary-hover); color: var(--text-primary); }
.image-node-empty-item-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex-shrink: 0; color: var(--text-tertiary); font-size: 16px; }
.image-node-empty-item:hover .image-node-empty-item-icon { color: var(--text-primary); }

.image-node-ai-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.92);
  font-size: 11px;
  line-height: 16px;
  pointer-events: none;
  backdrop-filter: blur(2px);
}

/* 工具栏锚点撑满卡片（提供 bottom:100% / left:50% 的参照），真正的盒子是里面那层 */
.image-node-toolbar-anchor { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
.image-node-toolbar-box { position: absolute; bottom: 100%; left: 50%; display: inline-flex; pointer-events: auto; }
/* 工具栏组件自带一套「浮在卡片上方」的定位，这里由外层盒子接管，把它退回普通流 */
.image-node-toolbar-box :deep(.canvas-node-top-toolbar) {
  position: static;
  bottom: auto;
  left: auto;
  transform: none;
}

/* 宽 660、不随画布缩放 —— 都由内联 style 给（见 composerStyle），这里只负责挂到卡片正下方。
   间距 12px 是 LibTV 实测值，和视频/文本节点保持一致（原先这里写的是 18px，三个节点各写一份） */
.image-node-prompt-panel { position: absolute; top: calc(100% + 12px); left: 50%; z-index: 10; }
</style>
