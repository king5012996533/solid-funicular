import type { GenerationTaskStartPayload, GenerationTaskStreamEvent } from './shared'
import type { GenerationRecordPayload } from '../generation-records/shared'
import type { RuntimeManagedTask } from './task-runtime-governor'

// 与运行时治理层、策略层统一同一份任务类型（详见 execution-strategies.ts 的说明）
type AudioExecutionTask = RuntimeManagedTask

type AudioTaskRetryState = {
  attempt: number
  waitDurationMs: number
  status: number
  errorPreview: string
  stage: string
}

export interface AudioTaskExecutorContext {
  syncSharedTaskRuntime: (task: AudioExecutionTask, status: 'running' | 'completed') => Promise<void>
  ensureTaskNotAborted: (task: AudioExecutionTask) => Promise<void>
  emitTaskProgressEvent: (recordId: string, input: {
    stage: string
    stopped?: boolean
    message?: string
  }) => void
  markTaskRetryState: (task: AudioExecutionTask, input: AudioTaskRetryState) => Promise<void>
  requestAudioGeneration: (input: {
    signal: AbortSignal
    providerId: string
    modelKey: string
    requestBody: Record<string, unknown>
    onRetry?: (retryState: AudioTaskRetryState) => Promise<void> | void
  }) => Promise<{ upstreamUrl: string; audioUrls: string[] }>
  buildInitialRecordPayload: (payload: GenerationTaskStartPayload) => GenerationRecordPayload
  // 实现层返回更新后的记录；这里只关心写成功与否
  updateGenerationRecord: (recordId: string, payload: GenerationRecordPayload, currentUserId: string) => Promise<unknown>
  getGenerationRecordById: (recordId: string, currentUserId: string) => Promise<Record<string, unknown>>
  emitTaskStreamEvent: (recordId: string, event: GenerationTaskStreamEvent) => void
  logGenerationTask: (stage: string, detail: Record<string, unknown>) => void
}

// 从 data URL / 扩展名推导音频 MIME，写进 GenerationOutput.mimeType 供前端选播放器与下载名。
const resolveAudioMimeType = (url: string) => {
  const dataMatch = url.match(/^data:([^;,]+)[;,]/i)
  if (dataMatch?.[1]) {
    return dataMatch[1].toLowerCase()
  }

  const lowerUrl = url.toLowerCase()
  if (lowerUrl.includes('.wav')) return 'audio/wav'
  if (lowerUrl.includes('.ogg') || lowerUrl.includes('.oga')) return 'audio/ogg'
  if (lowerUrl.includes('.m4a')) return 'audio/mp4'
  if (lowerUrl.includes('.aac')) return 'audio/aac'
  return 'audio/mpeg'
}

const resolveAudioDurationSeconds = (requestBody: Record<string, unknown>) => {
  const rawSeconds = Number(requestBody.seconds ?? requestBody.duration)
  return Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.trunc(rawSeconds) : undefined
}

// 独立承接音频任务执行主干，形状照 image-task-executor（同一套进度事件与收尾）。
export const executeAudioTask = async (
  task: AudioExecutionTask,
  payload: GenerationTaskStartPayload,
  context: AudioTaskExecutorContext,
) => {
  await context.syncSharedTaskRuntime(task, 'running')
  await context.ensureTaskNotAborted(task)

  const modelKey = String(payload.modelKey || '').trim()
  if (!modelKey) {
    throw new Error('缺少音频模型标识')
  }

  const providerId = String((payload.requestBody || {}).providerId || '').trim()
  if (!providerId) {
    throw new Error('缺少音频厂商配置')
  }

  context.emitTaskProgressEvent(task.recordId, {
    stage: 'resolved_provider',
    message: '已解析厂商与模型配置，准备请求上游音频接口',
  })

  // 显式标成 Record<string, unknown>，否则 TS 会把这里推成窄对象，读 requestBody.seconds/duration 报属性不存在。
  const requestBody: Record<string, unknown> = {
    ...(payload.requestBody || {}),
    model: modelKey,
  }

  context.logGenerationTask('audio_task:request_start', {
    recordId: task.recordId,
    userId: task.userId,
    modelKey,
  })
  context.emitTaskProgressEvent(task.recordId, {
    stage: 'requesting_upstream',
    message: '已开始请求上游音频模型',
  })

  const { upstreamUrl, audioUrls } = await context.requestAudioGeneration({
    signal: task.abortController.signal,
    providerId,
    modelKey,
    requestBody,
    onRetry: (retryState) => context.markTaskRetryState(task, retryState),
  })
  await context.ensureTaskNotAborted(task)

  // requestAudioGeneration 内部已在上游无音频地址时抛错；这里再兜一道，绝不允许静默写「成功但没结果」。
  if (!audioUrls.length) {
    throw new Error('未能获取到生成的音频')
  }

  context.logGenerationTask('audio_task:request_upstream', {
    recordId: task.recordId,
    userId: task.userId,
    upstreamUrl,
    modelKey,
  })
  context.emitTaskProgressEvent(task.recordId, {
    stage: 'receiving_upstream_result',
    message: '上游已返回结果，正在解析音频内容',
  })
  context.emitTaskProgressEvent(task.recordId, {
    stage: 'syncing_record',
    message: '音频结果已解析，正在同步记录与资源信息',
  })

  const durationSeconds = resolveAudioDurationSeconds(requestBody)
  const outputs = audioUrls.map((url, index) => ({
    outputType: 'audio' as const,
    url,
    mimeType: resolveAudioMimeType(url),
    durationSeconds,
    sortOrder: index,
  }))

  await context.updateGenerationRecord(task.recordId, {
    ...context.buildInitialRecordPayload(payload),
    done: true,
    stopped: false,
    outputs,
  }, task.userId)
  const completedRecord = await context.getGenerationRecordById(task.recordId, task.userId)
  await context.syncSharedTaskRuntime(task, 'completed')
  context.emitTaskStreamEvent(task.recordId, {
    type: 'completed',
    recordId: task.recordId,
    done: true,
    stopped: false,
    record: completedRecord,
    stage: 'completed',
    message: '音频生成完成，结果已写入记录',
  })

  context.logGenerationTask('audio_task:request_success', {
    recordId: task.recordId,
    userId: task.userId,
    audioCount: outputs.length,
  })
}
