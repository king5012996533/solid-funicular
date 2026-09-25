/**
 * 退款幂等单测（2026-09-25）。
 *
 * 锁定「同一笔原始消费最多退一次」这条口径。这里测的是纯判定模块
 * server/marketing-center/refund-idempotency.ts（refundGenerationPoints 的内核）——
 * 它是整段退款逻辑里唯一「想错就会重复加钱」的地方，必须能在没有数据库的情况下钉死。
 *
 * 真机证据（走既有 refundGenerationPoints + 真库）见报告，本文件只负责：
 *   1. 幂等判定的各种边界（已退过 / 只有扣费 / 不同单号 / 缺单号）；
 *   2. 连调两次：第一次放行、第二次被拒（already_refunded），余额净变化只有一次。
 *
 * 跑法：npx tsx tests/refund-idempotency.test.ts
 */

import {
  buildRefundIdempotencyKey,
  decideRefundIdempotency,
  hasCommittedRefund,
  REFUND_ACTION,
  REFUND_CHANGE_TYPE,
  type RefundLedgerEntry,
} from '../server/marketing-center/refund-idempotency'

let passed = 0
let failed = 0

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

const check = (name: string, fn: () => void) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const consumeLog = (associationNo: string): RefundLedgerEntry => ({
  associationNo,
  changeType: 'CONSUME',
  action: 'DECREASE',
})

const refundLog = (associationNo: string): RefundLedgerEntry => ({
  associationNo,
  changeType: REFUND_CHANGE_TYPE,
  action: REFUND_ACTION,
})

console.log('== A. 幂等判定：同一笔消费最多退一次 ==')

check('账本里没有任何退款 → 放行', () => {
  const decision = decideRefundIdempotency({
    userId: 'u1',
    associationNo: 'GTK100',
    existingRefundLogs: [],
  })
  assert(decision.allowed === true, '首次退款应放行')
})

check('同单号已有 REFUND+INCREASE → 拒绝（already_refunded）', () => {
  const decision = decideRefundIdempotency({
    userId: 'u1',
    associationNo: 'GTK100',
    existingRefundLogs: [refundLog('GTK100')],
  })
  assert(decision.allowed === false, '已退过不应放行')
  assert(!decision.allowed && decision.reason === 'already_refunded', '原因应为 already_refunded')
})

check('只有同单号的扣费流水（CONSUME/DECREASE）→ 不影响退款放行', () => {
  const decision = decideRefundIdempotency({
    userId: 'u1',
    associationNo: 'GTK100',
    existingRefundLogs: [consumeLog('GTK100')],
  })
  assert(decision.allowed === true, '扣费流水本身不应被判成「已退款」')
})

check('退款属于另一次消费（不同单号）→ 不影响本单退款', () => {
  const decision = decideRefundIdempotency({
    userId: 'u1',
    associationNo: 'GTK100',
    existingRefundLogs: [refundLog('GTK999')],
  })
  assert(decision.allowed === true, '别的单号退款不应挡住本单')
})

check('缺少单号 → 拒绝（missing_association_no），绝不放在无法去重的情况下加钱', () => {
  const decision = decideRefundIdempotency({
    userId: 'u1',
    associationNo: '   ',
    existingRefundLogs: [],
  })
  assert(decision.allowed === false, '无单号不应放行')
  assert(!decision.allowed && decision.reason === 'missing_association_no', '原因应为 missing_association_no')
})

check('hasCommittedRefund 只看 REFUND+INCREASE，单号两端空白也视为同一单', () => {
  assert(hasCommittedRefund([refundLog(' GTK100 ')], 'GTK100') === true, '应忽略两端空白匹配同一单')
  assert(hasCommittedRefund([{ associationNo: 'GTK100', changeType: 'REFUND', action: 'DECREASE' }], 'GTK100') === false, '方向为 DECREASE 不是退款')
  assert(hasCommittedRefund([], '') === false, '空单号不应命中')
})

check('幂等键按「用户 + 单号」拼接，并去掉两端空白', () => {
  assert(
    buildRefundIdempotencyKey({ userId: ' u1 ', associationNo: ' GTK100 ' }) === 'u1::GTK100',
    '幂等键应为 trim 后的 userId::associationNo',
  )
})

console.log('== B. 连调两次：第一次放行、第二次被拒，余额只变一次 ==')

check('模拟退款两连调：第二次是 no-op，净增只有一次', () => {
  const ledger: RefundLedgerEntry[] = []
  let balance = 0
  const pointCost = 6
  const associationNo = 'GTK-2CALL'

  const attemptRefund = (): boolean => {
    // 与 refundGenerationPoints 同构：查已有退款流水 → 判定 → 放行才加钱、落流水
    const decision = decideRefundIdempotency({
      userId: 'u1',
      associationNo,
      existingRefundLogs: ledger,
    })
    if (!decision.allowed) return false
    balance += pointCost
    ledger.push(refundLog(associationNo))
    return true
  }

  const first = attemptRefund()
  const balanceAfterFirst = balance
  const second = attemptRefund()

  assert(first === true, '第一次退款应成功')
  assert(balanceAfterFirst === pointCost, `第一次后余额应为 ${pointCost}，实际 ${balanceAfterFirst}`)
  assert(second === false, '第二次退款应被拒（no-op）')
  assert(balance === pointCost, `第二次后余额不得再变（仍为 ${pointCost}），实际 ${balance}`)
  assert(ledger.length === 1, `只应有一条退款流水，实际 ${ledger.length}`)
})

const main = () => {
  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

main()
