<script setup>
import { isRasterReferenceUrl } from '@/config/reference-validation'
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import SidebarEmptyState from '@/components/canana/SidebarEmptyState.vue'
import AssistantSessionList from '@/components/canvas/AssistantSessionList.vue'
import {
  createGenerationTask,
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
// 折叠状态与画布页共用同一份（useChatSessions 是模块级单例）：
// 确认卡片长在这个面板里，面板收起来用户就看不见卡片 —— 而那是「不给答复就走不下去」的闸门。
import { useChatSessions } from '@/composables/useChatSessions'
import { buildAssistantChatMessages } from '@/composables/assistant-chat-history'
import { useCanvasAgentBridge } from '@/views/workflow/agent/use-canvas-agent-bridge'
import { CANVAS_AGENT_SKILL_KEY } from '@/shared/canvas-agent-tools'
import SelectPopup from '@/components/generate/common/SelectPopup.vue'
import { getAgentModel, setAgentModel } from '@/api/agent'

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

const inputMessage = ref('')
const messagesContainer = ref(null)
const toggleCollapse = (msg) => { msg.collapsed = !msg.collapsed }

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
}

onMounted(() => {
  // 先把对话模型目录拉起来：选择器要有东西可选，runCanvasAgentTurn 也要按用户选的模型走
  void refreshChatModels()
  // 后台拉取模型清单（getDefault*ModelKey 依赖此调用）
  void loadPublicModelCatalog()
  // 拉取助手会话列表（首次会自动建默认会话），然后加载当前会话历史
  void (async () => {
    await loadSessions()
    if (activeSessionId.value) {
      await loadSessionHistory(activeSessionId.value)
    }
  })()
})

onBeforeUnmount(cleanupStreams)

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
      })
    } else {
      out.push({
        id: `${baseId}-u`,
        type: 'user',
        content: record.prompt,
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
    })
  } else if (rtype === 'agent' || rtype === 'chat') {
    out.push({
      id: `${baseId}-a`,
      type: 'ai-text',
      content: record.content || '',
      loading: !record.done && !record.content,
      error: record.error || '',
    })
  }
  return out
}

// 拉取指定会话的历史记录并填充到 messages（time asc）
const loadSessionHistory = async (sessionId) => {
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
const confirmRequest = ref(null)          // { title, summary, items, costPoints, riskLevel, resolve }
const confirmNote = ref('')
const confirmRemembered = ref(false)      // 用户勾了「本任务内不再问同类动作」

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
    confirmRequest.value = { ...request, resolve }
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
const askUserAnswers = ref([])       // 与问题一一对应：点选项即填入，也允许自由输入

/**
 * 服务端 Agent 通过桥要提问时调用；返回的 Promise 一直挂到用户提交或跳过。
 *
 * 提问是「关键信息不足」时的补救 —— 它和确认卡一样是阻塞式的（同一轮里等答复），
 * 所以卡片必须让人看得见：面板收起时它在屏幕外，用户只会看到画布一动不动，然后十分钟后收到超时。
 * 上一次的提问卡还没答复就再来一张时，先把上一张按「未回答」结掉，避免谁也答不了。
 */
const askUser = (request) =>
  new Promise((resolve) => {
    isPanelCollapsed.value = false
    askUserRequest.value?.resolve?.({ answers: [], skipped: true })
    const questions = Array.isArray(request?.questions) ? request.questions.slice(0, 3) : []
    askUserAnswers.value = questions.map(() => '')
    askUserRequest.value = { context: request?.context, questions, resolve }
    scrollToBottom()
  })

const settleAskUser = (answers, skipped = false) => {
  const pending = askUserRequest.value
  if (!pending) return
  askUserRequest.value = null
  const payload = (pending.questions || []).map((item, index) => ({
    question: item.question,
    answer: String((answers || [])[index] ?? '').trim(),
  }))
  pending.resolve(skipped ? { answers: [], skipped: true } : { answers: payload })
  askUserAnswers.value = []
}

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
    const target = messages.value[messages.value.length - 1]
    if (!target || target.type !== 'ai-text') return
    target.steps = [...(target.steps || []), step]
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
    // 这一轮的参考图存下来：Agent 调 attach_reference_images 时由桥从这里取
    turnReferenceImages.value = Array.isArray(referenceImages) ? [...referenceImages] : []
    aiMsg.content = ''
    aiMsg.steps = []

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
        // 本轮附的参考图：服务端会告诉 Agent「用户附了 N 张图」，
        // 它再决定要不要用 attach_reference_images 挂到某个节点上
        referenceImages: turnReferenceImages.value,
        // 最近几轮对话：服务端会把它并进本轮用户消息，保证措辞连贯
        history: (messages.value || [])
          .filter((item) => (item.type === 'user' || item.type === 'ai-text') && String(item.content || '').trim())
          .slice(-6)
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

    const controller = new AbortController()
    streamController = controller
    registerStream(controller)

    await subscribeGenerationTaskEvents(taskId, {
      signal: controller.signal,
      onEvent: (event) => {
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

const sendMessage = async () => {
  const content = inputMessage.value.trim()
  const refImages = uploadedImages.value.map((img) => img.src)

  if (!content && !refImages.length) return

  // 确保有活跃会话（首次发送会自动定位到默认会话）
  try {
    await ensureSession()
  } catch (err) {
    console.error('[RightPanel] ensureSession failed', err)
    return
  }

  hasMessages.value = true

  const userId = Date.now()
  messages.value.push(
    refImages.length
      ? { id: userId, type: 'user-with-ref', referenceImages: refImages, content: content || '（附了参考图）' }
      : { id: userId, type: 'user', content },
  )

  // 清空输入；参考图交给这一轮的 Agent（挂到节点上是它的活），不再由面板直接拿去生成
  inputMessage.value = ''
  uploadedImages.value = []
  scrollToBottom()

  messages.value.push({
    id: userId + 1,
    type: 'ai-text',
    content: '',
    loading: true,
    error: '',
  })
  scrollToBottom()

  await runCanvasAgentTurn(content || '我上传了参考图，帮我把它用起来', tailMessage(), refImages)
}

// 回车发送
const handleKeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendMessage()
  }
}

// 监听从中间底部传来的消息（画布触发的入口）：作为文本对话发起
watch(() => props.initialMessage, async (newMessage) => {
  if (!newMessage || !newMessage.trim()) return

  // 确保有活跃会话再发送
  try {
    await ensureSession()
  } catch (err) {
    console.error('[RightPanel] ensureSession failed', err)
    return
  }

  hasMessages.value = true
  const userId = Date.now()
  messages.value.push({
    id: userId,
    type: 'user',
    content: newMessage,
  })

  emit('message-received')
  scrollToBottom()

  messages.value.push({
    id: userId + 1,
    type: 'ai-text',
    content: '',
    loading: true,
    error: '',
  })
  scrollToBottom()
  // 画布触发的入口也走同一个 Agent：面板只有一条对话链路，
  // 免得「从这儿问」和「在输入框问」得到两种不同的能力（一个能动画布、一个只会聊天）。
  await runCanvasAgentTurn(newMessage, tailMessage())
})

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

      <!-- 空状态 - 使用可复用组件 -->
      <SidebarEmptyState
        v-if="!hasMessages"
        @upload="triggerUpload"
      />

      <!-- 消息列表 -->
      <div v-else class="chat-messages-list" ref="messagesContainer">
        <template v-for="msg in messages" :key="msg.id">
          <!-- 用户消息（右对齐） -->
          <div v-if="msg.type === 'user'" class="message-row user-MkS7tH">
            <div class="user-bubble">{{ msg.content }}</div>
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

          <!-- AI 文本流式回复 -->
          <div v-else-if="msg.type === 'ai-text'" class="message-row ai">
            <div class="ai-text-bubble">
              <!-- Agent 真的对画布做了什么：一条条列出来，用户能核对，也能看出它是不是在乱改 -->
              <div v-if="msg.steps?.length" class="agent-step-list">
                <div
                  v-for="step in msg.steps"
                  :key="`${msg.id}-step-${step.index}`"
                  :class="['agent-step', step.ok ? 'is-ok' : 'is-fail']"
                >
                  <span class="agent-step__index">{{ step.index }}</span>
                  <span class="agent-step__label">{{ step.label }}</span>
                  <span class="agent-step__summary">{{ step.summary }}</span>
                </div>
              </div>
              <div v-if="msg.content" class="ai-text-content">{{ msg.content }}</div>
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

          <!-- 用户消息（带参考图）：右对齐气泡 + 图片缩略图 -->
          <div v-else-if="msg.type === 'user-with-ref'" class="message-row user-with-ref-row">
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
          <span class="agent-confirm-card__title">{{ confirmRequest.title }}</span>
          <span
            v-if="confirmRequest.riskLevel"
            :class="['agent-confirm-card__risk', `is-${confirmRequest.riskLevel}`]"
          >{{ { low: '低风险', medium: '中风险', high: '高风险' }[confirmRequest.riskLevel] || confirmRequest.riskLevel }}</span>
        </div>
        <div class="agent-confirm-card__summary">{{ confirmRequest.summary }}</div>
        <ul v-if="confirmRequest.items?.length" class="agent-confirm-card__items">
          <li v-for="(item, index) in confirmRequest.items" :key="index">{{ item }}</li>
        </ul>
        <div v-if="confirmRequest.costPoints" class="agent-confirm-card__cost">
          预计消耗 <strong>{{ confirmRequest.costPoints }}</strong> 积分
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

      <!-- 关键信息不足：Agent 在同一轮里等用户回答（与确认卡并列，样式沿用同一套类名） -->
      <div v-if="askUserRequest" class="agent-ask-card">
        <div class="agent-ask-card__head">
          <span class="agent-ask-card__title">需要你补充一点信息</span>
        </div>
        <div v-if="askUserRequest.context" class="agent-ask-card__context">{{ askUserRequest.context }}</div>
        <div v-for="(item, index) in askUserRequest.questions" :key="index" class="agent-ask-card__q">
          <div class="agent-ask-card__question">{{ item.question }}</div>
          <div v-if="item.options?.length" class="agent-ask-card__options">
            <button
              v-for="(option, oi) in item.options"
              :key="oi"
              type="button"
              :class="['agent-ask-card__option', { 'is-active': askUserAnswers[index] === option }]"
              @click="askUserAnswers[index] = option"
            >{{ option }}</button>
          </div>
          <input
            v-model="askUserAnswers[index]"
            class="agent-ask-card__input"
            type="text"
            placeholder="也可以直接输入你的答案"
            @keydown.enter.stop.prevent="settleAskUser(askUserAnswers)"
          />
        </div>
        <div class="agent-ask-card__actions">
          <button type="button" class="agent-ask-card__btn is-skip" @click="settleAskUser([], true)">跳过</button>
          <button type="button" class="agent-ask-card__btn is-submit" @click="settleAskUser(askUserAnswers)">提交</button>
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
        <div v-if="uploadedImages.length" class="agent-composer__refs">
          <div v-for="img in uploadedImages" :key="img.id" class="agent-composer__ref">
            <img :src="img.src" :alt="img.name" @click="openPreview(img.src)" />
            <button type="button" class="agent-composer__ref-remove" title="移除" @click="removeUploadedImage(img.id)">×</button>
          </div>
        </div>
        <textarea
          v-model="inputMessage"
          class="agent-composer__input"
          rows="1"
          placeholder="交给 Agent 一件事（建节点、连线、生成、把一条片子串起来…）"
          title="Enter 发送 · Shift+Enter 换行"
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
          <!-- 面板只有 440px 宽，这一行放不下「Enter 发送 · Shift+Enter 换行」这种提示：
               实测它会把「交给 Agent」按钮挤到换行。提示改挂在输入框的 title 上，不占位置 -->
          <span class="agent-composer__spacer"></span>
          <button
            type="button"
            class="agent-composer__send"
            :disabled="runningAgent || (!inputMessage.trim() && !uploadedImages.length)"
            @click="sendMessage"
          >{{ runningAgent ? '执行中…' : '交给 Agent' }}</button>
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
 * Agent 输入区。
 *
 * 与它替换掉的 ContentGenerator 的关系：那个组件是图片生成的输入区（张数/比例/画质/高级设置），
 * 放进这个面板会让它看上去像个生成器 —— 用户的反馈正是这一句。这里只留「交办一件事」需要的三样：
 * 文字、附带的参考图、发送。生成参数由 Agent 调工具时自己决定。
 *
 * 定位沿用原来那套（absolute 贴底 + 盖在消息之上），因为它已经验证过不会被消息列表压住；
 * `.chat-messages-list` 的底部内边距同步调小，否则消息和输入框之间会空一大截。
 */
.agent-composer {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  /* 行与行之间留够：用户反馈「输入框都快挤在一起了」，原来是 8px */
  gap: 12px;
  padding: 14px 16px;
  border: 0.5px solid var(--stroke-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 14px;
  background: var(--canvas-float-block-default, rgba(24, 24, 27, 0.94));
  backdrop-filter: blur(var(--canvas-float-backdrop-blur, 12px));
  -webkit-backdrop-filter: blur(var(--canvas-float-backdrop-blur, 12px));
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
  max-height: 176px;
  /* 至少两行的高度：一行的话点进去光标就贴着边，看着很局促 */
  min-height: 44px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text-primary, #e5e7eb);
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
}
.agent-composer__input::placeholder {
  color: var(--text-tertiary, #71717a);
}
.agent-composer__bar {
  display: flex;
  align-items: center;
  /* 这几个控件在 440px 的老宽度下会互相顶，间隔给到 10 并允许模型名收缩 */
  gap: 10px;
  flex-wrap: nowrap;
}
.agent-composer__attach {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 5px 9px;
  border: 0.5px solid var(--stroke-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #a1a1aa);
  font-size: 12px;
  cursor: pointer;
}
.agent-composer__attach.is-active {
  color: #a5b4fc;
  border-color: #6366f1;
}
.agent-composer__spacer {
  flex: 1 1 auto;
}
.agent-composer__send {
  /* 绝不能因为左边变长就被压缩换行 */
  flex: 0 0 auto;
  margin-left: auto;
  padding: 7px 16px;
  border: 0;
  border-radius: 8px;
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.agent-composer__send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agent-composer__model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 可以收缩：模型名很长时先压它，不要挤掉发送按钮 */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 240px;
  padding: 5px 9px;
  border: 0.5px solid var(--stroke-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  color: var(--text-secondary, #a1a1aa);
  font-size: 12px;
  cursor: pointer;
}
.agent-composer__model:hover {
  color: var(--text-primary, #e5e7eb);
  border-color: var(--text-secondary, #71717a);
}
.agent-composer__model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 输入区变矮了（原来那个生成器高得多），消息列表的底部留白同步收一下 */
.chat-messages-list {
  padding-bottom: 170px;
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

/* 步骤清单与确认卡片（2026-09-23，制片 Agent 的界面部分）
   跟着面板已有的视觉语言走：浅底、细边框、等宽序号，不引入新的色彩体系。 */
.agent-step-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(148, 163, 184, 0.4);
}
.agent-step {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #475569;
}
.agent-step.is-fail { color: #b91c1c; }
.agent-step__index {
  flex: 0 0 auto;
  min-width: 16px;
  font-variant-numeric: tabular-nums;
  color: #94a3b8;
}
.agent-step__label { flex: 0 0 auto; font-weight: 600; }
.agent-step__summary { flex: 1 1 auto; word-break: break-word; }

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
.agent-confirm-card__title { font-size: 13px; font-weight: 700; color: #312e81; }
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
.agent-ask-card__title { font-size: 13px; font-weight: 700; color: #312e81; }
.agent-ask-card__context { font-size: 12px; line-height: 1.6; color: #3730a3; }
.agent-ask-card__q { margin-top: 10px; }
.agent-ask-card__question { font-size: 12px; font-weight: 600; color: #334155; }
.agent-ask-card__options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.agent-ask-card__option {
  padding: 4px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  background: #fff;
  color: #4338ca;
  font-size: 12px;
  cursor: pointer;
}
.agent-ask-card__option.is-active { background: #4f46e5; border-color: #4f46e5; color: #fff; }
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

/* AI 文本流式回复气泡 */
.message-row.ai > .ai-text-bubble {
  background: var(--bg-block-secondary, rgba(255, 255, 255, 0.04));
  border-radius: 16px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  max-width: 85%;
  padding: 12px 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
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
  max-width: 85%;
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
