import { sendJson } from '../ai-gateway/shared'
import { requireCurrentSessionUser } from '../auth/session'
import { getPointBalance } from '../marketing-center/service'
import { POINTS_BALANCE_PATH } from './constants'

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
  try {
    const requestUrl = new URL(String(req.url || ''), 'http://localhost')
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
