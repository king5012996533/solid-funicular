/**
 * 制片 Agent 的会话转录：跨轮持久化与恢复（2026-09-26）
 *
 * 背景（这是「让画布 Agent 像个真正的智能体」的第一块地基）：
 * 执行器每轮都是 `new Agent({ initialState: { systemPrompt, tools } })`，
 * 任务一结束 Pi 的转录就被丢掉 —— Agent 没有任何跨轮记忆，它的「记忆」只剩画布本身。
 * 实测症状：它一轮里**连读 39 次画布**才敢动手，最后报「模型既没回答也没调用工具」。
 * 这里把 Pi 的转录落进 `GenerationRecord.metaJson`（不建表、不迁移），
 * 下一轮按 **sessionId + 画布 id** 取回、塞进 `initialState.messages`，让会话真正跨轮存活。
 *
 * 关于 Pi 的语义（读的是 @earendil-works/pi-agent-core@0.87.1，行号见本次报告）：
 *   - `initialState.messages` 是**会话转录**；只有它**不是**以 system 消息开头时，
 *     `initialState.systemPrompt` + `tools` 才会被折成一条领衔的 system 消息
 *     （`dist/agent.js` createMutableAgentState）。也就是说：若原样保留旧转录里那条 system 消息，
 *     本轮新的 `systemPrompt` 会被**静默忽略**（工作手册与画布摘要会冻结在上一轮）。
 *     所以这里**只存非 system 消息**，system 头每轮用当轮 systemPrompt + 当前工具集重建。
 *   - 工具集变了 Pi 自己会在下一次请求前用一条 system 消息把差异告知模型
 *     （`dist/agent-loop.js` declareToolChanges / `@earendil-works/pi-ai` transcript.js getToolStateChanges）。
 *     我们什么都不用做 —— 这推翻了当年那条「手工塞 messages 会把工具顶掉」的注释所担心的坑。
 *   - 转录里的消息都是纯 JSON 数据（content 数组只有 text/thinking/toolCall/image），JSON 往返即可安全序列化；
 *     唯一带 typebox symbol 键的是 system 消息里的 `toolsAdded`，而这里恰好不存 system 消息，所以根本不碰它。
 */

/** metaJson 里存转录用的键（GenerationRecord.metaJson 是 Json 字段，不新增列/迁移） */
export const CANVAS_AGENT_SESSION_META_KEY = 'canvasAgentSession'

/** 转录结构版本号：将来形状要变时，旧数据按版本直接判为不可用，退回 fallback 而不是猜着解析 */
export const CANVAS_AGENT_SESSION_VERSION = 1

/**
 * 转录总字符预算。
 *
 * 为什么按「总字符」而不是「固定条数 / 固定单条长度」：旧路径是
 * `.slice(-8)`（服务端）× `slice(0, 500)`（每条），把上下文砍到几乎没有，
 * 一次 `get_canvas_state` 的返回就能把好几条挤掉。这里改成「总量有上限、从最旧的用户回合开始丢」，
 * 单条消息不再被腰斩，信息密度由预算而不是拍脑袋的 8 / 500 决定。
 * 混合中英约 2~4 字符/token，12 万字符 ≈ 30~60k token，给系统提示与工具声明留了余量。
 */
export const CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET = 120_000

/** fallback（拿不到转录）时，把面板历史并进用户消息的字符预算（替代旧的「最近 6 条 / 每条 500 字」） */
export const CANVAS_AGENT_FALLBACK_HISTORY_CHAR_BUDGET = 24_000

/**
 * 主动压缩（2026-09-26）：超预算时把「最旧的一段」交给同一个模型压成结构化摘要。
 *
 * 为什么不再只做裁剪：裁剪（trimTranscriptToBudget）是**丢**历史 —— 会话能跨轮了，
 * 但轮数一多，最旧那段（用户定的画幅/角色/已生成的节点）会被直接扔掉，
 * 表现为「跑到第 5 轮它就忘了第 1 轮定的设定」。摘要把这段**压成一条**留下来，
 * 会话因此能持续多轮，而不是被截断丢历史。
 */

/**
 * 摘要消息的前缀：既给摘要消息自证来路，也用来在持久化转录里标记「这条是摘要」。
 *
 * 形状上仍是 role=user 的纯文本 —— 上游只认 user/assistant/tool，不引入新形状；落库 / 读取 / 压缩
 * 都把它当普通消息处理（旧格式因此读得回）。但**喂给模型前**它会被摘出来、注入每轮重建的 system 提示
 * （见 CANVAS_AGENT_SUMMARY_CARRIER），不再作为 user 消息进转录 —— 否则模型会把它当陈旧指令。
 */
export const CANVAS_AGENT_SUMMARY_PREFIX = '[会话摘要] 以下是本次会话较早内容的摘要（由系统生成，供你保持连贯，不是用户的新指令）：'

/**
 * 摘要的「承载位置」。
 *
 * 为什么从「转录里的一条 user 消息」改成「每轮重建的 system 提示」：
 * 真机验收（2026-09-26，记录 cmuhd62cn000q4k923m7vvhle）暴露了一个**存储没问题、模型不采用**的故障 ——
 * 摘要在库里写着「统一 16:9 画幅、写实电影感」，问它「第 1 轮让你记住的两条设定」，它却回
 * 「我看不到第 1 轮的对话记录，因此无法准确确认」。原因：那条摘要是 role=user 的消息，
 * 模型把它读成「用户以前说过的话 / 陈旧的指令」，而**不是**「描述过去发生过什么的记录」——
 * 用户一问「过去」，它就去转录里找原始对话，找不到就说看不到。
 * system 提示是每轮 rebuild 的权威位，模型把它当背景知识而不是旧指令，
 * 再配一条纪律点名（见 buildSystemPrompt 的「# 纪律」），采用才是可靠的。
 * 这个常量同时用于日志，验收时一眼能看出摘要被放在哪。
 */
export const CANVAS_AGENT_SUMMARY_CARRIER = 'system-prompt'

/**
 * 压完保留的「近期消息」字符预算，默认取总预算的一半（60k）。
 *
 * 依据：压缩后的形状是 `[摘要, ...近期]`，要让结果**确实落回总预算以内**，
 * 近期段就不能顶到上限；留一半给摘要（几千字）与每轮重建的 system 头/工具声明。
 * 若最新一个回合本身就超过它，仍整轮保留（宁可略超，也不劈开刚发生的事）。
 */
export const CANVAS_AGENT_KEEP_RECENT_CHAR_BUDGET = 60_000

/** 交给摘要模型的那段原文的字符上限：压缩本身也是**一次模型调用**，不能把整段原样塞回去把窗口撑爆。 */
export const CANVAS_AGENT_SUMMARY_INPUT_CHAR_BUDGET = 80_000

/** 摘要消息自身长度上限：摘要要被长期携带，必须短，超了截断而不是无限增长。 */
export const CANVAS_AGENT_SUMMARY_MAX_CHARS = 8_000

/** 拼给摘要模型的单条消息内容上限（工具结果可能有整张画布的 JSON）。 */
export const CANVAS_AGENT_SUMMARY_SOURCE_ITEM_MAX_CHARS = 4_000

/** 落进 metaJson 的会话结构 */
export interface CanvasAgentPersistedSession {
  version: number
  /** 画布 id（= 流水线锁的 workflowId）。切画布时这个值不同，恢复就必须落空 */
  canvasId: string
  savedAt: string
  /** 只含非 system 消息（user / assistant / toolResult），已是可安全写入 Json 字段的纯数据 */
  messages: unknown[]
}

/** fallback 路径要并进用户消息的历史行 */
export interface CanvasAgentHistoryLine {
  role: 'user' | 'assistant'
  content: string
}

/** 从 requestBody 取本轮所属画布 id（= beginPipelineRun 拿到的 workflowId）。取不到就返回空串。 */
export const resolveCanvasAgentCanvasId = (requestBody: unknown): string => {
  const pipelineLock = (requestBody as { pipelineLock?: { workflowId?: unknown } } | null | undefined)?.pipelineLock
  return String(pipelineLock?.workflowId || '').trim()
}

const roleOf = (message: unknown): string =>
  String((message as { role?: unknown } | null | undefined)?.role || '')

/** 只取文本块拼成纯文本（thinking 不进摘要输入，避免把思考当成事实写进摘要） */
const textContentOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const block = part as { type?: string; text?: string }
      return block?.type === 'text' ? String(block.text || '') : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 这条消息恢复到上游时，会不会变成「空消息」。
 *
 * 问的是上游接口能不能接受：网关（pi-gateway-stream.toOpenAiMessages）只会把 text 与 toolCall
 * 转成 OpenAI 形状 —— 一条只有 thinking、或内容为空的 assistant 会变成 `content: null` 且没有
 * tool_calls，上游会直接 400。**失败的回合正是这种形状**（stopReason=error / aborted，content=[]）。
 * 所以落库前先把这类空回合剔掉，免得下一轮恢复时上游报错。
 * toolResult 一律保留（它一定跟着上一条带 toolCall 的 assistant，而成对关系由调用方保证）。
 */
const isRenderablePersistedMessage = (message: unknown): boolean => {
  const role = roleOf(message)
  if (role === 'toolResult') return true
  if (role === 'user') {
    const content = (message as { content?: unknown }).content
    if (Array.isArray(content)) return content.length > 0
    return String(content ?? '').trim().length > 0
  }
  if (role === 'assistant') {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.some((part) => {
      const type = String((part as { type?: unknown } | null | undefined)?.type || '')
      if (type === 'toolCall') return true
      if (type === 'text') return String((part as { text?: unknown }).text || '').trim().length > 0
      return false
    })
  }
  return false
}

/**
 * 转录 → 可持久化的纯数据。
 *
 * 只保留 user / assistant / toolResult：system 消息不存（理由见文件头 —— 保留了会让新 systemPrompt 失效），
 * 自定义消息角色（若有）也不存；空的 / 只有思考的 assistant 回合也剔掉（见 isRenderablePersistedMessage）。
 * 最后做一次 JSON 往返，丢掉 undefined / 函数 / symbol 键，确保写进 Json 字段、读回来还是同一份。
 */
export const toPersistedTranscriptMessages = (messages: unknown): unknown[] => {
  if (!Array.isArray(messages)) return []
  const kept = messages.filter((message) => {
    const role = roleOf(message)
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return false
    return isRenderablePersistedMessage(message)
  })
  try {
    return JSON.parse(JSON.stringify(kept)) as unknown[]
  } catch {
    return []
  }
}

/** 转录的粗略字符量（按每条消息的 JSON 文本长度估算） */
export const countTranscriptChars = (messages: unknown): number => {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((sum, message) => {
    try {
      return sum + JSON.stringify(message ?? null).length
    } catch {
      return sum
    }
  }, 0)
}

/**
 * 按预算从最旧的「用户回合」开始丢，返回保留下来的尾部。
 *
 * 回合以 user 消息为界：assistant 的 toolCall 与其后的 toolResult 必须成对留下 ——
 * 只留 toolResult 不留发起它的 assistant，上游会看到「没有对应调用的工具结果」。
 * 若最新一个回合本身就超预算，仍然整轮保留：宁可略超，也不能把「用户刚说的话 / 刚做完的活」丢掉。
 */
export const trimTranscriptToBudget = (
  messages: unknown,
  budget = CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET,
): unknown[] => {
  if (!Array.isArray(messages) || messages.length === 0) return []

  const boundaries: number[] = []
  messages.forEach((message, index) => {
    if (index === 0 || roleOf(message) === 'user') boundaries.push(index)
  })

  let chosen = boundaries[boundaries.length - 1]
  for (const boundary of boundaries) {
    if (countTranscriptChars(messages.slice(boundary)) <= budget) {
      chosen = boundary
      break
    }
  }

  return messages.slice(chosen)
}

/**
 * 给 Pi 的 `transformContext` 用的裁剪：**保留头部 system 消息**，只裁非 system 的尾部。
 *
 * 为什么单独一个函数：`transformContext` 拿到的是 Pi 的**运行时转录**，它以一条 system 消息开头
 * （`agent.js` createMutableAgentState 把 systemPrompt+工具声明 unshift 进去，工具集变化时还会在它后面
 * 再插一条 system）。若直接拿去 `trimTranscriptToBudget`，一旦裁剪点落在某个 user 边界，
 * **领衔的 system 消息会被一起丢掉** —— 模型就再也看不到工作手册与工具声明了（静默失效，不报错）。
 * 这里先把头部连续的 system 原样摘出来，只对后面的对话按预算裁剪，再拼回去。
 */
export const trimTranscriptToBudgetPreservingSystem = (
  messages: unknown,
  budget = CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET,
): unknown[] => {
  if (!Array.isArray(messages) || messages.length === 0) return []

  let headEnd = 0
  while (headEnd < messages.length && roleOf(messages[headEnd]) === 'system') headEnd += 1
  const head = messages.slice(0, headEnd)
  const rest = messages.slice(headEnd)
  if (rest.length === 0) return head

  // system 头本身也占体积（工具声明可能很大），从预算里扣掉，保证总量不超
  const restBudget = Math.max(1, budget - countTranscriptChars(head))
  return [...head, ...trimTranscriptToBudget(rest, restBudget)]
}

/** 组织成待落库的会话结构；没有画布 id 或不含任何有效消息时返回 null（不落库） */
export const buildCanvasAgentSessionMeta = (input: {
  canvasId: string
  messages: unknown
  savedAt?: string
}): CanvasAgentPersistedSession | null => {
  const canvasId = String(input.canvasId || '').trim()
  const messages = trimTranscriptToBudget(toPersistedTranscriptMessages(input.messages))
  if (!canvasId || messages.length === 0) return null

  return {
    version: CANVAS_AGENT_SESSION_VERSION,
    canvasId,
    savedAt: input.savedAt || new Date().toISOString(),
    messages,
  }
}

/**
 * 从 metaJson 读回会话。
 *
 * 校验三件事，任一不满足都返回 null（调用方据此走 fallback，绝不用一份可疑的转录去拼上下文）：
 *   1. 版本号一致；
 *   2. `canvasId` 与本次要恢复的画布一致 —— **切画布不许串台**；
 *   3. 至少含一条有效消息。
 * 读回后再过一遍预算裁剪：旧数据可能是按更大预算存的，恢复前先把体积压回当前上限。
 */
export const readCanvasAgentSession = (
  metaJson: unknown,
  canvasId: string,
): CanvasAgentPersistedSession | null => {
  const expected = String(canvasId || '').trim()
  if (!expected) return null

  const raw = (metaJson as Record<string, unknown> | null | undefined)?.[CANVAS_AGENT_SESSION_META_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const session = raw as { version?: unknown; canvasId?: unknown; savedAt?: unknown; messages?: unknown }
  if (Number(session.version) !== CANVAS_AGENT_SESSION_VERSION) return null
  if (String(session.canvasId || '').trim() !== expected) return null

  const messages = toPersistedTranscriptMessages(session.messages)
  if (messages.length === 0) return null

  return {
    version: CANVAS_AGENT_SESSION_VERSION,
    canvasId: expected,
    savedAt: String(session.savedAt || ''),
    messages: trimTranscriptToBudget(messages),
  }
}

export interface CanvasAgentSessionBootstrap {
  canvasId: string
  /** 本轮是否具备「按画布 + 会话恢复」的前提（画布 id 与会话 id 都在） */
  restoreEnabled: boolean
  /** 恢复出来的转录；为空表示这一轮走 fallback 拼装路径 */
  restoredMessages: unknown[]
  source: 'session' | 'fallback'
}

/**
 * 决定本轮用「恢复的转录」还是「fallback 拼装」。
 *
 * 抽成纯函数是为了能单测「跨轮记忆」与「切画布隔离」这两条最容易静默出错的规则：
 * 它们不报错、不改变返回形状，一旦退化成空转录，只有靠断言才看得见。
 * 这里再校验一次 canvasId：即便上游（DB 查询）挑错了记录，也不会把别的画布的记忆串过来。
 */
export const resolveCanvasAgentSessionBootstrap = (input: {
  requestBody: unknown
  sessionId?: string
  previousSession?: CanvasAgentPersistedSession | null
}): CanvasAgentSessionBootstrap => {
  const canvasId = resolveCanvasAgentCanvasId(input.requestBody)
  const sessionId = String(input.sessionId || '').trim()

  if (!canvasId || !sessionId) {
    return { canvasId, restoreEnabled: false, restoredMessages: [], source: 'fallback' }
  }

  const previous = input.previousSession
  if (!previous
    || String(previous.canvasId || '').trim() !== canvasId
    || !Array.isArray(previous.messages)
    || previous.messages.length === 0) {
    return { canvasId, restoreEnabled: true, restoredMessages: [], source: 'fallback' }
  }

  const restoredMessages = trimTranscriptToBudget(toPersistedTranscriptMessages(previous.messages))
  if (restoredMessages.length === 0) {
    return { canvasId, restoreEnabled: true, restoredMessages: [], source: 'fallback' }
  }

  return { canvasId, restoreEnabled: true, restoredMessages, source: 'session' }
}

/**
 * fallback 路径：从面板历史里挑最近若干条能塞进预算的 user/assistant 消息。
 *
 * 替代旧的「最近 6 条 × 每条砍 500 字」：条数不再拍死，单条也不再腰斩，
 * 由总字符预算决定能带多少（一条很长的历史消息只要还在预算内就原样带上）。
 */
export const selectCanvasAgentFallbackHistory = (
  history: unknown,
  budget = CANVAS_AGENT_FALLBACK_HISTORY_CHAR_BUDGET,
): CanvasAgentHistoryLine[] => {
  if (!Array.isArray(history) || budget <= 0) return []

  const normalized = history
    .map((item) => ({
      role: String((item as { role?: unknown } | null | undefined)?.role || ''),
      content: String((item as { content?: unknown } | null | undefined)?.content || '').trim(),
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)

  const selected: CanvasAgentHistoryLine[] = []
  let used = 0
  for (let index = normalized.length - 1; index >= 0; index--) {
    const item = normalized[index]
    const cost = item.content.length + 3
    if (selected.length > 0 && used + cost > budget) break
    const content = cost > budget ? item.content.slice(0, budget) : item.content
    selected.unshift({ role: item.role as 'user' | 'assistant', content })
    used += content.length + 3
    if (used >= budget) break
  }

  return selected
}

// ─────────────────────────────────────────────────────────────────────────────
// 主动压缩（2026-09-26）
//
// 「决策」与「摘要动作」刻意分开：
//   · planCanvasAgentCompaction 是**纯函数**，回答「要不要压、压哪一段、压完留什么」，可单测；
//   · compactCanvasAgentTranscript 才真的调模型，且失败一律安全回退到既有裁剪。
// 这样最容易静默出错的规则（成对保留、摘要累积）不依赖网络就能钉死。
// ─────────────────────────────────────────────────────────────────────────────

/** 这条消息是不是我们塞进去的「会话摘要」（role=user + 前缀） */
export const isCanvasAgentSummaryMessage = (message: unknown): boolean => {
  if (roleOf(message) !== 'user') return false
  const content = (message as { content?: unknown } | null | undefined)?.content
  return typeof content === 'string' && content.trimStart().startsWith(CANVAS_AGENT_SUMMARY_PREFIX)
}

/**
 * 造一条摘要消息。
 *
 * `timestamp` 固定传 0：本函数要可复现（单测/日志），也避免摘要顶着「刚发生」的时间戳
 * 干扰后续按时间的判断。超长摘要截断 —— 它要被长期携带，体积必须有界。
 */
export const buildCanvasAgentSummaryMessage = (summaryText: string, timestamp = 0) => {
  const text = String(summaryText || '').trim()
  const clipped = text.length > CANVAS_AGENT_SUMMARY_MAX_CHARS
    ? `${text.slice(0, CANVAS_AGENT_SUMMARY_MAX_CHARS)}…（摘要过长已截断）`
    : text
  return {
    role: 'user' as const,
    content: `${CANVAS_AGENT_SUMMARY_PREFIX}\n${clipped}`,
    timestamp,
  }
}

/** 取出摘要消息里的正文（去掉前缀 + 那条换行）；不是摘要消息返回空串 */
export const extractCanvasAgentSummaryText = (message: unknown): string => {
  if (!isCanvasAgentSummaryMessage(message)) return ''
  const content = String((message as { content?: unknown } | null | undefined)?.content || '')
  return content.slice(CANVAS_AGENT_SUMMARY_PREFIX.length).trim()
}

/**
 * 把转录里的「会话摘要」消息摘出来，返回摘要正文与去掉摘要后的其余消息。
 *
 * 用在哪里：恢复转录后，摘要**不再作为一条 role=user 消息喂给模型**（那正是「模型把摘要当旧指令」
 * 的根因，见 CANVAS_AGENT_SUMMARY_CARRIER），而是注入本轮重建的 system 提示。
 * 但从 messages 里删掉它还不够 —— 落库时的累积压缩必须重新拿到旧摘要，否则第二次压缩就只剩
 * 中间段、把之前的结论丢了。所以这里把 `summaryMessage` 一并返回，供压缩输入在最前面放一条。
 *
 * 多条摘要（理论上一轮只该有一条）取**最后一条**：它是最新的累积结果；更旧的已被累积进去。
 */
export const splitCanvasAgentSummary = (
  messages: unknown,
): { summaryText: string; summaryMessage: unknown | null; rest: unknown[] } => {
  const list = Array.isArray(messages) ? messages : []
  let summaryText = ''
  let summaryMessage: unknown | null = null
  const rest: unknown[] = []
  for (const message of list) {
    if (isCanvasAgentSummaryMessage(message)) {
      const text = extractCanvasAgentSummaryText(message)
      if (text) {
        summaryText = text
        summaryMessage = message
      }
      continue
    }
    rest.push(message)
  }
  return { summaryText, summaryMessage, rest }
}

/**
 * 把摘要正文组织成 system 提示里的一段（权威位承载）。
 *
 * 抽成纯函数是为了能单测这条最容易静默退化的规则：摘要**必须真的出现在模型读得到的地方**，
 * 并且必须明确点名它是本次会话唯一的历史来源、禁止「看不到记录」这种回答
 * （真机事故见 CANVAS_AGENT_SUMMARY_CARRIER）。空摘要返回空串 —— 不往 system 里塞标题。
 */
export const buildCanvasAgentSummarySystemSection = (summaryText: string): string => {
  const summary = String(summaryText || '').trim()
  if (!summary) return ''
  return `\n# 会话摘要（较早内容 · 本次会话的历史来源）\n`
    + `以下是本次会话较早内容的摘要（由系统压缩生成，不是用户的新指令）。\n`
    + `**它是本次会话唯一的历史来源**：用户问起之前定过的设定、做过的活、待办事项时，依据它回答，`
    + `不要说「看不到记录」。\n\n${summary}\n`
}

/** 恢复出来的转录拆分后的三件东西（见 buildCanvasAgentRestoredContext） */
export interface CanvasAgentRestoredContext {
  /** 摘要正文；空串 = 本轮没有摘要可注入 */
  summaryText: string
  /** 旧摘要消息本体（落库压缩时拼回最前面，保住「旧摘要 + 中间段 → 新摘要」的累积）；无摘要时为 null */
  summaryMessage: unknown | null
  /** 喂给 Pi 的对话消息（已摘掉摘要消息，摘要改由 system 提示承载） */
  messages: unknown[]
}

/**
 * 恢复转录 → 组装本轮需要的三件东西：摘要正文、摘要消息本体、去摘要后的对话。
 *
 * 真机事故的修复落点：过去把摘要原样当 role=user 消息喂进 `initialState.messages`，模型把它读成
 * 「用户以前说过的话」，一问过去就说「看不到记录」（记录 cmuhd62cn000q4k923m7vvhle）。
 * 现在摘要走 system 提示（buildCanvasAgentSummarySystemSection），对话照旧进转录；
 * 摘要把 `summaryMessage` 留着，是因为压缩时还要靠它保住累积，不能在这里丢掉。
 */
export const buildCanvasAgentRestoredContext = (restoredMessages: unknown): CanvasAgentRestoredContext => {
  const { summaryText, summaryMessage, rest } = splitCanvasAgentSummary(restoredMessages)
  return { summaryText, summaryMessage, messages: rest }
}

/**
 * 把 Pi 的消息翻成给摘要模型读的纯文本。
 *
 * 工具结果里可能是整张画布的 JSON（正是它把上下文撑大的），所以单条内容与总量都要截断 ——
 * 摘要调用本身也是一次模型请求，不能反过来把它撑爆。
 */
export const buildCanvasAgentSummarySource = (
  span: unknown,
  options?: { maxChars?: number; itemMaxChars?: number },
): string => {
  if (!Array.isArray(span)) return ''
  const itemMaxChars = options?.itemMaxChars ?? CANVAS_AGENT_SUMMARY_SOURCE_ITEM_MAX_CHARS
  const maxChars = options?.maxChars ?? CANVAS_AGENT_SUMMARY_INPUT_CHAR_BUDGET

  const clip = (text: string) => (text.length > itemMaxChars
    ? `${text.slice(0, itemMaxChars)}…（已截断 ${text.length - itemMaxChars} 字）`
    : text)

  const lines: string[] = []
  for (const raw of span) {
    const message = raw as { content?: unknown; toolName?: string; isError?: boolean }
    const role = roleOf(raw)
    if (role === 'user') {
      lines.push(`用户：${clip(textContentOf(message.content))}`)
      continue
    }
    if (role === 'assistant') {
      const parts = Array.isArray(message.content) ? message.content : []
      const calls = parts
        .map((part) => part as { type?: string; name?: string })
        .filter((part) => part?.type === 'toolCall')
        .map((part) => String(part.name || ''))
        .filter(Boolean)
      const text = clip(textContentOf(parts))
      lines.push(`助手：${text}${calls.length ? `（并调用工具：${calls.join('、')}）` : ''}`)
      continue
    }
    if (role === 'toolResult') {
      const name = String(message.toolName || '')
      lines.push(
        `工具结果${name ? `(${name})` : ''}${message.isError ? '[失败]' : ''}：${clip(textContentOf(message.content))}`,
      )
    }
  }

  const joined = lines.filter((line) => line.trim().length > 0).join('\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…（更早内容已截断）` : joined
}

/** 压缩决策的产物（纯数据，可断言） */
export interface CanvasAgentCompactionPlan {
  /** 是否应压缩：转录总字符超过预算 */
  shouldCompact: boolean
  /** 要交给模型压成摘要的最旧一段 */
  span: unknown[]
  /** 压缩后**原样保留**的近期消息（不含 span） */
  retained: unknown[]
  budget: number
  keepRecentBudget: number
  beforeChars: number
  /** span 里是否含旧摘要 —— 是则本次是「摘要累积」而不是重新摘要 */
  carriesPreviousSummary: boolean
}

/**
 * 判断要不要压、压哪一段、压完剩什么。
 *
 * 规则：
 *   1. 总字符 ≤ 预算 → 不压（不花冤枉钱）；
 *   2. 超过 → 保留「近期」到 keepRecentBudget 以内（按用户回合边界切，toolCall 与 toolResult 成对），
 *      其余最旧的一段作为 span 交给模型；
 *   3. span 从第 0 条开始 → 若转录开头是上一轮的摘要消息，它必然落进 span，
 *      于是「旧摘要 + 中间那段」被一起重压成新摘要（**摘要累积**，不丢之前的结论）；
 *   4. 只有一个回合且超预算 → span 为空，不压（没有更旧的段可压，交给兜底裁剪）。
 *
 * `retained` 复用 trimTranscriptToBudget：它保证保留了整条用户回合、且不会只留 toolResult 丢掉发起它的 assistant。
 */
export const planCanvasAgentCompaction = (
  messages: unknown,
  options?: { budget?: number; keepRecentBudget?: number },
): CanvasAgentCompactionPlan => {
  const normalized = toPersistedTranscriptMessages(messages)
  const budget = options?.budget ?? CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET
  // 近期段最多留「总预算一半」且不超过 60k：给摘要与每轮重建的 system 头/工具声明留余量，
  // 保证压缩后 `[摘要, ...近期]` 确实落回总预算以内。
  const keepRecentBudget = options?.keepRecentBudget
    ?? Math.max(1, Math.min(CANVAS_AGENT_KEEP_RECENT_CHAR_BUDGET, Math.floor(budget / 2)))
  const beforeChars = countTranscriptChars(normalized)

  const noopPlan: CanvasAgentCompactionPlan = {
    shouldCompact: false,
    span: [],
    retained: normalized,
    budget,
    keepRecentBudget,
    beforeChars,
    carriesPreviousSummary: false,
  }
  if (budget <= 0 || normalized.length === 0 || beforeChars <= budget) return noopPlan

  const retained = trimTranscriptToBudget(normalized, keepRecentBudget)
  const span = normalized.slice(0, normalized.length - retained.length)
  if (span.length === 0) return noopPlan

  return {
    shouldCompact: true,
    span,
    retained,
    budget,
    keepRecentBudget,
    beforeChars,
    carriesPreviousSummary: span.some((message) => isCanvasAgentSummaryMessage(message)),
  }
}

/** 压缩动作的结果（落库与日志都用它） */
export interface CanvasAgentCompactionResult {
  /** 压缩后的转录 `[摘要消息, ...近期消息]`；未压缩时是净化后的原转录 */
  messages: unknown[]
  compacted: boolean
  /** 摘要调用失败、已退回「丢最旧一段」裁剪 */
  fellBack: boolean
  beforeMessageCount: number
  afterMessageCount: number
  beforeChars: number
  afterChars: number
  /** 摘要消息本身的字符数（含前缀） */
  summaryChars: number
  /** 被压进摘要的旧消息条数 */
  summarizedMessageCount: number
  /** 本次压的旧消息里是否含上一次的摘要（是 → 累积，而不是覆盖丢掉之前的结论） */
  carriesPreviousSummary: boolean
  /** 失败原因（仅 fellBack=true 时有值，供日志） */
  failureReason: string
}

/** 极端保护：`[摘要, ...近期]` 仍超预算时，只在（总预算 − 摘要）内保留近期尾部 —— 摘要一定留住 */
const clampCompactedTranscript = (
  summaryMessage: unknown,
  retained: unknown[],
  budget: number,
): unknown[] => {
  const combined = [summaryMessage, ...retained]
  if (countTranscriptChars(combined) <= budget) return combined
  const summaryChars = countTranscriptChars([summaryMessage])
  const tail = trimTranscriptToBudget(retained, Math.max(1, budget - summaryChars))
  return [summaryMessage, ...tail]
}

/**
 * 真正执行压缩：调一次模型把最旧一段压成一条结构化摘要。
 *
 * 失败安全（契约）：`summarize` 抛错 / 返回空 → **不抛错**，退回既有的「从最旧用户回合丢」裁剪，
 * 并在结果里标 `fellBack`（调用方据此记日志）。
 */
export const compactCanvasAgentTranscript = async (input: {
  messages: unknown
  budget?: number
  keepRecentBudget?: number
  /** 把一段旧消息压成摘要文本；失败/超时请抛错，本函数负责安全回退 */
  summarize: (span: unknown[]) => Promise<string>
}): Promise<CanvasAgentCompactionResult> => {
  const normalized = toPersistedTranscriptMessages(input.messages)
  const plan = planCanvasAgentCompaction(normalized, {
    budget: input.budget,
    keepRecentBudget: input.keepRecentBudget,
  })
  const base = {
    beforeMessageCount: normalized.length,
    beforeChars: plan.beforeChars,
  }

  if (!plan.shouldCompact) {
    return {
      ...base,
      messages: plan.retained,
      compacted: false,
      fellBack: false,
      afterMessageCount: plan.retained.length,
      afterChars: plan.beforeChars,
      summaryChars: 0,
      summarizedMessageCount: 0,
      carriesPreviousSummary: false,
      failureReason: '',
    }
  }

  try {
    const summaryText = String((await input.summarize(plan.span)) || '').trim()
    if (!summaryText) throw new Error('摘要模型返回空内容')
    const summaryMessage = buildCanvasAgentSummaryMessage(summaryText)
    const result = clampCompactedTranscript(summaryMessage, plan.retained, plan.budget)
    return {
      ...base,
      messages: result,
      compacted: true,
      fellBack: false,
      afterMessageCount: result.length,
      afterChars: countTranscriptChars(result),
      summaryChars: String((summaryMessage as { content?: unknown }).content || '').length,
      summarizedMessageCount: plan.span.length,
      carriesPreviousSummary: plan.carriesPreviousSummary,
      failureReason: '',
    }
  } catch (error) {
    const fallbackMessages = trimTranscriptToBudget(normalized, plan.budget)
    return {
      ...base,
      messages: fallbackMessages,
      compacted: false,
      fellBack: true,
      afterMessageCount: fallbackMessages.length,
      afterChars: countTranscriptChars(fallbackMessages),
      summaryChars: 0,
      summarizedMessageCount: plan.span.length,
      carriesPreviousSummary: plan.carriesPreviousSummary,
      failureReason: error instanceof Error ? error.message : String(error),
    }
  }
}
