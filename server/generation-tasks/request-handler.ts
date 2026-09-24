import { requireCurrentSessionUser } from '../auth/session'
import { sendJson } from '../ai-gateway/shared'
import { isPrismaConfigured } from '../db/prisma'
import { REDIS_CONFIG, consumeFixedWindowRateLimit, getRedisRuntimeSettings } from '../redis'
import { writeScopedLog } from '../shared/logging'
import { GENERATION_TASKS_BASE_PATH } from './constants'
import {
  getGenerationTaskRecord,
  startGenerationTask,
  stopGenerationTask,
  subscribeGenerationTaskStream,
} from './service'
import { resolveClientToolResult } from './canvas-agent-bridge'
import type { AgentToolResultPayload } from '../../src/shared/generation-task-stream'
import {
  GenerationTaskRequestError,
  readGenerationTaskBody,
  sendGenerationTaskError,
  isInsufficientPointsError,
  isModelPricingRefusedError,
  resolveGenerationTaskErrorStatus,
} from './shared'

// 统一输出生成任务请求异常，便于排查启动、轮询和停止链路。
const logGenerationTaskRequestError = (detail: Record<string, unknown>) => {
  writeScopedLog('error', '生成任务', '请求异常', detail)
}

// 处理生成任务的创建、查询与停止请求。
export const handleGenerationTasksRequest = async (req: any, res: any) => {
  const requestUrl = String(req.url || '').split('?')[0]
  const taskPath = requestUrl.startsWith(`${GENERATION_TASKS_BASE_PATH}/`)
    ? decodeURIComponent(requestUrl.slice(GENERATION_TASKS_BASE_PATH.length + 1))
    : ''
  const taskId = taskPath.endsWith('/stop')
    ? taskPath.slice(0, -'/stop'.length)
    : taskPath.endsWith('/events')
      ? taskPath.slice(0, -'/events'.length)
      : taskPath.endsWith('/tool-result')
        ? taskPath.slice(0, -'/tool-result'.length)
        : taskPath

  let currentUser: { id?: string | null } | null = null
  let payloadSummary: Record<string, unknown> | null = null

  try {
    if (!isPrismaConfigured()) {
      sendGenerationTaskError(res, 500, '缺少 DATABASE_URL，暂时无法使用生成任务。')
      return
    }

    currentUser = await requireCurrentSessionUser(req, res)
    if (!currentUser?.id) {
      return
    }

    if (req.method === 'POST' && requestUrl === GENERATION_TASKS_BASE_PATH) {
      const runtimeSettings = await getRedisRuntimeSettings()
      const rateLimitResult = await consumeFixedWindowRateLimit({
        scope: 'task-submit',
        identifier: String(currentUser.id || '').trim(),
        limit: runtimeSettings.taskSubmitRateLimit || REDIS_CONFIG.taskSubmitRateLimit,
        windowSeconds: REDIS_CONFIG.rateLimitWindowSeconds,
      })

      if (!rateLimitResult.allowed) {
        throw new GenerationTaskRequestError(
          429,
          `提交过于频繁，请在 ${rateLimitResult.retryAfterSeconds || REDIS_CONFIG.rateLimitWindowSeconds} 秒后重试`,
        )
      }

      const payload = await readGenerationTaskBody(req)
      payloadSummary = {
        sessionId: payload?.sessionId || null,
        source: payload?.source || null,
        type: payload?.type || null,
        requestMode: payload?.requestMode || null,
        referenceImageCount: Array.isArray(payload?.referenceImages) ? payload.referenceImages.length : 0,
        hasRequestBody: Boolean(payload?.requestBody),
      }
      const data = await startGenerationTask(payload, currentUser.id)
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'GET' && taskId) {
      if (requestUrl === `${GENERATION_TASKS_BASE_PATH}/${encodeURIComponent(taskId)}/events`) {
        // 从原始 url 解析 lastEventId 用于断线重连重放
        const queryString = String(req.url || '').split('?')[1] || ''
        const queryParams = new URLSearchParams(queryString)
        const lastEventIdRaw = queryParams.get('lastEventId')
        const lastEventId = lastEventIdRaw ? Number.parseInt(lastEventIdRaw, 10) : 0
        await subscribeGenerationTaskStream(taskId, currentUser.id, res, {
          lastEventId: Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0,
        })
        return
      }
      const data = await getGenerationTaskRecord(taskId, currentUser.id)
      sendJson(res, 200, { data })
      return
    }

    /**
     * 画布 Agent 的工具回执入口（M2 的桥）。
     *
     * 浏览器执行完一个 `requiresClient` 工具后 POST 回来，服务端把挂起的 Promise 兑现，
     * Agent 继续往下走。**归属校验靠 taskId 本身就够了**：`getGenerationTaskRecord` 会按
     * currentUser 校验这条记录属不属于他 —— 别人的任务查不到就直接 404，
     * 不存在「拿别人的 recordId 回执把别人 Agent 带跑」这条路。
     */
    if (
      req.method === 'POST' &&
      requestUrl === `${GENERATION_TASKS_BASE_PATH}/${encodeURIComponent(taskId)}/tool-result`
    ) {
      await getGenerationTaskRecord(taskId, currentUser.id)
      const body = (await readGenerationTaskBody(req)) as unknown as Partial<AgentToolResultPayload>
      const callId = String(body?.callId || '').trim()
      if (!callId) {
        throw new GenerationTaskRequestError(400, '缺少 callId，无法定位要回执的工具调用')
      }
      const accepted = resolveClientToolResult(taskId, {
        callId,
        name: body?.name ? String(body.name) : undefined,
        ok: body?.ok !== false,
        result: String(body?.result || ''),
        summary: body?.summary ? String(body.summary) : undefined,
        details: body?.details && typeof body.details === 'object' ? body.details : undefined,
      })
      sendJson(res, 200, { data: { accepted } })
      return
    }

    if (req.method === 'POST' && requestUrl === `${GENERATION_TASKS_BASE_PATH}/${encodeURIComponent(taskId)}/stop`) {
      const data = await stopGenerationTask(taskId, currentUser.id)
      sendJson(res, 200, { data })
      return
    }

    sendGenerationTaskError(res, 405, 'Method Not Allowed')
  } catch (error: any) {
    logGenerationTaskRequestError({
      method: req.method,
      requestUrl,
      taskId: taskId || null,
      currentUserId: currentUser?.id || null,
      payloadSummary,
      errorMessage: error?.message || '处理生成任务失败',
      errorStack: error?.stack || null,
    })
    const statusCode = resolveGenerationTaskErrorStatus(error)
    /**
     * 余额不足是**可预期的业务结果**，不是服务器错误。
     *
     * consumeGenerationPoints 余额不够时抛 code='INSUFFICIENT_POINTS'，之前这里一律按 500 返回，
     * 前端只能提示「服务器错误」，用户不知道该去充值。这里单独给 402，并带上当前余额/所需积分，
     * 口径与 /api/ai/request 网关的 402 完全一致（同一份扣费函数抛出的同一个错误）。
     */
    if (isInsufficientPointsError(error)) {
      sendJson(res, statusCode, {
        message: error?.message || '积分不足',
        error: {
          type: 'insufficient_points',
          message: error?.message || '积分不足',
          currentBalance: Number(error?.currentBalance || 0),
          requiredPoints: Number(error?.requiredPoints || 0),
        },
      })
      return
    }
    /**
     * 定价缺失/未标定/规格匹配不到档位 → 400 + 语义化 code。
     * 这不是服务器错误：拒绝发生在扣费之前，用户积分不会被扣，前端要能提示可读文案。
     */
    if (isModelPricingRefusedError(error)) {
      sendJson(res, statusCode, {
        message: error?.message || '该模型暂不可用',
        error: {
          type: 'model_pricing_refused',
          code: error?.code,
          reason: error?.reason,
          message: error?.message || '该模型暂不可用',
        },
      })
      return
    }
    sendGenerationTaskError(res, statusCode, error?.message || '处理生成任务失败')
  }
}
