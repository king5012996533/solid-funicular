<script setup lang="ts">
/**
 * 图片节点（RunningHUB 风样板）
 *
 * 视觉对照 HTML 抽出的真实样式：
 *   - 卡片 380×280, border-radius 16
 *   - 标题外置（absolute bottom:100%）
 *   - 4 类状态：空态菜单 / ready-state（有上游连线）/ 加载 / 有图
 *   - 选中态：青绿描边 + 流光边框 + 模糊光晕
 *   - 节点外左右 -56px "+" 按钮
 *   - 选中后下方浮出 CanvasPromptInput（图片模型 + 尺寸/质量/价格 chip）
 *   - 保留批量生图组叠卡能力
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import {
  CopyDocument,
  Download,
  Delete,
  Picture,
  VideoCamera,
  PictureFilled,
  Sunny,
  Upload as UploadIcon,
  Aim,
  EditPen,
  Refresh,
  MoreFilled,
  Crop,
  ZoomIn,
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import CanvasNodeHoverToolbar, { type NodeToolbarAction } from '@/components/canvas/CanvasNodeHoverToolbar.vue'
import CanvasNodeTopToolbar, { type NodeTopToolbarItem } from '@/components/canvas/CanvasNodeTopToolbar.vue'
import ContentGenerator, { type GeneratorParamsSnapshot } from '@/components/generate/ContentGenerator.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import { useNodeTitleEdit } from '@/composables/useNodeTitleEdit'
import {
  updateNode,
  removeNode,
  duplicateNode,
  addNode,
  addEdge,
  nodes,
  type WorkflowImageNodeData,
} from '../../composables/useWorkflowCanvas'
import { uploadStorageFile } from '@/api/storage'
import { loadPublicModelCatalog, getModelByName, getDefaultImageModelKey, type ImageModel } from '@/config/models'
import { describeAspectRatio, describeResolutionTier, pickValidChoice, resolveImageParamSchema } from '@/config/model-params'
import { isRasterReferenceUrl } from '@/config/reference-validation'
import { collectUpstreamPromptText, composePrompt } from '../../composables/upstream-inputs'
import { useNodeInputState } from '../../composables/node-input-requirements'
import { useNodeCollapse } from '../../composables/useNodeCollapse'
import { inboundEdges, outboundEdges, nodeIndex } from '../../composables/workflow-graph-index'
import { collectReferenceableAssets } from '../../composables/reference-resolver'
import { createGenerationTask, subscribeGenerationTaskEvents, resolveGenerationTaskModel } from '@/api/generation-tasks'
import { appendImageReferencesToRequestBody } from '@/shared/image-generation-request'

const props = defineProps<{
  id: string
  data: WorkflowImageNodeData & { selected?: boolean }
  selected?: boolean
}>()
const isSelected = computed(() => props.selected || props.data?.selected)
const titleEdit = useNodeTitleEdit(props.id, () => props.data?.label || 'Image')
const { updateNodeInternals, addSelectedNodes, removeSelectedNodes, getNodes } = useVueFlow()

const showActions = ref(false)
const imageUrl = ref(props.data?.url || '')
const isLoading = ref(!!props.data?.loading)
const errorMsg = ref(props.data?.error || '')
const fileInputRef = ref<HTMLInputElement | null>(null)

watch(
  [() => props.data?.url, () => props.data?.loading, () => props.data?.error],
  ([url, loading, error]) => {
    if (url !== undefined) imageUrl.value = url
    if (loading !== undefined) isLoading.value = loading
    if (error !== undefined) errorMsg.value = error
  },
)

// 上游连线检测：当 target=本节点 的边存在时，节点处于"已连接参考图片"状态
/**
 * 上游输入状态（对齐 LibTV：节点自己说清「已有什么、还缺什么」）。
 * 判定标准是上游**真的产出了内容**，不是「有一条边」——
 * 连了一个还没出图的节点不算已连接，否则界面会说谎。
 */
const inputState = useNodeInputState(() => props.id)
const { collapsed, toggleCollapse } = useNodeCollapse(() => props.id)

// 4 类状态优先级：加载 > 错误 > 有图 > ready-state（有真实上游内容）> 空态菜单
const showLoading = computed(() => isLoading.value)
const showError = computed(() => !isLoading.value && !!errorMsg.value)
const showImage = computed(() => !isLoading.value && !errorMsg.value && !!imageUrl.value)
const showReady = computed(() => (
  !showLoading.value && !showError.value && !showImage.value && inputState.value.satisfied.length > 0
))
const showEmpty = computed(() => !showLoading.value && !showError.value && !showImage.value && !showReady.value)

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
      imageUrl.value = uploaded.publicUrl
      updateNode(props.id, { url: uploaded.publicUrl, loading: false })
      // 上传成功后：如果还没有下游节点，自动创建一个 ready-state 的下游 image 节点
      autoCreateDownstreamImageNode()
    } else {
      throw new Error('upload returned empty')
    }
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

// 已有下游节点？
// 上下游都走共享索引：原先每帧都要遍历整个 edges 数组，节点一多就是灾难
// （实测 1000 节点时拖拽只有 24 FPS，索引化后回到可接受区间）
const hasDownstream = computed(() => (outboundEdges.value.get(props.id) || []).length > 0)

/**
 * 自动创建一个下游 image 节点 + 连线，让画布进入 img_5 状态：
 * 「左侧已上传图片节点 → 右侧 ready-state Image 节点 + 底部 PromptInput（自动带 "图片1" 缩略 chip）」
 */
const autoCreateDownstreamImageNode = () => {
  if (hasDownstream.value) return
  const node = nodes.value.find((n) => n.id === props.id)
  if (!node) return
  const newId = addNode('image', { x: node.position.x + 480, y: node.position.y }, { label: 'Image' })
  addEdge({
    source: props.id,
    target: newId,
    sourceHandle: 'right',
    targetHandle: 'left',
    type: 'imageOrder',
    data: { imageOrder: 1 },
  })
  setTimeout(() => {
    updateNodeInternals([newId])
    const allNodes = getNodes.value
    removeSelectedNodes(allNodes.filter((n) => n.selected))
    const target = allNodes.find((n) => n.id === newId)
    if (target) addSelectedNodes([target])
  }, 100)
}

const handleDownload = async () => {
  if (!imageUrl.value) return
  try {
    const res = await fetch(imageUrl.value)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `image_${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    window.open(imageUrl.value, '_blank')
  }
}

const handleDelete = () => removeNode(props.id)
const handleDuplicate = () => {
  const newId = duplicateNode(props.id)
  if (newId) setTimeout(() => updateNodeInternals([newId]), 50)
}

// 批量生图组：当 isBatchRoot 且子图数量 > 1 时显示叠卡 + 计数
const isBatchGroupVisible = computed(() =>
  Boolean(props.data?.isBatchRoot && (props.data.batchChildren?.length ?? 0) > 1),
)
const batchChildCount = computed(() => props.data?.batchChildren?.length ?? 0)
const toggleBatchExpanded = () => {
  if (!isBatchGroupVisible.value) return
  updateNode(props.id, { batchExpanded: !props.data?.batchExpanded })
}

// 「尝试」菜单：图生图 / 图生视频 / 图片换背景 / 首帧图生视频
const requireImage = (): boolean => {
  if (imageUrl.value) return true
  ElMessage.info('请先上传图片，再使用该能力')
  triggerUpload()
  return false
}

const handleImageToImage = () => {
  if (!requireImage()) return
  // 已有图：直接创建下游占位节点；没图时 requireImage 已触发上传，handleFileChange 上传成功后会调 autoCreate
  autoCreateDownstreamImageNode()
}
const handleImageToVideo = (role: 'first_frame_image' | 'input_reference' = 'input_reference') => {
  if (!requireImage()) return
  const node = nodes.value.find((n) => n.id === props.id)
  if (!node) return
  // 直接建一个视频节点并连线：参数在视频节点自己身上，不再经过配置节点
  const newId = addNode('video', { x: node.position.x + 380, y: node.position.y })
  addEdge({
    source: props.id,
    target: newId,
    sourceHandle: 'right',
    targetHandle: 'left',
    type: 'imageRole',
    data: { imageRole: role },
  })
  setTimeout(() => updateNodeInternals([newId]), 50)
}

const hoverActions = computed<NodeToolbarAction[]>(() => {
  const list: NodeToolbarAction[] = [
    { id: 'duplicate', label: '复制', icon: CopyDocument, onClick: handleDuplicate },
  ]
  if (imageUrl.value) {
    list.push({ id: 'download', label: '下载', icon: Download, onClick: handleDownload })
  }
  list.push({ id: 'delete', label: '删除', icon: Delete, danger: true, onClick: handleDelete })
  return list
})

/**
 * 空态里的动作 = **创建下游节点**，不是本节点的能力。
 *
 * 改之前这里叫「尝试：」，混了四件事：图生图 / 图生视频 / 图片换背景 / 首帧图生视频。
 * 实际情况是三项都在建下游节点（另有 ⊕ 手柄那条路径）、「图片换背景」只弹
 * 「接入中」——4 项里没有一项是"本节点能做什么"。LibTV 的「尝试」放的是
 * 本节点的操作模式（图片节点给图生图/图片高清），语义完全不同。
 *
 * 我们图片节点目前**没有**可供选择的模式（图生图/文生图是由有没有上游参考图
 * 自动决定的，不用户选），所以这里不再摆「尝试」，只留一个标注清楚的分组。
 * 用户要的"本节点能出什么"由输入声明 + 上传按钮 + 下方 composer 承担。
 */
const downstreamItems = [
  { id: 'i2i', label: '再生成一张（图片）', icon: Picture, onClick: handleImageToImage },
  { id: 'i2v', label: '生成视频（当参考帧）', icon: VideoCamera, onClick: () => handleImageToVideo('input_reference') },
  { id: 'first-frame', label: '生成视频（当首帧）', icon: PictureFilled, onClick: () => handleImageToVideo('first_frame_image') },
]

// 选中态下方浮层：用 ContentGenerator（与 /generate 同款），锁定 image 类型
onMounted(() => {
  void loadPublicModelCatalog()
})
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

// 卡片上的参数 chip：模型名 · 尺寸 · 画质。尺寸档位由像素尺寸推导，不是写死的标签。
const paramChips = computed(() => {
  const chips: string[] = []
  const modelKey = appliedParams.value.modelKey
  if (modelKey) {
    const model = getModelByName(modelKey) as { label?: string } | null
    chips.push(model?.label || modelKey)
  }
  const size = appliedParams.value.ratio
  if (size) {
    const tier = describeResolutionTier(size)
    const ratioLabel = describeAspectRatio(size)
    chips.push(tier ? `${ratioLabel} · ${tier}` : ratioLabel)
  }
  const quality = appliedParams.value.resolution
  if (quality) {
    const model = modelKey ? (getModelByName(modelKey) as ImageModel | null) : null
    const matched = model?.qualities?.find((item) => item.key === quality)
    chips.push(matched?.label || quality)
  }
  return chips
})

// 顶部悬浮工具栏（参照 RunningHUB .image-toolbar）：仅在选中 + 有图时显示
const topToolbarItems = computed<NodeTopToolbarItem[]>(() => [
  { id: 'panorama', label: '全景图', icon: Aim, hasDropdown: true, onClick: () => ElMessage.info('全景图：接入中') },
  { id: 'hd', label: 'HD 增强', icon: PictureFilled, onClick: () => ElMessage.info('HD 增强：接入中') },
  { id: 'edit-element', label: '编辑元素', icon: EditPen, onClick: () => ElMessage.info('编辑元素：接入中') },
  { id: 'angle', label: '角度', icon: Refresh, onClick: () => ElMessage.info('角度：接入中') },
  { id: 'light', label: '打光', icon: Sunny, onClick: () => ElMessage.info('打光：接入中') },
  { id: 'more', label: '更多', icon: MoreFilled, onClick: () => ElMessage.info('更多：接入中') },
  { type: 'divider' },
  { id: 'crop', label: '裁剪', icon: Crop, iconOnly: true, onClick: () => ElMessage.info('裁剪：接入中') },
  { id: 'download-mini', label: '下载', icon: Download, iconOnly: true, onClick: handleDownload },
  { id: 'preview', label: '放大预览', icon: ZoomIn, iconOnly: true, onClick: () => imageUrl.value && window.open(imageUrl.value, '_blank') },
  { type: 'divider' },
  { id: 'agent', label: '加入 Agent', textMark: 'R', onClick: () => ElMessage.info('加入 Agent：接入中') },
])

// ContentGenerator 发送：用上游图作为参考 + 用户 prompt 调图生图，结果回填到当前节点
const isGenerating = ref(false)
const taskStreamController = ref<AbortController | null>(null)
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
  //   · 一个 @ 都没敲（或解析结果为空）→ 保持原来的全自动注入行为，向后兼容。
  const rawRefImages = Array.isArray(options?.referenceImages) && options.referenceImages.length
    ? options.referenceImages
    : upstreamReferenceUrls.value
  // 再做一次栅格过滤，防止用户直接通过 ContentGenerator 上传 SVG/PDF 等
  const refImages = rawRefImages.filter(isRasterReferenceUrl)
  if (rawRefImages.length > refImages.length) {
    ElMessage.warning('已忽略非栅格格式（SVG 等）的参考图，图生图模型不支持')
  }
  isGenerating.value = true
  taskStreamController.value?.abort()
  updateNode(props.id, { loading: true, error: '' })
  try {
    const fallbackKey = String(options?.modelKey || '').trim() || String(props.data?.model || '').trim()
    const { providerId, modelKey } = resolveGenerationTaskModel({
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
  <div class="image-node-wrapper" @mouseenter="showActions = true" @mouseleave="showActions = false">
    <!-- 节点外置标题 -->
    <div class="image-node-title" :title="titleEdit.editing.value ? '' : '双击编辑名称'" @dblclick.stop="titleEdit.start">
      <!-- 折叠开关：对齐 LibTV 标题前的 ▶ -->
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
      <span v-else>{{ data?.label || 'Image' }}</span>
    </div>

    <!-- 参数 chip：模型 · 尺寸 · 画质。值来自节点 data，由工具栏写入，
         所以换模型时这一行会跟着变 —— 参数是模型给的，不是卡片写死的 -->
    <div v-if="paramChips.length" class="image-node-params" :title="paramChips.join(' · ')">
      <span v-for="(chip, index) in paramChips" :key="chip" class="image-node-param-chip">
        <span v-if="index > 0" class="image-node-param-divider" aria-hidden="true"></span>
        {{ chip }}
      </span>
    </div>

    <!-- 节点本体 -->
    <div class="image-node-card" :class="{ 'is-selected': isSelected, 'is-collapsed': collapsed }">

      <!-- 折叠态：只留一行摘要，点标题前的 ▶ 展开 -->
      <div v-if="collapsed" class="node-collapsed-summary">
        <span class="node-collapsed-summary__text">
          {{ inputState.connectedLabel || inputState.emptyLabel }}
        </span>
      </div>

      <template v-else>
      <!-- 空态：按类型声明需要什么输入 + 能力项。
           文案来自 node-input-rules（对齐 LibTV：节点自己说清要连什么） -->
      <div v-if="showEmpty" class="image-node-empty">
        <div class="image-node-empty-hint">{{ inputState.emptyLabel }}</div>
        <div class="image-node-empty-title">生成下游节点：</div>
        <div class="image-node-empty-menu">
          <button
            v-for="item in downstreamItems"
            :key="item.id"
            type="button"
            class="image-node-empty-item nodrag nopan"
            @click.stop="item.onClick"
          >
            <el-icon class="image-node-empty-item-icon">
              <component :is="item.icon" />
            </el-icon>
            <span>{{ item.label }}</span>
          </button>
        </div>
        <button class="image-node-upload-pill nodrag nopan" @click.stop="triggerUpload">
          <el-icon><UploadIcon /></el-icon>
          <span>上传图片</span>
        </button>
      </div>

      <!-- ready-state：上游真的产出了内容。
           文案按实际输入拼（已连接提示词 / 已连接参考图 / 两者），不再写死一句 -->
      <div v-else-if="showReady" class="image-node-ready">
        <div class="image-node-ready-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
            <path d="M3 15L7 11L10 14L15 9L21 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="image-node-ready-text">{{ inputState.connectedLabel }}</div>
        <div class="image-node-ready-hint">选中节点后在下方配置并生成</div>
      </div>

      <!-- 加载 -->
      <div v-else-if="showLoading" class="image-node-loading">
        <div class="image-node-spinner" />
        <span>生成中…</span>
      </div>

      <!-- 错误 -->
      <div v-else-if="showError" class="image-node-error" @click.stop="triggerUpload">
        <span>{{ errorMsg }}，点击重新上传</span>
      </div>

      <!-- 有图 -->
      <div
        v-else
        class="image-node-display"
        :class="{ 'is-batch-root': isBatchGroupVisible, 'is-batch-expanded': data?.batchExpanded }"
        @dblclick.stop="toggleBatchExpanded"
      >
        <template v-if="isBatchGroupVisible && !data?.batchExpanded">
          <div class="image-node-batch-frame image-node-batch-frame--2" aria-hidden="true" />
          <div class="image-node-batch-frame image-node-batch-frame--1" aria-hidden="true" />
        </template>
        <img :src="imageUrl" alt="生成图片" class="image-node-image" />
        <button
          class="image-node-replace-btn nodrag nopan"
          title="替换图片"
          @mousedown.stop
          @click.stop="triggerUpload"
        >
          <span class="image-node-replace-icon" aria-hidden="true">↑</span>
          <span>替换</span>
        </button>
        <span v-if="isBatchGroupVisible" class="image-node-batch-count" :title="`批量组 ${batchChildCount} 张，双击展开/折叠`">
          {{ batchChildCount }}
        </span>
        <div v-if="isBatchGroupVisible && data?.batchExpanded" class="image-node-batch-grid">
          <div
            v-for="child in data?.batchChildren"
            :key="child.id"
            class="image-node-batch-grid__item"
            :class="{ 'is-primary': child.id === data?.primaryImageId }"
            @click.stop
          >
            <img :src="child.url" alt="批量子图" />
            <button
              class="image-node-batch-set-primary"
              title="设为主图"
              @click.stop="updateNode(id, { primaryImageId: child.id, url: child.url })"
            >
              ★
            </button>
          </div>
        </div>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        style="display: none"
        @change="handleFileChange"
      />
      </template>
    </div>

    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />

    <CanvasNodeHoverToolbar :visible="showActions" :actions="hoverActions" />

    <!-- 选中态顶部悬浮工具栏（仅有图时显示） -->
    <CanvasNodeTopToolbar :visible="isSelected && showImage" :items="topToolbarItems" />

    <!-- 选中态下方浮出 prompt。
         只要有上游输入（文本或图片）就能生成；空节点也允许直接文生图，
         所以这里不再要求「有上游且自身为空」才出现。 -->
    <div v-if="isSelected && !showLoading" class="image-node-prompt-panel nodrag nopan" @mousedown.stop>
      <ContentGenerator
        layout="sidebar"
        :collapsible="false"
        :default-expanded="true"
        initial-creation-type="image"
        :hide-type-selector="true"
        :verbose-toolbar="true"
        :external-reference-images="upstreamReferenceUrls"
        :referenceable-assets="referenceableAssets"
        :initial-params="appliedParams"
        placeholder-override="描述你想生成的图片内容，按 Enter 生成"
        popup-placement="top"
        @params-change="handleParamsChange"
        @send="handlePromptSend"
      />
    </div>
  </div>
</template>

<style scoped>
.image-node-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

/* 参数 chip 行：夹在标题和卡片之间，随宽度截断不换行 */
.image-node-params {
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
.image-node-param-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 20px;
  color: var(--text-tertiary, rgba(224, 245, 255, 0.55));
  flex-shrink: 0;
}
.image-node-param-divider {
  width: 1px;
  height: 10px;
  background: var(--stroke-tertiary, rgba(255, 255, 255, 0.14));
}
.image-node-param-chip:first-child {
  color: var(--text-secondary, rgba(224, 245, 255, 0.72));
  font-weight: 500;
}

.image-node-title {
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
  letter-spacing: 0.2px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease, color 0.2s ease;
}
.image-node-title:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}
.image-node-title-icon {
  font-size: 16px;
  color: var(--text-tertiary);
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
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  outline: none;
  box-sizing: border-box;
}

.image-node-card {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 380px;
  min-height: 280px;
  background: var(--canvas-node-bg);
  /* 常驻 1px 描边（LibTV 同款）：未选中几乎看不见，选中只换颜色。
     这样选中态不靠"加一圈"实现，节点尺寸不会跳动 */
  border: 1px solid var(--canvas-node-border);
  /* LibTV 实测 12px */
  border-radius: 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  transition: border-color 0.16s, min-width 0.2s ease;
}
/* 有图态：节点变宽，图片居中（参照 RunningHUB 生成结果布局 img_11） */
.image-node-card:has(.image-node-display) {
  min-width: 580px;
  min-height: 340px;
}
.image-node-card.is-selected {
  border-color: var(--canvas-node-border-selected);
}

/* 空态菜单 */
.image-node-empty {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  justify-content: center;
  padding: 20px;
}
.image-node-empty-title {
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 18px;
  /* 与下面图标列共用一条左边界 */
  padding: 0 8px;
  margin-bottom: 12px;
}
/* 输入需求声明：告诉用户该去连什么才能开始（对齐 LibTV 的空态写法） */
.image-node-empty-hint {
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 18px;
  padding: 0 8px;
  margin-bottom: 16px;
}
.image-node-empty-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.image-node-empty-item {
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
  transition: background-color 0.15s ease, color 0.15s ease;
}
.image-node-empty-item:hover {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
.image-node-empty-item-icon {
  font-size: 16px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.image-node-empty-item:hover .image-node-empty-item-icon {
  color: var(--text-primary);
}
.image-node-upload-pill {
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
.image-node-upload-pill:hover {
  background: var(--canvas-float-block-hover);
  color: var(--brand-main-default);
}

/* ready-state（有上游连线但空图）*/
.image-node-ready {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  padding: 24px;
}
.image-node-ready-icon {
  color: var(--text-tertiary);
  opacity: 0.6;
}
.image-node-ready-text {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}
.image-node-ready-hint {
  color: var(--text-tertiary);
  font-size: 12px;
}

/* 加载 / 错误 */
.image-node-loading,
.image-node-error {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
}
.image-node-error {
  color: #ef4444;
  cursor: pointer;
}
.image-node-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--stroke-secondary);
  border-top-color: var(--brand-main-default);
  animation: image-node-spin 0.8s linear infinite;
}
@keyframes image-node-spin {
  to { transform: rotate(360deg); }
}

/* 批量组叠卡 / 有图态：图片居中，最大尺寸限制让节点周围有黑色边距（参照 img_11） */
.image-node-display {
  position: relative;
  flex: 1 1 0;
  display: inline-flex;
  justify-content: center;
  overflow: hidden;
}
.image-node-image {
  max-width: 320px;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  position: relative;
  z-index: 1;
  border-radius: var(--lv-border-radius-medium);
}
.image-node-batch-frame {
  position: absolute;
  inset: 0;
  background: var(--canvas-bg-block-default);
  border: 0.5px solid var(--stroke-secondary);
  border-radius: var(--lv-border-radius-medium);
  pointer-events: none;
}
.image-node-batch-frame--1 {
  transform: translate(-4px, -4px) rotate(-2deg);
  z-index: 0;
  opacity: 0.6;
}
.image-node-batch-frame--2 {
  transform: translate(-8px, -8px) rotate(-4deg);
  z-index: -1;
  opacity: 0.32;
}
.image-node-batch-count {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  padding: 1px 8px;
  background: var(--brand-main-default);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  pointer-events: none;
}
.image-node-batch-grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: 6px;
  padding: 8px;
  background: var(--canvas-float-block-default);
  border-radius: var(--lv-border-radius-medium);
  overflow-y: auto;
  z-index: 3;
}
.image-node-batch-grid__item {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--canvas-image-loading-start);
  border-radius: var(--lv-border-radius-small);
  overflow: hidden;
  border: 1.5px solid transparent;
  transition: border-color 0.12s;
}
.image-node-batch-grid__item:hover,
.image-node-batch-grid__item.is-primary {
  border-color: var(--brand-main-default);
}
.image-node-batch-grid__item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-node-batch-set-primary {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  background: var(--canvas-float-block-default);
  border: 0.5px solid var(--stroke-secondary);
  border-radius: 50%;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.image-node-batch-grid__item.is-primary .image-node-batch-set-primary {
  background: var(--brand-main-default);
  color: #fff;
  border-color: var(--brand-main-default);
}

/* 替换按钮（有图态右上角） */
.image-node-replace-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--canvas-float-block-default, rgba(30, 30, 30, 0.9));
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: background-color 0.2s, border-color 0.2s, color 0.2s;
}
.image-node-replace-btn:hover {
  background: var(--canvas-float-block-hover, var(--bg-block-primary-hover, rgba(50, 50, 50, 0.95)));
  border-color: var(--brand-main-default);
  color: var(--brand-main-default);
}
.image-node-replace-icon {
  font-size: 14px;
  line-height: 1;
}

/* 左右 Handle 隐藏（用 .image-node-add-btn 替代） */
.image-node-handle {
  width: 1px !important;
  height: 1px !important;
  opacity: 0 !important;
  pointer-events: none !important;
  border: 0 !important;
  background: transparent !important;
}

/* 外置 "+" 按钮 */
.image-node-add-btn {
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
.image-node-add-btn--left { left: -56px; }
.image-node-add-btn--right { right: -56px; }
.image-node-add-btn__icon {
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
.image-node-add-btn:hover { color: var(--text-primary); }
.image-node-add-btn:active { transform: translateY(-50%) scale(0.95); }

/* 节点下方浮出 prompt */
.image-node-prompt-panel {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  min-width: 540px;
  max-width: 760px;
  z-index: 5;
}
</style>
