import { readJsonBody, sendJson } from '../ai-gateway/shared'
import type { GenerationTaskStreamEventBase } from '../../src/shared/generation-task-stream'
import type { ResearchTaskConfig } from '../../src/shared/research/research-types'
import { isModelPricingRefusedError, MODEL_PRICING_REFUSED_CODE } from '../../src/shared/model-pricing-rules'

// 重新导出共享协议中的类型与失败码，让服务端代码继续按原路径引用
export type {
  GenerationTaskStreamEventType,
  GenerationTaskFailureCode,
  GenerationTaskStreamEventBase,
} from '../../src/shared/generation-task-stream'

export interface GenerationTaskStartPayload {
  sessionId?: string
  source?: string
  type: string
  requestMode?: 'image-generation' | 'image-edit'
  prompt: string
  model?: string
  modelKey?: string
  ratio?: string
  resolution?: string
  duration?: string
  feature?: string
  skill?: string
  referenceImages?: string[]
  /** 局部重绘蒙版（透明处 = 可重绘区域），仅 image-edit 用得上 */
  mask?: string
  researchConfig?: Partial<ResearchTaskConfig> | null
  requestBody?: Record<string, unknown> | null
}

// 服务端 record 是数据库行的通用对象表示
export type GenerationTaskStreamEvent = GenerationTaskStreamEventBase<Record<string, unknown>>

export class GenerationTaskRequestError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'GenerationTaskRequestError'
    this.statusCode = statusCode
  }
}

// 读取生成任务请求体。
export const readGenerationTaskBody = async (req: any) => {
  const payload = await readJsonBody(req)
  return payload as GenerationTaskStartPayload
}

// 返回统一的生成任务接口错误。
export const sendGenerationTaskError = (res: any, statusCode: number, message: string) => {
  sendJson(res, statusCode, {
    message,
    error: {
      type: 'generation_task_error',
      message,
    },
  })
}

/**
 * 余额不足错误码：由 marketing-center 的 consumeGenerationPoints 抛出。
 * 它是**可预期的业务结果**，不是服务器错误 —— 接口层据此返回 402 而不是 500。
 */
export const INSUFFICIENT_POINTS_CODE = 'INSUFFICIENT_POINTS'

export const isInsufficientPointsError = (error: any) => error?.code === INSUFFICIENT_POINTS_CODE

// 定价缺失/未标定/规格匹配失败：由 ModelPricingRefusedError 抛出（见 model-pricing-rules.ts）。
// 接口层据此返回 400 + 语义化 error.type=model_pricing_refused，而不是 500「服务器错误」。
export { isModelPricingRefusedError, MODEL_PRICING_REFUSED_CODE }

/**
 * 生成任务接口异常 → HTTP 状态码。
 *
 * 单独抽出来是为了可测：402（余额不足）与 500（真·服务器错误）的边界必须钉死，
 * 否则前端只能把「去充值」提示成「服务器错误」。
 */
export const resolveGenerationTaskErrorStatus = (error: any): number => {
  if (error instanceof GenerationTaskRequestError) {
    return error.statusCode
  }
  if (isModelPricingRefusedError(error)) {
    return error.statusCode
  }
  if (isInsufficientPointsError(error)) {
    return 402
  }
  return 500
}
