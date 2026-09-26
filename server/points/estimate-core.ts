/**
 * `/api/points/estimate` 的纯逻辑核心（不碰 IO、不 import prisma）。
 *
 * 抽出来的理由：handler 里「解析模型键 → 查价 → 求和」这段是可以脱离数据库单测的，
 * 而它又恰好是 2026-09-26 出问题的那一环 —— 抽成纯函数后用桩解析器就能把
 * 「合法输入算得出钱 / 算不出钱时不许返回 0」这两条钉死（见 tests/points-estimate.test.ts）。
 *
 * 两条硬约束（都是真机踩过的坑，不是设计洁癖）：
 *   1. **拿不到价时不许返回 0**：0 会被上层当成「不花钱」，与「不知道」混为一谈。
 *      一张 gpt-image-2 实际扣 6 分，接口却回 0，确认卡就写成「本批将预扣 0 分」。
 *      这里对估不出的项给 `cost: null` + `unestimatable` 明细，整批总额要么是全部项之和，
 *      要么**整批不给**（绝不拿部分数字冒充整批）。
 *   2. 同一「模型 + 规格 + 张数」只解析一次价（perImage 随张数变、perTask 不变）。
 */

export type EstimateEndpointType = 'chat' | 'image' | 'video' | 'audio'

export interface EstimateItemInput {
  model?: unknown
  size?: unknown
  count?: unknown
}

/** 定价解析器的返回（对齐 resolveModelPricingCost 的子集，便于单测注入） */
export interface ResolvedEstimateCost {
  pointCost: number
  refuse: boolean
  refuseReason?: string
  detail?: string
}

export type ResolveEstimateCost = (input: {
  providerId: string
  modelKey: string
  endpointType: EstimateEndpointType
  size: string
  count: number
}) => Promise<ResolvedEstimateCost>

export interface EstimateItemDetail {
  model: string
  size: string
  count: number
  /** 估得出才是数字；估不出为 null —— **绝不能是 0**（0 是「不花钱」的意思） */
  cost: number | null
  estimated: boolean
}

export interface EstimateUnestimatableItem {
  model: string
  /** `model_key_unresolvable`：模型键不是三段式；其余为定价表的 fallbackReason */
  reason: string
  detail?: string
}

export interface EstimateOutcome {
  /** 仅当**每一项**都估得出才给整批总额；有任一项估不出就整个字段缺失（上层据此降级） */
  totalEstimated?: number
  details: EstimateItemDetail[]
  /** 估不出的项：日志与上层据此区分「没估出来」与「不花钱」 */
  unestimatable: EstimateUnestimatableItem[]
}

/**
 * 画布的模型选择键 → 计费函数要的三个参数。
 *
 * 画布节点存的是 `providerId::CATEGORY::modelKey`，而 `resolveModelPricingCost`
 * 要 providerId + modelKey + endpointType 三项。解析不出（例如只存了裸 modelKey）时返回 null，
 * 由调用方如实标成「估不出」，**不再静默按 0 计**。
 */
export const parseModelSelectionKey = (raw: string) => {
  const parts = String(raw || '').split('::').map((item) => item.trim())
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { providerId: parts[0], endpointType: parts[1].toLowerCase() as EstimateEndpointType, modelKey: parts[2] }
  }
  return null
}

/** 单项：解析键 → 查价；拿不到价一律返回 cost:null（原因可辨） */
const estimateOne = async (
  item: EstimateItemInput,
  resolve: ResolveEstimateCost,
): Promise<{ cost: number | null; reason?: string; detail?: string }> => {
  const model = String(item?.model || '').trim()
  const parsed = parseModelSelectionKey(model)
  if (!parsed) {
    return {
      cost: null,
      reason: 'model_key_unresolvable',
      detail: `模型键不是「providerId::类别::modelKey」形式：${model || '(空)'}`,
    }
  }
  const size = String(item?.size || '').trim()
  const count = Math.max(1, Math.trunc(Number(item?.count) || 1))
  const resolved = await resolve({ ...parsed, size, count })
  // 未配价 / 未标定 / 匹配失败 → 估不出（不再按 0）：真正的拦截在建单接口，那里会给 4xx。
  if (resolved?.refuse) {
    return { cost: null, reason: resolved.refuseReason || 'pricing_unavailable', detail: resolved.detail }
  }
  return { cost: Math.max(0, Math.trunc(Number(resolved?.pointCost) || 0)) }
}

export const computePointsEstimate = async (
  items: EstimateItemInput[],
  resolve: ResolveEstimateCost,
): Promise<EstimateOutcome> => {
  const details: EstimateItemDetail[] = []
  const unestimatable: EstimateUnestimatableItem[] = []
  // 同一「模型 + 规格 + 张数」只查一次价：10 个同规格节点只打一次库。
  // key 必须带上 size/count —— perImage 随张数变、perTask 不变，不带会互相串价。
  const costCache = new Map<string, { cost: number | null; reason?: string; detail?: string }>()
  let totalEstimated = 0

  for (const item of items) {
    const model = String(item?.model || '').trim()
    const size = String(item?.size || '').trim()
    const count = Math.max(1, Math.trunc(Number(item?.count) || 1))
    const cacheKey = `${model}::${size}::${count}`
    let cached = costCache.get(cacheKey)
    if (!cached) {
      cached = await estimateOne(item, resolve)
      costCache.set(cacheKey, cached)
    }

    if (cached.cost === null) {
      details.push({ model, size, count, cost: null, estimated: false })
      unestimatable.push({ model, reason: cached.reason || 'unknown', detail: cached.detail })
      continue
    }
    details.push({ model, size, count, cost: cached.cost, estimated: true })
    totalEstimated += cached.cost
  }

  const outcome: EstimateOutcome = { details, unestimatable }
  // 有任一项估不出 → 整批不给总额：部分数字冒充整批只会让账更对不上。
  if (!unestimatable.length) {
    outcome.totalEstimated = totalEstimated
  }
  return outcome
}
