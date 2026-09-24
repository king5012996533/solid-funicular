import { sendJson } from '../ai-gateway/shared'
import { requireCurrentSessionUser } from '../auth/session'
import { getPointBalance, resolveModelPricingCost } from '../marketing-center/service'
import { buildNormalizedGenerationParams } from '../../src/shared/model-pricing-rules'
import { POINTS_BALANCE_PATH, POINTS_ESTIMATE_PATH } from './constants'

/**
 * `GET /api/points/balance` —— 只返回「当前可用积分」这一个数字。
 *
 * 为什么单开一个接口而不再复用现有接口（选型理由）：
 * 1. 预校验会在批量生成前频繁调用，需要**轻量**：现有接口大多捎带项目/画布详情，
 *    为了一个数字把整份详情序列化一遍不划算。
 * 2. 解耦：以后积分冻结/预扣（生成前预占额度）都可以在这个接口上扩展，不污染别的业务接口。
 * 3. **方便单独降级**：这个接口挂了只影响「配额校验」这一条规则 ——
 *    调用方拿不到余额就静默跳过配额判断，画布读取、节点操作完全不受影响。
 *
 * 口径与计费一致：取 `PointAccountLog` 最新一条的 `balanceAfter`（与营销中心/扣费同一口径，
 * 不另发明一套算法）。
 */
export const handlePointsRequest = async (req: any, res: any) => {
  const requestUrl = new URL(String(req.url || ''), 'http://localhost')
  if (requestUrl.pathname === POINTS_ESTIMATE_PATH) {
    await handlePointsEstimateRequest(req, res)
    return
  }
  try {
    if (req.method !== 'GET' || requestUrl.pathname !== POINTS_BALANCE_PATH) {
      sendJson(res, 404, { success: false, message: 'Not Found' })
      return
    }

    const currentUser = await requireCurrentSessionUser(req, res)
    if (!currentUser) {
      // 未登录：调用方（预校验）会把它当作「拿不到余额」→ 静默跳过配额校验
      return
    }

    const available = await getPointBalance(currentUser.id)
    if (typeof available !== 'number' || Number.isNaN(available)) {
      // 查不到就如实说查不到，让调用方走降级分支 —— **不要返回 0 冒充余额**
      sendJson(res, 200, { success: false, available: 0, message: '暂时读不到积分余额' })
      return
    }

    sendJson(res, 200, { success: true, available: Math.max(0, Math.trunc(available)) })
  } catch (error: any) {
    // 5xx：同样让调用方走降级分支，不阻断预校验整体流程
    sendJson(res, 500, { success: false, message: error?.message || '读取积分余额失败' })
  }
}

/**
 * 画布的模型选择键 → 计费函数要的三个参数。
 *
 * 画布节点存的是 `providerId::CATEGORY::modelKey`（模型选择器的选择键），
 * 而 `resolveModelPricingCost` 要 providerId + modelKey + endpointType 三项。
 * 在这里解析一次，调用方（前端）不必知道计费函数的入参形状。
 */
const parseModelSelectionKey = (raw: string) => {
  const parts = String(raw || '').split('::').map((item) => item.trim())
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { providerId: parts[0], endpointType: parts[1].toLowerCase(), modelKey: parts[2] }
  }
  return null
}

/**
 * `POST /api/points/estimate` —— 一批节点的预估消耗。
 *
 * 为什么必须由服务端算：真实扣费走的是 `resolveModelPricingCost`（读 model_pricing 定价表）。
 * 前端复写一套「张数 × 常量」迟早与计费漂移，最后表现为「预校验说 30 分、实际扣了 42 分」——
 * 用户对不上账，比不预估还糟。这里直接调同一个函数，**连参数归一化都共用**（size/count 一起传进去），
 * 所以按张/按次/按秒的区别由定价算法自己处理，接口不再另乘一次张数。
 *
 * 性能：同一批里多个节点常是同一「模型 + 规格 + 张数」，所以按这个三元组去重后再查，
 * 10 个同规格节点只查一次库。不能只按模型去重：perImage 随张数变、perTask 不变，
 * 同模型不同张数的节点必须各算各的，否则会互相串价。
 */
export const handlePointsEstimateRequest = async (req: any, res: any) => {
  try {
    const requestUrl = new URL(String(req.url || ''), 'http://localhost')
    if (req.method !== 'POST' || requestUrl.pathname !== POINTS_ESTIMATE_PATH) {
      sendJson(res, 404, { success: false, message: 'Not Found' })
      return
    }

    const currentUser = await requireCurrentSessionUser(req, res)
    if (!currentUser) {
      // 未登录：调用方按「拿不到预估」处理 → 配额校验静默跳过
      return
    }

    const body = await readJsonBody(req)
    const items = Array.isArray(body?.items) ? body.items : []
    if (!items.length) {
      sendJson(res, 200, { success: true, totalEstimated: 0, details: [] })
      return
    }

    // 单个节点的预估：与结算同一个解析器 + 同一套参数归一化
    const estimateOne = async (item: any) => {
      const model = String(item?.model || '').trim()
      const parsed = parseModelSelectionKey(model)
      if (!parsed) return 0
      const resolved = await resolveModelPricingCost({
        providerId: parsed.providerId,
        modelKey: parsed.modelKey,
        endpointType: parsed.endpointType as 'chat' | 'image' | 'video',
        params: buildNormalizedGenerationParams({
          kind: parsed.endpointType === 'video' ? 'video' : 'image',
          size: item?.size,
          count: item?.count,
        }),
      })
      // 未配价/未标定/匹配失败 → 预估按 0：真正的拦截在建单接口（那里会返回可读的 4xx）。
      // 这里不能沿用旧的草案价，否则预校验通过、建单却被拒，用户看到的数字前后矛盾。
      if (resolved?.refuse) return 0
      return Math.max(0, Math.trunc(Number(resolved?.pointCost) || 0))
    }

    // 去重：同一「模型 + 规格 + 张数」只查一次定价（key 必须带上 size/count，见函数头注释）
    const costCache = new Map<string, number>()
    let totalEstimated = 0
    const details: Array<{ model: string; size: string; count: number; cost: number }> = []
    for (const item of items) {
      const model = String(item?.model || '').trim()
      const size = String(item?.size || '').trim()
      const count = Math.max(1, Math.trunc(Number(item?.count) || 1))
      const cacheKey = `${model}::${size}::${count}`
      let cost = costCache.get(cacheKey)
      if (cost === undefined) {
        cost = await estimateOne(item)
        costCache.set(cacheKey, cost)
      }
      totalEstimated += cost
      details.push({ model, size, count, cost })
    }

    sendJson(res, 200, { success: true, totalEstimated, details })
  } catch (error: any) {
    // 5xx：调用方走降级分支（跳过配额校验），不阻断预校验整体流程
    sendJson(res, 500, { success: false, message: error?.message || '预估消耗计算失败' })
  }
}

/** 读 JSON body（限长，避免有人拿超大 body 打这个接口） */
const readJsonBody = async (req: any) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (!chunks.length) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}
