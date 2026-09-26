import type { GenerationRecordPayload } from '../generation-records/shared'
import type { GenerationTaskStartPayload, GenerationTaskStreamEvent } from './shared'
import type { GenerationTaskStrategyKey } from './strategy'
import type { AgentRunState } from '../../src/types/agent'
import { GenerationTaskRequestError } from './shared'
import { readCapabilityFlagsFromRequestBody, type ModelCapabilityFlags } from '../../src/shared/provider-capability'
import {
  buildNormalizedGenerationParams,
  ModelPricingRefusedError,
  type NormalizedGenerationParams,
  type PricingFallbackReason,
} from '../../src/shared/model-pricing-rules'
import type { RuntimeManagedTask } from './task-runtime-governor'

// 统一用治理层那一份任务类型（见 task-runtime-governor.ts 的说明）
type RunningGenerationTask = RuntimeManagedTask

type ConcurrencySlot = {
  scope: 'user' | 'skill' | 'provider'
  key: string
  limit: number
  currentCount: number
}

type CreatedRecord = {
  id: string
  type: string
  prompt: string
  content: string
  error: string
  model: string
  modelKey: string
  ratio: string
  resolution: string
  duration: string
  feature: string
  skill: string
  done: boolean
  stopped?: boolean
  images?: string[]
  agentRun?: AgentRunState | null
}

type BillingDetail = {
  pointCost: number
  modelName: string
}

export interface TaskLifecycleContext {
  resolveGenerationTaskStrategy: (payload: GenerationTaskStartPayload) => {
    key: GenerationTaskStrategyKey
  }
  buildTaskSubmissionIdempotencyKey: (input: {
    userId: string
    strategyKey: string
    providerId: string
    modelKey: string
    skill: string
    prompt: string
    requestMode: string
    referenceImages: string[]
    requestBody: Record<string, unknown> | null
  }) => string
  claimIdempotencyKey: <T>(key: string) => Promise<{
    // 与 server/redis/idempotency.ts 的 IdempotencyClaimResult 对齐：实现返回的是 'acquired'
    // （原声明写成 'claimed'，没有任何地方消费过这个名字，纯属叫法过期）
    state: 'completed' | 'in_progress' | 'acquired'
    data?: T
    // 实现里只有 acquired 时才带 token，声明跟着放宽
    token?: string
  }>
  completeIdempotencyKey: (key: string, token: string, data: { recordId: string }) => Promise<void>
  clearPendingIdempotencyKey: (key: string, token: string) => Promise<void>
  getGenerationRecordById: (recordId: string, currentUserId: string) => Promise<CreatedRecord>
  createGenerationRecord: (payload: GenerationRecordPayload, currentUserId: string) => Promise<CreatedRecord>
  // 实现层返回更新后的记录；这里只关心写成功与否
  updateGenerationRecord: (recordId: string, payload: GenerationRecordPayload, currentUserId: string) => Promise<unknown>
  attachGenerationPointRecordId: (input: {
    associationNo: string
    userId: string
    generationRecordId: string
    // 实现层返回更新后的积分流水（可能是 null），这里只关心写成功与否
  }) => Promise<unknown>
  resolveGenerationPointCost: (input: {
    providerId: string
    modelKey: string
    endpointType: 'chat' | 'image'
    capabilityFlags?: ModelCapabilityFlags | null
  }) => Promise<BillingDetail>
  /**
   * 读 `model_pricing` 定价表的结算入口（M3 试点），与上面的 resolveGenerationPointCost 是两条不同的账：
   *   - resolveGenerationPointCost：读模型里扁平的 billingPower，且支持能力开关倍率 → **对话链路继续用它**
   *     （能力倍率只在这条链路上有意义，且 chat 模型现全库未配价、行为要保持不变）。
   *   - resolveModelPricingCost：读结构化定价表 + 接收真实请求参数 → 图片/视频结算与预估接口都用它，
   *     从而与预估接口共用同一个算法，保证「预估 = 实扣」。
   * 返回里的 usingDraft 仅用于打日志（只有「读配置本身失败」才走草案兜底）；
   * 未配价 / 未标定 / 规格匹配不到档位会返回 refuse=true，建单路径据此**在扣费前**拒绝生成。
   */
  resolveModelPricingCost: (input: {
    providerId: string
    modelKey: string
    endpointType: 'image' | 'video' | 'audio'
    params?: NormalizedGenerationParams
  }) => Promise<{
    pointCost: number
    usingDraft: boolean
    fallbackReason?: PricingFallbackReason
    refuse: boolean
    refuseReason?: PricingFallbackReason
    detail: string
    modelName: string
  }>
  consumeGenerationPoints: (input: {
    userId: string
    pointCost: number
    sourceId: string
    associationNo: string
    endpointType: 'chat' | 'image' | 'video' | 'audio'
    providerId: string
    modelKey: string
    modelName: string
    metaJson: Record<string, unknown>
  }) => Promise<unknown>
  /**
   * 退回已扣但任务没建起来的积分（见 startGenerationTask 的 catch）。
   *
   * 「扣分」与「建单」分属两个事务（consumeGenerationPoints 自己提交），建单失败时
   * 扣费不会自动回滚 —— 必须显式退，否则用户被白扣且无记录可查。
   */
  refundGenerationPoints: (input: {
    userId: string
    pointCost: number
    sourceId: string
    associationNo: string
    endpointType: 'chat' | 'image' | 'video' | 'audio'
    providerId: string
    modelKey: string
    modelName: string
    metaJson: Record<string, unknown>
  }) => Promise<unknown>
  acquireTaskConcurrencySlots: (input: {
    userId: string
    providerId: string
    skillKey: string
  }) => Promise<ConcurrencySlot[]>
  releaseTaskConcurrencySlots: (slots: ConcurrencySlot[]) => Promise<void>
  buildAgentPendingRun: (
    recordId: string,
    query: string,
    skill: string,
    referenceImages?: string[],
  ) => AgentRunState
  buildGatewayAssociationNo: () => string
  setLocalRunningTask: (task: RunningGenerationTask) => void
  syncSharedTaskRuntime: (
    task: RunningGenerationTask,
    status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped',
    extra?: Record<string, unknown>,
  ) => Promise<void>
  emitTaskStreamEvent: (recordId: string, event: GenerationTaskStreamEvent) => void
  logGenerationTask: (stage: string, detail: Record<string, unknown>) => void
  runTaskInBackground: (task: RunningGenerationTask, payload: GenerationTaskStartPayload) => void
  resolveTaskRecordSnapshot: (recordId: string, currentUserId: string) => Promise<any>
  getLocalRunningTask: (recordId: string) => RunningGenerationTask | undefined
  getSharedTaskRuntime: (recordId: string) => Promise<{
    status?: string
  } | null>
  markSharedTaskAbortRequested: (recordId: string) => Promise<void>
  abortTaskWithReason: (task: RunningGenerationTask, reason: 'user_stop') => void
}

export const buildInitialRecordPayload = (payload: GenerationTaskStartPayload): GenerationRecordPayload => ({
  sessionId: String(payload.sessionId || '').trim() || undefined,
  source: String(payload.source || 'generate').trim() || 'generate',
  type: payload.type === 'research' || String(payload.skill || '').trim() === 'research-report'
    ? 'research'
    : payload.type,
  prompt: String(payload.prompt || '').trim(),
  content: '',
  error: '',
  model: String(payload.model || '').trim(),
  modelKey: String(payload.modelKey || '').trim(),
  ratio: String(payload.ratio || '').trim(),
  resolution: String(payload.resolution || '').trim(),
  duration: String(payload.duration || '').trim(),
  feature: String(payload.feature || '').trim(),
  skill: String(payload.skill || '').trim() || 'general',
  referenceImages: Array.isArray(payload.referenceImages) ? [...payload.referenceImages] : [],
  done: false,
  stopped: false,
  images: [],
})

const buildGenerationTaskIdempotencyKey = (
  payload: GenerationTaskStartPayload,
  userId: string,
  strategyKey: string,
  providerId: string,
  modelKey: string,
  context: TaskLifecycleContext,
) => {
  return context.buildTaskSubmissionIdempotencyKey({
    userId,
    strategyKey,
    providerId,
    modelKey,
    skill: String(payload.skill || '').trim(),
    prompt: String(payload.prompt || '').trim(),
    requestMode: String(payload.requestMode || '').trim(),
    referenceImages: Array.isArray(payload.referenceImages) ? payload.referenceImages : [],
    requestBody: payload.requestBody || null,
  })
}

const resolveTaskSkillKey = (payload: GenerationTaskStartPayload, strategyKey: GenerationTaskStrategyKey) => {
  return String(payload.skill || '').trim() || strategyKey || 'general'
}

const resolveTaskBillingTarget = (
  payload: GenerationTaskStartPayload,
  strategyKey: GenerationTaskStrategyKey,
) => {
  const providerId = String((payload.requestBody || {}).providerId || '').trim()
  const modelKey = String(payload.modelKey || '').trim()
  const isImageTask = strategyKey === 'image'

  if (!providerId) {
    throw new GenerationTaskRequestError(400, '未匹配到后台模型配置，请先在后台配置可用模型')
  }

  if (!modelKey) {
    throw new GenerationTaskRequestError(400, isImageTask ? '缺少图片模型标识' : '缺少对话模型标识')
  }

  return {
    providerId,
    modelKey,
  }
}

export const startGenerationTask = async (
  payload: GenerationTaskStartPayload,
  currentUserId: string,
  context: TaskLifecycleContext,
) => {
  const strategy = context.resolveGenerationTaskStrategy(payload)
  const { providerId, modelKey } = resolveTaskBillingTarget(payload, strategy.key)
  const skillKey = resolveTaskSkillKey(payload, strategy.key)
  // 解析前端塞入的能力开关（联网搜索/深度思考），用于计费倍率联动。
  // 仅 agent-chat 链路读取；image / agent-workspace 暂时不接 capability 计费。
  const capabilityFlags = readCapabilityFlagsFromRequestBody(payload.requestBody)
  const idempotencyKey = buildGenerationTaskIdempotencyKey(
    payload,
    currentUserId,
    strategy.key,
    providerId,
    modelKey,
    context,
  )
  const idempotencyClaim = await context.claimIdempotencyKey<{ recordId?: string }>(idempotencyKey)

  if (idempotencyClaim.state === 'completed' && idempotencyClaim.data?.recordId) {
    return context.getGenerationRecordById(String(idempotencyClaim.data.recordId), currentUserId)
  }

  if (idempotencyClaim.state === 'in_progress') {
    throw new GenerationTaskRequestError(409, '检测到相同任务正在处理中，请稍候查看结果')
  }

  let concurrencySlots: ConcurrencySlot[] = []
  /**
   * 「扣分」与「建单」不在同一个事务：consumeGenerationPoints 先自己提交了扣费，
   * 之后的建单（createGenerationRecord）、回写流水、写幂等键任一步抛错，都会走到下面的 catch，
   * 而已提交的扣费**不会**自动回滚。所以这里记下这笔扣费，失败时原路退回 ——
   * 杜绝「分数已扣、任务却不存在」（审计 P1-1）。
   * 任务成功交接给 runTaskInBackground 后置空：那之后的失败由任务自己的退款收口负责。
   */
  let committedConsume: {
    associationNo: string
    pointCost: number
    endpointType: 'chat' | 'image' | 'video' | 'audio'
    providerId: string
    modelKey: string
    modelName: string
  } | null = null

  try {
    /**
     * 对话计费 + 按技能占并发槽位的这一类任务：agent-chat（普通对话）、research-report（研究报告）、
     * canvas-agent（制片 Agent）。三者都是「按 chat 端点计价、产出落在 record.content」的长任务，
     * 所以共用同一条创建路径 —— 制片 Agent 的特别之处全在执行器里（工具桥 + 花钱闸门），
     * 创建与结算没有理由再分一套。
     */
    if (
      strategy.key === 'agent-chat'
      || strategy.key === 'research-report'
      || strategy.key === 'canvas-agent'
    ) {
      concurrencySlots = await context.acquireTaskConcurrencySlots({
        userId: currentUserId,
        providerId,
        skillKey,
      })

      const billingDetail = await context.resolveGenerationPointCost({
        providerId,
        modelKey,
        endpointType: 'chat',
        capabilityFlags,
      })
      const associationNo = context.buildGatewayAssociationNo()
      const pointLog = billingDetail.pointCost > 0
        ? await context.consumeGenerationPoints({
          userId: currentUserId,
          pointCost: billingDetail.pointCost,
          sourceId: associationNo,
          associationNo,
          endpointType: 'chat',
          providerId,
          modelKey,
          modelName: billingDetail.modelName,
          metaJson: {
            source: 'generation-task',
            taskType: strategy.key,
          },
        })
        : null

      // 记下这笔已提交的扣费：建单失败要退回（见函数头 committedConsume 说明）。
      if (pointLog) {
        committedConsume = {
          associationNo,
          pointCost: billingDetail.pointCost,
          endpointType: 'chat',
          providerId,
          modelKey,
          modelName: billingDetail.modelName,
        }
      }

      const createdRecord = await context.createGenerationRecord(buildInitialRecordPayload(payload), currentUserId)
      await context.attachGenerationPointRecordId({
        associationNo,
        userId: currentUserId,
        generationRecordId: createdRecord.id,
      })
      await context.completeIdempotencyKey(idempotencyKey, idempotencyClaim.token as string, {
        recordId: createdRecord.id,
      })

      const task: RunningGenerationTask = {
        recordId: createdRecord.id,
        userId: currentUserId,
        // payload.type 是宽松 string，任务对象要求 'image' | 'agent' | 'research'（策略解析时已确定）
        type: payload.type as RunningGenerationTask['type'],
        strategyKey: strategy.key,
        abortController: new AbortController(),
        associationNo,
        billedEndpointType: 'chat',
        billedPointCost: pointLog ? billingDetail.pointCost : 0,
        billedProviderId: providerId,
        billedModelKey: modelKey,
        billedModelName: billingDetail.modelName || String(payload.model || '').trim(),
        refundCommitted: false,
        concurrencySlots,
      }

      context.setLocalRunningTask(task)
      await context.syncSharedTaskRuntime(task, 'queued', { skillKey })
      context.emitTaskStreamEvent(createdRecord.id, {
        type: 'progress',
        recordId: createdRecord.id,
        done: false,
        stopped: false,
        record: createdRecord,
        stage: 'queued',
        message: '任务已创建，等待服务端执行',
      })
      context.logGenerationTask('task_created', {
        recordId: createdRecord.id,
        userId: currentUserId,
        type: payload.type,
        strategyKey: strategy.key,
        providerId,
        modelKey,
      })
      committedConsume = null
      context.runTaskInBackground(task, payload)
      return createdRecord
    }

    if (strategy.key === 'agent-workspace') {
      concurrencySlots = await context.acquireTaskConcurrencySlots({
        userId: currentUserId,
        providerId,
        skillKey,
      })

      const billingDetail = await context.resolveGenerationPointCost({
        providerId,
        modelKey,
        endpointType: 'chat',
        capabilityFlags,
      })
      const associationNo = context.buildGatewayAssociationNo()
      const pointLog = billingDetail.pointCost > 0
        ? await context.consumeGenerationPoints({
          userId: currentUserId,
          pointCost: billingDetail.pointCost,
          sourceId: associationNo,
          associationNo,
          endpointType: 'chat',
          providerId,
          modelKey,
          modelName: billingDetail.modelName,
          metaJson: {
            source: 'generation-task',
            taskType: 'agent-workspace',
            skill: String(payload.skill || '').trim(),
          },
        })
        : null

      // 同 chat 分支：记下已提交的扣费，建单失败要退回。
      if (pointLog) {
        committedConsume = {
          associationNo,
          pointCost: billingDetail.pointCost,
          endpointType: 'chat',
          providerId,
          modelKey,
          modelName: billingDetail.modelName,
        }
      }

      const initialPayload = {
        ...buildInitialRecordPayload(payload),
        agentRun: context.buildAgentPendingRun(
          `record-${Date.now()}`,
          String(payload.prompt || '').trim(),
          String(payload.skill || '').trim() || 'general',
          Array.isArray(payload.referenceImages) ? payload.referenceImages : [],
        ),
      } satisfies GenerationRecordPayload
      const createdRecord = await context.createGenerationRecord(initialPayload, currentUserId)
      await context.attachGenerationPointRecordId({
        associationNo,
        userId: currentUserId,
        generationRecordId: createdRecord.id,
      })
      await context.completeIdempotencyKey(idempotencyKey, idempotencyClaim.token as string, {
        recordId: createdRecord.id,
      })

      const task: RunningGenerationTask = {
        recordId: createdRecord.id,
        userId: currentUserId,
        type: 'agent',
        strategyKey: strategy.key,
        abortController: new AbortController(),
        associationNo,
        billedEndpointType: 'chat',
        billedPointCost: pointLog ? billingDetail.pointCost : 0,
        billedProviderId: providerId,
        billedModelKey: modelKey,
        billedModelName: billingDetail.modelName || String(payload.model || '').trim(),
        refundCommitted: false,
        concurrencySlots,
      }

      context.setLocalRunningTask(task)
      await context.syncSharedTaskRuntime(task, 'queued', { skillKey })
      context.emitTaskStreamEvent(createdRecord.id, {
        type: 'progress',
        recordId: createdRecord.id,
        done: false,
        stopped: false,
        record: createdRecord,
        stage: 'queued',
        message: '技能任务已创建，等待服务端执行',
      })
      context.logGenerationTask('task_created', {
        recordId: createdRecord.id,
        userId: currentUserId,
        type: payload.type,
        strategyKey: strategy.key,
        skill: payload.skill,
        modelKey: payload.modelKey,
      })
      committedConsume = null
      context.runTaskInBackground(task, payload)
      return createdRecord
    }

    concurrencySlots = await context.acquireTaskConcurrencySlots({
      userId: currentUserId,
      providerId,
      skillKey,
    })

    // 图片、视频与音频共用这一段创建路径：按任务类型取端点（视频按秒、音频按次/秒，kind 必须给对）。
    const billingEndpointType = strategy.key === 'video'
      ? 'video'
      : strategy.key === 'audio'
        ? 'audio'
        : 'image'
    const requestBody = payload.requestBody || {}
    const billingDetail = await context.resolveModelPricingCost({
      providerId,
      modelKey,
      endpointType: billingEndpointType,
      params: buildNormalizedGenerationParams({
        kind: billingEndpointType,
        size: requestBody.size,
        count: requestBody.count ?? requestBody.n,
        seconds: requestBody.seconds ?? requestBody.duration,
      }),
    })

    /**
     * 定价缺失/未标定/规格匹配不到档位 → **在扣费之前**拒绝建单。
     *
     * 这一步必须在 consumeGenerationPoints 之前：拒绝发生在扣费前，就不会产生任何扣款，
     * 也就不需要「先扣再退」那种补偿（那会在流水里留下两条记录、还可能退失败）。
     * 前端拿到的是可读的 4xx 文案（ModelPricingRefusedError → model_pricing_refused）。
     */
    if (billingDetail.refuse) {
      context.logGenerationTask('task_pricing_refused', {
        userId: currentUserId,
        providerId,
        modelKey,
        endpointType: billingEndpointType,
        reason: billingDetail.refuseReason,
      })
      throw new ModelPricingRefusedError(
        billingDetail.refuseReason ?? 'pricing_model_not_configured',
        billingDetail.detail || '该模型暂不可用，请联系运营',
      )
    }

    // 「读配置本身失败」仍按草案价放行，但必须留下日志，方便回头定位是哪次环境异常
    if (billingDetail.usingDraft) {
      context.logGenerationTask('task_pricing_draft_fallback', {
        userId: currentUserId,
        providerId,
        modelKey,
        endpointType: billingEndpointType,
        reason: billingDetail.fallbackReason,
        pointCost: billingDetail.pointCost,
      })
    }

    const associationNo = context.buildGatewayAssociationNo()
    const pointLog = billingDetail.pointCost > 0
      ? await context.consumeGenerationPoints({
        userId: currentUserId,
        pointCost: billingDetail.pointCost,
        sourceId: associationNo,
        associationNo,
        // 必须按任务真实类型落流水：之前写死 'image'，视频任务的备注/筛选全被当成图片
        // （备注变成「图片生成消耗积分」，后台按 endpointType=video 筛不到）。
        endpointType: billingEndpointType,
        providerId,
        modelKey,
        modelName: billingDetail.modelName,
        metaJson: {
          source: 'generation-task',
          taskType: strategy.key,
        },
      })
      : null

    // 记下已提交的扣费：建单失败要退回（见函数头 committedConsume 说明）。
    if (pointLog) {
      committedConsume = {
        associationNo,
        pointCost: billingDetail.pointCost,
        endpointType: billingEndpointType,
        providerId,
        modelKey,
        modelName: billingDetail.modelName,
      }
    }

    const createdRecord = await context.createGenerationRecord(buildInitialRecordPayload(payload), currentUserId)
    await context.attachGenerationPointRecordId({
      associationNo,
      userId: currentUserId,
      generationRecordId: createdRecord.id,
    })
    await context.completeIdempotencyKey(idempotencyKey, idempotencyClaim.token as string, {
      recordId: createdRecord.id,
    })

    const task: RunningGenerationTask = {
      recordId: createdRecord.id,
      userId: currentUserId,
      type: 'image',
      strategyKey: strategy.key,
      abortController: new AbortController(),
      associationNo,
      // 退款也按真实类型记：视频任务失败要写「视频…」，不能跟着写死成 "image"。
      billedEndpointType: billingEndpointType,
      billedPointCost: pointLog ? billingDetail.pointCost : 0,
      billedProviderId: providerId,
      billedModelKey: modelKey,
      billedModelName: billingDetail.modelName,
      refundCommitted: false,
      concurrencySlots,
    }

    context.setLocalRunningTask(task)
    await context.syncSharedTaskRuntime(task, 'queued', { skillKey })
    context.emitTaskStreamEvent(createdRecord.id, {
      type: 'progress',
      recordId: createdRecord.id,
      done: false,
      stopped: false,
      record: createdRecord,
      stage: 'queued',
      message: '任务已创建，等待服务端执行',
    })
    context.logGenerationTask('task_created', {
      recordId: createdRecord.id,
      userId: currentUserId,
      type: payload.type,
      strategyKey: strategy.key,
      providerId,
      modelKey,
    })
    committedConsume = null
    context.runTaskInBackground(task, payload)
    return createdRecord
  } catch (error) {
    if (concurrencySlots.length) {
      await context.releaseTaskConcurrencySlots(concurrencySlots)
    }
    await context.clearPendingIdempotencyKey(idempotencyKey, idempotencyClaim.token as string)
    // 扣费已提交、任务却没建起来 → 原路退回，避免「分数已扣、任务不存在」。
    // 退款本身失败只记日志，绝不覆盖原始异常（原始异常才是调用方要看到的）。
    if (committedConsume) {
      try {
        await context.refundGenerationPoints({
          userId: currentUserId,
          pointCost: committedConsume.pointCost,
          sourceId: committedConsume.associationNo,
          associationNo: committedConsume.associationNo,
          endpointType: committedConsume.endpointType,
          providerId: committedConsume.providerId,
          modelKey: committedConsume.modelKey,
          modelName: committedConsume.modelName,
          metaJson: {
            refundReason: 'task_create_failed',
          },
        })
      } catch (refundError) {
        context.logGenerationTask('task_create_refund_failed', {
          userId: currentUserId,
          associationNo: committedConsume.associationNo,
          pointCost: committedConsume.pointCost,
          errorMessage: refundError instanceof Error ? refundError.message : String(refundError || ''),
        })
      }
    }
    throw error
  }
}

export const getGenerationTaskRecord = async (
  recordId: string,
  currentUserId: string,
  context: TaskLifecycleContext,
) => {
  return context.resolveTaskRecordSnapshot(recordId, currentUserId)
}

export const stopGenerationTask = async (
  recordId: string,
  currentUserId: string,
  context: TaskLifecycleContext,
) => {
  const task = context.getLocalRunningTask(recordId)

  if (task) {
    if (task.userId !== currentUserId) {
      throw new Error('无权停止当前生成任务')
    }
    context.abortTaskWithReason(task, 'user_stop')
  } else {
    const sharedRuntime = await context.getSharedTaskRuntime(recordId)
    if (sharedRuntime?.status === 'running') {
      await context.markSharedTaskAbortRequested(recordId)
      return context.getGenerationRecordById(recordId, currentUserId)
    }

    const currentRecord = await context.getGenerationRecordById(recordId, currentUserId)
    if (currentRecord.done) {
      return currentRecord
    }

    await context.updateGenerationRecord(recordId, {
      type: currentRecord.type,
      prompt: currentRecord.prompt,
      content: currentRecord.content,
      error: '',
      model: currentRecord.model,
      modelKey: currentRecord.modelKey,
      ratio: currentRecord.ratio,
      resolution: currentRecord.resolution,
      duration: currentRecord.duration,
      feature: currentRecord.feature,
      skill: currentRecord.skill,
      done: true,
      stopped: true,
      images: currentRecord.images,
      agentRun: currentRecord.agentRun,
    }, currentUserId)
    const stoppedRecord = await context.getGenerationRecordById(recordId, currentUserId)
    context.emitTaskStreamEvent(recordId, {
      type: 'stopped',
      recordId,
      done: true,
      stopped: true,
      record: stoppedRecord,
      stage: 'stopped',
      message: '任务已停止',
    })
  }

  return context.getGenerationRecordById(recordId, currentUserId)
}
