<script setup lang="ts">
/**
 * 工作流主页面
 * 基于 Vue Flow 的节点连线工作流画布
 */
import { computed, ref, watch, onMounted, onUnmounted, nextTick, markRaw } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { ElMessage } from 'element-plus'
import { VueFlow, useVueFlow, SelectionMode, type Connection, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { useAsyncAction, useShortcut } from '@/composables'
import { useLoadingStore } from '@/stores/loading'
import {
  nodes, edges, addNode, addEdge, updateNode, applyCanvasSnapshot,
  canvasViewport, updateViewport,
  undo, redo, canUndo, canRedo, manualSaveHistory, initSampleData, initHistory,
  pauseHistory, resumeHistory,
  type WorkflowAddEdgeParams,
  type WorkflowCanvasEdge,
  type WorkflowNodeType,
} from './composables/useWorkflowCanvas'
import { WORKFLOW_TEMPLATES } from './config/workflows'
import { useWorkflowPersistence } from './composables/useWorkflowPersistence'
import type { WorkflowDefinitionSummary } from './api/definitions'
import { acquireWorkflowPipelineLock, forceReleaseWorkflowPipelineLock, releaseWorkflowPipelineLock, updateWorkflowDefinition } from './api/definitions'
import type { WorkflowCanvasPosition } from './composables/workflow-orchestrator-types'

// 节点组件
import TextNode from './components/nodes/TextNode.vue'
import ImageNode from './components/nodes/ImageNode.vue'
import VideoNode from './components/nodes/VideoNode.vue'
import AssetNode from './components/nodes/AssetNode.vue'
import { buildCanvasBrief } from './config/canvas-brief'

// 边组件
import ImageRoleEdge from './components/edges/ImageRoleEdge.vue'
import PromptOrderEdge from './components/edges/PromptOrderEdge.vue'
import ImageOrderEdge from './components/edges/ImageOrderEdge.vue'
import CanvasDefaultEdge from '@/components/canvas/CanvasDefaultEdge.vue'

// 画布壳（infinite-canvas → canana-vue 迁移产物）
import CanvasContextMenu from '@/components/canvas/CanvasContextMenu.vue'
import CanvasZoomControls from '@/components/canvas/CanvasZoomControls.vue'
import CanvasMiniMap from '@/components/canvas/CanvasMiniMap.vue'
import CanvasConnectionLine from '@/components/canvas/CanvasConnectionLine.vue'
import RightPanel from '@components/canana/RightPanel.vue'
import { useChatSessions } from '@/composables/useChatSessions'
import { useCanvasSelection } from '@/composables/useCanvasSelection'
import { useCanvasClipboard } from '@/composables/useCanvasClipboard'
import { useCanvasDrop } from '@/composables/useCanvasDrop'
import {
  canvasBackgroundMode,
  removeNode,
  duplicateNode,
  clearCanvas,
} from './composables/useWorkflowCanvas'
import { useCanvasAlignmentGuides } from './composables/useCanvasAlignmentGuides'
import { computeCanvasLayout } from './config/canvas-layout'
import {
  NODE_TYPE_PRESENTATION,
  getNodeTypePresentation,
  suggestNodeTypes,
  type ConnectDirection,
} from './config/node-suggestions'
import type { GraphNode } from '@vue-flow/core'
import type { CanvasAgentContext } from './agent/canvas-agent-tools'
import { runNodeById, beginAgentRunRound } from './composables/useCanvasNodeRunner'
import { resolveAttachedReferences } from './composables/resolveAttachedReferences'
import type { ContextMenuItem, ContextMenuPosition } from '@/types/canvas-interaction'
import { resolveModelSelectionKey, getAllImageModels, getAllVideoModels, getAllChatModels } from '@/config/models'

const router = useRouter()
const route = useRoute()
const {
  viewport,
  zoomIn,
  zoomOut,
  fitView,
  updateNodeInternals,
  screenToFlowCoordinate,
  setNodes,
  connectionStartHandle,
  getSelectedNodes,
} = useVueFlow()

/**
 * 助手面板要的画布摘要。
 * 以前助手完全看不见画布（没传任何状态），只能空对空写提示词 ——
 * 用户问"这个画布还缺什么"它只能猜。摘要本身是纯函数，有单测。
 */
const assistantCanvasBrief = computed(() => buildCanvasBrief(
  nodes.value,
  edges.value,
  getSelectedNodes.value.map(node => node.id),
))

// 对齐辅助线：拖拽节点时与邻近节点吸附，并显示对齐虚线
const { guides, computeAlignment, clear: clearGuides } = useCanvasAlignmentGuides()

// 注册自定义节点类型
const nodeTypes = {
  text: markRaw(TextNode),
  image: markRaw(ImageNode),
  video: markRaw(VideoNode),
  asset: markRaw(AssetNode),
} as any

// 注册自定义边类型
const edgeTypes = {
  default: markRaw(CanvasDefaultEdge),
  imageRole: markRaw(ImageRoleEdge),
  promptOrder: markRaw(PromptOrderEdge),
  imageOrder: markRaw(ImageOrderEdge),
} as any

// 工作流持久化
const {
  currentWorkflowId,
  currentWorkflowDetail,
  workflowList,
  reloadWorkflowList,
  fetchWorkflowDetail,
  loadWorkflowDetail,
  applyWorkflowVersionToCanvas,
  autosaveWorkflow,
  resetCurrentWorkflowState,
} = useWorkflowPersistence()

// UI 状态
const showNodeMenu = ref(false)
const showTemplatePanel = ref(false)
const showWorkflowLibraryPanel = ref(false)
const workflowName = ref('')
const workflowCode = ref('')
const workflowDescription = ref('')
const workflowCategory = ref('')
const workflowListKeyword = ref('')
const workflowLoadingByRoute = ref(false)
const initialCanvasBaselineSnapshot = ref('')
const selectedWorkflowVersionId = ref('')
const selectedLibraryWorkflowId = ref('')
const selectedLibraryWorkflowDetail = ref<null | {
  definition: WorkflowDefinitionSummary
  versions: Array<{
    id: string
    workflowId: string
    createdBy: string | null
    versionNo: number
    versionName: string | null
    changeSummary: string | null
    status: string
    definitionJson: unknown
    nodesJson: unknown
    edgesJson: unknown
    viewportJson: unknown
    inputSchemaJson: unknown
    outputSchemaJson: unknown
    runtimeConfigJson: unknown
    publishedAt: string | null
    createdAt: string
    updatedAt: string
  }>
}>(null)
const autosaveTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const autosaveState = ref<'idle' | 'saving' | 'saved' | 'error' | 'locked'>('idle')
/**
 * 流水线锁（制片 Agent 本轮执行期间持有）。
 *
 * 持锁期间**只有带这个 token 的保存**能写进画布。前端自己的自动保存也要带上它 ——
 * Agent 的改动本来就是在浏览器里改节点、再由这条自动保存写下去的，不带 token 会把自己的写入拦掉。
 */
const pipelineToken = ref('')
const pipelineSnapshotVersionId = ref('')
const pipelineRetryTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const autosaveErrorMessage = ref('')
const autosaveReady = ref(false)
const autosaveInFlight = ref<Promise<void> | null>(null)

// 头部标题重命名
const renamingTitle = ref(false)
const renameTitleInput = ref('')

interface WorkflowTemplateNode {
  id: string
  type: WorkflowNodeType
  position: WorkflowCanvasPosition
  data: Record<string, unknown>
  newId?: string
}

interface WorkflowTemplateDefinition {
  createNodes: (startPosition: WorkflowCanvasPosition) => {
    nodes: WorkflowTemplateNode[]
    edges: WorkflowCanvasEdge[]
  }
}

interface WorkflowNodeOption {
  type: WorkflowNodeType
  name: string
  color: string
  icon: string
}

const currentWorkflowTitle = computed(() => {
  return currentWorkflowDetail.value?.definition?.name || workflowName.value || '未命名工作流'
})

const currentWorkflowStatusText = computed(() => {
  return currentWorkflowDetail.value?.definition?.status === 'ACTIVE' ? '已发布' : '草稿'
})

const autosaveStatusText = computed(() => {
  if (autosaveState.value === 'saving') {
    return '保存中'
  }

  if (autosaveState.value === 'saved') {
    return '已自动保存'
  }

  if (autosaveState.value === 'locked') {
    return autosaveErrorMessage.value || 'Agent 正在改这块画布'
  }
  if (autosaveState.value === 'error') {
    return autosaveErrorMessage.value || '保存失败'
  }

  return currentWorkflowId.value ? '实时保存已开启' : '准备自动保存'
})

const startRenameTitle = () => {
  renameTitleInput.value = currentWorkflowTitle.value
  renamingTitle.value = true
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.wf-header-meta__title-input')
    el?.focus()
    el?.select()
  })
}

const cancelRenameTitle = () => {
  renamingTitle.value = false
}

const submitRenameTitle = async () => {
  const nextTitle = renameTitleInput.value.trim()
  if (!nextTitle) {
    renamingTitle.value = false
    return
  }

  // 未保存的新工作流：只改本地 name，后续保存/自动保存时带上
  if (!currentWorkflowId.value) {
    workflowName.value = nextTitle
    renamingTitle.value = false
    return
  }

  try {
    const detail = await updateWorkflowDefinition(currentWorkflowId.value, { name: nextTitle })
    currentWorkflowDetail.value = detail
    workflowName.value = detail.definition.name
  } catch (error) {
    console.error('重命名工作流失败', error)
    ElMessage.error('重命名失败，请稍后重试')
  } finally {
    renamingTitle.value = false
  }
}

const buildComparableCanvasSnapshot = (input: {
  nodesJson: unknown
  edgesJson: unknown
  viewportJson: unknown
}) => {
  return JSON.stringify({
    nodesJson: Array.isArray(input.nodesJson) ? input.nodesJson : [],
    edgesJson: Array.isArray(input.edgesJson) ? input.edgesJson : [],
    viewportJson: input.viewportJson && typeof input.viewportJson === 'object'
      ? {
        x: Number((input.viewportJson as { x?: number }).x || 0),
        y: Number((input.viewportJson as { y?: number }).y || 0),
        zoom: Number((input.viewportJson as { zoom?: number }).zoom || 1) || 1,
      }
      : {
        x: 0,
        y: 0,
        zoom: 1,
      },
  })
}

const savedCanvasSnapshot = computed(() => {
  const currentVersion = selectedWorkflowVersionId.value
    ? currentWorkflowDetail.value?.versions?.find(item => item.id === selectedWorkflowVersionId.value)
    : currentWorkflowDetail.value?.definition?.currentVersion
      || currentWorkflowDetail.value?.definition?.latestVersion
      || currentWorkflowDetail.value?.versions?.[0]

  return buildComparableCanvasSnapshot({
    nodesJson: currentVersion?.nodesJson,
    edgesJson: currentVersion?.edgesJson,
    viewportJson: currentVersion?.viewportJson,
  })
})

/** 立即结算一次快照。加载/应用画布后取基线用 —— 那种场景不能等防抖 */
const buildCanvasSnapshotNow = () => buildComparableCanvasSnapshot({
  nodesJson: nodes.value,
  edgesJson: edges.value,
  viewportJson: canvasViewport.value,
})

/**
 * 画布快照：判断「相对上次保存有没有变化」。
 *
 * 为什么不是 computed（这里是整个画布最贵的单点）：
 *   它的代价是把整张画布 JSON.stringify（1000 节点 ≈ 1–2MB）。而
 *   `JSON.stringify(nodes.value)` 会读遍每个节点的每个属性，于是**拖拽时
 *   position 每帧变化都会让这个 computed 失效**，下一帧整张画布重新序列化 +
 *   多 MB 字符串比对。
 *   用 CDP 采样实测：这占了拖拽总 CPU 的 **50.9%**，远超节点渲染、Vue Flow、
 *   边组件 —— 也就是说之前 F9 里我猜的「边遍历」和 F9b 里猜的「卡片内容太重」
 *   都不是瓶颈（折叠全部节点后帧率一点没变，就是这个原因）。
 *
 * 改成延迟结算：依赖变化后起一个定时器，画布稳定下来才算一次。
 * 判断"要不要保存"不需要帧级精度，用户看不出这 400ms。
 * 用 trailing 防抖而不是节流：拖拽过程中一次都不算、松手后才算 ——
 * 正好对应「拖拽期间不该保存」的语义。
 */
const canvasSnapshot = ref('')
let canvasSnapshotTimer: ReturnType<typeof setTimeout> | null = null

const scheduleCanvasSnapshot = () => {
  if (canvasSnapshotTimer) clearTimeout(canvasSnapshotTimer)
  canvasSnapshotTimer = setTimeout(() => {
    canvasSnapshotTimer = null
    canvasSnapshot.value = buildCanvasSnapshotNow()
  }, 400)
}

// flush: 'post' —— 等本轮 DOM 更新完再排期，避免和渲染抢同一帧
watch([nodes, edges, canvasViewport], scheduleCanvasSnapshot, { flush: 'post', deep: false })

const isCanvasDirty = computed(() => {
  if (!currentWorkflowId.value) {
    return canvasSnapshot.value !== initialCanvasBaselineSnapshot.value
  }

  return canvasSnapshot.value !== savedCanvasSnapshot.value
})

const syncWorkflowFormFromDetail = () => {
  const definition = currentWorkflowDetail.value?.definition
  workflowName.value = definition?.name || ''
  workflowCode.value = definition?.code || ''
  workflowDescription.value = definition?.description || ''
  workflowCategory.value = definition?.category || ''
}

const clearAutosaveTimer = () => {
  if (autosaveTimer.value) {
    clearTimeout(autosaveTimer.value)
    autosaveTimer.value = null
  }
}

const syncWorkflowRouteQuery = async (workflowId?: string) => {
  const nextWorkflowId = String(workflowId || '').trim()
  const currentQueryWorkflowId = String(route.query.workflowId || '').trim()
  const nextVersionId = String(selectedWorkflowVersionId.value || '').trim()
  const currentQueryVersionId = String(route.query.versionId || '').trim()

  if (nextWorkflowId === currentQueryWorkflowId && nextVersionId === currentQueryVersionId) {
    return
  }

  const nextQuery = { ...route.query }
  if (nextWorkflowId) {
    nextQuery.workflowId = nextWorkflowId
  } else {
    delete nextQuery.workflowId
  }

  if (nextVersionId) {
    nextQuery.versionId = nextVersionId
  } else {
    delete nextQuery.versionId
  }

  await router.replace({
    path: route.path,
    query: nextQuery,
  })
}

const tryLoadWorkflowByRoute = async (
  workflowId: string,
  options: { versionId?: string | null } = {},
) => {
  const normalizedWorkflowId = String(workflowId || '').trim()
  const normalizedVersionId = String(options.versionId || '').trim()
  if (!normalizedWorkflowId) {
    return
  }

  if (normalizedWorkflowId === currentWorkflowId.value && normalizedVersionId === selectedWorkflowVersionId.value) {
    return
  }

  workflowLoadingByRoute.value = true
  try {
    await flushAutosave()
    const detail = await loadWorkflowDetail(normalizedWorkflowId)
    selectedWorkflowVersionId.value = normalizedVersionId
    applyWorkflowVersionToCanvas(detail, normalizedVersionId || undefined)
    syncWorkflowFormFromDetail()
    await nextTick()
    fitView({ padding: 0.24 })
  } catch (error: any) {
    ElMessage.error(error?.message || '打开工作流失败')
    await syncWorkflowRouteQuery(currentWorkflowId.value || undefined)
  } finally {
    workflowLoadingByRoute.value = false
  }
}

const resetWorkflowDraftForm = () => {
  workflowName.value = ''
  workflowCode.value = ''
  workflowDescription.value = ''
  workflowCategory.value = ''
}

const createWorkflowAction = useAsyncAction(async () => {
  await flushAutosave()

  resetCurrentWorkflowState()
  selectedWorkflowVersionId.value = ''
  selectedLibraryWorkflowId.value = ''
  selectedLibraryWorkflowDetail.value = null
  resetWorkflowDraftForm()
  applyCanvasSnapshot({
    nodes: [],
    edges: [],
  }, {
    x: 100,
    y: 50,
    zoom: 0.8,
  })
  initialCanvasBaselineSnapshot.value = buildCanvasSnapshotNow()
  await syncWorkflowRouteQuery(undefined)
  autosaveState.value = 'idle'
  autosaveErrorMessage.value = ''
  await nextTick()
  fitView({ padding: 0.24 })
  ElMessage.success('已新建空白工作流')
}, { globalKey: 'blocking', globalText: '正在新建工作流…' })

const handleCreateWorkflow = () => {
  void createWorkflowAction.run()
}

// 添加工作流模板
const handleAddWorkflow = (workflow: WorkflowTemplateDefinition) => {
  const cx = -viewport.value.x / viewport.value.zoom + (window.innerWidth / 2) / viewport.value.zoom
  const cy = -viewport.value.y / viewport.value.zoom + (window.innerHeight / 2) / viewport.value.zoom
  const start = { x: cx - 300, y: cy - 200 }
  const { nodes: newNodes, edges: newEdges } = workflow.createNodes(start)

  newNodes.forEach((node) => {
    const id = addNode(node.type, node.position, node.data)
    newEdges.forEach((edge) => {
      if (edge.source === node.id) edge.source = id
      if (edge.target === node.id) edge.target = id
    })
    node.newId = id
  })

  setTimeout(() => {
    newEdges.forEach(edge => {
      addEdge({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || 'right',
        targetHandle: edge.targetHandle || 'left',
        type: edge.type,
        data: edge.data,
      })
    })
    newNodes.forEach(node => {
      if (node.newId) {
        updateNodeInternals([node.newId])
      }
    })
  }, 100)

  showTemplatePanel.value = false
}

// 节点类型菜单选项：展示信息与「谁能接在谁后面」的规则统一放在 config/node-suggestions
const nodeTypeOptions: WorkflowNodeOption[] = NODE_TYPE_PRESENTATION

// 工具栏按钮
const tools = [
  { id: 'text', name: '文本', icon: 'M4 6h16M4 12h8m-8 6h16', action: () => addNewNode('text') },
  { id: 'image', name: '文生图', icon: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z', action: () => addNewNode('image') },
  { id: 'video', name: '视频生成', icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z', action: () => addNewNode('video') },
  // 素材库：直接建一个素材节点（对齐 LibTV 底部工具条的「素材库」）
  { id: 'asset', name: '素材库', icon: 'M4 8a1.5 1.5 0 0 1 1.5-1.5h3.3a1.5 1.5 0 0 1 1.2.6l1 1.4h7.5A1.5 1.5 0 0 1 20 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', action: () => addNewNode('asset') },
]

// 添加新节点
/**
 * 在指定画布坐标放一个新节点：置顶 + 通知 Vue Flow 重新测量。
 * 左侧工具栏（放在视口中心）和拖线落空（放在鼠标落点）共用这一段。
 */
const placeNewNode = (type: WorkflowNodeType, flowPosition: WorkflowCanvasPosition) => {
  const id = addNode(type, flowPosition)
  const maxZ = Math.max(0, ...nodes.value.map(n => n.zIndex || 0))
  updateNode(id, { zIndex: maxZ + 1 })
  setTimeout(() => updateNodeInternals([id]), 50)
  return id
}

const addNewNode = (type: WorkflowNodeType) => {
  const cx = -viewport.value.x / viewport.value.zoom + (window.innerWidth / 2) / viewport.value.zoom
  const cy = -viewport.value.y / viewport.value.zoom + (window.innerHeight / 2) / viewport.value.zoom
  placeNewNode(type, { x: cx - 140, y: cy - 100 })
  showNodeMenu.value = false
}

// 快速连线（Dify 同款）：按住 Shift 点击节点 A，再按住 Shift 点击节点 B，自动连线。
const quickLinkSourceId = ref<string | null>(null)

// 把「按节点类型推断 edge type」的逻辑抽出来，拖拽连线（onConnect）与快速连线共用。
// 现在没有配置节点了，所以判定直接落在生成节点上：
//   文本 → 图片/视频 = 提示词顺序（promptOrder）
//   图片 → 图片      = 参考图顺序（imageOrder）
//   图片 → 视频      = 图片角色（首帧 / 参考）
const applyTypedEdgeConnection = (params: WorkflowAddEdgeParams) => {
  const sourceNode = nodes.value.find(n => n.id === params.source)
  const targetNode = nodes.value.find(n => n.id === params.target)
  const targetType = targetNode?.type

  if (sourceNode?.type === 'text' && (targetType === 'image' || targetType === 'video')) {
    const existing = edges.value.filter(e => e.target === params.target && e.type === 'promptOrder')
    addEdge({ ...params, type: 'promptOrder', data: { promptOrder: existing.length + 1 } })
  } else if (sourceNode?.type === 'image' && targetType === 'image') {
    const existing = edges.value.filter(e => e.target === params.target && e.type === 'imageOrder')
    addEdge({ ...params, type: 'imageOrder', data: { imageOrder: existing.length + 1 } })
  } else if (sourceNode?.type === 'image' && targetType === 'video') {
    addEdge({ ...params, type: 'imageRole', data: { imageRole: 'first_frame_image' } })
  } else {
    addEdge(params)
  }
}

// 处理连接
// 记录本次拖拽是否真的连成了一条边：Vue Flow 在 pointerup 时先 emit connect
// （只有落在合法 handle 上才会触发），紧接着 emit connectEnd。
// 所以 connectEnd 里看到这个标记，就说明「线连上了，不该弹菜单」。
let connectProducedEdge = false

const onConnect = (params: Connection) => {
  if (!params.source || !params.target) return

  connectProducedEdge = true
  applyTypedEdgeConnection({
    source: params.source,
    target: params.target,
    sourceHandle: params.sourceHandle ?? undefined,
    targetHandle: params.targetHandle ?? undefined,
  })
}

/**
 * 拖线落空 → 在落点弹出候选节点菜单（libtv 那种「节点到节点」的直接感）
 *
 * 三件事要判断清楚：
 *   1. 这条线到底连上没有 —— 连上了就什么都不做，正常连线走 onConnect；
 *      拖着线松手在空白处（或落在非法 handle 上）才该弹菜单；
 *   2. 拖的是哪一侧 —— 右侧（source）拖出，新节点在下游；左侧（target）拖出，新节点在上游；
 *   3. 候选类型 —— 由 node-suggestions 的规则表推导，保证连出来的边有意义。
 */
/**
 * 把 'var(--x)' 解析成当前画布作用域下的实际颜色值。
 *
 * 为什么需要：建节点菜单用的 CanvasContextMenu 会 Teleport 到 body，
 * 落在 .workflow-container 之外 —— 而画布配色 token 定义在 .workflow-container 上。
 * 菜单里直接写 var(--brand-*) 会取到根的全局值（其中品牌色会被运行时主题按后台配置改写），
 * 于是同一个节点类型在菜单里和画布上的颜色对不上。
 * 所以在拼菜单时就把值解析好：菜单显示什么颜色，画布上就是什么颜色。
 * 非 var() 的输入原样返回。
 */
const resolveCanvasToken = (value: string): string => {
  const matched = /^var\((--[a-z0-9-]+)\)$/i.exec(String(value || '').trim())
  if (!matched || typeof window === 'undefined') return value
  const container = document.querySelector('.workflow-container')
  if (!container) return value
  return getComputedStyle(container).getPropertyValue(matched[1]).trim() || value
}

/**
 * 建节点菜单的公共构造：三类菜单（拖线落空 / 双击空白 / 右键空白）
 * 列的都是同一批节点类型，图标和文案都该一致，所以只在这里拼一次。
 *
 * @param types 要列出的节点类型（顺序由调用方给定）
 * @param idPrefix 菜单项 id 前缀，便于区分来源做埋点
 * @param onClickFor 自定义点击行为；不传则走「建节点并连边」
 */
const buildNodeTypeMenuItems = (
  types: WorkflowNodeType[],
  idPrefix: string,
  onClickFor?: (type: WorkflowNodeType) => () => void,
): ContextMenuItem[] => types.map((type) => {
  const presentation = getNodeTypePresentation(type)
  return {
    id: `${idPrefix}-${type}`,
    label: presentation?.name || type,
    iconPath: presentation?.icon,
    iconColor: presentation ? resolveCanvasToken(presentation.color) : undefined,
    onClick: onClickFor
      ? onClickFor(type)
      : () => createNodeFromConnectMenu(type),
  } as ContextMenuItem
})

const isDropOnNodeElement = (event: MouseEvent | TouchEvent) => {
  const target = event.target as HTMLElement | null
  if (!target?.closest) return false
  // 落在任何 handle 或节点卡片上都算「用户本来想连这个」，不弹菜单
  return Boolean(target.closest('.vue-flow__handle, .vue-flow__node'))
}

const onConnectEnd = (event?: MouseEvent | TouchEvent) => {
  const producedEdge = connectProducedEdge
  connectProducedEdge = false

  if (producedEdge || !event) return
  if (isDropOnNodeElement(event)) return

  const startHandle = connectionStartHandle.value
  if (!startHandle) return

  const originNode = nodes.value.find(node => node.id === startHandle.nodeId)
  if (!originNode) return

  const direction: ConnectDirection = startHandle.type === 'target' ? 'upstream' : 'downstream'
  const candidates = suggestNodeTypes(originNode.type, direction)
  if (!candidates.length) return

  const point = 'changedTouches' in event ? event.changedTouches[0] : event
  const clientX = Number(point?.clientX)
  const clientY = Number(point?.clientY)
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return

  // 弹菜单前先关掉其它菜单（右键菜单、双击菜单），保证同一时刻只有一个
  closeCanvasMenus()

  // 落点即新节点位置。节点是左上角定位，所以把落点当作中心往回偏半个卡片的量，
  // 手感上就是「节点从鼠标长出来」。
  const flowPosition = screenToFlowCoordinate({ x: clientX, y: clientY })
  pendingConnection.value = {
    originNodeId: originNode.id,
    originHandleId: String(startHandle.id || (direction === 'downstream' ? 'right' : 'left')),
    direction,
    position: { x: flowPosition.x - 190, y: flowPosition.y - 140 },
  }

  connectMenuItems.value = buildNodeTypeMenuItems(candidates, 'connect-add')
  connectMenuPosition.value = { x: clientX, y: clientY }
  connectMenuVisible.value = true
}

/** 菜单里选了类型：建节点 + 按规则连边 + 选中它，落点位置在拖拽时就存好了 */
const createNodeFromConnectMenu = (type: WorkflowNodeType) => {
  const pending = pendingConnection.value
  connectMenuVisible.value = false
  pendingConnection.value = null
  if (!pending) return

  const newNodeId = placeNewNode(type, pending.position)

  const isDownstream = pending.direction === 'downstream'
  applyTypedEdgeConnection({
    source: isDownstream ? pending.originNodeId : newNodeId,
    target: isDownstream ? newNodeId : pending.originNodeId,
    sourceHandle: isDownstream ? pending.originHandleId : 'right',
    targetHandle: isDownstream ? 'left' : pending.originHandleId,
  })

  // 新节点直接选中，紧接着就能在下方写提示词 —— 少一次点击
  nextTick(() => {
    setNodes(nodes.value.map(node => ({ ...node, selected: node.id === newNodeId })))
    updateNodeInternals([newNodeId])
  })
}

const closeConnectMenu = () => {
  connectMenuVisible.value = false
  pendingConnection.value = null
}

const hasExistingEdge = (source: string, target: string, sourceHandle?: string, targetHandle?: string) => {
  return edges.value.some(edge =>
    edge.source === source
    && edge.target === target
    && (edge.sourceHandle || undefined) === sourceHandle
    && (edge.targetHandle || undefined) === targetHandle,
  )
}

const handleNodeClick = (payload: { event: MouseEvent | TouchEvent; node: { id: string } }) => {
  const originalEvent = payload.event as MouseEvent
  // 只在按住 Shift 时介入；其他点击一律交回 vue-flow 默认行为。
  if (!(originalEvent && 'shiftKey' in originalEvent && originalEvent.shiftKey)) {
    return
  }

  const targetNodeId = payload.node?.id
  if (!targetNodeId) return

  if (!quickLinkSourceId.value) {
    quickLinkSourceId.value = targetNodeId
    return
  }

  if (quickLinkSourceId.value === targetNodeId) {
    quickLinkSourceId.value = null
    return
  }

  // 沿用 vue-flow 默认 handle 命名（与拖拽连线一致）：右出左入。
  const sourceHandle = 'right'
  const targetHandle = 'left'
  if (!hasExistingEdge(quickLinkSourceId.value, targetNodeId, sourceHandle, targetHandle)) {
    applyTypedEdgeConnection({
      source: quickLinkSourceId.value,
      target: targetNodeId,
      sourceHandle,
      targetHandle,
    })
  }
  quickLinkSourceId.value = null
  originalEvent.preventDefault?.()
  originalEvent.stopPropagation?.()
}

// 给挂起源节点动态打 .wf-quick-link-source class，提示"A 已选中，下一次 Shift+点击的节点为目标"。
// 这是整个快速连线流程仅保留的视觉反馈，跟挂起状态同生同灭。
const resolveNodeClass = (node: { id: string }) => {
  return node.id === quickLinkSourceId.value ? 'wf-quick-link-source' : undefined
}

// 顶部提示横幅用：挂起源节点的可读名称
const quickLinkSourceLabel = computed(() => {
  const sourceId = quickLinkSourceId.value
  if (!sourceId) return ''
  const node = nodes.value.find(n => n.id === sourceId)
  if (!node) return ''
  const label = (node.data as { label?: string })?.label
  if (label) return label
  const typeOption = nodeTypeOptions.find(opt => opt.type === node.type)
  const idSuffix = sourceId.replace(/^node_/, '')
  return `${typeOption?.name || node.type} #${idSuffix}`
})

const cancelQuickLink = () => {
  quickLinkSourceId.value = null
}

// 处理视口变化
const handleViewportChange = (v: typeof canvasViewport.value) => updateViewport(v)

// 处理边变化
const onEdgesChange = (changes: Array<{ type?: string }>) => {
  if (changes.some(c => c.type === 'remove')) {
    nextTick(() => manualSaveHistory())
  }
}

// 处理画布点击
const onPaneClick = () => {
  showNodeMenu.value = false
  // 双击菜单挂在 body 上，靠 document 上的 mousedown 收不回来：
  // d3-zoom / 节点拖拽都会吃掉画布上的 mousedown 冒泡，
  // 所以单击空白由 pane 自己的 click 事件负责关掉它
  closeDblClickMenu()
}

// 返回首页：保存草稿 → 跳转。globalKey:'blocking' 期间会弹遮罩"正在保存草稿…"，
// 避免用户感觉点了没反应。useAsyncAction 自身防止重复点击。
const goBackAction = useAsyncAction(async () => {
  await flushAutosave()

  const returnTo = String(route.query.returnTo || '').trim()
  if (returnTo) {
    await router.push(returnTo)
    return
  }

  await router.push('/')
}, { globalKey: 'blocking', globalText: '正在保存草稿…' })

const goBackLoading = goBackAction.loading

const goBack = () => {
  void goBackAction.run()
}

const {
  run: handleRefreshWorkflowList,
  loading: workflowListLoading,
} = useAsyncAction(async () => {
  await reloadWorkflowList({
    scene: 'WORKFLOW_CANVAS',
    keyword: workflowListKeyword.value || undefined,
  })
})

const loadWorkflowAction = useAsyncAction(async (workflow: WorkflowDefinitionSummary) => {
  const versionId = selectedLibraryWorkflowId.value === workflow.id
    ? selectedWorkflowVersionId.value || selectedLibraryWorkflowDetail.value?.definition.currentVersionId || ''
    : ''
  await tryLoadWorkflowByRoute(workflow.id, { versionId })
  await syncWorkflowRouteQuery(workflow.id)
  showWorkflowLibraryPanel.value = false
  ElMessage.success(`已打开工作流：${workflow.name}`)
}, { globalKey: 'blocking', globalText: '正在加载工作流…' })

const handleLoadWorkflow = (workflow: WorkflowDefinitionSummary) => {
  void loadWorkflowAction.run(workflow)
}

const selectLibraryAction = useAsyncAction(async (workflow: WorkflowDefinitionSummary) => {
  selectedLibraryWorkflowDetail.value = await fetchWorkflowDetail(workflow.id)
})
const libraryDetailLoading = selectLibraryAction.loading

const handleSelectLibraryWorkflow = (workflow: WorkflowDefinitionSummary) => {
  selectedLibraryWorkflowId.value = workflow.id
  selectedLibraryWorkflowDetail.value = null
  void selectLibraryAction.run(workflow)
}

const loadWorkflowVersionAction = useAsyncAction(async (workflow: WorkflowDefinitionSummary, versionId: string) => {
  await tryLoadWorkflowByRoute(workflow.id, { versionId })
  await syncWorkflowRouteQuery(workflow.id)
  showWorkflowLibraryPanel.value = false
  ElMessage.success(`已打开 ${workflow.name} 的指定版本`)
}, { globalKey: 'blocking', globalText: '正在加载版本…' })

const handleLoadWorkflowVersion = (workflow: WorkflowDefinitionSummary, versionId: string) => {
  void loadWorkflowVersionAction.run(workflow, versionId)
}

const performAutosave = async () => {
  autosaveState.value = 'saving'
  autosaveErrorMessage.value = ''

  const detail = await autosaveWorkflow({
    pipelineToken: pipelineToken.value || undefined,
    workflowId: currentWorkflowId.value || undefined,
    name: workflowName.value || `未命名工作流 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    code: workflowCode.value || undefined,
    description: workflowDescription.value || null,
    category: workflowCategory.value || null,
    scene: 'WORKFLOW_CANVAS',
  })

  currentWorkflowDetail.value = detail
  currentWorkflowId.value = detail.definition.id
  selectedWorkflowVersionId.value = detail.definition.currentVersionId || detail.definition.latestVersion?.id || ''
  syncWorkflowFormFromDetail()
  await syncWorkflowRouteQuery(detail.definition.id)
  autosaveState.value = 'saved'
}

const scheduleAutosave = () => {
  if (!autosaveReady.value || workflowLoadingByRoute.value || !isCanvasDirty.value) {
    return
  }

  clearAutosaveTimer()
  autosaveTimer.value = setTimeout(() => {
    void flushAutosave()
  }, 1500)
}

/** 锁释放后自动重试那次被拦下的保存（只挂一个定时器，避免失败风暴） */
const schedulePipelineRetry = () => {
  if (pipelineRetryTimer.value) return
  pipelineRetryTimer.value = setTimeout(() => {
    pipelineRetryTimer.value = null
    void flushAutosave()
  }, 4000)
}

/**
 * 强制释放「自己」画布上的锁（顶部状态条 / Agent 面板都走这里）。
 *
 * 孤儿锁场景：任务其实早跑完了，锁却没被正常放掉，用户被自己的锁挡着干等 TTL。
 * 服务端只放 userId 匹配的那把，所以对别人的并发保护没有任何影响。
 */
const handleForceReleaseLock = async (): Promise<boolean> => {
  const workflowId = currentWorkflowId.value
  if (!workflowId) return false
  try {
    await forceReleaseWorkflowPipelineLock(workflowId)
    pipelineToken.value = ''
    pipelineSnapshotVersionId.value = ''
    ElMessage.success('已强制释放画布锁')
    // 锁放掉了，把之前被 409 拦下的那笔保存补写回去
    void flushAutosave()
    return true
  } catch (error: any) {
    ElMessage.error(error?.message || '强制释放失败')
    return false
  }
}

const flushAutosave = async () => {
  clearAutosaveTimer()

  if (!autosaveReady.value || workflowLoadingByRoute.value || !isCanvasDirty.value) {
    return
  }

  if (autosaveInFlight.value) {
    await autosaveInFlight.value
    return
  }

  autosaveInFlight.value = (async () => {
    try {
      await performAutosave()
    } catch (error: any) {
      /**
       * 画布被流水线占用：**这不是失败，是稍后会重试的暂存**。
       *
       * 关键三点：① 不清 isCanvasDirty（编辑器里的改动还在、也不标记为已保存）；
       * ② 明确告诉用户发生了什么，而不是丢一句「保存失败」；
       * ③ 自动重试 —— 等 Agent 那轮结束（锁释放）就会写进去。
       * 不做这些，症状会是「我改了半天，刷新一看全没了」—— 比不加锁更糟。
       */
      if (error?.name === 'WorkflowCanvasLockedError') {
        autosaveState.value = 'locked'
        autosaveErrorMessage.value = 'Agent 正在改这块画布，你的改动已暂存；等它这轮结束会自动保存。如确认没有 Agent 在跑，点右侧「强制释放」'
        schedulePipelineRetry()
        return
      }
      autosaveState.value = 'error'
      autosaveErrorMessage.value = error?.message || '自动保存失败'
    } finally {
      autosaveInFlight.value = null
    }
  })()

  await autosaveInFlight.value
}

/**
 * 整理画布（对齐 LibTV 的「整理画布」，Option+Shift+F）
 *
 * 布局计算全在 config/canvas-layout.ts（纯函数、有单测）。
 * 这里只负责把结果写回节点位置 —— 一次性写完并只记一条历史，
 * 而不是逐个节点改（逐个改会往撤销栈里塞 N 条记录，撤销一次只回退一个节点）。
 */
/**
 * 整理画布后的「还原 / 保留」确认（对齐 LibTV）。
 *
 * 位置变更本身已经作为**一条**历史记录进了撤销栈（Cmd+Z 也能退回去），
 * 但那要求用户知道有撤销；LibTV 的做法是直接把「要不要保留」摆出来问一次。
 * 快照只存 id + position：尺寸是算出来的，不该跟着回滚。
 */
const layoutSnapshot = ref<Array<{ id: string; position: { x: number; y: number } }> | null>(null)

const keepLayout = () => {
  layoutSnapshot.value = null
}

const revertLayout = () => {
  const snapshot = layoutSnapshot.value
  if (!snapshot) return
  const byId = new Map(snapshot.map(item => [item.id, item.position]))
  nodes.value = nodes.value.map(node => {
    const position = byId.get(node.id)
    return position ? { ...node, position: { ...position } } : node
  })
  layoutSnapshot.value = null
  setTimeout(() => {
    updateNodeInternals(nodes.value.map(node => node.id))
    void fitView({ padding: 0.2 })
  }, 50)
}

const autoLayoutCanvas = () => {
  if (!nodes.value.length) return
  // dimensions 是 Vue Flow 在运行时量完才补上的字段，不在我们的节点类型声明里，
  // 所以这里窄化读一次 —— 拿不到时交给布局函数用兜底尺寸
  const measured = nodes.value as unknown as Array<{
    id: string
    position: { x: number; y: number }
    dimensions?: { width: number; height: number }
  }>

  const { positions } = computeCanvasLayout(
    measured.map(node => ({
      id: node.id,
      position: node.position,
      width: node.dimensions?.width,
      height: node.dimensions?.height,
    })),
    edges.value.map(edge => ({ source: edge.source, target: edge.target })),
  )
  if (!positions.size) return

  // 先把「整理前」的位置记下来，整理完用它撑起确认条
  const before = nodes.value.map(node => ({ id: node.id, position: { ...node.position } }))

  nodes.value = nodes.value.map(node => {
    const next = positions.get(node.id)
    return next ? { ...node, position: next } : node
  })

  layoutSnapshot.value = before

  setTimeout(() => {
    updateNodeInternals(nodes.value.map(node => node.id))
    void fitView({ padding: 0.2 })
  }, 50)
}

/** 快捷键面板：内容是我们**实际注册**的快捷键，不是抄来的清单 */
const showShortcutPanel = ref(false)

const shortcutGroups = [
  {
    title: '画布',
    items: [
      { keys: ['Space', '拖拽'], desc: '临时平移画布' },
      { keys: ['双击空白'], desc: '弹出节点类型菜单' },
      { keys: ['⌥ ⇧ F'], desc: '整理画布' },
    ],
  },
  {
    title: '节点',
    items: [
      { keys: ['从 ⊕ 拖出'], desc: '连线；落在空白处弹候选节点' },
      { keys: ['双击标题'], desc: '重命名节点' },
      { keys: ['Delete'], desc: '删除选中节点' },
      { keys: ['⌘ C'], desc: '复制选中节点' },
      { keys: ['⌘ V'], desc: '粘贴节点' },
      { keys: ['⌘ A'], desc: '全选节点' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: ['⌘ Z'], desc: '撤销' },
      { keys: ['⌘ ⇧ Z'], desc: '重做' },
      { keys: ['Esc'], desc: '取消当前连线 / 关闭浮层' },
      { keys: ['⌘ N'], desc: '新建工作流' },
    ],
  },
]

// 键盘快捷键（统一走 useShortcut 注册，自动管理生命周期 + 输入框焦点屏蔽）
useShortcut(
  'Escape',
  () => {
    if (quickLinkSourceId.value) {
      quickLinkSourceId.value = null
    }
  },
  // Esc 不阻止默认，让 el-dialog / el-popover 等浮层也能关闭
  { preventDefault: false },
)
useShortcut('CmdOrCtrl+Z', () => undo())
useShortcut(['CmdOrCtrl+Shift+Z', 'CmdOrCtrl+Y'], () => redo())
useShortcut('CmdOrCtrl+N', () => {
  void handleCreateWorkflow()
})
// Option+Shift+F —— 与 LibTV 同一个组合键，便于两边来回切时形成肌肉记忆
useShortcut('Alt+Shift+F', () => autoLayoutCanvas())

// 空格临时平移：按住 Space 时禁用节点拖拽，左键也加入 panOnDrag
const isSpacePressed = ref(false)
const panOnDragValue = computed<true | number[]>(() => (isSpacePressed.value ? [0, 1, 2] : true))

/**
 * Vue Flow 的选择键（按住 Cmd 框选、按住 Shift 多选）。
 *
 * 说明一处**库内自相矛盾**，免得后人再查：`.d.ts` 里这两个 prop 的类型是 `KeyFilter | null`
 * （字符串是合法的，库里自己的默认值也是字符串 `'Shift'`），但**运行时 props 声明**写的是 `Boolean | null`，
 * 于是 Vue 在 dev 模式下会一直刷：
 *   Invalid prop: type check failed for prop "selectionKeyCode". Expected Boolean | Null, got String "Meta"
 * 这个警告**改不掉**（除非改库或改成 `true`/`null` 那种语义、从而改变拖拽框选行为），
 * 而且**只在 dev 构建出现**、不进生产包，所以这里保留正确行为、不迁就声明。
 */
const selectionKeyCode = 'Meta'
const multiSelectionKeyCode = 'Shift'

const isEditableSpaceTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return el.isContentEditable
}

const handleSpaceDown = (event: KeyboardEvent) => {
  if (event.code !== 'Space' || event.repeat) return
  if (isEditableSpaceTarget(event.target)) return
  event.preventDefault()
  isSpacePressed.value = true
}
const handleSpaceUp = (event: KeyboardEvent) => {
  if (event.code === 'Space') {
    isSpacePressed.value = false
  }
}

// 节点拖拽期间暂停历史入栈，拖拽结束统一作为 1 条历史记录
const onNodeDragStart = () => {
  pauseHistory()
}

/**
 * 拖拽过程中做对齐吸附。
 *
 * 注意这里刻意「不」调用 pauseHistory 之外的历史逻辑：
 * 吸附只是调整节点位置，最终位置仍由 node-drag-stop 统一入栈一次。
 * 阈值随缩放换算（见 composable），所以放大缩小时手感一致。
 */
const onNodeDrag = (dragEvent: { node: GraphNode; nodes: GraphNode[] }) => {
  const { node, nodes: draggedNodes } = dragEvent
  if (!node?.dragging) return
  /**
   * ⚠️ 这里必须传「画布上的全部节点」，**不能**用 dragEvent.nodes。
   *
   * dragEvent.nodes 的语义是「正在被拖拽的节点」（多选拖拽时是那一批），不是全部节点。
   * 之前拿它当 peer 集合，导致 peers 里永远只有被拖的那个节点自己（被 `peer.id === dragged.id`
   * 跳过）→ 对齐辅助线**一次都算不出来**（等于死功能）。2026-09-23 用 CDP 打点实测：
   * node-drag 触发 23 次、payload 里 peers=1、画布上却有 2 个节点、参考线元素 0 条。
   */
  const { dx, dy } = computeAlignment(node, nodes.value, viewport.value.zoom)
  if (dx === null && dy === null) return
  /**
   * 多选拖拽：把主拖拽节点算出来的对齐量**整组平移** —— 组内相对位置不变、组整体吸附。
   * dragEvent.nodes 在这里正好是「正在被拖拽的那一批」（单选时就是它自己）。
   */
  for (const dragged of draggedNodes?.length ? draggedNodes : [node]) {
    if (dx !== null) dragged.position.x += dx
    if (dy !== null) dragged.position.y += dy
  }
}

const onNodeDragStop = () => {
  resumeHistory()
  clearGuides()
}

// === 选择 / 剪贴板 / 拖入 / 右键菜单 ===
const { selectAll } = useCanvasSelection()
const { copySelected, pasteFromSlot, hasClipboard } = useCanvasClipboard()
const { onDrop: onCanvasFileDrop, onDragOver: onCanvasFileDragOver } = useCanvasDrop()

// 小地图开关
const isMiniMapOpen = ref(true)
const toggleMiniMap = () => {
  isMiniMapOpen.value = !isMiniMapOpen.value
}

// 右键上下文菜单
const contextMenuVisible = ref(false)
const contextMenuPosition = ref<ContextMenuPosition>({ x: 0, y: 0 })
const contextMenuItems = ref<ContextMenuItem[]>([])

// 拖线落空弹出的候选节点菜单（独立于右键菜单，两者不会同时出现）
const connectMenuVisible = ref(false)
const connectMenuPosition = ref<ContextMenuPosition>({ x: 0, y: 0 })
const connectMenuItems = ref<ContextMenuItem[]>([])
/** 拖拽起点信息，选中类型后据此建节点并连边 */
const pendingConnection = ref<{
  originNodeId: string
  originHandleId: string
  direction: ConnectDirection
  position: WorkflowCanvasPosition
} | null>(null)

// 双击画布空白弹出的节点类型菜单（与右键菜单、拖线菜单互斥）
const dblClickMenuVisible = ref(false)
const dblClickMenuPosition = ref<ContextMenuPosition>({ x: 0, y: 0 })
const dblClickMenuItems = ref<ContextMenuItem[]>([])
/** 双击点换算成画布坐标后的落点，选中类型时用它建节点 */
const pendingDblClickPosition = ref<WorkflowCanvasPosition | null>(null)

/** 弹层互斥：画布上任何时刻只允许一个菜单可见，新开一个先把其它的关掉 */
const closeCanvasMenus = () => {
  contextMenuVisible.value = false
  connectMenuVisible.value = false
  pendingConnection.value = null
  dblClickMenuVisible.value = false
  pendingDblClickPosition.value = null
  showNodeMenu.value = false
}

const closeContextMenu = () => {
  contextMenuVisible.value = false
}
/**
 * 「Agent 创作」在右键菜单里的图标（24×24 stroke path）：
 * 一大一小两颗星芒 —— 与画布右边缘那个入口按钮同一个意象，用户一眼能对上。
 */
const AGENT_SPARKLE_PATH =
  'M12 3.4l1.6 4.6 4.6 1.6-4.6 1.6L12 15.8l-1.6-4.6L5.8 9.6l4.6-1.6L12 3.4z M18.4 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z'

/**
 * 从右键菜单打开 Agent。
 *
 * 两条路径（空白处右键 / 卡片上右键）共用：先把面板展开，
 * 卡片那条再带上一句「针对这个节点」的交代 —— 菜单项写的就是「让 Agent 处理这个节点」，
 * 用户点了就该真的开始处理，而不是只打开一个空面板让他再打一遍字
 * （这句话会走既有的 initialMessage 通道，和面板里手打一句话是同一条链路）。
 */
const openCanvasAgentFromMenu = (options: { aboutNodeId?: string } = {}) => {
  if (isAssistantCollapsed.value) {
    toggleAssistantPanel()
  }
  if (options.aboutNodeId) {
    pendingAssistantMessage.value = `帮我处理画布上的节点 ${options.aboutNodeId}`
  }
}

const openPaneContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  closeCanvasMenus()
  const flowPos = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  // 与拖线落空、双击空白列的是同一批节点，所以共用构造器（图标/文案一致）
  contextMenuItems.value = [
    {
      id: 'agent-create',
      label: 'Agent 创作',
      iconPath: AGENT_SPARKLE_PATH,
      onClick: () => openCanvasAgentFromMenu(),
    },
    { id: 'divider', label: '', type: 'divider' },
    ...buildNodeTypeMenuItems(
      ['text', 'image', 'video', 'asset'],
      'pane-add',
      type => () => addNode(type, flowPos),
    ),
    { id: 'divider', label: '', type: 'divider' },
    {
      id: 'paste',
      label: '粘贴',
      shortcut: 'Cmd+V',
      disabled: !hasClipboard(),
      onClick: () => pasteFromSlot(),
    },
  ]
  contextMenuPosition.value = { x: event.clientX, y: event.clientY }
  contextMenuVisible.value = true
}
const openNodeContextMenu = (payload: NodeMouseEvent) => {
  payload.event.preventDefault()
  const e = payload.event as unknown as MouseEvent
  closeCanvasMenus()
  contextMenuItems.value = [
    {
      id: 'agent-handle-node',
      label: '让 Agent 处理这个节点',
      iconPath: AGENT_SPARKLE_PATH,
      onClick: () => openCanvasAgentFromMenu({ aboutNodeId: payload.node.id }),
    },
    { id: 'divider', label: '', type: 'divider' },
    { id: 'duplicate', label: '复制', shortcut: 'Cmd+C', onClick: () => duplicateNode(payload.node.id) },
    { id: 'delete', label: '删除', shortcut: 'Del', danger: true, onClick: () => removeNode(payload.node.id) },
  ]
  contextMenuPosition.value = { x: e.clientX, y: e.clientY }
  contextMenuVisible.value = true
}

/** 双击是否落在画布空白处：节点、连线、连接点、画布内浮层都不算空白 */
const isPaneBackgroundDblClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  if (!target?.closest) return false
  if (target.closest('.vue-flow__node, .vue-flow__edge, .vue-flow__handle, .vue-flow__panel')) return false
  return Boolean(target.closest('.vue-flow__pane'))
}

/**
 * 双击画布空白 → 在双击点弹节点类型菜单。
 *
 * 与「拖线落空」的菜单不同：这里没有起点节点，连不出有意义的边，
 * 所以候选给全部节点类型（顺序即 NODE_TYPE_PRESENTATION），建出的节点是孤立的。
 */
const openPaneDoubleClickMenu = (event: MouseEvent) => {
  if (!isPaneBackgroundDblClick(event)) return

  closeCanvasMenus()

  // 与拖线菜单同一套居中偏移：Vue Flow 节点按左上角定位，把双击点当作节点中心
  const flowPosition = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  pendingDblClickPosition.value = { x: flowPosition.x - 190, y: flowPosition.y - 140 }
  dblClickMenuItems.value = buildNodeTypeMenuItems(
    NODE_TYPE_PRESENTATION.map(presentation => presentation.type),
    'dblclick-add',
    type => () => createNodeFromDblClickMenu(type),
  )
  dblClickMenuPosition.value = { x: event.clientX, y: event.clientY }
  dblClickMenuVisible.value = true
}

/** 双击菜单里选了类型：在双击点建节点（不带边）+ 置顶 + 选中 */
const createNodeFromDblClickMenu = (type: WorkflowNodeType) => {
  const position = pendingDblClickPosition.value
  dblClickMenuVisible.value = false
  pendingDblClickPosition.value = null
  if (!position) return

  const newNodeId = placeNewNode(type, position)
  nextTick(() => {
    setNodes(nodes.value.map(node => ({ ...node, selected: node.id === newNodeId })))
    updateNodeInternals([newNodeId])
  })
}

const closeDblClickMenu = () => {
  dblClickMenuVisible.value = false
  pendingDblClickPosition.value = null
}

// 清空画布（带确认）
const clearCanvasWithConfirm = () => {
  if (typeof window === 'undefined') return
  if (window.confirm('确定要清空画布吗？此操作不可撤销。')) {
    clearCanvas()
  }
}

// 扩展快捷键
useShortcut('CmdOrCtrl+A', () => selectAll())
useShortcut('CmdOrCtrl+C', () => {
  copySelected()
})
useShortcut('CmdOrCtrl+V', () => {
  pasteFromSlot()
})

// 助手面板（复用 canana 视图的 RightPanel）
const {
  isPanelCollapsed: isAssistantCollapsed,
  togglePanel: toggleAssistantPanel,
  panelWidth: assistantPanelWidth,
  setPanelWidth: setAssistantPanelWidth,
  PANEL_WIDTH_MIN: ASSISTANT_PANEL_MIN,
  PANEL_WIDTH_MAX: ASSISTANT_PANEL_MAX,
} = useChatSessions()

/**
 * 拖面板左边缘改宽度。
 *
 * 用的是面板自带的那份宽度状态（useChatSessions.panelWidth）—— 它本来就在，只是一直没人用，
 * 面板宽度还被写死在 CSS 里。现在 CSS 只认 `--assistant-panel-width`，由这里绑上去，
 * 于是「拖多宽」和「画布让出多少」永远是同一个数，不会各走各的。
 */
const resizingAssistant = ref(false)
const startAssistantResize = (event: MouseEvent) => {
  event.preventDefault()
  resizingAssistant.value = true
  const onMove = (moveEvent: MouseEvent) => {
    setAssistantPanelWidth(window.innerWidth - moveEvent.clientX)
  }
  const onUp = () => {
    resizingAssistant.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/**
 * 给画布助手的「工具上下文」（2026-09-23）
 *
 * 助手要能真的动手改画布，就得有一个明确的、可注入的能力面 —— 就是这里。
 * 面板自己不 import 画布 store：能力从这个对象进来，好处是能力清单一眼可读、
 * 也能用假上下文单测（scripts/tests/test-canvas-agent-tools.mjs）。
 */
/**
 * 把 Agent 给的模型名规范成画布上真正在用的格式。
 *
 * 画布节点的 `data.model` 存的是目录里的 **selectionKey**（providerId::CATEGORY::modelKey），
 * 只写裸模型名（比如 mock-image）在生产里解析不到，会**静默回退到默认厂商** ——
 * 实测时 Agent 就踩了这个坑：它把模型改成 mock-image 后执行，结果打到了另一个厂商上，
 * 报出「API Key 解密失败」，而它自己还猜到了「看起来 key 格式不对」。
 */
const normalizeAgentModelPatch = (type: string, patch: Record<string, unknown>) => {
  const model = typeof patch?.model === 'string' ? patch.model.trim() : ''
  if (!model) return patch
  const category = type === 'image' ? 'IMAGE' : type === 'video' ? 'VIDEO' : 'CHAT'
  const byKey = resolveModelSelectionKey(model, category)
  if (byKey) return { ...patch, model: byKey }
  /**
   * 再按**展示名**匹配一次：Agent 常常直接把面板上看到的名字念出来（例如「打桩视频（本地）」），
   * 而画布上存的是 providerId::CATEGORY::modelKey。
   * 之前只按 key 匹配 → 匹配不到就把这个裸名字写进节点 → 节点解析不了、静默回退到默认模型
   * （实测：节点上的模型被换成了 Seedance）。
   */
  const candidates = category === 'IMAGE' ? getAllImageModels() : category === 'VIDEO' ? getAllVideoModels() : getAllChatModels()
  const normalized = model.toLowerCase()
  const byLabel = candidates.find((item) => {
    const label = String((item as { label?: string }).label || '').toLowerCase()
    return label && (label === normalized || label.includes(normalized) || normalized.includes(label))
  })
  if (byLabel) return { ...patch, model: byLabel.key }
  // 两边都匹配不到：**不要**把裸名字写进节点（那会让它回退到默认模型），保持节点原样并留下痕迹
  console.warn('[canvas-agent] 模型名无法解析，已忽略该字段：', model)
  const { model: _ignored, ...rest } = patch
  return rest
}

const canvasAgentContext: CanvasAgentContext = {
  snapshotNodes: () => nodes.value.map((node) => ({
    id: node.id,
    type: node.type,
    label: String((node.data as { label?: string })?.label || ''),
    text: String((node.data as { prompt?: string; content?: string; url?: string })?.prompt
      || (node.data as { content?: string })?.content
      || ''),
    // 分开给：预校验按节点类型分派字段，只给合并后的 text 会把有提示词的节点误报成空
    prompt: String((node.data as { prompt?: string })?.prompt || ''),
    content: String((node.data as { content?: string })?.content || ''),
    model: String((node.data as { model?: string })?.model || ''),
    size: String((node.data as { size?: string })?.size || ''),
    quality: String((node.data as { quality?: string })?.quality || ''),
    status: (node.data as { loading?: boolean })?.loading ? '生成中' : String((node.data as { error?: string })?.error || ''),
    // 已经生成出来的图地址：连续性靠它（母版出图后要把这张图挂给分镜节点当参考图）
    imageUrl: String((node.data as { url?: string })?.url || ''),
    textLength: String((node.data as { content?: string })?.content || '').length,
    // 参考图要给出来：预校验要探这些图还在不在（这是「人物崩坏」最常见的来源）
    referenceImages: Array.isArray((node.data as { referenceImages?: string[] })?.referenceImages)
      ? ((node.data as { referenceImages?: string[] }).referenceImages as string[])
      : [],
  })),
  snapshotEdges: () => edges.value.map((edge) => ({ source: edge.source, target: edge.target })),
  selectedIds: () => getSelectedNodes.value.map((node) => node.id),
  defaultPosition: () => screenToFlowCoordinate({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }),
  addNode: (type, position, data) => addNode(type as WorkflowNodeType, position, normalizeAgentModelPatch(type, data || {})),
  updateNode: (id, patch) => {
    const target = nodes.value.find((node) => node.id === id)
    if (!target) return false
    updateNode(id, normalizeAgentModelPatch(target.type, patch || {}) as Parameters<typeof updateNode>[1])
    return true
  },
  removeNode: (id) => {
    if (!nodes.value.some((node) => node.id === id)) return false
    removeNode(id)
    return true
  },
  addEdge: (source, target) => {
    if (edges.value.some((edge) => edge.source === source && edge.target === target)) return false
    addEdge({ source, target })
    return true
  },
  selectNodes: (ids, focus = true) => {
    const wanted = new Set(ids)
    setNodes(nodes.value.map((node) => ({ ...node, selected: wanted.has(node.id) })))
    if (focus && ids.length) {
      void fitView({ nodes: ids, duration: 300, padding: 0.3 })
    }
  },
  /**
   * 开始/结束一轮流水线（由助手面板在跑 Agent 前后来调）。
   *
   * 放这里而不是面板里：只有画布页知道自己的 workflowId、也只有它管着自动保存。
   * 面板负责「什么时候开始/结束」，画布页负责「锁与保存怎么配合」。
   */
  beginPipelineRun: async (label?: string) => {
    // 新一轮开始：清空上一轮的「已完成触发」去重状态，让本轮可以重新执行节点。
    beginAgentRunRound()
    const workflowId = currentWorkflowId.value
    if (!workflowId) return { ok: false, reason: 'no_workflow' as const }
    try {
      const lock = await acquireWorkflowPipelineLock(workflowId, label)
      pipelineToken.value = lock.token
      pipelineSnapshotVersionId.value = lock.snapshotVersionId
      await flushAutosave()
      // 把 workflowId + token 一并交回面板：建 Agent 任务时带着它，服务端据此把锁绑到任务上、终态释放
      return { ok: true as const, snapshotVersionId: lock.snapshotVersionId, workflowId, pipelineToken: lock.token }
    } catch (error: any) {
      // 只有「被占用」是可操作状态；其它错误（网络/鉴权）要如实分开，别一律叫 locked
      if (error?.name === 'WorkflowCanvasLockedError') {
        return { ok: false, reason: 'locked' as const, message: error?.message || '画布已被占用' }
      }
      return { ok: false, reason: 'error' as const, message: error?.message || '取画布锁失败' }
    }
  },
  endPipelineRun: async () => {
    const workflowId = currentWorkflowId.value
    const token = pipelineToken.value
    pipelineToken.value = ''
    if (workflowId && token) {
      try {
        await releaseWorkflowPipelineLock(workflowId, token)
      } catch {
        // 释放失败不影响本轮结果：锁还有 TTL 兜底，且服务端在任务终态时也会放（见 releasePipelineLockForTask）
      }
    }
    // 锁一放掉，把本轮期间被拦下的编辑补写回去
    void flushAutosave()
  },
  /**
   * 强制释放「自己」画布上的锁（B 的兜底）。
   *
   * 孤儿锁场景：任务其实早跑完了，锁却没被正常放掉，用户被自己的锁挡住干等 TTL。
   * 服务端只放 userId 匹配的那把，所以这里释放它不会影响别人的并发保护。
   */
  forceReleasePipelineRun: async () => {
    const ok = await handleForceReleaseLock()
    return { ok, message: ok ? undefined : '强制释放失败：请确认当前画布已保存' }
  },
  runNode: (id) => runNodeById(id),
  /**
   * 批量执行（串行）。
   *
   * 为什么不让工具层用 Promise.all 并发起：提交生成任务有**每人限流**，
   * 一口气并发 6~12 个很容易被限流挡回来，而且失败时说不清是哪一个没起来。
   * 串行虽然慢几秒（每次只是「触发」，不等出图），但每个节点的成败都能如实回报。
   */
  runNodes: async (ids) => {
    const outcomes: Array<{ id: string; ok: boolean; reason?: string }> = []
    for (const id of ids) {
      const result = await runNodeById(id)
      outcomes.push({ id, ok: result.ok, reason: result.reason })
    }
    return outcomes
  },
  /**
   * 把参考图挂到图片节点上。
   *
   * 参考图存在 `data.referenceImages` 上 —— 这是节点自己读的字段（ImageNode 的 runGeneration
   * 会拿它决定走图生图还是文生图，Agent 的 run_node 也会读同一份）。所以这里只需要写数据，
   * 不必再发明一条「参考图」通道，两边天然一致。
   */
  attachReferenceImages: (id, images) => {
    const target = nodes.value.find((node) => node.id === id)
    if (!target) return { ok: false, reason: `找不到节点 ${id}` }
    if (target.type !== 'image') return { ok: false, reason: `节点 ${id} 不是图片节点，不能挂参考图` }

    /**
     * 解析每一项：模型给「节点 id」时取该节点**已经生成的那张图**，给「图片地址」时原样保留。
     *
     * 为什么必须解析 id：实测模型会写 attach_reference_images({id:"node_9", images:["node_1","node_2"]}) ——
     * 它想引用的显然是一号/二号母版出图，交上来的却是节点 id。这些 id 既不是 URL 也没有扩展名，
     * 会一路穿到服务端，在 `new URL("node_2")` 上抛 "Failed to parse URL from node_2"，
     * 一整批分镜图就这么全废了（实测 8 条集中失败）。规则在 resolveAttachedReferences 里。
     */
    const { resolved, unresolved } = resolveAttachedReferences(images, (nodeId) => {
      const hit = nodes.value.find((node) => node.id === nodeId)
      return {
        exists: Boolean(hit),
        imageUrl: String((hit?.data as { url?: string })?.url || '').trim(),
      }
    })

    if (!resolved.length) {
      return { ok: false, reason: `没有可用的参考图：${unresolved.join('；') || 'images 为空'}` }
    }
    updateNode(id, { referenceImages: [...resolved] })
    return unresolved.length
      ? { ok: true, reason: `已挂 ${resolved.length} 张，忽略了 ${unresolved.length} 项：${unresolved.join('；')}` }
      : { ok: true }
  },
  applyTemplate: (templateId, position) => {
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === templateId)
    if (!template) return null
    const { nodes: createdNodes, edges: createdEdges } = template.createNodes(position)
    // 模板里的节点 id 是临时的，落画布后要换成真实 id —— 用一张映射表，不去改模板对象本身
    const idMap = new Map<string, string>()
    createdNodes.forEach((node) => {
      const id = addNode(node.type, node.position, node.data)
      idMap.set(node.id, id)
    })
    // 连线要等节点挂载后再加（Vue Flow 需要拿到 handle），与画布上手动套模板同一条路径
    setTimeout(() => {
      createdEdges.forEach((edge) => {
        addEdge({
          source: idMap.get(edge.source) || edge.source,
          target: idMap.get(edge.target) || edge.target,
          sourceHandle: edge.sourceHandle || 'right',
        })
      })
    }, 50)
    return { nodes: createdNodes.length, edges: createdEdges.length }
  },
  listTemplates: () => WORKFLOW_TEMPLATES.map((item) => ({ id: item.id, name: item.name, description: item.description })),
  nodeTypeHints: () => [
    { type: 'text', name: '文本输入' },
    { type: 'image', name: '图片生成' },
    { type: 'video', name: '视频生成' },
    { type: 'asset', name: '素材' },
  ],
}
const pendingAssistantMessage = ref('')

// 助手生成的图片落到画布：在视口中心创建 image 节点
const handleAssistantAddImage = ({ url }: { url: string }) => {
  if (!url) return
  const center = screenToFlowCoordinate({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  addNode('image', center, { url, label: '助手生成' })
}

/**
 * 窄屏提示：画布依赖鼠标（拖拽/连线/缩放）和大屏空间，手机上节点会挤成一团、助手面板也比屏幕宽。
 * 与其把半个界面裁掉，不如给一条明确提示；用户点掉后仍可平移/查看画布。
 */
const isNarrowViewport = ref(false)
const mobileHintDismissed = ref(false)
const showMobileHint = computed(() => isNarrowViewport.value && !mobileHintDismissed.value)
let narrowViewportQuery: MediaQueryList | null = null
const syncNarrowViewport = (event: MediaQueryList | MediaQueryListEvent) => {
  isNarrowViewport.value = Boolean(event.matches)
}

onMounted(() => {
  initSampleData()
  initHistory()
  initialCanvasBaselineSnapshot.value = buildCanvasSnapshotNow()
  // 首次也要结算一次，否则 isCanvasDirty 在第一次变更前一直比的是空串
  canvasSnapshot.value = buildCanvasSnapshotNow()

  window.addEventListener('keydown', handleSpaceDown)
  window.addEventListener('keyup', handleSpaceUp)

  const initialWorkflowId = String(route.query.workflowId || '').trim()
  const initialVersionId = String(route.query.versionId || '').trim()
  if (initialWorkflowId) {
    void tryLoadWorkflowByRoute(initialWorkflowId, {
      versionId: initialVersionId || undefined,
    })
  }

  autosaveReady.value = true

  narrowViewportQuery = window.matchMedia('(max-width: 768px)')
  syncNarrowViewport(narrowViewportQuery)
  narrowViewportQuery.addEventListener('change', syncNarrowViewport)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleSpaceDown)
  window.removeEventListener('keyup', handleSpaceUp)
  clearAutosaveTimer()
  narrowViewportQuery?.removeEventListener('change', syncNarrowViewport)
  narrowViewportQuery = null
})

watch(() => route.query.workflowId, (workflowId) => {
  const normalizedWorkflowId = String(workflowId || '').trim()
  const normalizedVersionId = String(route.query.versionId || '').trim()

  if (!normalizedWorkflowId) {
    if (currentWorkflowId.value) {
      void handleCreateWorkflow()
    }
    return
  }

  if (!normalizedWorkflowId || workflowLoadingByRoute.value) {
    return
  }

  void tryLoadWorkflowByRoute(normalizedWorkflowId, {
    versionId: normalizedVersionId || undefined,
  })
})

// 浏览器后退、地址栏跳走等场景：同样让用户看到"正在保存草稿…"，
// 避免脏 canvas 触发 flushAutosave 时几秒无反馈
const loadingStore = useLoadingStore()
onBeforeRouteLeave(async (_to, _from, next) => {
  loadingStore.start('blocking', '正在保存草稿…')
  try {
    await flushAutosave()
  } finally {
    loadingStore.stop('blocking')
  }
  next()
})

watch(canvasSnapshot, () => {
  scheduleAutosave()
})
</script>

<template>
  <div
    class="workflow-container"
    :class="{ 'workflow-right-panel-open': !isAssistantCollapsed, 'workflow-resizing-panel': resizingAssistant }"
    :style="{ '--assistant-panel-width': `${assistantPanelWidth}px` }"
  >
    <div v-if="showMobileHint" class="workflow-mobile-hint" role="status">
      <span class="workflow-mobile-hint__text">
        画布编辑更适合桌面端：手机上节点与连线会挤在一起，拖拽、连线、缩放都不方便。
      </span>
      <button
        type="button"
        class="workflow-mobile-hint__close"
        @click="mobileHintDismissed = true"
      >
        仍要查看
      </button>
    </div>
    <div class="workflow-workbench">
      <div class="workflow-main">
        <div
          class="workflow-canvas-wrap"
          @dragover="onCanvasFileDragOver"
          @drop="onCanvasFileDrop"
          @dblclick="openPaneDoubleClickMenu"
        >
          <!-- zoom-on-double-click 关掉了 vue-flow 自带的双击缩放：
               双击空白现在改成弹「新建节点」菜单，两者不能同时生效 -->
          <!-- 网格吸附为什么关掉（2026-09-23）：
               原来这里开着 :snap-to-grid="true" :snap-grid="[20,20]"，结果是**拖拽不跟手** ——
               指针在同一个 20px 格子里移动时节点纹丝不动，跨格才跳一下。
               CDP 实测：59.7% 的帧「指针动了、节点没动」，最长连续 16 帧（≈267ms）白走，
               然后跳 26px（20 × 当时缩放 1.343）；帧率却一直是满的（93% idle），
               所以这不是性能问题，是位置被网格量化了。而且 20px 与背景点阵的 16px 对不上，
               节点会停在看不见的格线上。
               需要对齐时走我方的对齐辅助线（useCanvasAlignmentGuides：6 屏幕像素阈值、
               按缩放换算），只在真正接近对齐时吸附、平时完全跟手。
               将来若还想要网格吸附，建议做成「按住修饰键才生效」或「松手时对齐一次」。 -->
          <VueFlow
            v-model:nodes="nodes"
            v-model:edges="edges"
            v-model:viewport="viewport"
            :node-types="nodeTypes"
            :edge-types="edgeTypes"
            :default-viewport="canvasViewport"
            :min-zoom="0.1"
            :max-zoom="2"
            :delete-key-code="['Delete', 'Backspace']"
            :selection-key-code="selectionKeyCode"
            :multi-selection-key-code="multiSelectionKeyCode"
            :selection-mode="SelectionMode.Partial"
            :pan-on-drag="panOnDragValue"
            :nodes-draggable="!isSpacePressed"
            :pan-on-scroll="false"
            :connect-on-click="false"
            :zoom-on-double-click="false"
            :connection-line-component="CanvasConnectionLine"
            :node-class-name="resolveNodeClass"
            @connect="onConnect"
            @connect-end="onConnectEnd"
            @node-click="handleNodeClick"
            @pane-click="onPaneClick"
            @viewport-change="handleViewportChange"
            @edges-change="onEdgesChange"
            @node-drag-start="onNodeDragStart"
            @node-drag="onNodeDrag"
            @node-drag-stop="onNodeDragStop"
            @pane-context-menu="openPaneContextMenu"
            @node-context-menu="openNodeContextMenu"
            class="workflow-canvas"
            :class="{ 'workflow-canvas--space-panning': isSpacePressed }"
          >
            <!-- 网格：点阵 16px / 圆点 1px，与 LibTV 实测一致。
                 用户仍可在「画布外观」里切成网格线或空白 -->
            <Background
              v-if="canvasBackgroundMode !== 'blank'"
              :gap="16"
              :size="1"
              :variant="canvasBackgroundMode === 'dots' ? 'dots' : 'lines'"
            />
          </VueFlow>

          <!--
            对齐辅助线覆盖层
            用与画布相同的 viewport 变换，保证线与节点严格对齐。
            线宽按 1/zoom 反向补偿，屏幕上始终是 1px；命中时吸附由 onNodeDrag 负责。
          -->
          <svg
            v-if="guides.v.length || guides.h.length"
            class="workflow-guides"
            aria-hidden="true"
          >
            <g :transform="`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`">
              <line
                v-for="x in guides.v"
                :key="`v-${x}`"
                :x1="x" :y1="-100000" :x2="x" :y2="100000"
                :stroke-width="1 / viewport.zoom"
                class="workflow-guides__line"
              />
              <line
                v-for="y in guides.h"
                :key="`h-${y}`"
                :x1="-100000" :y1="y" :x2="100000" :y2="y"
                :stroke-width="1 / viewport.zoom"
                class="workflow-guides__line"
              />
            </g>
          </svg>

          <CanvasMiniMap :visible="isMiniMapOpen" />
          <CanvasZoomControls
            :mini-map-open="isMiniMapOpen"
            @toggle-mini-map="toggleMiniMap"
            @clear="clearCanvasWithConfirm"
          />
          <CanvasContextMenu
            :visible="contextMenuVisible"
            :position="contextMenuPosition"
            :items="contextMenuItems"
            @close="closeContextMenu"
          />
          <!-- 拖线落空：在落点给出可以接在这里的节点类型 -->
          <CanvasContextMenu
            :visible="connectMenuVisible"
            :position="connectMenuPosition"
            :items="connectMenuItems"
            @close="closeConnectMenu"
          />
          <!-- 双击空白：没有起点节点，所以在双击点给出全部节点类型 -->
          <CanvasContextMenu
            :visible="dblClickMenuVisible"
            :position="dblClickMenuPosition"
            :items="dblClickMenuItems"
            @close="closeDblClickMenu"
          />
        </div>

        <header class="workflow-header">
          <div class="workflow-header-left">
            <button class="wf-btn wf-btn-sm" :disabled="goBackLoading" @click="goBack" title="返回">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <span style="font-size: 13px; color: var(--text-primary); padding: 0 8px;">工作流</span>
          </div>

          <div class="workflow-header-right">
            <div class="wf-header-meta">
              <input
                v-if="renamingTitle"
                v-model="renameTitleInput"
                class="wf-header-meta__title wf-header-meta__title-input"
                type="text"
                maxlength="80"
                @blur="submitRenameTitle"
                @keyup.enter.prevent="submitRenameTitle"
                @keyup.esc.prevent="cancelRenameTitle"
              />
              <span
                v-else
                class="wf-header-meta__title"
                title="点击重命名工作流"
                @click="startRenameTitle"
              >
                {{ currentWorkflowTitle }}
              </span>
              <span class="wf-header-meta__status">{{ currentWorkflowStatusText }} · {{ autosaveStatusText }}</span>
              <!-- 孤儿锁自救入口：任务早跑完但锁没放掉时，不让用户干等 TTL -->
              <button
                v-if="autosaveState === 'locked'"
                type="button"
                class="wf-header-meta__force-unlock"
                @click="handleForceReleaseLock"
              >
                强制释放
              </button>
            </div>
          </div>
        </header>

        <!-- 快速连线状态横幅：Shift+点击挂起源节点后顶部提示 -->
        <Transition name="wf-quick-link-banner">
          <div v-if="quickLinkSourceId" class="wf-quick-link-banner" role="status" aria-live="polite">
            <span class="wf-quick-link-banner__dot" aria-hidden="true"></span>
            <span class="wf-quick-link-banner__text">
              正在连线：<strong>{{ quickLinkSourceLabel }}</strong> → 按住 Shift 点击目标节点完成
            </span>
            <span class="wf-quick-link-banner__hint">Esc 取消</span>
            <button
              class="wf-quick-link-banner__close"
              type="button"
              aria-label="取消快速连线"
              @click="cancelQuickLink"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </Transition>

        <!-- 整理画布后的确认条：问一次「保留还是还原」，而不是默默改掉用户摆好的位置 -->
        <Transition name="wf-quick-link-banner">
          <div v-if="layoutSnapshot" class="wf-layout-confirm" role="status" aria-live="polite">
            <span class="wf-layout-confirm__text">是否保留此次整理结果？</span>
            <button class="wf-layout-confirm__btn" type="button" @click="revertLayout">还原</button>
            <button class="wf-layout-confirm__btn is-primary" type="button" @click="keepLayout">保留</button>
          </div>
        </Transition>

        <nav class="workflow-left-toolbar">
          <div class="workflow-left-toolbar-container">
            <button
              class="wf-btn wf-btn-icon"
              :class="{ active: showNodeMenu }"
              @click="showNodeMenu = !showNodeMenu"
              title="添加节点"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>

            <button
              class="wf-btn wf-btn-icon"
              :class="{ active: showTemplatePanel }"
              @click="showTemplatePanel = !showTemplatePanel"
              title="工作流模板"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
              </svg>
            </button>

            <div class="wf-divider"></div>

            <button
              v-for="tool in tools"
              :key="tool.id"
              class="wf-btn wf-btn-icon"
              @click="tool.action"
              :title="tool.name"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path :d="tool.icon" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <div class="wf-divider"></div>

            <button class="wf-btn wf-btn-icon" :disabled="!canUndo" @click="undo()" title="撤销">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M3 10h10a5 5 0 015 5v0a5 5 0 01-5 5H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M7 14l-4-4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="wf-btn wf-btn-icon" :disabled="!canRedo" @click="redo()" title="重做">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M21 10H11a5 5 0 00-5 5v0a5 5 0 005 5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M17 14l4-4-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <div class="wf-divider"></div>

            <!-- 整理画布：按流向分层重排（Option+Shift+F），与 LibTV 同一个组合键 -->
            <button
              class="wf-btn wf-btn-icon"
              :disabled="!nodes.length"
              @click="autoLayoutCanvas"
              title="整理画布（⌥⇧F）"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M4 6h6M4 12h6M4 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M14 9h6M14 15h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M10 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
              </svg>
            </button>

            <!-- 快捷键面板：列的是我们实际注册的快捷键 -->
            <button
              class="wf-btn wf-btn-icon"
              :class="{ active: showShortcutPanel }"
              @click="showShortcutPanel = !showShortcutPanel"
              title="快捷键"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="2.5" y="6" width="19" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </nav>

        <!-- 快捷键面板 -->
        <aside v-if="showShortcutPanel" class="workflow-shortcut-panel">
          <div class="workflow-shortcut-head">
            <span>快捷键</span>
            <button type="button" class="workflow-shortcut-close" @click="showShortcutPanel = false">✕</button>
          </div>
          <div v-for="group in shortcutGroups" :key="group.title" class="workflow-shortcut-group">
            <div class="workflow-shortcut-group-title">{{ group.title }}</div>
            <div v-for="item in group.items" :key="item.desc" class="workflow-shortcut-row">
              <span class="workflow-shortcut-keys">
                <kbd v-for="key in item.keys" :key="key">{{ key }}</kbd>
              </span>
              <span class="workflow-shortcut-desc">{{ item.desc }}</span>
            </div>
          </div>
        </aside>

        <div v-if="showNodeMenu" class="wf-node-menu">
          <button
            v-for="opt in nodeTypeOptions"
            :key="opt.type"
            class="wf-node-menu-item"
            @click="addNewNode(opt.type)"
          >
            <!-- 颜色走 style 而不是 stroke 表现属性：
                 表现属性不解析 var()，写 a 上去会直接失效。
                 stroke-width 1.5 与画布图标模块的设计规格一致（见 canvas-icons.ts） -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                :d="opt.icon"
                :style="{ stroke: opt.color }"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>{{ opt.name }}</span>
          </button>
        </div>

        <div class="workflow-bottom-toolbar" v-if="false">
          <div class="workflow-bottom-toolbar-container">
            <button class="wf-btn wf-btn-sm" @click="fitView({ padding: 0.2 })" title="适应视图">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="wf-btn wf-btn-sm" @click="zoomOut()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <span class="wf-zoom-text">{{ Math.round(viewport.zoom * 100) }}%</span>
            <button class="wf-btn wf-btn-sm" @click="zoomIn()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        <Transition name="wf-panel">
          <div v-if="showTemplatePanel" class="wf-template-panel" @click.self="showTemplatePanel = false">
            <div class="wf-template-panel-inner">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <span style="font-size: 14px; font-weight: 500; color: var(--text-primary);">工作流模板</span>
                <button class="wf-btn wf-btn-sm" @click="showTemplatePanel = false">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
              <div class="wf-template-list">
                <div
                  v-for="tpl in WORKFLOW_TEMPLATES"
                  :key="tpl.id"
                  class="wf-template-card"
                  @click="handleAddWorkflow(tpl)"
                >
                  <div class="wf-template-card-title">{{ tpl.name }}</div>
                  <div class="wf-template-card-desc">{{ tpl.description }}</div>
                </div>
              </div>
            </div>
          </div>
        </Transition>

        <Transition name="wf-panel">
          <div v-if="showWorkflowLibraryPanel" class="wf-template-panel" @click.self="showWorkflowLibraryPanel = false">
            <div class="wf-template-panel-inner wf-persistence-panel">
              <div class="wf-persistence-panel__header">
                <div>
                  <div class="wf-persistence-panel__title">打开工作流</div>
                  <div class="wf-persistence-panel__desc">查看保存过的工作流定义，并把版本快照恢复到当前画布。</div>
                </div>
                <button class="wf-btn wf-btn-sm" @click="showWorkflowLibraryPanel = false">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>

              <div class="wf-persistence-toolbar">
                <input v-model="workflowListKeyword" class="wf-persistence-input" placeholder="按名称、编码、分类搜索" @keyup.enter="handleRefreshWorkflowList" />
                <button class="wf-btn wf-btn-md" :disabled="workflowListLoading" @click="handleRefreshWorkflowList">
                  {{ workflowListLoading ? '加载中...' : '刷新' }}
                </button>
              </div>

              <div class="wf-workflow-list">
                <div
                  v-for="workflow in workflowList"
                  :key="workflow.id"
                  class="wf-workflow-list__group"
                >
                  <button
                    class="wf-workflow-list__item"
                    :class="{ 'is-active': workflow.id === currentWorkflowId || workflow.id === selectedLibraryWorkflowId }"
                    @click="handleSelectLibraryWorkflow(workflow)"
                  >
                    <div class="wf-workflow-list__main">
                      <div class="wf-workflow-list__title-row">
                        <span class="wf-workflow-list__title">{{ workflow.name }}</span>
                        <span class="wf-workflow-list__badge">{{ workflow.status === 'ACTIVE' ? '已发布' : '草稿' }}</span>
                      </div>
                      <div class="wf-workflow-list__code">{{ workflow.code }}</div>
                      <div class="wf-workflow-list__desc">{{ workflow.description || '暂无描述' }}</div>
                    </div>
                    <div class="wf-workflow-list__meta">
                      <span>版本 {{ workflow.latestVersionNo }}</span>
                      <span>{{ workflow.category || '未分类' }}</span>
                    </div>
                  </button>

                  <div
                    v-if="selectedLibraryWorkflowId === workflow.id"
                    class="wf-workflow-list__versions"
                  >
                    <div class="wf-workflow-list__versions-header">
                      <span>版本列表</span>
                      <button class="wf-btn wf-btn-md wf-btn-primary" @click="handleLoadWorkflow(workflow)">
                        打开当前版本
                      </button>
                    </div>

                    <div v-if="libraryDetailLoading" class="wf-workflow-list__empty">
                      正在加载版本列表...
                    </div>

                    <div
                      v-else-if="selectedLibraryWorkflowDetail?.versions?.length"
                      class="wf-workflow-list__version-list"
                    >
                      <button
                        v-for="version in selectedLibraryWorkflowDetail.versions"
                        :key="version.id"
                        class="wf-workflow-list__version-item"
                        :class="{ 'is-active': version.id === selectedWorkflowVersionId }"
                        @click="handleLoadWorkflowVersion(workflow, version.id)"
                      >
                        <div class="wf-workflow-list__version-main">
                          <span class="wf-workflow-list__version-title">
                            V{{ version.versionNo }} {{ version.versionName || '未命名版本' }}
                          </span>
                          <span class="wf-workflow-list__version-desc">
                            {{ version.changeSummary || '暂无版本说明' }}
                          </span>
                        </div>
                        <span class="wf-workflow-list__version-badge">
                          {{ version.status === 'PUBLISHED' ? '已发布' : version.status === 'DEPRECATED' ? '已废弃' : '草稿' }}
                        </span>
                      </button>
                    </div>

                    <div v-else class="wf-workflow-list__empty">
                      这个工作流暂时还没有版本数据。
                    </div>
                  </div>
                </div>

                <div v-if="!workflowListLoading && workflowList.length === 0" class="wf-workflow-list__empty">
                  还没有可打开的工作流，先保存一个吧。
                </div>
              </div>
            </div>
          </div>
        </Transition>

<!--        <ContentGenerator-->
<!--          class="workflow-content-generator"-->
<!--          :collapsible="true"-->
<!--          :default-expanded="false"-->
<!--          popup-placement="top"-->
<!--          @send="handlePromptSend"-->
<!--        />-->
      </div>

      <!-- 右侧助手面板（复用 canana 视图的 RightPanel）：fixed 定位 + translateX 动画 -->
      <aside class="workflow-assistant-aside">
        <RightPanel
          :title="currentWorkflowTitle"
          :visible="!isAssistantCollapsed"
          :initial-message="pendingAssistantMessage"
          :canvas-brief="assistantCanvasBrief"
          :agent-context="canvasAgentContext"
          @close="toggleAssistantPanel"
          @message-received="pendingAssistantMessage = ''"
          @add-image-to-canvas="handleAssistantAddImage"
        />
      </aside>

      <!--
        拖这里改面板宽度（只在面板打开时存在）。放 6px 宽的透明条，视觉上不留痕，
        但鼠标压上去会给 col-resize 光标 —— 用户才知道这里能拖。
      -->
      <div
        v-if="!isAssistantCollapsed"
        class="workflow-assistant-resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-valuenow="assistantPanelWidth"
        :aria-valuemin="ASSISTANT_PANEL_MIN"
        :aria-valuemax="ASSISTANT_PANEL_MAX"
        title="拖动调整面板宽度"
        @mousedown="startAssistantResize"
      ></div>

      <!--
        Agent 创作入口。面板收起时常驻显示（面板打开时它本来就该让位给面板本身）。
        必须永远压在右键菜单与节点操作条之上 —— 那两样正好在「右键」「拖卡片」时出现。
      -->
      <button
        v-if="isAssistantCollapsed"
        class="canvas-assistant-toggle"
        title="打开 Agent 创作（让 Agent 直接改这块画布）"
        @click="toggleAssistantPanel"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3.2l1.7 4.9 4.9 1.7-4.9 1.7L12 16.4l-1.7-4.9L5.4 9.8l4.9-1.7L12 3.2z"
            fill="currentColor"
          />
          <path d="M18.6 15.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="currentColor" />
        </svg>
        <span class="canvas-assistant-toggle__label">Agent创作</span>
      </button>
    </div>
  </div>
</template>

<style>
@import './styles/workflow.css';
/* 画布外观对齐 LibTV（实测色值）。放在 workflow.css 之后，才能覆盖其中的默认值 */
@import './styles/libtv-tokens.css';

/* ===== 快捷键面板（F7）===== */
.workflow-shortcut-panel {
  position: absolute;
  top: 64px;
  left: 72px;
  z-index: 6;
  width: 288px;
  padding: 12px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 12px;
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur, 16px));
}

.workflow-shortcut-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.workflow-shortcut-close {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.workflow-shortcut-close:hover {
  color: var(--text-primary);
}

.workflow-shortcut-group + .workflow-shortcut-group {
  margin-top: 12px;
}

.workflow-shortcut-group-title {
  margin-bottom: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.workflow-shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 26px;
}

.workflow-shortcut-keys {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
}

.workflow-shortcut-keys kbd {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 5px;
  background: var(--bg-block-secondary-default);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.workflow-shortcut-desc {
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: right;
}
</style>
