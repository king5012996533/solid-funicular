import type { GenerationTaskStreamEvent } from './shared'
import type { GenerationTaskStrategyKey } from './strategy'

export interface LocalRunningGenerationTask {
  recordId: string
  userId: string
  type: 'image' | 'agent' | 'research'
  // 用策略键联合类型（而不是宽松 string）：运行时治理层的 RuntimeManagedTask 依赖它做收窄
  strategyKey: GenerationTaskStrategyKey
  abortController: AbortController
  associationNo: string
  billedEndpointType: 'chat' | 'image' | 'video'
  billedPointCost: number
  billedProviderId: string
  billedModelKey: string
  billedModelName: string
  refundCommitted: boolean
  // 任务创建时占用的并发槽位，结束后需要统一释放。
  concurrencySlots?: Array<{
    scope: 'user' | 'skill' | 'provider'
    key: string
    limit: number
    currentCount: number
  }>
}

const runningGenerationTasks = new Map<string, LocalRunningGenerationTask>()
const taskStreamSubscribers = new Map<string, Set<any>>()
// 用户级订阅计数：防止同一用户开过多 SSE 连接耗尽资源
const userStreamSubscribers = new Map<string, Set<any>>()
// 每用户最多并发 SSE 订阅数（典型场景：多标签页 + 工作流多节点同时执行）
export const SSE_PER_USER_LIMIT = Number.parseInt(process.env.SSE_PER_USER_LIMIT || '20', 10)

/**
 * 终态事件：发出这条之后这次任务就不会再有事件了。
 * 与前端 src/api/generation-tasks.ts 的 TERMINAL_EVENT_TYPES 同口径。
 */
const TERMINAL_TASK_STREAM_EVENT_TYPES = new Set(['completed', 'failed', 'stopped', 'end'])

export const setLocalRunningTask = (task: LocalRunningGenerationTask) => {
  runningGenerationTasks.set(task.recordId, task)
}

export const getLocalRunningTask = (recordId: string) => runningGenerationTasks.get(recordId)

export const hasLocalRunningTask = (recordId: string) => runningGenerationTasks.has(recordId)

export const deleteLocalRunningTask = (recordId: string) => {
  runningGenerationTasks.delete(recordId)
}

// 检查用户当前的 SSE 并发订阅数是否已达上限
export const isUserStreamSubscriberLimitReached = (userId: string) => {
  const set = userStreamSubscribers.get(userId)
  return (set?.size || 0) >= SSE_PER_USER_LIMIT
}

export const addTaskStreamSubscriber = (recordId: string, res: any, userId?: string) => {
  let subscribers = taskStreamSubscribers.get(recordId)
  if (!subscribers) {
    subscribers = new Set()
    taskStreamSubscribers.set(recordId, subscribers)
  }
  subscribers.add(res)

  if (userId) {
    let userSet = userStreamSubscribers.get(userId)
    if (!userSet) {
      userSet = new Set()
      userStreamSubscribers.set(userId, userSet)
    }
    userSet.add(res)
  }
}

export const removeTaskStreamSubscriber = (recordId: string, res: any, userId?: string) => {
  const subscribers = taskStreamSubscribers.get(recordId)
  if (subscribers) {
    subscribers.delete(res)
    if (subscribers.size === 0) {
      taskStreamSubscribers.delete(recordId)
    }
  }

  if (userId) {
    const userSet = userStreamSubscribers.get(userId)
    if (userSet) {
      userSet.delete(res)
      if (userSet.size === 0) {
        userStreamSubscribers.delete(userId)
      }
    }
  }
}

export const getTaskStreamSubscriberCount = (recordId: string) => taskStreamSubscribers.get(recordId)?.size || 0

// 统一向当前实例上的 SSE 连接写事件，不关心事件来自本地还是 Redis 广播。
//
// backpressure 策略：当 res.write 返回 false 表示 socket 写入缓冲已满
// （客户端处理太慢），主动断开该连接，让客户端通过自动重连 + lastEventId
// 重放遗漏事件，避免内存被慢客户端撑爆。
export const emitLocalTaskStreamEvent = (recordId: string, event: GenerationTaskStreamEvent) => {
  const subscribers = taskStreamSubscribers.get(recordId)
  if (!subscribers?.size) {
    return
  }

  // 写入 SSE 标准 id 字段，让客户端跟踪 lastEventId 用于断线重连定位
  const idLine = event.id !== undefined ? `id: ${event.id}\n` : ''
  const payload = `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  // 写入失败（连接已断）与缓冲已满一样，都走「主动断开」这条路径：
  // 调 res.end() 触发订阅侧的 close 处理器统一退订。只在本地集合里 delete、不 end()，
  // 会让用户级计数（userStreamSubscribers）永远留下这一项 —— 是「攒到 20 就 429」的成因之一。
  const slowSubscribers: any[] = []
  for (const res of subscribers) {
    try {
      const ok = res.write(payload)
      if (ok === false) {
        // 缓冲已满：标记为待断开，避免后续事件继续堆积内存
        slowSubscribers.push(res)
      }
    } catch {
      slowSubscribers.push(res)
    }
  }

  // 慢订阅者断开连接，触发客户端通过自动重连 + lastEventId 恢复
  for (const res of slowSubscribers) {
    subscribers.delete(res)
    try {
      res.end()
    } catch {
      // 已经断开就忽略
    }
  }

  /**
   * 终态事件发完，服务端主动关掉连接。
   *
   * 前端收到 completed/failed/stopped 后已经会主动断开，但**不能只靠前端**：
   * 旧版页面、被缓存的 bundle、非浏览器的客户端都可能一直挂着这条连接 —— 而每条连接
   * 都占着该用户的实时订阅额度（SSE_PER_USER_LIMIT，默认 20），一直占到位列寿命上限
   * （SSE_MAX_CONNECTION_MS，默认 30 分钟）。攒满就是「订阅任务状态失败 (429)」。
   *
   * 终态之后本来也不会再有事件，收在这里最省事：连接一关，订阅侧的 close 处理器
   * 自然把用户级计数与分布式订阅一起退掉。
   */
  if (TERMINAL_TASK_STREAM_EVENT_TYPES.has(String(event.type))) {
    for (const res of subscribers) {
      try {
        res.end()
      } catch {
        // 已经断开就忽略
      }
    }
  }

  if (subscribers.size === 0) {
    taskStreamSubscribers.delete(recordId)
  }
}
