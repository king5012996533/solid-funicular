/**
 * 积分相关的独立路径（M3 ③-1 预校验用）。
 *
 * 两个接口各自独立降级、独立监控，不互相污染：
 *   /balance  —— 当前可用积分（高频轻量查询）
 *   /estimate —— 一批节点的预估消耗（复用服务端计费函数，杜绝口径漂移）
 */
export const POINTS_BALANCE_PATH = '/api/points/balance'
export const POINTS_ESTIMATE_PATH = '/api/points/estimate'

export const isPointsPath = (requestPath: string) =>
  requestPath === POINTS_BALANCE_PATH || requestPath === POINTS_ESTIMATE_PATH
