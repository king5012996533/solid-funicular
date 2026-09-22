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
import { ElMessage } from 'element-plus'
import ContentGenerator, { type GeneratorParamsSnapshot } from '@/components/generate/ContentGenerator.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import {
  updateNode,
  type WorkflowImageNodeData,
} from '../../composables/useWorkflowCanvas'
import { loadPublicModelCatalog, getModelByName, getDefaultImageModelKey, type ImageModel } from '@/config/models'
import { pickValidChoice, resolveImageParamSchema } from '@/config/model-params'
import { isRasterReferenceUrl } from '@/config/reference-validation'
import { collectUpstreamPromptText, composePrompt } from '../../composables/upstream-inputs'
import { inboundEdges, nodeIndex } from '../../composables/workflow-graph-index'
import { collectReferenceableAssets } from '../../composables/reference-resolver'
import { createGenerationTask, subscribeGenerationTaskEvents, resolveGenerationTaskModel } from '@/api/generation-tasks'
import { appendImageReferencesToRequestBody } from '@/shared/image-generation-request'

const props = defineProps<{
  id: string
  data: WorkflowImageNodeData & { selected?: boolean }
  selected?: boolean
}>()
const isSelected = computed(() => props.selected || props.data?.selected)
const imageUrl = ref(props.data?.url || '')
const isLoading = ref(!!props.data?.loading)
const errorMsg = ref(props.data?.error || '')

watch(
  [() => props.data?.url, () => props.data?.loading, () => props.data?.error],
  ([url, loading, error]) => {
    if (url !== undefined) imageUrl.value = url
    if (loading !== undefined) isLoading.value = loading
    if (error !== undefined) errorMsg.value = error
  },
)

const showLoading = computed(() => isLoading.value)
const showError = computed(() => !isLoading.value && !!errorMsg.value)
const showImage = computed(() => !isLoading.value && !errorMsg.value && !!imageUrl.value)

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
  <div class="image-node-wrapper">
    <div class="image-node-card" :class="{ 'is-selected': isSelected }">
      <div v-if="showLoading" class="image-node-loading" aria-label="图片生成中">
        <div class="image-node-spinner" />
      </div>
      <div v-else-if="showError" class="image-node-error" role="alert">{{ errorMsg }}</div>
      <img v-else-if="showImage" :src="imageUrl" alt="生成图片" class="image-node-image" @dblclick.stop="openImagePreview()" />
    </div>
    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />
    <el-image-viewer v-if="previewVisible" :url-list="[previewTarget]" :z-index="4000" :scale="0.86" teleported hide-on-click-modal @close="previewVisible = false" />
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
.image-node-wrapper { position: relative; width: 100%; height: 100%; }
.image-node-card { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--canvas-node-border); border-radius: 12px; box-sizing: border-box; background: var(--canvas-node-bg); }
.image-node-card.is-selected { border-color: var(--canvas-node-border-selected); }
.image-node-loading, .image-node-error { display: grid; place-items: center; width: 100%; height: 100%; }
.image-node-error { padding: 12px; color: #ef4444; font-size: 12px; line-height: 18px; text-align: center; box-sizing: border-box; }
.image-node-spinner { width: 18px; height: 18px; border: 2px solid var(--stroke-secondary); border-top-color: var(--brand-main-default); border-radius: 50%; animation: image-node-spin 0.8s linear infinite; }
@keyframes image-node-spin { to { transform: rotate(360deg); } }
.image-node-image { display: block; width: 100%; height: 100%; object-fit: contain; }
.image-node-prompt-panel { position: absolute; top: calc(100% + 18px); left: 50%; width: 420px; transform: translateX(-50%); z-index: 10; }
</style>
