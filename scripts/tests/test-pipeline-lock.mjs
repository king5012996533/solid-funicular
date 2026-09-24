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
  evaluateCanvasWriteLock,
  isPipelineLockExpired,
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

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
