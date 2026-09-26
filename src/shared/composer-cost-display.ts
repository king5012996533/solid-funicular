/**
 * 生成器页脚「本次预估积分」的展示口径（纯逻辑，可单测）
 *
 * 为什么要改（2026-09-26 对齐 LibTV 时发现的真问题）：
 * 页脚原来读的是**客户端配置里的单位价**（`model.defaultParams.billingRule.power`），
 * 于是有两处不对：
 *   1. 那是客户端抄的一份价格，服务端定价表改了它不会跟着变；
 *   2. 图片显示 `6 / 张`（单位价，不是这一单要花多少），视频更糟 —— 只显示一个裸的 `6`，
 *      连单位都没有，用户根本不知道这个数字是什么。
 *
 * LibTV 在同一位置（紧贴发送按钮左侧）显示的是**本次提交的预估总额**（如 `1380`）。
 * 所以口径统一成：只显示服务端 `/api/points/estimate` 给的 `totalEstimated`，
 * **拿不到就不显示**（沿用仓库既有纪律：宁可不说数字，也不说错的）。
 *
 * 这个文件只放纯函数，网络部分在 `composables/useComposerCostEstimate.ts`。
 */

/**
 * 缺口档位：决定数字用什么颜色（对齐 LibTV 的 --credit-gap-none / -medium / -strong）。
 *
 * 为什么多一个 `unknown`：LibTV 的三档都是「知道余额」时的结论。我们这边余额是**可能拿不到的**
 * （未登录 / 接口 5xx），那种情况必须是中性的第四态 —— 既不能标成「充足」（青色）骗人，
 * 更不能标成红色吓人。所以 `unknown` 单独一档，渲染时用页面默认的中性文字色。
 */
export type CreditGapLevel = 'unknown' | 'ok' | 'medium' | 'strong'

/**
 * 估算值可用性判定。
 *
 * `null` / `undefined` / `NaN` / `0` / 负数一律视为「拿不到」→ 返回 null。
 * 为什么把 0 也算拿不到：`/api/points/estimate` 估不出时**不会给 `totalEstimated`**，
 * 而历史上出现过「解析不出就静默按 0」的 bug，界面上就变成「本批预扣 0 分」这种错数字。
 * 所以 0 在这里没有「免费」的含义，只有「不知道」的含义。
 */
export const resolveUsableEstimate = (raw: unknown): number | null => {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

/** 页脚文案。拿不到就返回空串，调用方据此不渲染这一块（而不是显示 0） */
export const formatEstimateText = (total: number | null): string =>
  total === null ? '' : `预估 ${total} 分`

/**
 * 与余额相比属于哪一档。
 *
 * 拿不到估算或拿不到余额 → `unknown`：**不吓唬也不讨好**，用中性色。
 * 总额 > 余额 → `strong`：这一单跑不动，会在提交时被服务端拦下。
 * 总额 ≥ 余额 × 0.8 → `medium`：跑完就快见底了（含「正好花光」这一档）。
 * 其余 → `ok`：够用，用品牌青（= LibTV 的 `--credit-gap-none`）。
 */
export const CREDIT_GAP_WARN_RATIO = 0.8

export const resolveCreditGapLevel = (
  total: number | null,
  available: number | null,
): CreditGapLevel => {
  if (total === null || available === null) return 'unknown'
  if (total > available) return 'strong'
  if (total >= available * CREDIT_GAP_WARN_RATIO) return 'medium'
  return 'ok'
}

/** 估算缓存键：模型 + 规格 + 数量，三者任一不同都必须重新问价 */
export const buildComposerEstimateKey = (modelKey: string, size: string, count: number): string =>
  [String(modelKey || '').trim(), String(size || '').trim(), String(Math.max(1, Math.trunc(Number(count) || 1)))].join('::')
