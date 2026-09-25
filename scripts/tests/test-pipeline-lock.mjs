#!/usr/bin/env node
/**
 * 画布流水线锁的决策逻辑单测（纯函数，不连库）。
 *
 * 为什么这几条值得单测：写入口的守卫一旦写反，症状是两个方向都很糟 ——
 *   写严了：Agent 自己那轮的保存被自己的锁拦掉，整条流水线空转；
 *   写松了：外部改动照旧能插进来，锁形同虚设（就是这个功能要解决的问题）。
 * 而且这两条路径平时很难在真机上复现，所以把决策规则单独钉死。
 *
 * 跑法：npx tsx scripts/tests/test-pipeline-lock.mjs
 */
import {
  canForceReleaseLockForUser,
  evaluateCanvasWriteLock,
  isPipelineLockExpired,
  shouldReleaseLockForTask,
} from '../../server/workflow-definitions/pipeline-lock-rules.ts'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

const now = 1_800_000_000_000
const lock = (overrides = {}) => ({
  workflowId: 'wf_1',
  userId: 'user_1',
  token: 'pl_token_A',
  snapshotVersionId: 'ver_snapshot',
  acquiredAt: now - 1000,
  expiresAt: now + 60_000,
  ...overrides,
})

console.log('== 写入守卫 ==')

check('没有锁时一律放行（不跑流水线时不能影响任何人）', () => {
  assert(evaluateCanvasWriteLock(null, undefined, now).blocked === false, '无锁应放行')
  assert(evaluateCanvasWriteLock(undefined, 'whatever', now).blocked === false, '无锁应放行')
})

check('持锁 + 没带 token（外部写入）→ 拦下，并给出持锁者', () => {
  const decision = evaluateCanvasWriteLock(lock(), undefined, now)
  assert(decision.blocked === true, '应拦下')
  assert(decision.holder?.token === 'pl_token_A', '要能告诉调用方是谁持锁')
})

check('持锁 + token 不对 → 拦下', () => {
  assert(evaluateCanvasWriteLock(lock(), 'pl_token_WRONG', now).blocked === true, '错 token 应拦下')
})

check('持锁 + token 正确 → **必须放行**（Agent 自己那轮的保存就走这条路）', () => {
  assert(evaluateCanvasWriteLock(lock(), 'pl_token_A', now).blocked === false, '对 token 必须放行 —— 拦了等于把自己的写入挡住')
})

check('空 token 与 undefined 等价（都不能冒充持锁者）', () => {
  assert(evaluateCanvasWriteLock(lock(), '', now).blocked === true, '空 token 应拦下')
})

console.log('\n== TTL 兜底 ==')

check('锁过期后放行（避免任务僵死把画布永久锁住）', () => {
  const expired = lock({ expiresAt: now - 1 })
  assert(isPipelineLockExpired(expired, now) === true, '应判定为过期')
  assert(evaluateCanvasWriteLock(expired, undefined, now).blocked === false, '过期锁不该继续拦人')
})

check('未过期的锁仍然拦人（别把兜底写成「永远放行」）', () => {
  const alive = lock({ expiresAt: now + 1 })
  assert(isPipelineLockExpired(alive, now) === false, '不该判定为过期')
  assert(evaluateCanvasWriteLock(alive, undefined, now).blocked === true, '未过期就该拦')
})

console.log('\n== 任务终态释放（只放自己那把） ==')

check('recordId 匹配 → 允许按任务释放（任务终态收口走这条）', () => {
  assert(shouldReleaseLockForTask(lock({ recordId: 'rec_A' }), 'rec_A') === true, '同一任务应能放')
})

check('recordId 不匹配 → **不放**（任务 A 收口不能误放 B 后来取的锁）', () => {
  assert(shouldReleaseLockForTask(lock({ recordId: 'rec_B' }), 'rec_A') === false, '不同任务绝不能放')
})

check('没有 recordId（老客户端取锁未绑定）→ 不放，交给 TTL/客户端释放', () => {
  assert(shouldReleaseLockForTask(lock(), 'rec_A') === false, '未绑定的锁不该被任意任务放掉')
})

check('return false 是幂等前提：锁已不在 / recordId 为空都不该误判', () => {
  assert(shouldReleaseLockForTask(null, 'rec_A') === false, '锁不存在应返回 false')
  assert(shouldReleaseLockForTask(lock({ recordId: 'rec_A' }), '') === false, '空 recordId 应返回 false')
})

console.log('\n== 同用户强制释放（只放自己的锁） ==')

check('同一用户 → 可以强制释放自己画布上的锁', () => {
  assert(canForceReleaseLockForUser(lock({ userId: 'user_1' }), 'user_1') === true, '自己的锁应可强制释放')
})

check('不同用户 → 拒绝（别人的锁一律不动）', () => {
  assert(canForceReleaseLockForUser(lock({ userId: 'user_1' }), 'user_2') === false, '不能放别人的锁')
})

check('锁不存在 / 空 userId → 不肯放', () => {
  assert(canForceReleaseLockForUser(null, 'user_1') === false, '没有锁应返回 false')
  assert(canForceReleaseLockForUser(lock({ userId: 'user_1' }), '') === false, '空 userId 应返回 false')
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
