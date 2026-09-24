import { buildApiUrl } from "./http";

/**
 * 积分接口的客户端封装（画布 Agent 预校验用）—— 2026-09-25
 *
 * 为什么单独一个文件、只封两个只读调用：预校验（preflight_check）要在**批量生成前**
 * 弄清「这一批要花多少、现在有多少」。这两个数字由服务端算（`/api/points/*` 复用结算同一套
 * 定价解析），前端只负责取回来。放在这里而不是塞进工具层，是为了让「拿不到就降级」这件事
 * 边界清晰：工具层只关心「拿到没有」，HTTP 细节留在这里。
 *
 * 关键约定：**接口失败一律抛出**（401 / 5xx / 非 JSON），调用方据此走降级分支
 * （配额校验静默跳过），绝不用一个假数字（例如 0）冒充真实余额 —— 那会把「不知道」
 * 变成「余额是 0」，反而拦掉本来能跑的批次。
 */

const POINTS_BALANCE_PATH = "/api/points/balance";
const POINTS_ESTIMATE_PATH = "/api/points/estimate";

export interface PointsBalanceResponse {
  success?: boolean;
  available?: number;
  message?: string;
}

/**
 * 单个预估项。
 *
 * `model` 是画布模型选择键 `providerId::CATEGORY::modelKey`（节点里存的就是它），
 * 服务端拿它解析定价；`count` 是这一步要生成的数量，`size` 是画幅（可选）。
 */
export interface PointsEstimateItem {
  model: string;
  size?: string;
  count?: number;
}

export interface PointsEstimateResponse {
  success?: boolean;
  totalEstimated?: number;
  details?: Array<{ model: string; size: string; count: number; cost: number }>;
  message?: string;
}

// 读取当前可用积分；失败（未登录/5xx/网络）直接抛错，由调用方降级。
export const requestPointsBalance = async (
  signal?: AbortSignal,
): Promise<PointsBalanceResponse> => {
  const response = await fetch(buildApiUrl(POINTS_BALANCE_PATH), {
    method: "GET",
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new Error(`读取积分余额失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as PointsBalanceResponse;
};

// 预估一批节点的消耗；同样失败即抛错，由调用方降级。
export const requestPointsEstimate = async (
  items: PointsEstimateItem[],
  signal?: AbortSignal,
): Promise<PointsEstimateResponse> => {
  const response = await fetch(buildApiUrl(POINTS_ESTIMATE_PATH), {
    method: "POST",
    credentials: "include",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    throw new Error(`预估消耗失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as PointsEstimateResponse;
};
