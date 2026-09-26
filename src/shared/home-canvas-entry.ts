/**
 * 首页「说一句 → 新建画布 → 自动交给 Agent」的纯逻辑。
 *
 * 抽成独立模块是为了可单测：命名规则、一次性标记的读写/消费、以及「什么时候该自动发送」
 * 都不依赖 Vue 与浏览器（存储可注入）。组件只负责把结论接到既有的发送路径上。
 */

/** 「待发送给 Agent」标记的存储键（sessionStorage，按标签页隔离） */
export const HOME_CANVAS_AGENT_PENDING_KEY = 'canana:home-canvas:pending-agent-send'

/** 画布名取用户那句话的前 N 个字符 */
export const HOME_CANVAS_NAME_MAX_LENGTH = 14

/** 用户那句话为空时兜底的项目名 */
export const FALLBACK_CANVAS_NAME = '未命名项目'

/** 只要 get/set/remove，方便单测注入内存实现 */
export interface HomeCanvasPendingStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface HomeCanvasAgentPending {
  workflowId: string
  message: string
}

const resolveDefaultStorage = (): HomeCanvasPendingStorage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    // 隐私模式等场景访问 sessionStorage 会抛异常：当作没有存储，放弃自动发送
    return null
  }
}

/**
 * 用用户那句话当画布名：折叠空白（含换行）→ 去首尾空格 → 取前 14 个字符。
 *
 * 按码点截断而不是按 UTF-16 单元，避免把 emoji 这类代理对从中间切开。
 * 空串（或只有空白）返回「未命名项目」。
 */
export const resolveHomeCanvasName = (message: string): string => {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return FALLBACK_CANVAS_NAME

  const chars = Array.from(normalized)
  if (chars.length <= HOME_CANVAS_NAME_MAX_LENGTH) return normalized
  return `${chars.slice(0, HOME_CANVAS_NAME_MAX_LENGTH).join('')}…`
}

/** 写标记：只有画布 id 与话都在才写，坏的载荷宁可不写（不写就不会误发） */
export const writeHomeCanvasAgentPending = (
  pending: HomeCanvasAgentPending,
  storage: HomeCanvasPendingStorage | null = resolveDefaultStorage(),
): void => {
  if (!storage) return
  const workflowId = String(pending?.workflowId || '').trim()
  const message = String(pending?.message || '').trim()
  if (!workflowId || !message) return
  try {
    storage.setItem(HOME_CANVAS_AGENT_PENDING_KEY, JSON.stringify({ workflowId, message }))
  } catch {
    // 存不下就放弃自动发送：宁可让用户手打一遍，也不要在画布上乱发
  }
}

/**
 * 只读探测（不消费）：标记存在、且正好指向这块画布时返回载荷。
 *
 * 不匹配的标记（残留、串台）不返回 —— 自动发送只认「那次带标记的导航」目标的那张画布。
 */
export const readHomeCanvasAgentPending = (
  expectedWorkflowId: string,
  storage: HomeCanvasPendingStorage | null = resolveDefaultStorage(),
): HomeCanvasAgentPending | null => {
  if (!storage) return null
  const expected = String(expectedWorkflowId || '').trim()
  if (!expected) return null

  let raw: string | null = null
  try {
    raw = storage.getItem(HOME_CANVAS_AGENT_PENDING_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as HomeCanvasAgentPending
    const workflowId = String(parsed?.workflowId || '').trim()
    const message = String(parsed?.message || '').trim()
    if (workflowId !== expected || !message) return null
    return { workflowId, message }
  } catch {
    return null
  }
}

/**
 * 一次性消费：读取后**立刻删除标记**，再交给发送。
 *
 * 顺序是刻意的 —— 先清再发：HMR、组件重复挂载、刷新页面时标记已经不在，
 * 同一句话就不会被第二次交给 Agent。与当前画布不匹配的残留标记同样被清掉，避免它飘到别的画布上误发。
 * 删除失败时按「没消费成功」处理（返回 null）：宁可不发，也不冒重复发送的风险。
 */
export const consumeHomeCanvasAgentPending = (
  expectedWorkflowId: string,
  storage: HomeCanvasPendingStorage | null = resolveDefaultStorage(),
): HomeCanvasAgentPending | null => {
  if (!storage) return null
  const pending = readHomeCanvasAgentPending(expectedWorkflowId, storage)
  try {
    storage.removeItem(HOME_CANVAS_AGENT_PENDING_KEY)
  } catch {
    return null
  }
  return pending
}

export interface AutoSendToAgentState {
  /** 当前画布上存在待发送标记 */
  hasFlag: boolean
  /** 画布已就绪（画布数据已载入 + 会话已绑定） */
  canvasReady: boolean
  /** Agent 正在跑一轮 */
  running: boolean
  /** 画布存在有效流水线锁（被别的流水线占用） */
  locked: boolean
  /** 这次的标记已经被消费过（同一挂载内的幂等保险） */
  consumed: boolean
}

/** 全部条件满足才自动发送：就绪、空闲、无锁、标记未被消费 */
export const shouldAutoSendToAgent = (state: AutoSendToAgentState): boolean => {
  return Boolean(
    state
      && state.hasFlag
      && state.canvasReady
      && !state.running
      && !state.locked
      && !state.consumed,
  )
}

export type AutoSendBlockReason = 'none' | 'wait' | 'occupied'

/**
 * 不该自动发送时的原因：
 * · none —— 没有标记 / 已消费，什么都不用做；
 * · wait —— 画布未就绪或正在跑，等状态变化后重判；
 * · occupied —— 画布被别的流水线占用，把话填进输入框即可，**绝不绕过锁**。
 */
export const resolveAutoSendBlockReason = (state: AutoSendToAgentState): AutoSendBlockReason => {
  if (!state || !state.hasFlag || state.consumed) return 'none'
  if (!state.canvasReady || state.running) return 'wait'
  if (state.locked) return 'occupied'
  return 'none'
}
