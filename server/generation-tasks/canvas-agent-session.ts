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
