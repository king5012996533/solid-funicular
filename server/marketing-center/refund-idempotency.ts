/**
 * 退款幂等判定（纯函数，不碰 IO）。
 *
 * 背景：`refundGenerationPoints` 原先只按入参原样追加一条 REFUND 流水，**不检查这笔消费
 * 是否已经退过**。清理脚本/重试链路只要重放一次，就会同意发放第二份退款 —— 钱多退一份，
 * 账面上还看不出来（两条 REFUND 流水各自都「合法」）。
 *
 * 口径：**同一笔原始消费（扣费时的 `associationNo`）最多退一次**。
 * 幂等键就是「用户 + 原始消费单号」；判据是账本里是否已经存在同单号、同类型的退款流水。
 *
 * 为什么放在纯函数里：幂等判定是这段逻辑里唯一「想错就会重复加钱」的地方，必须能在没有
 * 数据库的情况下被单测钉死（见 tests/refund-idempotency.test.ts）。
 */

/** 账本里参与幂等判定所需的字段子集（PointAccountLog 的最小子集） */
export interface RefundLedgerEntry {
  associationNo?: string | null
  changeType?: string | null
  action?: string | null
}

/** 退款流水的固定特征：类型 REFUND、方向 INCREASE */
export const REFUND_CHANGE_TYPE = 'REFUND'
export const REFUND_ACTION = 'INCREASE'

export type RefundIdempotencyDecision =
  | { allowed: true; idempotencyKey: string }
  | { allowed: false; reason: 'already_refunded'; idempotencyKey: string }
  | { allowed: false; reason: 'missing_association_no' }

/** 幂等键：同一用户 + 同一原始消费单号 ＝ 一笔消费。仅用于日志/排障，不落库。 */
export const buildRefundIdempotencyKey = (input: { userId: string; associationNo: string }): string => {
  return `${String(input.userId || '').trim()}::${String(input.associationNo || '').trim()}`
}

/**
 * 这批已有流水里，是否已经存在同一笔消费的退款。
 *
 * 只认 `changeType=REFUND && action=INCREASE`：扣费流水（changeType=CONSUME、
 * action=DECREASE）即便单号相同也只是「被退的对象」，不构成「已退款」。
 */
export const hasCommittedRefund = (
  existingLogs: RefundLedgerEntry[],
  associationNo: string,
): boolean => {
  const normalized = String(associationNo || '').trim()
  if (!normalized) return false
  return existingLogs.some((log) => (
    String(log.associationNo || '').trim() === normalized
    && log.changeType === REFUND_CHANGE_TYPE
    && log.action === REFUND_ACTION
  ))
}

/**
 * 决定这笔退款是否放行。
 *
 * - 有单号、且账本里已存在同单号退款 → `already_refunded`（调用方按安全 no-op 处理）；
 * - 没有单号 → `missing_association_no`（拿不到幂等键，宁可报错也绝不冒险重复加钱）；
 * - 其余 → `allowed`。
 */
export const decideRefundIdempotency = (input: {
  userId: string
  associationNo?: string | null
  existingRefundLogs: RefundLedgerEntry[]
}): RefundIdempotencyDecision => {
  const associationNo = String(input.associationNo || '').trim()
  if (!associationNo) {
    return { allowed: false, reason: 'missing_association_no' }
  }

  const idempotencyKey = buildRefundIdempotencyKey({ userId: input.userId, associationNo })
  if (hasCommittedRefund(input.existingRefundLogs, associationNo)) {
    return { allowed: false, reason: 'already_refunded', idempotencyKey }
  }
  return { allowed: true, idempotencyKey }
}
