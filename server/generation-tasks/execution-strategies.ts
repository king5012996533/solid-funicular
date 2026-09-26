import type { GenerationTaskStartPayload, GenerationTaskStreamEvent } from './shared'
import type { GenerationRecordPayload } from '../generation-records/shared'
import type { GenerationTaskStrategyKey } from './strategy'
import type { AgentRunState } from '../../src/types/agent'
import type { RuntimeManagedTask, SyncStatus } from './task-runtime-governor'

export type TaskAbortReason = 'user_stop' | 'shared_stop' | 'execution_lock_lost'

/**
 * 结算路径手上的任务对象。
 *
 * 以前这里是**第三份**最小类型 `{recordId, userId, strategyKey}`，而运行时治理层（task-runtime-governor）
 * 用的是 `RuntimeManagedTask`（多一个 `type`）、各执行器又各自声明了第四、第五份
 * `{recordId, userId, abortController}`。三份形状互相不可赋值，于是上下文对象一传递就报 33 处类型错
 * （2026-09-23 清债时发现）。现在统一用治理层那一份 —— 运行时本来就是同一个对象。
 */
type SettlementTask = RuntimeManagedTask

type SettlementRecord = Record<string, unknown> & {
  content?: string
  agentRun?: AgentRunState | null
}

/**
 * 任务进度事件。字段取各执行器用到的并集（`record`/`done` 是工作台那套在传）——
 * 以前只声明 stage/stopped/message，工作台执行器按自己的形状传 record 就报类型错。
 */
export type EmitTaskProgressEvent = (recordId: string, event: {
  stage: string
  message?: string
  stopped?: boolean
  done?: boolean
  record?: Record<string, unknown> | null
}) => void

type EmitTaskStreamEvent = (recordId: string, event: GenerationTaskStreamEvent) => void

export interface GenerationTaskExecutionStrategyContext {
  executeImageGenerationTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  /** 视频：异步任务制（建单 → 轮询 → 取件） */
  executeVideoGenerationTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  /** 音频：一次请求返回成品，形状与图片同策 */
  executeAudioGenerationTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  executeAgentChatTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  /** 制片 Agent（画布）：Pi 循环跑在服务端，画布工具经事件流交给浏览器执行 */
  executeCanvasAgentTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  executeAgentWorkspaceTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  executeResearchReportTask: (task: SettlementTask, payload: GenerationTaskStartPayload) => Promise<void>
  refundTaskPointsIfNeeded: (task: SettlementTask, reason: string) => Promise<void>
  markTaskExecutionState: (task: SettlementTask, input: {
    lastErrorAt?: string
    lastErrorMessage?: string
  }) => Promise<void>
  emitTaskProgressEvent: EmitTaskProgressEvent
  emitTaskStreamEvent: EmitTaskStreamEvent
  buildInitialRecordPayload: (payload: GenerationTaskStartPayload) => GenerationRecordPayload
  // 实现层返回更新后的记录；这里只关心「写成功了没有」，所以返回值类型放宽（写 void 会让实现无法赋值）
  updateGenerationRecord: (recordId: string, payload: GenerationRecordPayload, currentUserId: string) => Promise<unknown>
  getGenerationRecordById: (recordId: string, currentUserId: string) => Promise<SettlementRecord>
  syncSharedTaskRuntime: (task: SettlementTask, status: SyncStatus, extra?: Record<string, unknown>) => Promise<void>
  buildAgentStoppedRun: (agentRun: AgentRunState, message: string) => AgentRunState
  buildAgentErrorRun: (agentRun: AgentRunState, message: string) => AgentRunState
  normalizeGenerationErrorMessage: (error: unknown, fallbackMessage: string) => string
  logGenerationTask: (stage: string, detail: Record<string, unknown>) => void
  logGenerationTaskError: (stage: string, error: unknown, detail: Record<string, unknown>) => void
}

export interface GenerationTaskExecutionStrategy {
  key: GenerationTaskStrategyKey
  execute: (
    task: SettlementTask,
    payload: GenerationTaskStartPayload,
    context: GenerationTaskExecutionStrategyContext,
  ) => Promise<void>
  handleStopped: (
    task: SettlementTask,
    payload: GenerationTaskStartPayload,
    context: GenerationTaskExecutionStrategyContext,
  ) => Promise<void>
  handleFailed: (
    task: SettlementTask,
    payload: GenerationTaskStartPayload,
    error: unknown,
    errorMessage: string,
    context: GenerationTaskExecutionStrategyContext,
  ) => Promise<void>
  resolveFailureMessage: (
    error: unknown,
    abortReason: TaskAbortReason | '',
    context: GenerationTaskExecutionStrategyContext,
  ) => string
}

// 图片生成任务的收口逻辑相对固定，集中在这里，避免 service.ts 持续堆分支。
const imageTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'image',
  execute(task, payload, context) {
    return context.executeImageGenerationTask(task, payload)
  },
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '任务已收到停止指令',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'stopping',
      stopped: true,
      message: '任务已收到停止指令，正在收口状态',
    })
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: true,
      error: '',
      images: [],
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '任务已停止',
    })
    context.logGenerationTask('image_task:stopped', {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage,
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'failing',
      message: '任务执行异常，正在写入失败状态',
    })
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: false,
      error: errorMessage,
      images: [],
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage,
    })
    context.logGenerationTaskError('image_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次生成'
    }

    return context.normalizeGenerationErrorMessage(error, '图片生成失败')
  },
}

// 音频生成任务与图片同策：收口只需退分、写终态记录并广播事件。
const audioTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'audio',
  execute(task, payload, context) {
    return context.executeAudioGenerationTask(task, payload)
  },
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '任务已收到停止指令',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'stopping',
      stopped: true,
      message: '任务已收到停止指令，正在收口状态',
    })
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: true,
      error: '',
      outputs: [],
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '音频生成已停止',
    })
    context.logGenerationTask('audio_task:stopped', {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage,
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'failing',
      message: '音频生成异常，正在写入失败状态',
    })
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: false,
      error: errorMessage,
      outputs: [],
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage,
    })
    context.logGenerationTaskError('audio_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次生成'
    }

    return context.normalizeGenerationErrorMessage(error, '音频生成失败')
  },
}

// Agent 对话任务需要保留已有内容，因此与图片任务分开策略化处理。
const agentChatTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'agent-chat',
  execute(task, payload, context) {
    return context.executeAgentChatTask(task, payload)
  },
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '任务已收到停止指令',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'stopping',
      stopped: true,
      message: '任务已收到停止指令，正在收口状态',
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: String(currentRecord.content || ''),
      done: true,
      stopped: true,
      error: '',
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '任务已停止',
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage,
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'failing',
      message: '任务执行异常，正在写入失败状态',
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: String(currentRecord.content || ''),
      done: true,
      stopped: false,
      error: errorMessage,
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage,
    })
    context.logGenerationTaskError('agent_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次任务'
    }

    return context.normalizeGenerationErrorMessage(error, '对话生成失败')
  },
}

/**
 * 制片 Agent 的收口与 agent-chat 同策：它也是对话型任务，产出落在 record.content 上。
 * 不同的是**它跑的过程中会改画布**：中途被停止/失败时画布上已经落下的节点不该被回滚
 * （用户看得见的成果，回滚反而是破坏），所以两边都不做「撤销画布改动」这类动作，
 * 只在提示里如实说明「本轮没跑完」。
 */
const canvasAgentTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  ...agentChatTaskExecutionStrategy,
  key: 'canvas-agent',
  execute(task, payload, context) {
    return context.executeCanvasAgentTask(task, payload)
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次任务'
    }

    return context.normalizeGenerationErrorMessage(error, '制片 Agent 执行失败')
  },
}

// Agent 工作台任务需要同步 agentRun 的停止态与失败态，因此单独策略化。
const agentWorkspaceTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'agent-workspace',
  execute(task, payload, context) {
    return context.executeAgentWorkspaceTask(task, payload)
  },
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '任务已收到停止指令',
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    const stoppedRun = currentRecord.agentRun
      ? context.buildAgentStoppedRun(currentRecord.agentRun, '任务已停止')
      : null
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: '',
      agentRun: stoppedRun,
      done: true,
      stopped: true,
      error: '',
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '任务已停止',
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage,
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    const errorRun = currentRecord.agentRun
      ? context.buildAgentErrorRun(currentRecord.agentRun, errorMessage)
      : null
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: '',
      agentRun: errorRun,
      done: true,
      stopped: false,
      error: errorMessage,
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage,
    })
    context.logGenerationTaskError('agent_workspace_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次任务'
    }

    return context.normalizeGenerationErrorMessage(error, '对话生成失败')
  },
}

const videoTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'video',
  execute(task, payload, context) {
    return context.executeVideoGenerationTask(task, payload)
  },
  /**
   * 收口与图片同策（2026-09-25 修）。
   *
   * 之前这里只退分 + 记一行状态，**既没写记录也没发终止事件**：画布上的视频节点靠事件流
   * 收尾，收不到 terminated 事件就永远停在「生成中」；刷新后记录还是 RUNNING，
   * 用户既看不到结果也停不下来。而上游对 failed/timeout/cancelled 会全额退分给我们，
   * 所以收口时必须同步退给用户（退款走既有 refundGenerationPoints，不手写流水）。
   */
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '任务已收到停止指令',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'stopping',
      stopped: true,
      message: '视频生成已收到停止指令，正在收口状态',
    })
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: true,
      error: '',
      outputs: [],
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '视频生成已停止',
    })
    context.logGenerationTask('video_task:stopped', {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    // 视频是长任务，失败退款与图片同策（没拿到成品就退；上游 failed/timeout/cancelled 也全额退给我们）
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage || '视频生成失败',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'failing',
      message: '视频生成异常，正在写入失败状态',
    })
    // 失败也要把记录写成终态：只发事件不写记录的话，刷新后界面又回到「生成中」
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: false,
      error: errorMessage || '视频生成失败',
      outputs: [],
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage || '视频生成失败',
    })
    context.logGenerationTaskError('video_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '任务执行锁已失效，系统已中断本次生成'
    }
    // 上游的原因（超时/内容被拒/额度不足/参考图不可达）优先原样透出，便于用户判断能不能重试
    const message = error instanceof Error ? error.message : String(error)
    if (!message) return context.normalizeGenerationErrorMessage(error, '视频生成失败')
    return message.length > 200 ? `${message.slice(0, 200)}…` : message
  },
}

const researchReportTaskExecutionStrategy: GenerationTaskExecutionStrategy = {
  key: 'research-report',
  execute(task, payload, context) {
    return context.executeResearchReportTask(task, payload)
  },
  async handleStopped(task, payload, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_aborted')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: '研究任务已收到停止指令',
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'stopping',
      stopped: true,
      message: '研究任务已收到停止指令，正在收口状态',
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: String(currentRecord.content || ''),
      done: true,
      stopped: true,
      error: '',
    }, task.userId)
    const stoppedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'stopped')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'stopped',
      recordId: task.recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '研究任务已停止',
    })
  },
  async handleFailed(task, payload, error, errorMessage, context) {
    await context.refundTaskPointsIfNeeded(task, 'task_failed')
    await context.markTaskExecutionState(task, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: errorMessage,
    })
    context.emitTaskProgressEvent(task.recordId, {
      stage: 'failing',
      message: '研究任务执行异常，正在写入失败状态',
    })
    const currentRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.updateGenerationRecord(task.recordId, {
      ...context.buildInitialRecordPayload(payload),
      content: String(currentRecord.content || ''),
      done: true,
      stopped: false,
      error: errorMessage,
    }, task.userId)
    const failedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
    await context.syncSharedTaskRuntime(task, 'failed')
    context.emitTaskStreamEvent(task.recordId, {
      type: 'failed',
      recordId: task.recordId,
      done: true,
      stopped: false,
      record: failedRecord,
      stage: 'failed',
      message: errorMessage,
    })
    context.logGenerationTaskError('research_task:failed', error, {
      recordId: task.recordId,
      userId: task.userId,
    })
  },
  resolveFailureMessage(error, abortReason, context) {
    if (abortReason === 'execution_lock_lost') {
      return '研究任务执行锁已失效，系统已中断本次任务'
    }

    return context.normalizeGenerationErrorMessage(error, '研究报告生成失败')
  },
}

const EXECUTION_STRATEGY_REGISTRY: Record<GenerationTaskStrategyKey, GenerationTaskExecutionStrategy> = {
  image: imageTaskExecutionStrategy,
  video: videoTaskExecutionStrategy,
  audio: audioTaskExecutionStrategy,
  'agent-chat': agentChatTaskExecutionStrategy,
  'canvas-agent': canvasAgentTaskExecutionStrategy,
  'agent-workspace': agentWorkspaceTaskExecutionStrategy,
  'research-report': researchReportTaskExecutionStrategy,
}

// 按策略键获取执行策略；当前优先承接停止/失败收口逻辑。
export const getGenerationTaskExecutionStrategy = (strategyKey: GenerationTaskStrategyKey) => {
  const strategy = EXECUTION_STRATEGY_REGISTRY[strategyKey]
  if (!strategy) {
    throw new Error('未找到对应的生成任务执行策略')
  }

  return strategy
}
