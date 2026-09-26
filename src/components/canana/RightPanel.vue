<script setup>
import { isRasterReferenceUrl } from '@/config/reference-validation'
import { renderMarkdownBlocks } from '@/composables/research/report-markdown-utils'
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import SidebarEmptyState from '@/components/canana/SidebarEmptyState.vue'
import AgentToolTrace from '@/components/canana/AgentToolTrace.vue'
import AssistantSessionList from '@/components/canvas/AssistantSessionList.vue'
import {
  createGenerationTask,
  steerGenerationTask,
  subscribeGenerationTaskEvents,
  resolveGenerationTaskModel,
} from '@/api/generation-tasks'
import { listGenerationRecords } from '@/api/generation-records'
import {
  loadPublicModelCatalog,
  getDefaultChatModelKey,
  getAllChatModels,
  notifyModelSelectionFallback,
  reconcileModelSelection,
  resolveModelLabel,
} from '@/config/models'
import { appendImageReferencesToRequestBody } from '@/shared/image-generation-request'
import { useAssistantSessions } from '@/composables/useAssistantSessions'
import {
  decideCanvasSession,
  readCanvasSessionMap,
  upsertCanvasSessionBinding,
  writeCanvasSessionMap,
} from '@/composables/canvas-session-binding'
// 折叠状态与画布页共用同一份（useChatSessions 是模块级单例）：
// 确认卡片长在这个面板里，面板收起来用户就看不见卡片 —— 而那是「不给答复就走不下去」的闸门。
import { useChatSessions } from '@/composables/useChatSessions'
import { buildAssistantChatMessages } from '@/composables/assistant-chat-history'
import { useCanvasAgentBridge } from '@/views/workflow/agent/use-canvas-agent-bridge'
import {
  clearAgentGeneratingNodes,
  resetAgentActiveNodes,
} from '@/views/workflow/composables/useAgentActiveNodes'
import { CANVAS_AGENT_SKILL_KEY } from '@/shared/canvas-agent-tools'
import SelectPopup from '@/components/generate/common/SelectPopup.vue'
import { getAgentModel, setAgentModel } from '@/api/agent'
import {
  AGENT_CONFIRM_PREDEDUCT_NOTICE,
  collectConfirmationNodeIds,
  resolveAgentConfirmCostDisplayFromCache,
} from '@/components/canana/agent-confirm-cost'
import { buildAgentWorkflowCard } from '@/components/canana/agent-workflow-card'
import { buildCanvasAgentCrew } from '@/components/canana/agent-crew'
import {
  describeAgentInterjectionNotice,
  normalizeAgentInterjectionMode,
  resolveAgentSendRoute,
} from '@/components/canana/agent-send-routing'
import {
  consumeHomeCanvasAgentPending,
  readHomeCanvasAgentPending,
  resolveAutoSendBlockReason,
  shouldAutoSendToAgent,
} from '@/shared/home-canvas-entry'

const props = defineProps({
  title: { type: String, default: '' },
  visible: { type: Boolean, default: false },
  initialMessage: { type: String, default: '' },
  /**
   * 画布状态摘要（由 workflow 页生成的纯文本）。
   * 没有它，助手完全看不见用户眼前有什么节点 —— 只能空对空写提示词。
   */
  canvasBrief: { type: String, default: '' },
  /**
   * 画布工具上下文（由页面注入）。给了它，助手才会「真的动手」：
   * 先走一轮带工具的 Agent 循环（增删节点、连线、选中、触发执行），
   * 模型没要求调用工具、或这一轮没执行成功时，回退到原来的流式对话。
   */
  agentContext: { type: Object, default: null },
  /**
   * 当前画布 id（= 流水线锁的 workflowId）。给了它，面板就把会话绑到这张画布上：
   * 显示这张画布那次的对话，并且 Agent 记忆（键 sessionId + 画布 id）能命中。
   * 未保存的画布是空串 —— 此时刻意不切会话、也刻意不让 Agent 记忆启用（防串台）。
   */
  canvasId: { type: String, default: '' },
  /**
   * 画布是否已就绪（画布数据已载入、不在加载中）。
   * 与 canvasId 配合：只有「就绪 + 会话已绑定」时才处理首页带来的自动发送。
   */
  canvasReady: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'message-received', 'add-image-to-canvas'])

// 会话列表（与 /generate 通过 source='canvas-assistant' 物理隔离）
const {
  sessions: assistantSessions,
  activeSession,
  activeSessionId,
  loadSessions,
  createNewSession,
  renameSessionTitle,
  removeSessionById,
  setActive,
  ensureSession,
  touchActiveSession,
  ASSISTANT_SOURCE,
} = useAssistantSessions()

const sessionListVisible = ref(false)
const sessionListAnchor = ref(null)
const headerTitleText = computed(() => activeSession.value?.title || props.title || '未命名对话')

const openSessionList = () => {
  sessionListVisible.value = !sessionListVisible.value
}
const closeSessionList = () => {
  sessionListVisible.value = false
}

const handleSessionSelect = (id) => {
  if (id === activeSessionId.value) {
    closeSessionList()
    return
  }
  setActive(id)
  cleanupStreams()
  closeSessionList()
  // 切换会话后加载该会话的历史 records
  void loadSessionHistory(id)
}

const handleSessionCreate = async () => {
  try {
    const created = await createNewSession()
    messages.value = []
    hasMessages.value = false
    cleanupStreams()
    // 新会话还没有 records，不需要 loadSessionHistory，留空展示空态
    void created
  } catch (err) {
    console.error('[RightPanel] create session failed', err)
  } finally {
    closeSessionList()
  }
}

const handleSessionRename = async (id, title) => {
  try {
    await renameSessionTitle(id, title)
  } catch (err) {
    console.error('[RightPanel] rename session failed', err)
  }
}

const handleSessionDelete = async (id) => {
  try {
    const wasActive = activeSessionId.value === id
    await removeSessionById(id)
    if (wasActive) {
      cleanupStreams()
      // 删除当前会话后，切换到新选中的会话并加载它的历史
      if (activeSessionId.value) {
        void loadSessionHistory(activeSessionId.value)
      } else {
        messages.value = []
        hasMessages.value = false
      }
    }
  } catch (err) {
    console.error('[RightPanel] delete session failed', err)
  }
}

// 是否有消息（用于决定显示空状态还是消息列表）
const hasMessages = ref(false)

// 消息数据
const messages = ref([])

/**
 * 导演控制台状态（AI Director Console · 批次 1）。
 *
 * 只由服务端的 `console_state` 事件写入 —— 状态由服务端从真实事件推导，前端不做任何推算、
 * 不显示任何没有分母的百分比。它**不属于任何一条消息**：不参与 Markdown 渲染、不进转录。
 * 空态（无消息）时整块不显示，保持现有引导 + 示例 chip。
 */
const consoleState = ref(null)

/**
 * 工作流卡片（批次 4）：由控制台状态纯逻辑组装标题 / 输入 / 输出 / 状态。
 *
 * 组装里不含任何推算 —— 输入与产出都来自服务端从真实事件推导的 `workflow` 字段，
 * 缺项显示「—」；空态（无 consoleState）返回 null，整块不渲染。
 */
const workflowCard = computed(() => buildAgentWorkflowCard(consoleState.value))

/** 执行日志的标记符号（与产品约定的 ✓ ▶ ○ ! 一致） */
const CONSOLE_MARK_SYMBOLS = { done: '✓', running: '▶', pending: '○', failed: '!' }
const consoleMarkSymbol = (mark) => CONSOLE_MARK_SYMBOLS[mark] || '·'

const inputMessage = ref('')
const messagesContainer = ref(null)
const composerInputRef = ref(null)
const toggleCollapse = (msg) => { msg.collapsed = !msg.collapsed }

// 「画布 Agent」发言形态：时间戳、hover 复制（本批只做复制，复制该条正文）
const formatClock = (value) => {
  const date = new Date(Number(value) || Date.now())
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const copiedMessageId = ref(null)
let copyResetTimer = null
const copyMessage = async (msg) => {
  const text = String(msg?.content || '')
  if (!text) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // 非安全上下文没有 clipboard API：退回一个临时 textarea，别让按钮点了没反应
      const holder = document.createElement('textarea')
      holder.value = text
      holder.style.position = 'fixed'
      holder.style.opacity = '0'
      document.body.appendChild(holder)
      holder.select()
      document.execCommand('copy')
      document.body.removeChild(holder)
    }
    copiedMessageId.value = msg.id
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copiedMessageId.value = null }, 1500)
  } catch (err) {
    console.error('[RightPanel] copy message failed', err)
  }
}

// 空态的示例 chip：点一下只填进输入框，不自动发送（用户还能改）
const examplePrompts = [
  '帮我做个 30 秒广告',
  '给这个节点出一张图',
  '整理一下画布',
]
const applyExamplePrompt = (text) => {
  inputMessage.value = text
  nextTick(() => composerInputRef.value?.focus())
}

// 图片上传
const uploadedImages = ref([])
const fileInputRef = ref(null)



// 跟踪进行中的流式请求，用于卸载时统一 abort
const activeStreams = []

const registerStream = (controller) => {
  activeStreams.push(controller)
}

const cleanupStreams = () => {
  while (activeStreams.length) {
    const c = activeStreams.shift()
    try { c?.abort() } catch { /* ignore */ }
  }
  // 卸载/切会话时把还没答复的提问卡按「未回答」结掉：否则那个 Promise 会一直挂着
  if (askUserRequest.value) settleAskUser([], true)
  // 控制台状态属于「当前会话这一轮」，切会话/卸载时要一并清掉，否则会串到别的会话
  consoleState.value = null
  // 画布动作高亮同理：切会话/切画布/卸载时全清并取消定时器，绝不把高亮留给下一张画布
  resetAgentActiveNodes()
}

/**
 * 画布 → 会话绑定（B：会话绑到画布）。
 *
 * 为什么需要：助手会话一直全局只有一个，同一会话把不同画布的对话混在一起；
 * 而 Agent 跨轮记忆的键是 **sessionId + 画布 id**（见 canvas-agent-executor 的会话恢复）——
 * 会话不跟着画布切，换个画布就命中不到记忆。这里用 localStorage 里的
 * 「画布 id → 会话 id」映射做最小可用：命中就复用这张画布那次的会话，
 * 没有映射（或映射的会话已被删）就新建一条并写回。切画布 = 切会话，不混串。
 *
 * 不做库表迁移：Agent 转录存在 GenerationRecord.metaJson.canvasAgentSession.canvasId 上但没索引，
 * 按画布反查会话代价大；跨设备续写的方案与代价见本次报告。
 */
const boundCanvasId = ref('')
/** 会话绑定已完成的画布 id（首页自动发送要等它，避免和组织会话/载入历史抢跑） */
const canvasSessionReadyFor = ref('')

const bindSessionToCanvas = async (rawCanvasId) => {
  const canvasId = String(rawCanvasId || '').trim()
  if (!canvasId) {
    // 未保存的画布没有 id：不动当前会话（也刻意不让 Agent 记忆启用），并允许同一画布再次进入时重绑
    boundCanvasId.value = ''
    canvasSessionReadyFor.value = ''
    return
  }
  if (canvasId === boundCanvasId.value) {
    canvasSessionReadyFor.value = canvasId
    return
  }
  boundCanvasId.value = canvasId
  try {
    // 先拉一次会话列表：映射里那个会话可能已在服务端被删，得用现存列表校验
    await loadSessions()
    const existingSessionIds = (assistantSessions.value || []).map((item) => item.id)
    const decision = decideCanvasSession({
      canvasId,
      map: readCanvasSessionMap(),
      existingSessionIds,
    })

    let sessionId = decision.sessionId
    if (decision.needsCreate) {
      const created = await createNewSession(props.title ? `${props.title}` : undefined)
      sessionId = created.id
    }
    if (decision.shouldBind && sessionId) {
      writeCanvasSessionMap(upsertCanvasSessionBinding(readCanvasSessionMap(), canvasId, sessionId))
    }
    if (sessionId && sessionId !== activeSessionId.value) {
      setActive(sessionId)
    }
    cleanupStreams()
    await loadSessionHistory(sessionId)
  } catch (err) {
    console.error('[RightPanel] bind canvas session failed', err)
  } finally {
    // 绑定失败也标记就绪：发送路径自己会 ensureSession，不该让首页带来的那句话一直等下去
    canvasSessionReadyFor.value = canvasId
  }
}

watch(() => props.canvasId, (canvasId) => {
  void bindSessionToCanvas(canvasId)
})

onMounted(() => {
  // 先把对话模型目录拉起来：选择器要有东西可选，runCanvasAgentTurn 也要按用户选的模型走
  void refreshChatModels()
  // 后台拉取模型清单（getDefault*ModelKey 依赖此调用）
  void loadPublicModelCatalog()
  // 拉取助手会话列表（首次会自动建默认会话），然后按当前画布绑会话 / 载入历史。
  // 画布 id 常常后到（画布页恢复是异步的），后到时由上面的 watch(props.canvasId) 接手。
  void (async () => {
    await loadSessions()
    await bindSessionToCanvas(props.canvasId)
    if (!String(props.canvasId || '').trim() && activeSessionId.value) {
      await loadSessionHistory(activeSessionId.value)
    }
  })()
})

onBeforeUnmount(() => {
  cleanupStreams()
  if (copyResetTimer) clearTimeout(copyResetTimer)
})

// 把后端持久化的 record 映射为前端 UI 消息行
const mapRecordToMessages = (record) => {
  const ts = record.createdAt ? new Date(record.createdAt).getTime() : Date.now()
  const baseId = record.id || String(ts)
  const out = []
  const refImages = Array.isArray(record.referenceImages) ? record.referenceImages.filter(Boolean) : []
  if (record.prompt) {
    if (refImages.length) {
      out.push({
        id: `${baseId}-u`,
        type: 'user-with-ref',
        content: record.prompt,
        referenceImages: refImages,
        time: ts,
      })
    } else {
      out.push({
        id: `${baseId}-u`,
        type: 'user',
        content: record.prompt,
        time: ts,
      })
    }
  }
  const rtype = String(record.type || '').trim()
  if (rtype === 'image') {
    const images = Array.isArray(record.images) ? record.images.filter(Boolean) : []
    out.push({
      id: `${baseId}-a`,
      type: 'ai-images',
      summary: (record.prompt || '图片生成').slice(0, 10) + (record.prompt?.length > 10 ? '...' : ''),
      collapsed: false,
      images,
      totalCount: images.length,
      loading: !record.done && !images.length,
      error: record.error || '',
      time: ts,
    })
  } else if (rtype === 'agent' || rtype === 'chat') {
    out.push({
      id: `${baseId}-a`,
      type: 'ai-text',
      content: record.content || '',
      loading: !record.done && !record.content,
      error: record.error || '',
      time: ts,
    })
  }
  return out
}

// 拉取指定会话的历史记录并填充到 messages（time asc）
const loadSessionHistory = async (sessionId) => {
  // 历史记录里没有控制台状态（它只随当前运行的事件流来）：读历史时先清空，避免显示上一次运行的残留
  consoleState.value = null
  if (!sessionId) {
    messages.value = []
    hasMessages.value = false
    return
  }
  try {
    const all = await listGenerationRecords()
    const list = Array.isArray(all) ? all : []
    const filtered = list
      .filter((r) => r.sessionId === sessionId && (r.source || 'generate') === ASSISTANT_SOURCE)
      .sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return at - bt
      })
    const mapped = []
    for (const record of filtered) {
      mapped.push(...mapRecordToMessages(record))
    }
    messages.value = mapped
    hasMessages.value = mapped.length > 0
    scrollToBottom()
  } catch (err) {
    console.error('[RightPanel] loadSessionHistory failed', err)
  }
}

const triggerUpload = () => {
  fileInputRef.value?.click()
}

const handleFileChange = (e) => {
  const files = e.target.files
  if (!files) return

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (event) => {
        uploadedImages.value.push({
          id: Date.now() + Math.random(),
          src: event.target.result,
          name: file.name
        })
      }
      reader.readAsDataURL(file)
    }
  }
  // 清空input以便重复选择同一文件
  e.target.value = ''
}

const removeUploadedImage = (id) => {
  uploadedImages.value = uploadedImages.value.filter(img => img.id !== id)
}

// 图片预览
const previewImage = ref(null)
const openPreview = (src) => {
  previewImage.value = src
}
const closePreview = () => {
  previewImage.value = null
}

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// 把 messages 数组里的最后一项以响应式代理形式取回，便于后续 mutation 触发 UI 更新
const tailMessage = () => messages.value[messages.value.length - 1]

/**
 * 当前正在流式的那条 Agent 消息。
 *
 * 不能再用「数组最后一项」：一轮进行中用户可以插话，插话气泡会追加在流式气泡**之后**，
 * 那时最后一项是用户消息。若仍按 tail 找，工具步骤/进行中标签就会挂到用户气泡上（静默不显示）。
 */
const activeAgentMessage = () => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const msg = messages.value[index]
    if (msg.type === 'ai-text' && msg.loading) return msg
  }
  return null
}

const handleAddImageToCanvas = (url) => {
  if (!url) return
  emit('add-image-to-canvas', { url })
}

// 参考图格式校验统一放在 config/reference-validation.ts ——
// 这里原来另写了一份，且和 ImageNode 那份行为不一致（漏了 SVG 的 data URL）
// 调用图片生成 API（写入到指定 aiMsg.images）
// 调用流式对话 API（走 createGenerationTask({ type:'agent' }) + SSE 订阅，后端持久化 record，刷新可恢复）

/**
 * 把面板里已有的历史拼成上游的 messages 数组。
 *
 * 原来这里写死 `messages: [{ role:'user', content: prompt }]` —— 只发当前这一句，
 * 于是**面板上有历史、模型侧完全没有记忆**（用户原话"完全没有上下文记忆"）。
 * 真正的拼装逻辑在 `composables/assistant-chat-history.ts`（纯函数 + 单测）：
 * 这类 bug 不报错、不改变返回值的形状，模型照样答得通，只不上文，
 * 靠 typecheck / 构建 / e2e 一个都抓不住，所以必须有单元测试钉着。
 */
const buildChatMessages = (prompt) => buildAssistantChatMessages(messages.value, prompt, props.canvasBrief)

/**
 * 面板模式开关（2026-09-23 重写）。
 *
 * 原来切「Agent 模式」要靠 ContentGenerator 顶部那个可拖拽的类型选择器 —— 用户反馈
 * 「有个拖拉件，不好找」。这里改成两个常驻按钮，并且**用 hideTypeSelector 把原来那个藏掉**，
 * 不再有两套入口互相打架。默认落在「对话」，因为画布上最常用的就是让 Agent 动手。
 */
/**
 * 面板只有一种身份：**Agent**。
 *
 * 这里原来有个「对话（Agent） / 图片生成」模式开关 —— 用户看到后直接问「为什么会有两个选项」。
 * 他说得对：这个面板的定位就是「派活给 Agent，由它调工具进生产」，图片生成是 Agent 的一个动作，
 * 不该是平级的第二个模式。而且那个开关放在文档流里，被绝对定位的输入区盖住了半截。
 * 所以开关整个去掉，面板只做 Agent 一件事（附件参考图那条路仍然直达图片生成，见 sendMessage）。
 */

/**
 * 面板里的「Agent 模式」现在跑的是**服务端制片 Agent**（M2 起）。
 *
 * 为什么不再在浏览器里跑模型循环：画布 Agent 要干的活已经从「加几个节点」变成
 * 「从剧本到分镜图/视频的一整条链路」—— 那是一条几分钟到几十分钟的长任务，
 * 中间要花钱、要留痕、要能在刷新后继续。浏览器一侧做不了这些：
 * 一关页面循环就没了，调用记录也没有地方落。所以决策放服务端，这里只做两件事：
 *   1. 把服务端要的画布操作真的执行掉（就是下面这个桥）；
 *   2. 把「要不要花这笔钱」的确认卡片弹给用户。
 */
const { isPanelCollapsed } = useChatSessions()
/**
 * Agent 用哪个对话模型 —— 用户自己选。
 *
 * 复用的是全站同一个「Agent 模型」偏好（api/agent 的 getAgentModel/setAgentModel，存 localStorage）：
 * 首页那个 Agent 工具栏改的就是它。两处共用一份，用户不必在两个地方各选一次。
 *
 * 关于「权限」：这份清单来自**服务端公开目录**（/api/provider-config/catalog），
 * 只返回启用中的厂商与模型。以后要按会员等级/角色限制某些模型，在服务端目录那一层过滤即可，
 * 这里不需要改 —— 目录里没有的模型，选择器里自然也不会出现。
 */
const chatModelOptions = ref([])
const selectedModelKey = ref('')
const modelSelectOpen = ref(false)
const modelTriggerRef = ref(null)

const selectedModelLabel = computed(() => (
  chatModelOptions.value.find((item) => item.value === selectedModelKey.value)?.label
  || selectedModelKey.value
  || '对话模型'
))

const refreshChatModels = async () => {
  await loadPublicModelCatalog()
  let list = getAllChatModels().map((item) => ({ value: item.key, label: item.label }))
  if (!list.length) {
    // 目录可能是空缓存（后台刚改过配置），强制刷一次再取
    await loadPublicModelCatalog(true)
    list = getAllChatModels().map((item) => ({ value: item.key, label: item.label }))
  }
  chatModelOptions.value = list
  const preferred = String(getAgentModel() || '').trim()
  // 原选模型已下架时回落到目录默认模型，并明确提示用户（不静默换、也不让这一轮直接失败）；
  // 同时把全站那份偏好收敛过去，否则每开一次面板都会再提示一次。
  const reconciled = reconcileModelSelection(preferred, 'CHAT')
  const next = reconciled.key || list[0]?.value || ''
  selectedModelKey.value = next
  if (reconciled.fellBack) {
    notifyModelSelectionFallback(preferred, resolveModelLabel(next, 'CHAT'))
    setAgentModel(next)
  }
}

const pickChatModel = (key) => {
  selectedModelKey.value = key
  setAgentModel(key)
  modelSelectOpen.value = false
}

const toggleChatModelSelect = (event) => {
  event.stopPropagation()
  modelSelectOpen.value = !modelSelectOpen.value
}

const turnReferenceImages = ref([])       // 本轮用户附的参考图（Agent 挂图时从这里取）
/**
 * 一轮内插话（steer / follow-up）。
 *
 * 运行中用户还能发消息 —— 但那条路走 `/steer` 投递给**正在跑的那个任务**（`activeAgentTaskId`），
 * 绝不 `createGenerationTask`（否则就是两个任务抢同一把画布锁）。`interjectionMode` 是用户选的
 * 「插入当前轮 / 排队」。见 agent-send-routing 的路由判定与单测。
 */
const activeAgentTaskId = ref('')         // 正在跑的 Agent 任务 id（投递插话用；空闲为空串）
const interjectionMode = ref('steer')     // steer | follow-up
const interjectionNotice = ref('')        // 插话结果提示（成功/失败都如实说）
const confirmRequest = ref(null)          // { title, summary, items, nodeIds, riskLevel, resolve }
const confirmNote = ref('')
const confirmRemembered = ref(false)      // 用户勾了「本任务内不再问同类动作」
// 确认卡的积分显示：只认服务端（预校验缓存下来的估算 + 余额）；拿不到就降级成预扣说明，绝不用模型自报的数
const confirmCostDisplay = ref(null)

/**
 * 取「预校验已经算过的服务端数字」填确认卡。
 *
 * 数字只认服务端：`preflight_check` 已把这一批的总额与余额缓存下来（键 = 目标节点集合），
 * 这里按本次确认的目标节点集合**精确匹配**取用 —— 集合不完全一致（多一个/少一个）、
 * 没预校验过、或缓存过期，一律降级成预扣说明，绝不用模型自报或前端手算的数字充数。
 *
 * 刻意**不再**在此重打一次估算接口：那条路径与预校验重复，且常因拿不到整批（204）而降级，
 * 正是「卡片动辄只显示通用文案」的来源。缓存命中即用，不命中即降级 —— 宁可不说数字，也不说错的。
 */
const loadConfirmCostDisplay = (request) => {
  const snapshot = typeof props.agentContext?.snapshotNodes === 'function'
    ? props.agentContext.snapshotNodes()
    : []
  const nodes = Array.isArray(snapshot) ? snapshot : []
  const nodeIds = collectConfirmationNodeIds({
    nodeIds: request?.nodeIds,
    items: request?.items,
    knownNodeIds: nodes.map((node) => node?.id),
  })
  confirmCostDisplay.value = resolveAgentConfirmCostDisplayFromCache({ nodeIds })
}

/** 服务端 Agent 通过桥要确认时调用；返回的 Promise 一直挂到用户点按钮 */
const requestConfirmation = (request) =>
  new Promise((resolve) => {
    /**
     * 先把面板弹出来。
     *
     * 面板块的折叠状态默认是「收起」，而 Agent 现在正卡在这一步等服务端的答复 ——
     * 卡片被藏在屏幕外，用户只会看到画布一动不动，然后十分钟后收到「没等到答复」。
     * 闸门必须让人看得见，否则它就不是闸门，是个坑。
     */
    isPanelCollapsed.value = false
    // 上一次的卡片还没答复就再来一张：先把上一张按「拒绝」结掉，避免谁也答不了
    confirmRequest.value?.resolve?.({ approved: false, note: '用户未答复，已跳过' })
    confirmNote.value = ''
    const card = { ...request, resolve }
    confirmRequest.value = card
    confirmCostDisplay.value = null
    loadConfirmCostDisplay(request)
    scrollToBottom()
  })

const settleConfirm = (approved) => {
  const pending = confirmRequest.value
  if (!pending) return
  confirmRequest.value = null
  pending.resolve({
    approved,
    note: String(confirmNote.value || '').trim(),
    remember: Boolean(confirmRemembered.value),
  })
  confirmNote.value = ''
  confirmRemembered.value = false
}

const askUserRequest = ref(null)     // { context, questions, resolve }
const askUserAnswers = ref([])       // 与问题一一对应：{ optionKey, text } —— 点选项选中并高亮，也可自由输入

/** 点选一个方案：记住代号（回执据此带出代号+名称+特点），并清掉自由输入，避免两者打架 */
const selectAskUserOption = (index, optionKey) => {
  const entry = askUserAnswers.value[index]
  if (!entry) return
  entry.optionKey = optionKey
  entry.text = ''
}

/** 一旦开始自由输入（「都不满意，我来说」），就取消已选方案 */
const clearAskUserOption = (index) => {
  const entry = askUserAnswers.value[index]
  if (entry) entry.optionKey = ''
}

/**
 * 服务端 Agent 通过桥要提问时调用；返回的 Promise 一直挂到用户提交或跳过。
 *
 * 提问是「关键信息不足 / 需要拍板」时的补救 —— 它和确认卡一样是阻塞式的（同一轮里等答复），
 * 所以卡片必须让人看得见：面板收起时它在屏幕外，用户只会看到画布一动不动，然后十分钟后收到超时。
 * 上一次的提问卡还没答复就再来一张时，先把上一张按「未回答」结掉，避免谁也答不了。
 *
 * 批次 2：选项已由工具层归一成「代号 + 名称 + 特点」的对象，这里只负责呈现与收集作答。
 */
const askUser = (request) =>
  new Promise((resolve) => {
    isPanelCollapsed.value = false
    askUserRequest.value?.resolve?.({ answers: [], skipped: true })
    const questions = Array.isArray(request?.questions) ? request.questions.slice(0, 3) : []
    askUserAnswers.value = questions.map(() => ({ optionKey: '', text: '' }))
    askUserRequest.value = { context: request?.context, questions, resolve }
    scrollToBottom()
  })

const settleAskUser = (answers, skipped = false) => {
  const pending = askUserRequest.value
  if (!pending) return
  askUserRequest.value = null
  // 只回「点选的代号 / 自由输入」，代号 → 代号+名称+特点的拼装由工具层统一做（回执真源在 shared）
  const payload = (pending.questions || []).map((item, index) => {
    const entry = (answers || [])[index] || {}
    return {
      optionKey: String(entry.optionKey || '').trim(),
      text: String(entry.text || '').trim(),
    }
  })
  pending.resolve(skipped ? { answers: [], skipped: true } : { answers: payload })
  askUserAnswers.value = []
}

// 工具轨迹的展示字段（耗时 / 执行中）只活在前端内存里：
// step 的形状一个字不改 —— pending 只用来标「哪条细条正在跑」，stepTimes 只用来算耗时。
const pendingToolCallIds = new Set()
const resetToolTrace = () => { pendingToolCallIds.clear() }

const agentBridge = useCanvasAgentBridge({
  // 把「确认」这项能力叠在页面注入的画布操作之上：画布上下文由 workflow 页提供，
  // 而确认卡片属于这个面板的 UI，两者在这里合体。
  getContext: () => (props.agentContext
    ? {
        ...props.agentContext,
        requestConfirmation,
        askUser,
        // 参考图只有面板知道（用户是在这里上传的），节点操作只有画布页知道，
        // 两边各出一半，工具层在中间把它们拼起来
        referenceImages: () => turnReferenceImages.value,
      }
    : null),
  onStep: (step) => {
    const target = activeAgentMessage()
    if (!target) return
    target.steps = [...(target.steps || []), step]
    const now = Date.now()
    if (!target.turnStartedAt) target.turnStartedAt = now
    target.stepTimes = [...(target.stepTimes || []), now]
    target.pendingLabel = ''
    scrollToBottom()
  },
})

/**
 * 跑一轮服务端制片 Agent。
 *
 * 与浏览器侧循环的关键差别：**这里不再有「模型这一步调了什么工具」的判断逻辑** ——
 * 模型、工具、步数上限、花钱闸门全在服务端，前端只做三件事：
 *   把流式文字贴到气泡上、把服务端下发的工具调用执行掉、把终态收口好。
 * 这样刷新页面、换设备看到的都是同一个任务的同一条事件流。
 *
 * 返回 true 表示这一轮已经交给服务端处理（不管成没成），调用方不要再回退到普通对话 ——
 * 回退用的是同一个模型，只会把同一句错误再报一遍。
 */
const runCanvasAgentTurn = async (prompt, aiMsg, referenceImages = []) => {
  /**
   * 本轮的订阅控制器提到 try 外面，好让 finally 一定能把它 abort 掉。
   *
   * 服务端不会在任务终态时结束 SSE，不主动关就留下一条长连接一直占着「用户级实时订阅」额度
   * （每轮一条，攒到 20 就全线 429，「订阅任务状态失败 (429)」就是这么冒出来的）。
   */
  let streamController = null
  try {
    // 用用户在面板上选的那个模型（没选过就是全站默认），不再写死「默认对话模型」
    const preferredKey = String(selectedModelKey.value || getAgentModel() || getDefaultChatModelKey() || '').trim()
    const { providerId, modelKey } = await resolveGenerationTaskModel({
      modelKey: preferredKey,
      fallbackModelKey: getDefaultChatModelKey() || preferredKey,
      category: 'CHAT',
      missingModelMessage: '未匹配到有效对话模型，请先在后台配置模型',
    })

    // 占住画布：这一轮里只有我们自己（带 token）的保存能写进去，外部改动会被 409 拦下
    const lockResult = await props.agentContext?.beginPipelineRun?.('制片 Agent 本轮')
    if (lockResult && !lockResult.ok && lockResult.reason !== 'no_workflow') {
      if (lockResult.reason === 'locked') {
        /**
         * 画布被占用**不该是死胡同**：任务早跑完但锁没被正常放掉时，用户会被自己的锁挡住。
         * 记下这一轮的输入并给出「强制释放并重试」入口 —— 服务端只放同一用户持有的锁。
         */
        aiMsg.error = lockResult.message || '这块画布正在被另一个流水线执行占用；如确认没有 Agent 在跑，可点下方按钮强制释放并重试。'
        aiMsg.lockConflict = true
        aiMsg.retryPrompt = prompt
        aiMsg.retryRefImages = Array.isArray(referenceImages) ? [...referenceImages] : []
      } else {
        // 取锁失败（网络/鉴权等）：不带着「无锁」状态跑 Agent，如实报错让用户重试
        aiMsg.error = lockResult.message || '取画布锁失败，请稍后重试'
      }
      aiMsg.loading = false
      return true
    }

    agentBridge.reset()
    resetToolTrace()
    // 这一轮的参考图存下来：Agent 调 attach_reference_images 时由桥从这里取
    turnReferenceImages.value = Array.isArray(referenceImages) ? [...referenceImages] : []
    aiMsg.content = ''
    aiMsg.steps = []
    // 展示字段（细条耗时 / 执行中提示）：不写回 step 的数据形状，只挂在这条消息上
    aiMsg.turnStartedAt = Date.now()
    aiMsg.stepTimes = []
    aiMsg.pendingLabel = ''

    const saved = await createGenerationTask({
      source: ASSISTANT_SOURCE,
      sessionId: activeSessionId.value || undefined,
      type: 'agent',
      // 这个 skill 键决定服务端走「制片 Agent」策略（而不是普通对话）
      skill: CANVAS_AGENT_SKILL_KEY,
      prompt,
      modelKey,
      requestBody: {
        model: modelKey,
        providerId,
        // 画布现状：Agent 看不见画布，全靠这段摘要
        canvasBrief: props.canvasBrief || '',
        // 画布名（= 面板标题）：控制台顶部的「项目名」用它，服务端直接透传、不做推断
        canvasName: props.title || '',
        // 本轮附的参考图：服务端会告诉 Agent「用户附了 N 张图」，
        // 它再决定要不要用 attach_reference_images 挂到某个节点上
        referenceImages: turnReferenceImages.value,
        /**
         * 最近几轮对话：只在服务端**没有**可恢复的 Pi 转录时当兜底用（首次 / 旧数据 / 恢复失败）。
         *
         * 这里不再 `.slice(-6)`：条数由服务端的字符预算说了算 —— 固定 6 条会把长任务的上下文
         * 砍到几乎没有（一次 get_canvas_state 的返回就能顶掉好几条）。正常路径下服务端会恢复
         * 上一轮的完整转录，这个 history 根本不会用到。
         */
        history: (messages.value || [])
          .filter((item) => (item.type === 'user' || item.type === 'ai-text') && String(item.content || '').trim())
          .map((item) => ({
            role: item.type === 'user' ? 'user' : 'assistant',
            content: String(item.content || ''),
          })),
        /**
         * 这一轮占住的画布锁（workflowId + token）。
         *
         * 服务端建单时把它绑定到任务上，任务到达任何终态都由服务端释放 —— 锁不该比任务活得久。
         * 客户端 endPipelineRun 仍保留（正常路径及时释放），但不再是唯一出路。
         */
        pipelineLock: lockResult?.ok && lockResult.workflowId && lockResult.pipelineToken
          ? { workflowId: lockResult.workflowId, token: lockResult.pipelineToken }
          : undefined,
      },
    })

    touchActiveSession()

    const taskId = String(saved?.id || '').trim()
    if (!taskId) throw new Error('Agent 任务创建失败')
    // 记下这一轮的 taskId：运行中插话要走 /steer 投递给它（不建新任务）
    activeAgentTaskId.value = taskId

    const controller = new AbortController()
    streamController = controller
    registerStream(controller)

    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: (event) => {
        // 展示层先记一笔「哪一步正在跑」：桥只在执行完才回调 onStep，
        // 没有这一笔，进行中的细条就没有名字可显示。执行与回执仍归桥管。
        if (event.type === 'tool_call' && event.agentToolCall) {
          const call = event.agentToolCall
          const callId = String(call.callId || '')
          const target = activeAgentMessage()
          if (target && callId && !pendingToolCallIds.has(callId)) {
            pendingToolCallIds.add(callId)
            target.pendingLabel = call.label || call.name || '执行中'
            if (!target.turnStartedAt) target.turnStartedAt = Date.now()
            scrollToBottom()
          }
        }
        // 导演控制台状态：单独一条 UI 事件，**不并入消息正文**（不碰 aiMsg.content、
        // 不进 Markdown、也不回喂模型）——只更新顶部控制台
        if (event.type === 'console_state') {
          if (event.consoleState) consoleState.value = event.consoleState
          return
        }
        // 服务端要它执行一个画布操作：交给桥（内部会执行 + 回执）
        if (agentBridge.handleStreamEvent(taskId, event, controller.signal)) {
          return
        }
        if (event.type === 'content_delta') {
          if (typeof event.delta === 'string' && event.delta) {
            aiMsg.content += event.delta
          } else if (typeof event.content === 'string') {
            aiMsg.content = event.content
          }
          scrollToBottom()
          return
        }
        if (event.type === 'thinking_delta') {
          aiMsg.thinking = String(event.thinkingContent || '')
          return
        }
        if (event.type === 'snapshot') {
          const snapshotContent = String(event.record?.content || '')
          if (snapshotContent && snapshotContent.length > aiMsg.content.length) {
            aiMsg.content = snapshotContent
          }
          return
        }
        if (event.type === 'completed') {
          const finalContent = String(event.record?.content || '')
          if (finalContent) aiMsg.content = finalContent
          aiMsg.loading = false
          scrollToBottom()
          return
        }
        if (event.type === 'failed') {
          aiMsg.error = String(event.message || event.record?.error || 'Agent 执行失败')
          aiMsg.loading = false
          scrollToBottom()
          return
        }
        if (event.type === 'stopped') {
          aiMsg.error = aiMsg.error || '任务已停止'
          aiMsg.loading = false
        }
      },
    })
    return true
  } catch (err) {
    if (err?.name === 'AbortError') return true
    console.error('[RightPanel] canvas agent failed', err)
    aiMsg.error = `Agent 调用失败：${err?.message || err}`
    aiMsg.loading = false
    scrollToBottom()
    return true
  } finally {
    // 这一轮无论怎么结束，「执行中…」都不能留在界面上
    aiMsg.pendingLabel = ''
    // 插话窗口关闭：任务终态后再投递会失败，前端据此如实提示（不假装送达）
    activeAgentTaskId.value = ''
    // 回合结束：收掉所有「生成中」高亮（它没有 TTL，只能在这里/节点终态清），
    // 「刚创建」交给它自己的 4 秒 TTL 渐隐，不必提前掐断。
    clearAgentGeneratingNodes()
    // 任务结束后还有卡片挂着（用户没答复就断了），按未答复收掉，别让它一直占着位置
    if (confirmRequest.value) settleConfirm(false)
    if (askUserRequest.value) settleAskUser([], true)
    // 主动关掉本轮的事件流：正常终止订阅本身会返回，但异常/提前返回时不能把连接留在服务端
    try { streamController?.abort() } catch { /* 已结束 */ }
    // 释放画布锁（成功/失败都要放，否则用户会被自己的锁挡在外面）
    await props.agentContext?.endPipelineRun?.()
  }
}

// 发送消息：面板只有一条路 —— 交给 Agent
const runningAgent = computed(() => messages.value.some((msg) => msg.type === 'ai-text' && msg.loading))

/**
 * AI CREW（批次 4，预览）：只有 Director 是真的在干活（就是本画布 Agent），其余是占位。
 * 状态词随本轮是否真的在跑切换，不给未接入角色编任何状态。
 */
const crewMembers = computed(() => buildCanvasAgentCrew(runningAgent.value))

/**
 * 强制释放画布锁，然后重试这一轮。
 *
 * 用在 beginPipelineRun 返回 locked 时：用户看到可操作的按钮，而不是干等 TTL。
 * 服务端只放同一用户持有的锁，因此不会误伤别人的并发保护。
 */
const forceUnlockAndRetry = async (aiMsg) => {
  if (!aiMsg || aiMsg.forceUnlocking) return
  aiMsg.forceUnlocking = true
  try {
    const result = await props.agentContext?.forceReleasePipelineRun?.()
    if (!result?.ok) {
      aiMsg.error = result?.message || '强制释放失败，请稍后再试'
      return
    }
    aiMsg.error = ''
    aiMsg.lockConflict = false
    // 重新起一轮：锁已释放，同样的输入直接再来一次
    if (aiMsg.retryPrompt) {
      aiMsg.loading = true
      scrollToBottom()
      await runCanvasAgentTurn(aiMsg.retryPrompt, aiMsg, aiMsg.retryRefImages || [])
    }
  } finally {
    aiMsg.forceUnlocking = false
  }
}

/**
 * 一轮进行中插话：投递给正在跑的那个任务（steer / follow-up），**不建新任务**。
 *
 * 与 sendMessage 的新建分支互斥（由 resolveAgentSendRoute 判定）：运行中永远走这里，
 * 因此不会再 `createGenerationTask` —— 也就不会出现两个任务抢同一把画布锁。
 *
 * 为什么不能附参考图：参考图是**建任务时**带给服务端的（requestBody.referenceImages），
 * 中途投递没有携带位。与其静默丢掉用户的图，不如如实说清「这一轮不行，等它跑完再发」。
 */
const sendAgentInterjection = async (content, refImages, mode, { onAccepted } = {}) => {
  const text = String(content || '').trim()
  interjectionNotice.value = ''
  if (refImages.length) {
    interjectionNotice.value = '一轮进行中暂不支持附参考图：请等这一轮结束后再发。'
    return false
  }
  if (!text) return false

  const taskId = String(activeAgentTaskId.value || '').trim()
  if (!taskId) {
    // 界面以为在跑、但本轮 taskId 已清（极少见的竞态）：绝不冒然新建任务，如实提示重发
    interjectionNotice.value = '这一轮 Agent 已经结束，请重新发送。'
    return false
  }

  const normalizedMode = normalizeAgentInterjectionMode(mode)
  try {
    const result = await steerGenerationTask(taskId, { content: text, mode: normalizedMode })
    if (!result?.accepted) {
      interjectionNotice.value = result?.reason || '插话没有送达（这一轮可能刚好结束），请重新发送。'
      return false
    }
  } catch (err) {
    interjectionNotice.value = `插话失败：${err?.message || err}`
    return false
  }

  // 转录留痕：插话作为一条用户消息落进面板消息流；服务端同一份也会进 Pi 转录（参与记忆/压缩）
  const id = Date.now()
  messages.value.push({
    id,
    type: 'user-interjection',
    content: text,
    mode: normalizedMode,
    time: id,
  })
  inputMessage.value = ''
  scrollToBottom()
  if (typeof onAccepted === 'function') onAccepted()
  interjectionNotice.value = describeAgentInterjectionNotice(normalizedMode)
  return true
}

/**
 * 发送消息：面板唯一的发送实现。
 *
 * 输入框回车/按钮、画布右键的「交给 Agent」、首页带来的自动发送，全都走这一条 ——
 * 不另写发送逻辑，否则「从这儿问」和「自动发」会得到两种不同的能力。
 *
 * `explicitMessage`：外部代发的文本（首页那句话 / 画布触发的消息）；不传就用输入框里的内容。
 * `onAccepted`：用户消息已经落到对话里时回调（画布触发入口靠它清掉待发状态，时机与以前一致，
 * 不必等整轮 Agent 跑完）。
 *
 * 运行中则分流到「插话」（见 sendAgentInterjection），不新建任务。
 */
const sendMessage = async (explicitMessage, { onAccepted } = {}) => {
  const content = (typeof explicitMessage === 'string' ? explicitMessage : inputMessage.value).trim()
  const refImages = uploadedImages.value.map((img) => img.src)

  if (!content && !refImages.length) return false

  const route = resolveAgentSendRoute({ running: runningAgent.value, mode: interjectionMode.value })
  if (route.kind === 'interject') {
    return await sendAgentInterjection(content, refImages, route.mode, { onAccepted })
  }

  interjectionNotice.value = ''

  // 确保有活跃会话（首次发送会自动定位到默认会话）
  try {
    await ensureSession()
  } catch (err) {
    console.error('[RightPanel] ensureSession failed', err)
    return false
  }

  hasMessages.value = true

  const userId = Date.now()
  messages.value.push(
    refImages.length
      ? { id: userId, type: 'user-with-ref', referenceImages: refImages, content: content || '（附了参考图）', time: userId }
      : { id: userId, type: 'user', content, time: userId },
  )

  // 清空输入；参考图交给这一轮的 Agent（挂到节点上是它的活），不再由面板直接拿去生成
  inputMessage.value = ''
  uploadedImages.value = []
  scrollToBottom()
  if (typeof onAccepted === 'function') onAccepted()

  messages.value.push({
    id: userId + 1,
    type: 'ai-text',
    content: '',
    loading: true,
    error: '',
    time: userId + 1,
  })
  scrollToBottom()

  await runCanvasAgentTurn(content || '我上传了参考图，帮我把它用起来', tailMessage(), refImages)
  return true
}

// 回车发送
const handleKeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendMessage()
  }
}

/** 切换插话方式：插入当前轮 ⇄ 排队（只在运行中有意义，空闲时不影响发送） */
const toggleInterjectionMode = () => {
  interjectionMode.value = interjectionMode.value === 'follow-up' ? 'steer' : 'follow-up'
}

// 监听从中间底部传来的消息（画布触发的入口）：走同一个发送实现
watch(() => props.initialMessage, async (newMessage) => {
  if (!newMessage || !newMessage.trim()) return

  // 画布触发的入口也走同一个 Agent：面板只有一条对话链路，
  // 免得「从这儿问」和「在输入框问」得到两种不同的能力（一个能动画布、一个只会聊天）。
  await sendMessage(newMessage, {
    onAccepted: () => emit('message-received'),
  })
})

/**
 * 首页带来的「自动交给 Agent」。
 *
 * 首页说一句话会先建好一张画布、写下一枚一次性标记，再跳进来；这里在**画布与会话都就绪**后
 * 把标记消费掉并走既有的发送路径（sendMessage）—— 用户不用再点一次「交给 Agent」。
 *
 * 三条硬约束：
 *   · 先清标记再发送：HMR / 重复挂载 / 刷新都不会二次触发（标记已不在，读出来就是 null）；
 *   · 有锁不发：画布被别的流水线占用时只把话填进输入框并提示，绝不绕过锁；
 *   · 只走既有发送路径：不在这里另写一套发送逻辑。
 */
const autoSendState = ref('idle')      // idle | sent | filled，非 idle 即本次挂载已处理过
const autoSendNotice = ref('')
let autoSendInFlight = false

const prefillComposer = (message) => {
  inputMessage.value = message
  nextTick(() => composerInputRef.value?.focus())
}

/** 只读探测画布锁；拿不到（没注入/请求失败）就按未占用处理，真正的保护仍在 beginPipelineRun */
const probeCanvasLock = async () => {
  const checker = props.agentContext?.checkPipelineLock
  if (typeof checker !== 'function') return false
  try {
    return Boolean(await checker())
  } catch (err) {
    console.warn('[RightPanel] 查询画布锁失败，按未占用处理', err)
    return false
  }
}

const maybeAutoSendToAgent = async () => {
  if (autoSendInFlight || autoSendState.value !== 'idle') return

  const canvasId = String(props.canvasId || '').trim()
  // 未就绪（画布没载入 / 加载中 / 会话没绑好 / 正在跑）：先等，状态一变会再进来
  if (!canvasId || !props.canvasReady) return
  if (canvasSessionReadyFor.value !== canvasId) return
  if (runningAgent.value) return

  // 只读探测：没有属于这张画布的标记就什么都不做（重复挂载/刷新都会停在这里）
  const pending = readHomeCanvasAgentPending(canvasId)
  if (!pending) return

  autoSendInFlight = true
  try {
    const locked = await probeCanvasLock()
    const state = {
      hasFlag: true,
      canvasReady: true,
      running: runningAgent.value,
      locked,
      consumed: autoSendState.value !== 'idle',
    }

    if (shouldAutoSendToAgent(state)) {
      // 先清标记再发送：consume 是**唯一**的准入判据 —— 谁先清掉谁发送，
      // 这一步之后任何重复挂载/刷新/HMR 都读不到标记，天然幂等。
      const consumed = consumeHomeCanvasAgentPending(canvasId)
      if (!consumed) return
      autoSendState.value = 'sent'
      const accepted = await sendMessage(consumed.message)
      if (!accepted) {
        // 发送路径没接受（会话没建起来等）：退回输入框，别让这句话凭空消失
        autoSendState.value = 'filled'
        prefillComposer(consumed.message)
        autoSendNotice.value = '自动交给 Agent 失败，已把这句话放回输入框，可手动发送。'
      }
      return
    }

    if (resolveAutoSendBlockReason(state) === 'occupied') {
      // 画布被占用：也消费标记（否则重复挂载会反复覆盖输入框），只落地输入框，绝不绕过锁
      const consumed = consumeHomeCanvasAgentPending(canvasId)
      if (!consumed) return
      autoSendState.value = 'filled'
      prefillComposer(consumed.message)
      autoSendNotice.value = '这块画布正被另一个流水线占用，已把这句话放进输入框；等它结束后再点「交给 Agent」。'
    }
  } finally {
    autoSendInFlight = false
  }
}

watch(
  () => [props.canvasReady, props.canvasId, canvasSessionReadyFor.value, runningAgent.value],
  () => { void maybeAutoSendToAgent() },
)

// 计算内容生成器高度（用于任务指示器定位）
const contentGeneratorHeight = computed(() => hasMessages.value ? 102 : 102)
</script>

<template>
  <div class="agent-X3m2wp">
    <div class="chat-container">
      <!-- 头部 -->
      <div class="chat-header">
        <div
          ref="sessionListAnchor"
          class="trigger-container"
          tabindex="0"
          role="button"
          @click="openSessionList"
        >
          <!-- 面板的身份：这里就是 Agent，它靠调工具干活（原来这个信息靠底部的模式开关传达，
               而那个开关会被输入区盖住、还容易让人以为「图片生成」是另一条独立的路） -->
          <span class="right-panel-agent-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3.4l1.6 4.6 4.6 1.6-4.6 1.6L12 15.8l-1.6-4.6L5.8 9.6l4.6-1.6L12 3.4z"
                fill="currentColor"
              />
            </svg>
            Agent 创作
          </span>
          <div class="lv-typography title-vBcivv">{{ headerTitleText }}</div>
          <div class="arrow-icon-uG49Bu">
            <svg width="14" height="14" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" role="presentation" xmlns="http://www.w3.org/2000/svg">
              <g>
                <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M21.01 7.982A1.2 1.2 0 0 1 21 9.679l-8.156 8.06a1.2 1.2 0 0 1-1.688 0L3 9.68a1.2 1.2 0 0 1 1.687-1.707L12 15.199l7.313-7.227a1.2 1.2 0 0 1 1.697.01Z" fill="currentColor"></path>
              </g>
            </svg>
          </div>
        </div>
        <div class="actions-bl5UWA">
          <!-- 筛选按钮 -->
<!--          <div class="filter-button">
            <svg width="16" height="16" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" role="presentation" xmlns="http://www.w3.org/2000/svg" class="filter-icon">
              <g>
                <path data-follow-fill="currentColor" d="M4.927 2.86a2 2 0 0 0-2 2v1.672a3 3 0 0 0 .879 2.121l2.828 2.829a1 1 0 0 1 .293.707v4.605a2 2 0 0 0 .971 1.715l3.757 2.254a1.5 1.5 0 0 0 2.272-1.286V12.19a1 1 0 0 1 .293-.707l2.828-2.829a3 3 0 0 0 .88-2.121V4.86a2 2 0 0 0-2-2h-11Zm0 2h11v1.672a1 1 0 0 1-.293.707l-2.828 2.828a3 3 0 0 0-.879 2.122v6.405l-3-1.8v-4.605a3 3 0 0 0-.879-2.122L5.22 7.24a1 1 0 0 1-.293-.707V4.86Zm11 8.14a1 1 0 0 1 1-1h5a1 1 0 1 1 0 2h-5a1 1 0 0 1-1-1Zm0 4a1 1 0 0 1 1-1h3a1 1 0 1 1 0 2h-3a1 1 0 0 1-1-1Z" clip-rule="evenodd" fill-rule="evenodd" fill="currentColor"></path>
              </g>
            </svg>
          </div>-->
          <!-- 新建对话按钮 -->
          <div class="operation-button-bwA7yT" title="新建对话" @click="handleSessionCreate">
            <svg width="16" height="16" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" role="presentation" xmlns="http://www.w3.org/2000/svg">
              <g>
                <path data-follow-fill="currentColor" d="M17.5 2.5A4.5 4.5 0 0 1 22 6.998l.004 7.5a4.5 4.5 0 0 1-4.5 4.503h-5.027a1 1 0 0 0-.542.16l-4.15 2.68A1 1 0 0 1 6.241 21v-2.009a4.5 4.5 0 0 1-4.238-4.49L2 7.003A4.5 4.5 0 0 1 6.5 2.5h11Zm-11 2A2.5 2.5 0 0 0 4 7.001l.004 7.501a2.5 2.5 0 0 0 2.5 2.499h.738a1 1 0 0 1 1 1v1.163l2.609-1.684a2.999 2.999 0 0 1 1.626-.479h5.027a2.5 2.5 0 0 0 2.5-2.502L20 6.999A2.5 2.5 0 0 0 17.5 4.5h-11ZM12 7.2a1 1 0 0 1 1 1v1.5h1.5a1 1 0 1 1 0 2H13v1.5a1 1 0 1 1-2 0v-1.5H9.5a1 1 0 1 1 0-2H11V8.2a1 1 0 0 1 1-1Z" fill="currentColor"></path>
              </g>
            </svg>
          </div>
          <!-- 关闭面板按钮 -->
          <div class="operation-button-bwA7yT" @click="emit('close')">
            <svg width="16" height="16" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" role="presentation" xmlns="http://www.w3.org/2000/svg">
              <g>
                <path data-follow-fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M7 12a1 1 0 0 1 1-1h10.312L14.29 6.977a1 1 0 0 1 1.414-1.414l5.728 5.73a1 1 0 0 1 0 1.414l-5.728 5.73a1 1 0 1 1-1.414-1.414L18.31 13H8a1 1 0 0 1-1-1Zm-2.998 9a1 1 0 0 1-1-1L3 4a1 1 0 1 1 2 0l.002 16a1 1 0 0 1-1 1Z" fill="currentColor"></path>
              </g>
            </svg>
          </div>
        </div>
      </div>

      <!-- 会话列表浮层 -->
      <AssistantSessionList
        :visible="sessionListVisible"
        :sessions="assistantSessions"
        :active-id="activeSessionId"
        :anchor="sessionListAnchor"
        @close="closeSessionList"
        @create="handleSessionCreate"
        @select="handleSessionSelect"
        @rename="handleSessionRename"
        @delete="handleSessionDelete"
      />

      <!-- 隐藏的文件上传输入框 -->
      <input type="file" multiple accept="image/*" class="hidden-file-input" ref="fileInputRef" @change="handleFileChange">

      <!--
        导演控制台（AI Director Console）。
        内容全部来自服务端的 console_state 事件（由真实事件推导）；有会话/有任务且收到过状态才出现，
        空态保持下面的引导 + 示例 chip 不变。它只读，不参与消息流与 Markdown 渲染。
      -->
      <div v-if="hasMessages && consoleState" class="agent-console">
        <!--
          工作流卡片（批次 4）：当前在跑的那件事。
          标题 = 🎬 + 当前阶段名；输入/输出/状态全部来自服务端真实事件推导的 workflow 字段，
          缺项显示「—」——不写死示例、不编分母（分母只有 Agent 明确声明过才会带上）。
        -->
        <div v-if="workflowCard" class="agent-workflow-card">
          <div class="agent-workflow-card__head">
            <span class="agent-workflow-card__title">{{ workflowCard.title }}</span>
            <span v-if="workflowCard.project" class="agent-workflow-card__project">{{ workflowCard.project }}</span>
          </div>
          <div class="agent-workflow-card__row">
            <span class="agent-workflow-card__key">输入</span>
            <span class="agent-workflow-card__val">{{ workflowCard.inputText }}</span>
          </div>
          <div class="agent-workflow-card__row">
            <span class="agent-workflow-card__key">输出</span>
            <span class="agent-workflow-card__val">{{ workflowCard.outputText }}</span>
          </div>
          <!-- 批量提交的真实分母（批次 1 的 progress）：只在真有分母时出现 -->
          <div v-if="consoleState.progress" class="agent-workflow-card__row">
            <span class="agent-workflow-card__key">提交</span>
            <span class="agent-workflow-card__val">
              {{ consoleState.progress.done }}/{{ consoleState.progress.total }} {{ consoleState.progress.unit }}
            </span>
          </div>
          <div class="agent-workflow-card__row">
            <span class="agent-workflow-card__key">状态</span>
            <span class="agent-workflow-card__val">{{ workflowCard.statusText }}</span>
          </div>
        </div>

        <!--
          AI CREW（预览）：将来会有编剧/导演/摄影/美术/剪辑几路 Agent。
          当前只有 Director 是活的（就是本画布 Agent），其余一律「待接入」——不假装它们在干活，
          整块标注「预览」。角色与状态是数据驱动的列表，接入新角色只改 agent-crew.ts 一处。
        -->
        <div class="agent-crew" role="group" aria-label="AI CREW · 预览">
          <div class="agent-crew__head">
            <span class="agent-crew__title">AI CREW</span>
            <span class="agent-crew__tag">预览</span>
          </div>
          <ul class="agent-crew__list">
            <li
              v-for="member in crewMembers"
              :key="member.key"
              :class="['agent-crew__item', `is-${member.status}`]"
            >
              <span class="agent-crew__icon" aria-hidden="true">{{ member.icon }}</span>
              <span class="agent-crew__name">{{ member.name }}</span>
              <span class="agent-crew__state">{{ member.label }}</span>
            </li>
          </ul>
        </div>

        <ul v-if="consoleState.log?.length" class="agent-console__log">
          <li
            v-for="(item, index) in consoleState.log"
            :key="index"
            :class="['agent-console__log-item', `is-${item.mark}`]"
          >
            <span class="agent-console__mark">{{ consoleMarkSymbol(item.mark) }}</span>
            <span class="agent-console__log-text">{{ item.text }}</span>
          </li>
        </ul>
      </div>

      <!-- 空状态：一句引导 + 示例 chip（点一下只填进输入框，不自动发送） -->
      <div v-if="!hasMessages" class="agent-empty">
        <div class="agent-empty__main">
          <SidebarEmptyState @upload="triggerUpload" />
        </div>
        <div class="agent-empty__foot">
          <div class="agent-empty__hint">交给 Agent 一件事，它会直接改这张画布</div>
          <div class="agent-empty__chips">
            <button
              v-for="example in examplePrompts"
              :key="example"
              type="button"
              class="agent-composer__chip"
              @click="applyExamplePrompt(example)"
            >{{ example }}</button>
          </div>
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-else class="chat-messages-list" ref="messagesContainer">
        <template v-for="msg in messages" :key="msg.id">
          <!-- 用户消息（右对齐）：沿用设计稿的「你 · 时间」小标 + 气泡 -->
          <div v-if="msg.type === 'user'" class="message-row user-MkS7tH">
            <div class="user-col">
              <div class="agent-who">你 · {{ formatClock(msg.time) }}</div>
              <div class="user-bubble">{{ msg.content }}</div>
            </div>
          </div>

          <!-- 用户插话（一轮进行中）：右对齐；标注它是插入当前轮还是排队，让用户知道那句话何时生效 -->
          <div v-else-if="msg.type === 'user-interjection'" class="message-row user-MkS7tH">
            <div class="user-col">
              <div class="agent-who">
                你 · {{ formatClock(msg.time) }} · {{ msg.mode === 'follow-up' ? '排队中' : '插入当前轮' }}
              </div>
              <div class="user-bubble user-bubble--interjection">{{ msg.content }}</div>
            </div>
          </div>

          <!-- AI 图片回复 -->
          <div v-else-if="msg.type === 'ai-images'" class="message-row ai">
            <div class="ai-block">
              <!-- 摘要标题 -->
              <div class="summary-header" @click="toggleCollapse(msg)">
                <span>{{ msg.summary }}</span>
                <svg :class="{ 'rotated-Kj9mNl': msg.collapsed }" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M21.01 7.982A1.2 1.2 0 0 1 21 9.679l-8.156 8.06a1.2 1.2 0 0 1-1.688 0L3 9.68a1.2 1.2 0 0 1 1.687-1.707L12 15.199l7.313-7.227a1.2 1.2 0 0 1 1.697.01Z" fill="currentColor"/>
                </svg>
              </div>
              <!-- 加载占位 -->
              <div v-if="msg.loading && !msg.images.length" class="ai-images-loading">
                <span class="ai-images-spinner" />
                <span>图片生成中…</span>
              </div>
              <!-- 错误 -->
              <div v-else-if="msg.error" class="ai-images-error">{{ msg.error }}</div>
              <!-- 图片网格 -->
              <div v-else class="images-row" v-show="!msg.collapsed">
                <div v-for="(img, idx) in msg.images" :key="idx" class="image-cell" @click="openPreview(img)">
                  <img :src="img" />
                  <button class="image-cell-add" title="添加到画布" @click.stop="handleAddImageToCanvas(img)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <div v-if="idx === msg.images.length - 1 && msg.totalCount > msg.images.length" class="more-badge">
                    {{ msg.totalCount - msg.images.length }}+
                  </div>
                </div>
              </div>
              <!-- AI 提示 -->
              <div class="ai-notice">以上内容由 AI 生成</div>
              <!-- 操作按钮 -->
<!--              <div class="action-row">
                <div class="action-left">
                  <button class="action-btn-Wp3kLl">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m8.56 5.73 3.95-2.78a.5.5 0 0 1 .79.41v2.23h2.72v2H9.19a1 1 0 0 1-.63-.23c-.52-.36-.61-1.2 0-1.63Z" fill="currentColor"/></svg>
                    <span>重新生成</span>
                  </button>
                  <button class="action-btn-Wp3kLl icon-only-Kj8mNp">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7.06 10.15c-.2 0-.39.03-.58.06.06-.21.13-.42.23-.61.1-.28.26-.52.42-.76.13-.26.37-.44.54-.66.18-.22.43-.36.62-.54.19-.19.44-.28.64-.42.21-.12.39-.25.58-.31l.48-.2a.54.54 0 0 0 .31-.62l-.19-.76a.56.56 0 0 0-.67-.4l-.62.15c-.24.05-.5.17-.79.28-.29.13-.62.21-.92.42-.31.2-.67.36-.98.62-.3.27-.67.5-.94.85-.3.32-.59.66-.82 1.04-.26.37-.44.77-.63 1.17-.17.4-.31.8-.42 1.2a10.83 10.83 0 0 0-.34 2.19c-.03.64-.01 1.18.02 1.57.01.18.04.36.06.48l.02.15.02-.01a4.04 4.04 0 1 0 3.95-4.88Zm9.87 0c-.2 0-.39.03-.58.06.06-.21.12-.42.23-.61.1-.28.26-.52.42-.76.13-.26.37-.44.54-.66.18-.22.43-.36.62-.54.19-.19.44-.28.64-.42.21-.12.39-.25.58-.31l.48-.2a.54.54 0 0 0 .31-.62l-.19-.76a.56.56 0 0 0-.67-.4l-.62.15c-.24.04-.5.17-.79.28-.28.13-.61.21-.92.42-.31.2-.66.36-.98.62-.3.27-.67.5-.94.85-.3.32-.59.66-.82 1.04-.26.37-.44.77-.63 1.17-.17.4-.31.8-.42 1.2a10.83 10.83 0 0 0-.34 2.19c-.03.64-.01 1.18.02 1.57.01.18.04.36.06.48l.02.15.02-.01a4.04 4.04 0 1 0 3.95-4.88Z" fill="currentColor"/></svg>
                  </button>
                </div>
                <div class="action-right">
                  <button class="feedback-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M11.1 0a3.7 3.7 0 0 1 3.7 3.7v2.6h4.4a2.8 2.8 0 0 1 2.79 3.22l-1.24 8.1A2.8 2.8 0 0 1 17.96 20H5.1a3.08 3.08 0 0 1-3.09-2.67A1 1 0 0 1 2 17.2v-6.3c.21-1.48 1.48-2.78 3.1-2.9h1.8L10.19.59A1 1 0 0 1 11.1 0Z" fill="currentColor"/></svg>
                  </button>
                  <button class="feedback-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18.89 4a3.08 3.08 0 0 1 3.1 2.67c0 .04 0 .09 0 .13v6.3c0 .04 0 .09 0 .13-.2 1.48-1.47 2.78-3.09 2.77h-1.8l-3.29 7.4a1 1 0 0 1-.91.6 3.7 3.7 0 0 1-3.7-3.7v-2.6h-4.4a2.8 2.8 0 0 1-2.8-3.22L3.24 6.38A2.8 2.8 0 0 1 6.03 4h12.86Z" fill="currentColor"/></svg>
                  </button>
                </div>
              </div>-->
            </div>
          </div>

          <!-- Agent 回复：头像 + 名称/时间/复制，正文为主，工具调用默认收成一条细条 -->
          <div v-else-if="msg.type === 'ai-text'" class="message-row agent-row">
            <div class="agent-avatar" aria-hidden="true">✦</div>
            <div class="agent-main">
              <div class="agent-head">
                <span class="agent-name">画布 Agent</span>
                <span class="agent-time">{{ formatClock(msg.time) }}</span>
                <span class="agent-actions">
                  <button
                    v-if="msg.content"
                    type="button"
                    class="agent-action"
                    :class="{ 'is-copied': copiedMessageId === msg.id }"
                    :title="copiedMessageId === msg.id ? '已复制' : '复制'"
                    @click="copyMessage(msg)"
                  >
                    <svg v-if="copiedMessageId !== msg.id" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M9 2.5h8.5A2.5 2.5 0 0 1 20 5v8.5a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5V5A2.5 2.5 0 0 1 9 2.5Z" stroke="currentColor" stroke-width="1.6"/>
                      <path d="M15.5 19.5A2.5 2.5 0 0 1 13 22H6.5A2.5 2.5 0 0 1 4 19.5V13a2.5 2.5 0 0 1 2.5-2.5" stroke="currentColor" stroke-width="1.6"/>
                    </svg>
                    <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                </span>
              </div>
              <div class="agent-body">
                <!-- 工具调用轨迹：默认一行细条，点开看逐条细节（数据形状没动，只是呈现） -->
                <AgentToolTrace
                  :steps="msg.steps || []"
                  :step-times="msg.stepTimes || []"
                  :turn-started-at="msg.turnStartedAt || 0"
                  :pending-label="msg.pendingLabel || ''"
                />
                <!-- 正文按 Markdown 渲染（复用 report-markdown-utils 的自写渲染器：先 escape 再拼，XSS 安全）；
                     流式期间挂 .is-streaming，delta 到了即时重渲染，光标用伪元素接在末块行内末尾 -->
                <div
                  v-if="msg.content"
                  class="ai-text-content agent-md"
                  :class="{ 'is-streaming': msg.loading }"
                  v-html="renderMarkdownBlocks(msg.content)"
                ></div>
                <div v-else-if="msg.loading" class="ai-text-typing">
                  <span class="ai-text-dot" />
                  <span class="ai-text-dot" />
                  <span class="ai-text-dot" />
                </div>
                <div v-if="msg.error" class="ai-text-error">{{ msg.error }}</div>
                <!-- 画布被占用时的自救入口：确认没有 Agent 在跑就强制释放自己那把锁，并重试这一轮 -->
                <button
                  v-if="msg.lockConflict && !msg.loading"
                  type="button"
                  class="ai-text-force-unlock"
                  :disabled="msg.forceUnlocking"
                  @click="forceUnlockAndRetry(msg)"
                >
                  {{ msg.forceUnlocking ? '释放中…' : '强制释放并重试' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 用户消息（带参考图）：右对齐气泡 + 图片缩略图 -->
          <div v-else-if="msg.type === 'user-with-ref'" class="message-row user-with-ref-row">
            <div class="user-col">
              <div class="agent-who">你 · {{ formatClock(msg.time) }}</div>
              <div class="user-with-ref-bubble">
                <div v-if="msg.referenceImages?.length" class="user-with-ref-thumbs">
                  <div
                    v-for="(imageSrc, index) in msg.referenceImages"
                    :key="`${msg.id}-${index}`"
                    class="user-with-ref-thumb"
                    @click="openPreview(imageSrc)"
                  >
                    <img :src="imageSrc" alt="参考图" />
                  </div>
                </div>
                <div v-if="msg.content" class="user-with-ref-text">{{ msg.content }}</div>
              </div>
            </div>
          </div>

          <!-- 生成的图片组 -->
          <div v-else-if="msg.type === 'generated-images'" class="message-row">
            <div class="generated-grid">
              <div v-for="(img, idx) in msg.images" :key="idx" class="gen-image-cell" @click="openPreview(img)">
                <img :src="img" />
              </div>
            </div>
            <!-- 操作按钮 -->
            <div class="gen-actions">
              <button class="action-btn-Wp3kLl">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3.76 8a2.5 2.5 0 0 1 2.5-2.5h10.77a2.5 2.5 0 0 1 2.5 2.5v1.78a3.25 3.25 0 0 1 2-.08V8a4.5 4.5 0 0 0-4.5-4.5H6.26a4.5 4.5 0 0 0-4.5 4.5v7.93a4.5 4.5 0 0 0 4.5 4.5h5.84a2.44 2.44 0 0 1-.05-.57v-1.43H6.26a2.5 2.5 0 0 1-2.5-2.5V8Zm17.67 3.96a1 1 0 0 0-1.41 0l-5.77 5.7a.25.25 0 0 0-.07.18v2.37c0 .14.11.25.25.25h2.35a.25.25 0 0 0 .18-.08l5.71-5.79a1 1 0 0 0 0-1.41l-1.22-1.22Z" fill="currentColor"/></svg>
                <span>重新编辑</span>
              </button>
              <button class="action-btn-Wp3kLl">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m8.56 5.73 3.95-2.78a.5.5 0 0 1 .79.41v2.23h2.72v2H9.19a1 1 0 0 1-.63-.23c-.52-.36-.61-1.2 0-1.63Z" fill="currentColor"/></svg>
                <span>再次生成</span>
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- 底部内容生成器 -->
      <!-- 半自动闸门：Agent 要花钱/交付前必须在这里拿到用户答复，否则那一步做不下去 -->
      <div v-if="confirmRequest" class="agent-confirm-card">
        <div class="agent-confirm-card__head">
          <span class="agent-confirm-card__kicker">🎬 导演决策点 · 请批准</span>
          <span
            v-if="confirmRequest.riskLevel"
            :class="['agent-confirm-card__risk', `is-${confirmRequest.riskLevel}`]"
          >{{ { low: '低风险', medium: '中风险', high: '高风险' }[confirmRequest.riskLevel] || confirmRequest.riskLevel }}</span>
        </div>
        <div class="agent-confirm-card__title">{{ confirmRequest.title }}</div>
        <div class="agent-confirm-card__summary">{{ confirmRequest.summary }}</div>
        <ul v-if="confirmRequest.items?.length" class="agent-confirm-card__items">
          <li v-for="(item, index) in confirmRequest.items" :key="index">{{ item }}</li>
        </ul>
        <div class="agent-confirm-card__cost">
          <div v-if="confirmCostDisplay?.estimatedPoints != null" class="agent-confirm-card__estimate">
            本批将预扣 <strong>{{ confirmCostDisplay.estimatedPoints }}</strong> 分（服务端估算）
          </div>
          <div class="agent-confirm-card__pre-deduct">
            {{ confirmCostDisplay?.notice || AGENT_CONFIRM_PREDEDUCT_NOTICE }}
          </div>
          <div v-if="confirmCostDisplay?.balanceText" class="agent-confirm-card__balance">
            {{ confirmCostDisplay.balanceText }}
          </div>
        </div>
        <input
          v-model="confirmNote"
          class="agent-confirm-card__note"
          type="text"
          placeholder="补充要求（可选），例如：第 3 张不要"
          @keydown.enter.stop.prevent="settleConfirm(true)"
        />
        <div class="agent-confirm-card__actions">
          <button type="button" class="agent-confirm-card__btn is-reject" @click="settleConfirm(false)">拒绝</button>
          <button type="button" class="agent-confirm-card__btn is-approve" @click="settleConfirm(true)">同意并继续</button>
        </div>
      </div>

      <!-- 导演决策点：Agent 已做了一版、需要用户在两个方向里拍板（同一轮里等答复，与确认卡并列） -->
      <div v-if="askUserRequest" class="agent-ask-card">
        <div class="agent-ask-card__head">
          <span class="agent-ask-card__kicker">🎬 导演决策点</span>
        </div>
        <div v-if="askUserRequest.context" class="agent-ask-card__context">{{ askUserRequest.context }}</div>
        <div v-for="(item, index) in askUserRequest.questions" :key="index" class="agent-ask-card__q">
          <div class="agent-ask-card__question">{{ item.question }}</div>
          <div v-if="item.options?.length" class="agent-ask-card__options">
            <button
              v-for="option in item.options"
              :key="option.key"
              type="button"
              :class="['agent-ask-card__option', { 'is-active': askUserAnswers[index]?.optionKey === option.key }]"
              @click="selectAskUserOption(index, option.key)"
            >
              <span class="agent-ask-card__option-key">{{ option.key }}</span>
              <span class="agent-ask-card__option-body">
                <span class="agent-ask-card__option-label">{{ option.label }}</span>
                <span v-if="option.notes?.length" class="agent-ask-card__option-notes">{{ option.notes.join(' / ') }}</span>
              </span>
            </button>
          </div>
          <input
            v-model="askUserAnswers[index].text"
            class="agent-ask-card__input"
            type="text"
            placeholder="都不满意？直接说你的方案"
            @input="clearAskUserOption(index)"
            @keydown.enter.stop.prevent="settleAskUser(askUserAnswers)"
          />
        </div>
        <div class="agent-ask-card__actions">
          <button type="button" class="agent-ask-card__btn is-skip" @click="settleAskUser([], true)">跳过</button>
          <button type="button" class="agent-ask-card__btn is-submit" @click="settleAskUser(askUserAnswers)">确认</button>
        </div>
      </div>

      <!--
        Agent 输入区（2026-09-23 换掉了 ContentGenerator）
        用户的反馈很直接：「这个画布Agent还是一个生成器」。
        原来这里复用的是图片生成的输入组件 —— 带着张数、比例、画质、参考图、高级设置那一整套控件，
        面板看上去当然就是个生成器。而这些参数在这里根本不该由用户填：它们是 Agent 调工具时自己决定的。
        所以换成一个朴素的任务输入框：交办一件事，附带图，剩下的它自己来。
      -->
      <div class="agent-composer">
        <div v-if="autoSendNotice" class="agent-composer__notice" role="status">{{ autoSendNotice }}</div>
        <div v-if="interjectionNotice" class="agent-composer__notice" role="status">{{ interjectionNotice }}</div>
        <div v-if="uploadedImages.length" class="agent-composer__refs">
          <div v-for="img in uploadedImages" :key="img.id" class="agent-composer__ref">
            <img :src="img.src" :alt="img.name" @click="openPreview(img.src)" />
            <button type="button" class="agent-composer__ref-remove" title="移除" @click="removeUploadedImage(img.id)">×</button>
          </div>
        </div>
        <div class="agent-composer__box">
          <textarea
            ref="composerInputRef"
            v-model="inputMessage"
            class="agent-composer__input"
            rows="1"
            placeholder="交给 Agent 一件事：建节点、连线、生成、把一条片子串起来…"
            @keydown="handleKeydown"
          ></textarea>
          <div class="agent-composer__bar">
            <!-- 用哪个对话模型由用户定：以后配了多个文本模型（能力/价格/权限不同），就在这里选 -->
            <div
              ref="modelTriggerRef"
              class="agent-composer__model"
              role="combobox"
              tabindex="0"
              :aria-expanded="modelSelectOpen"
              :title="`当前对话模型：${selectedModelLabel}（点击切换）`"
              @click="toggleChatModelSelect"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M13.25 2.68a2.5 2.5 0 0 0-2.5 0L4.56 6.26a2.5 2.5 0 0 0-1.25 2.16v7.15a2.5 2.5 0 0 0 1.25 2.17l6.19 3.57a2.5 2.5 0 0 0 2.5 0l6.19-3.57a2.5 2.5 0 0 0 1.25-2.17V8.42a2.5 2.5 0 0 0-1.25-2.16L13.25 2.68Z"
                  fill="currentColor"
                />
              </svg>
              <span class="agent-composer__model-name">{{ selectedModelLabel }}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M21.01 7.98A1.2 1.2 0 0 1 21 9.68l-8.16 8.06a1.2 1.2 0 0 1-1.69 0L3 9.68a1.2 1.2 0 0 1 1.69-1.71L12 15.2l7.31-7.23a1.2 1.2 0 0 1 1.7.01Z" fill="currentColor" />
              </svg>
            </div>
            <button
              type="button"
              class="agent-composer__attach"
              :class="{ 'is-active': uploadedImages.length > 0 }"
              title="附参考图（Agent 会把它们挂到节点上用起来）"
              @click="triggerUpload"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.4 12.6 12.6 20.4a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.2-7.2" />
              </svg>
              <span v-if="uploadedImages.length">{{ uploadedImages.length }}</span>
              <span v-else>附图</span>
            </button>
            <!-- 提示改到输入框下方常驻一行（原来只挂在 title 上，用户根本看不到） -->
            <span class="agent-composer__spacer"></span>
            <!-- 停止仍只做视觉与禁用态：真正的 abort 属于另一批，这里不接逻辑（插话已接，见 /steer） -->
            <button
              type="button"
              class="agent-composer__stop"
              disabled
              title="停止（另一批开放）"
            >停止</button>
            <!-- 插话方式开关：只在运行中出现。默认「插入当前轮」，可切「排队」 -->
            <button
              v-if="runningAgent"
              type="button"
              class="agent-composer__interject-mode"
              :class="{ 'is-queued': interjectionMode === 'follow-up' }"
              :title="interjectionMode === 'follow-up'
                ? '当前：排队（这一轮结束后处理）——点击改为插入当前轮'
                : '当前：插入当前轮——点击改为排队'"
              @click="toggleInterjectionMode"
            >{{ interjectionMode === 'follow-up' ? '排队' : '插入当前轮' }}</button>
            <!-- 运行中不再禁用发送：输入的是「插话」，走 /steer 投递给正在跑的那一个任务（不建新任务） -->
            <button
              type="button"
              class="agent-composer__send"
              :disabled="!inputMessage.trim() && !uploadedImages.length"
              @click="sendMessage()"
            >{{ runningAgent ? (interjectionMode === 'follow-up' ? '排队' : '插入') : '交给 Agent' }}</button>
          </div>
        </div>
        <div class="agent-composer__hint">
          <span>Enter 发送</span>
          <span>Shift+Enter 换行</span>
          <span v-if="runningAgent">运行中可直接插话：插入当前轮 / 排队</span>
          <span v-else>工具默认折叠，点开看细节</span>
        </div>
      </div>

      <!-- 模型选择弹窗：与首页 Agent 工具栏复用同一个弹窗组件与同一份目录数据 -->
      <SelectPopup
        v-model:visible="modelSelectOpen"
        :trigger-ref="modelTriggerRef"
        placement="top"
        title="对话模型"
      >
        <ul class="lv-select-popup-inner">
          <li
            v-for="option in chatModelOptions"
            :key="option.value"
            :class="['lv-select-option', { 'lv-select-option-wrapper-selected': option.value === selectedModelKey }]"
            @click.stop="pickChatModel(option.value)"
          >
            <div class="select-option-label">
              <div class="select-option-label-content">
                <span>{{ option.label }}</span>
              </div>
            </div>
          </li>
        </ul>
      </SelectPopup>
    </div>

    <!-- 图片预览弹窗 -->
    <Teleport to="body">
      <div v-if="previewImage" class="image-preview-overlay" @click="closePreview">
        <div class="preview-container" @click.stop>
          <img :src="previewImage" class="preview-image" />
          <button class="preview-close" @click="closePreview">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M19.58 6.12a1.2 1.2 0 0 0-1.7-1.7L12 10.3 6.12 4.42a1.2 1.2 0 1 0-1.7 1.7L10.3 12l-5.88 5.88a1.2 1.2 0 0 0 1.7 1.7L12 13.7l5.88 5.88a1.2 1.2 0 1 0 1.7-1.7L13.7 12l5.88-5.88Z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/**
 * 样式 token 与布局全部对齐设计稿 `refund-e2e/mock-c.html`（方案 C · 极简流）。
 *
 * 结构：面板根节点挂一份 --agent-* token；消息流（头像/名称/时间/复制、工具细条、正文、
 * 流式光标）与输入区（模型 chip / 附图 / 停止 / 主按钮 / 提示行）都从这里取色取圆角 ——
 * 只在设计稿确实另有取值的地方（如占位色）才写单独的数值。
 *
 * 输入区仍是 absolute 贴底、盖在消息之上（已验证不会被消息列表压住）；
 * `.chat-messages-list` 的底部内边距按新输入区高度同步收窄，否则底部会空一大截。
 */
/* 设计稿 mock-c.html 的 token 落在面板根节点上：正文/工具/输入区都从这里继承 */
.agent-X3m2wp {
  --agent-bg: #0e0f12;
  --agent-surface: #16181d;
  --agent-surface-2: #14161b;
  --agent-line: #24262d;
  --agent-line-soft: #1e2027;
  --agent-text: #e8eaed;
  --agent-text-2: #9aa0a8;
  --agent-text-3: #6b7280;
  --agent-accent: #7c5cff;
  --agent-accent-soft: #b9a6ff;
  --agent-ok: #3ddc97;
  --agent-warn: #ffb020;
  --agent-r-sm: 8px;
  --agent-r-md: 12px;
  --agent-r-lg: 14px;
}

.agent-composer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--agent-line-soft, #1e2027);
  background: var(--agent-bg, #0e0f12);
}
.agent-composer__box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--agent-line, #24262d);
  border-radius: var(--agent-r-md, 12px);
  background: var(--agent-surface-2, #14161b);
}
/* 首页自动发送被占用/失败时的提示：常驻一行，别只挂在 title 上 */
.agent-composer__notice {
  padding: 8px 10px;
  border: 1px solid var(--agent-warn-line, #6b4a1f);
  border-radius: var(--agent-r-sm, 8px);
  background: var(--agent-warn-bg, #241a0d);
  color: var(--agent-warn-text, #f0b45a);
  font-size: 12px;
  line-height: 1.6;
}
.agent-composer__hint {
  display: flex;
  gap: 12px;
  /* 评审说原来的提示太灰：这里用 --agent-text-2，而不是设计稿里更暗的 --agent-text-3 */
  color: var(--agent-text-2, #9aa0a8);
  font-size: 11px;
}
.agent-composer__refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.agent-composer__ref {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  overflow: hidden;
  border: 0.5px solid var(--stroke-secondary, rgba(255, 255, 255, 0.14));
}
.agent-composer__ref img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
}
.agent-composer__ref-remove {
  position: absolute;
  top: 0;
  right: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 0 8px 0 8px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}
.agent-composer__input {
  width: 100%;
  max-height: 160px;
  /* 收窄到 36px：评审指出输入区太高、底部太空 */
  min-height: 36px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--agent-text, #e8eaed);
  font-size: 13.5px;
  line-height: 1.6;
  font-family: inherit;
}
.agent-composer__input::placeholder {
  /* 设计稿的占位色 .ph：#79818c，比原来的 text-tertiary 亮一档 */
  color: #79818c;
}
.agent-composer__bar {
  display: flex;
  align-items: center;
  /* 面板 560px 宽下这几个控件仍会互相顶，间隔 6 并允许模型名收缩 */
  gap: 6px;
  flex-wrap: nowrap;
}
.agent-composer__attach,
.agent-composer__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--agent-line, #24262d);
  border-radius: 7px;
  background: transparent;
  color: var(--agent-text-2, #9aa0a8);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.agent-composer__attach:hover,
.agent-composer__chip:hover {
  color: var(--agent-text, #e8eaed);
  border-color: #33363f;
}
.agent-composer__attach.is-active {
  color: var(--agent-accent-soft, #b9a6ff);
  border-color: rgba(124, 92, 255, 0.6);
}
.agent-composer__spacer {
  flex: 1 1 auto;
}
.agent-composer__stop {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--agent-line, #24262d);
  border-radius: 8px;
  background: transparent;
  color: var(--agent-text-2, #9aa0a8);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}
.agent-composer__stop:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agent-composer__send {
  /* 绝不能因为左边变长就被压缩换行 */
  flex: 0 0 auto;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--agent-accent, #7c5cff);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.agent-composer__send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agent-composer__interject-mode {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(124, 92, 255, 0.5);
  border-radius: 8px;
  background: transparent;
  color: var(--agent-accent-soft, #b9a6ff);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.agent-composer__interject-mode.is-queued {
  border-color: var(--agent-line, #24262d);
  color: var(--agent-text-2, #9aa0a8);
}

.agent-composer__model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 可以收缩：模型名很长时先压它，不要挤掉发送按钮 */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 200px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--agent-line, #24262d);
  border-radius: 7px;
  color: var(--agent-text-2, #9aa0a8);
  font-size: 12px;
  cursor: pointer;
}
.agent-composer__model:hover {
  color: var(--agent-text, #e8eaed);
  border-color: #33363f;
}
.agent-composer__model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 消息区：上下 padding 与行距一起收紧（评审指出留白太松） */
.chat-messages-list {
  padding: 12px 14px 150px;
}
.chat-messages-list .message-row {
  margin-bottom: 14px;
}

/**
 * 导演控制台：消息流之上的常驻状态条（游戏任务系统那种「当前阶段 / 进度 / 执行日志」）。
 * 风格对齐方案 C · 极简流：紧凑、不放大卡片、只用一根分隔线与消息区分开。
 */
.agent-console {
  flex-shrink: 0;
  padding: 8px 14px 9px;
  border-bottom: 1px solid var(--agent-line-soft, #1e2027);
  background: var(--agent-surface-2, #14161b);
  font-size: 11.5px;
  line-height: 1.5;
}
/*
 * 工作流卡片（批次 4）：当前在跑的那件事。
 * 刻意比决策卡轻 —— 细边框、紧凑、信息密度高，不放大卡片、不抢视觉。
 */
.agent-workflow-card {
  padding: 6px 8px 7px;
  border: 1px solid var(--agent-line-soft, #1e2027);
  border-radius: 6px;
  background: var(--agent-surface, #101216);
}
.agent-workflow-card__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.agent-workflow-card__title {
  flex: 0 0 auto;
  color: var(--agent-text, #e8eaed);
  font-size: 12px;
  font-weight: 600;
}
.agent-workflow-card__project {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--agent-text-3, #6b7280);
}
.agent-workflow-card__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 2px;
  min-width: 0;
}
.agent-workflow-card__key {
  flex: 0 0 auto;
  width: 26px;
  color: var(--agent-text-3, #6b7280);
}
.agent-workflow-card__val {
  min-width: 0;
  color: var(--agent-text-2, #9aa0a8);
  word-break: break-word;
}
/*
 * AI CREW（批次 4 · 预览）：一行角色占位。当前只有 Director 是活的，其余「待接入」。
 * 整块标注「预览」，视觉上比工作流卡片更轻（虚线分隔 + 更小的字）。
 */
.agent-crew {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--agent-line-soft, #1e2027);
}
.agent-crew__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-crew__title {
  color: var(--agent-text, #e8eaed);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.agent-crew__tag {
  padding: 0 4px;
  border: 1px solid var(--agent-line-soft, #1e2027);
  border-radius: 3px;
  color: var(--agent-text-3, #6b7280);
  font-size: 10px;
  line-height: 1.4;
}
.agent-crew__list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.agent-crew__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--agent-text-3, #6b7280);
}
.agent-crew__icon {
  font-size: 11px;
}
.agent-crew__state {
  color: var(--agent-text-3, #6b7280);
}
/* 只有已接入（active）的角色提亮，并在跑任务时用强调色；未接入一律灰着 */
.agent-crew__item.is-active {
  color: var(--agent-text, #e8eaed);
}
.agent-crew__item.is-active .agent-crew__state {
  color: var(--agent-accent-soft, #b9a6ff);
}
.agent-console__log {
  margin: 5px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-console__log-item {
  display: flex;
  gap: 6px;
  color: var(--agent-text-2, #9aa0a8);
}
.agent-console__mark {
  flex: 0 0 auto;
  width: 10px;
  text-align: center;
}
.agent-console__log-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-console__log-item.is-done .agent-console__mark {
  color: var(--agent-ok, #3ddc97);
}
.agent-console__log-item.is-running {
  color: var(--agent-text, #e8eaed);
}
.agent-console__log-item.is-running .agent-console__mark {
  color: var(--agent-accent, #7c5cff);
}
.agent-console__log-item.is-pending .agent-console__mark {
  color: var(--agent-text-3, #6b7280);
}
.agent-console__log-item.is-failed,
.agent-console__log-item.is-failed .agent-console__mark {
  color: #ff6b6b;
}

/* 「你 · 04:12」小标（用户消息与 Agent 共用同一套字号层级） */
.agent-who {
  margin-bottom: 6px;
  color: var(--agent-text-3, #6b7280);
  font-size: 11.5px;
}
.user-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 84%;
}

/* Agent 发言形态：左侧紫头像 + 名称/时间 + hover 复制 */
.agent-row {
  display: flex;
  gap: 10px;
}
.agent-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  margin-top: 1px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7c5cff, #4b32c3);
  color: #fff;
  font-size: 12px;
}
.agent-main {
  flex: 1 1 auto;
  min-width: 0;
}
.agent-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.agent-name {
  color: var(--agent-text, #e8eaed);
  font-size: 12.5px;
  font-weight: 600;
}
.agent-time {
  color: var(--agent-text-3, #6b7280);
  font-size: 11px;
}
.agent-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  opacity: 0.35;
  transition: opacity 0.15s;
}
.agent-row:hover .agent-actions {
  opacity: 1;
}
.agent-action {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--agent-text-2, #9aa0a8);
  cursor: pointer;
}
.agent-action:hover {
  border-color: var(--agent-line, #24262d);
  background: var(--agent-surface, #16181d);
  color: var(--agent-text, #e8eaed);
}
.agent-action.is-copied {
  color: var(--agent-ok, #3ddc97);
}

/* 正文：Markdown 渲染（复用 report-markdown-utils 的自写渲染器，无新依赖）。
   排版克制：标题小号加粗、列表紧、行内代码胶囊，避免浏览器默认大标题造成的跳动。
   v-html 注入的节点不带 scoped 属性，子元素样式一律走 :deep()。 */
.ai-text-content {
  color: var(--agent-text, #e8eaed);
  font-size: 13.5px;
  line-height: 1.7;
  word-break: break-word;
}
.agent-md :deep(p) {
  margin: 0 0 8px;
}
.agent-md :deep(p:last-child) {
  margin-bottom: 0;
}
.agent-md :deep(h1),
.agent-md :deep(h2),
.agent-md :deep(h3),
.agent-md :deep(h4) {
  margin: 12px 0 6px;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--agent-text, #e8eaed);
}
.agent-md :deep(h1:first-child),
.agent-md :deep(h2:first-child),
.agent-md :deep(h3:first-child),
.agent-md :deep(h4:first-child) {
  margin-top: 0;
}
.agent-md :deep(ul),
.agent-md :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 18px;
}
.agent-md :deep(li) {
  margin: 4px 0;
}
.agent-md :deep(li::marker) {
  color: var(--agent-text-3, #6b7280);
}
.agent-md :deep(strong) {
  color: #fff;
  font-weight: 600;
}
.agent-md :deep(a) {
  color: var(--agent-accent, #7c5cff);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.agent-md :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.agent-md :deep(pre) {
  margin: 6px 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--agent-line, #24262d);
  border-radius: 8px;
  background: var(--agent-surface, #16181d);
  overflow-x: auto;
}
.agent-md :deep(pre code) {
  padding: 0;
  background: transparent;
}
.agent-md :deep(hr) {
  margin: 10px 0;
  border: none;
  border-top: 1px solid var(--agent-line, #24262d);
}
/* 流式光标：接在最后一个块的行内末尾，不新增 DOM */
.agent-md.is-streaming :deep(> :last-child)::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 3px;
  vertical-align: -2px;
  background: var(--agent-accent, #7c5cff);
  animation: agent-caret-blink 1s steps(2) infinite;
}
@keyframes agent-caret-blink {
  50% { opacity: 0; }
}

/* 空态：引导语 + 示例 chip（点击只填入输入框） */
.agent-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding-bottom: 140px;
}
.agent-empty__main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.agent-empty__main .sidebar-empty-state.empty {
  padding-bottom: 0;
}
.agent-empty__foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 0 16px 8px;
}
.agent-empty__hint {
  color: var(--agent-text-2, #9aa0a8);
  font-size: 12px;
}
.agent-empty__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

/* 面板身份标识（Agent 创作）：放在头部，不会被底部的输入浮层盖住 */
.right-panel-agent-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  margin-right: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--canvas-float-block-default, rgba(79, 70, 229, 0.12));
  border: 0.5px solid var(--stroke-secondary, rgba(99, 102, 241, 0.4));
  color: var(--text-secondary, #6366f1);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

/* 工具调用轨迹（细条 / 合并 / 展开详情）已抽到 AgentToolTrace.vue ——
   这里原来那套「序号 + 标签 + 摘要」的步骤清单连同它和正文之间的虚线分隔线一并去掉，
   正文与工具彻底分离（设计稿方案 C）。 */

/**
 * 卡片浮在输入框上方。
 *
 * 为什么不能用普通文档流：面板底部的输入区（ContentGenerator）是 `position: absolute; bottom: 0;
 * z-index: 10`，文档流里的东西会被它盖住 —— 实测确认卡片的两个按钮正好被输入框压掉，
 * 用户看得到卡片却点不到按钮，Agent 于是白等十分钟。
 * 所以这里脱离文档流、放到 z-index 20，并留出输入区的高度。
 */
.agent-confirm-card {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 160px;
  z-index: 20;
  max-height: 46%;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #eef2ff;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.28);
}
.agent-confirm-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.agent-confirm-card__kicker { font-size: 13px; font-weight: 700; color: #312e81; }
.agent-confirm-card__title { margin-top: 6px; font-size: 13px; font-weight: 700; color: #1e293b; }
.agent-confirm-card__risk {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: #e0e7ff;
  color: #4338ca;
}
.agent-confirm-card__risk.is-high { background: #fee2e2; color: #b91c1c; }
.agent-confirm-card__risk.is-medium { background: #fef3c7; color: #92400e; }
.agent-confirm-card__summary {
  font-size: 12px;
  line-height: 1.6;
  color: #3730a3;
  white-space: pre-wrap;
}
.agent-confirm-card__items {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: #475569;
}
.agent-confirm-card__cost { margin-top: 8px; font-size: 12px; color: #92400e; }
.agent-confirm-card__estimate { font-weight: 600; }
.agent-confirm-card__pre-deduct { margin-top: 2px; color: #64748b; }
.agent-confirm-card__balance { margin-top: 2px; color: #475569; }
.agent-confirm-card__note {
  width: 100%;
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  font-size: 12px;
  background: #fff;
  color: #334155;
}
.agent-confirm-card__note:focus { outline: none; border-color: #6366f1; }
.agent-confirm-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.agent-confirm-card__btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
}
.agent-confirm-card__btn.is-reject {
  background: #fff;
  border-color: #cbd5e1;
  color: #475569;
}
.agent-confirm-card__btn.is-approve {
  background: #4f46e5;
  color: #fff;
}
.agent-confirm-card__btn.is-approve:hover { background: #4338ca; }
/* 提问卡：与确认卡同一套定位/配色（关键信息不足时在同一轮里问，卡片同样不能消失在屏幕外） */
.agent-ask-card {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 160px;
  z-index: 20;
  max-height: 46%;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #eef2ff;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.28);
}
.agent-ask-card__head { margin-bottom: 6px; }
.agent-ask-card__kicker { font-size: 13px; font-weight: 700; color: #312e81; }
.agent-ask-card__context { font-size: 12px; line-height: 1.6; color: #3730a3; }
.agent-ask-card__q { margin-top: 10px; }
.agent-ask-card__question { font-size: 12px; font-weight: 600; color: #334155; }
/* 方案是可点选的行（代号 + 名称 + 特点），不再是一排小胶囊 —— 名称与特点要看得清 */
.agent-ask-card__options { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.agent-ask-card__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
  background: #fff;
  color: #312e81;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.agent-ask-card__option.is-active { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.agent-ask-card__option-key {
  flex: 0 0 auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 6px;
  background: #e0e7ff;
  color: #4338ca;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.agent-ask-card__option.is-active .agent-ask-card__option-key { background: rgba(255, 255, 255, 0.25); color: #fff; }
.agent-ask-card__option-body { display: flex; flex-direction: column; gap: 2px; }
.agent-ask-card__option-label { font-weight: 600; }
.agent-ask-card__option-notes { color: #64748b; }
.agent-ask-card__option.is-active .agent-ask-card__option-notes { color: #e0e7ff; }
.agent-ask-card__input {
  width: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  font-size: 12px;
  background: #fff;
  color: #334155;
}
.agent-ask-card__input:focus { outline: none; border-color: #6366f1; }
.agent-ask-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.agent-ask-card__btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
}
.agent-ask-card__btn.is-skip { background: #fff; border-color: #cbd5e1; color: #475569; }
.agent-ask-card__btn.is-submit { background: #4f46e5; color: #fff; }
.agent-ask-card__btn.is-submit:hover { background: #4338ca; }
/* AI 图片加载/错误态 */
.ai-images-loading {
  align-items: center;
  color: var(--text-tertiary);
  display: inline-flex;
  font-size: 12px;
  gap: 8px;
  padding: 16px 0;
}
.ai-images-spinner {
  animation: ai-spin 0.8s linear infinite;
  border: 2px solid var(--stroke-secondary);
  border-radius: 50%;
  border-top-color: var(--brand-main-default);
  display: inline-block;
  height: 16px;
  width: 16px;
}
@keyframes ai-spin { to { transform: rotate(360deg); } }
.ai-images-error {
  color: #ef4444;
  font-size: 12px;
  padding: 12px 0;
}

/* 单图右上角"加入画布" + 按钮 */
.image-cell {
  position: relative;
}
.image-cell-add {
  align-items: center;
  background: rgba(0, 0, 0, 0.55);
  border: 0;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  height: 22px;
  justify-content: center;
  opacity: 0;
  position: absolute;
  right: 4px;
  top: 4px;
  transition: opacity 0.15s ease, transform 0.15s ease;
  width: 22px;
}
.image-cell:hover .image-cell-add { opacity: 1; }
.image-cell-add:hover { transform: scale(1.08); }

/* AI 文本流式回复：正文样式见上面的 .ai-text-content（不再用气泡卡片） */
.ai-text-error {
  color: #ef4444;
  font-size: 12px;
  margin-top: 6px;
}
.ai-text-force-unlock {
  background: rgba(0, 202, 224, 0.12);
  border: 1px solid rgba(0, 202, 224, 0.4);
  border-radius: 6px;
  color: #00cae0;
  cursor: pointer;
  font-size: 12px;
  margin-top: 8px;
  padding: 4px 10px;
}
.ai-text-force-unlock:disabled {
  cursor: default;
  opacity: 0.6;
}
.ai-text-typing {
  align-items: center;
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
}
.ai-text-dot {
  animation: ai-typing 1s infinite ease-in-out;
  background: var(--text-tertiary);
  border-radius: 50%;
  display: inline-block;
  height: 6px;
  width: 6px;
}
.ai-text-dot:nth-child(2) { animation-delay: 0.15s; }
.ai-text-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes ai-typing {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

/* 用户气泡：字号/圆角/内边距对齐设计稿（气泡尾巴在右下角），顺带收紧留白 */
.user-col .user-bubble,
.user-col .user-with-ref-text {
  max-width: 100%;
  padding: 9px 13px;
  border: 1px solid #2b3040;
  border-radius: 14px 14px 4px 14px;
  background: #232733;
  color: var(--agent-text, #e8eaed);
  font-size: 13.5px;
  line-height: 1.6;
}

/* 插话气泡：与普通用户气泡同形，左缘加一道强调色 —— 一眼区分「这是运行中补的一句」 */
.user-col .user-bubble--interjection {
  border-left: 2px solid var(--agent-accent, #7c5cff);
}

/* 用户消息（带参考图）：右对齐气泡 + 缩略图 */
.message-row.user-with-ref-row {
  display: flex;
  justify-content: flex-end;
}
.user-with-ref-bubble {
  align-items: flex-end;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 100%;
}
.user-with-ref-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}
.user-with-ref-thumb {
  background: var(--bg-block-secondary, rgba(255, 255, 255, 0.06));
  border-radius: 8px;
  cursor: pointer;
  flex: 0 0 auto;
  height: 72px;
  overflow: hidden;
  transition: transform 0.15s ease;
  width: 72px;
}
.user-with-ref-thumb:hover {
  transform: scale(1.03);
}
.user-with-ref-thumb img {
  display: block;
  height: 100%;
  object-fit: cover;
  width: 100%;
}
.user-with-ref-text {
  background: var(--bg-block-primary-default);
  border-radius: 16px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  padding: 12px 16px;
  word-break: break-word;
}

/* 图片预览弹窗 */
.image-preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100000;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.preview-container {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
}

.preview-image {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
  animation: scaleIn 0.2s ease;
}

@keyframes scaleIn {
  from { transform: scale(0.9); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.preview-close {
  position: absolute;
  top: -40px;
  right: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
}

.preview-close:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
