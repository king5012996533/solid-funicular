/** 积分余额查询的独立路径（M3 ③-1 预校验的配额校验用） */
export const POINTS_BALANCE_PATH = '/api/points/balance'

export const isPointsPath = (requestPath: string) => requestPath === POINTS_BALANCE_PATH
