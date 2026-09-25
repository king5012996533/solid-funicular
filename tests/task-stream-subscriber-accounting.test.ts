/**
 * 任务事件流订阅计数单测（2026-09-25）
 *
 * 背景：用户级 SSE 订阅额度（默认 20）被泄漏后，所有订阅一律 429（前端报
 * 「订阅任务状态失败 (429)」）。泄漏点有两个，都在这一层：
 *   1. 订阅时任务**已经结束**的那条路径：连接结束了却没有退订（修在 task-stream-subscription.ts，
 *      把统一的 close 退订提前到任何提前返回之前）；
 *   2. 事件下发时**写入失败/缓冲已满**的订阅者：只在本地集合里 delete、不主动断开，
 *      用户级计数（userStreamSubscribers）就永远留着这一项。
 * 本用例钉死第 2 点与基础的增删计数（第 1 点是纯顺序问题，由证据脚本对真实函数验证）。
 *
 * 跑法：npx tsx tests/task-stream-subscriber-accounting.test.ts
 */
import {
  addTaskStreamSubscriber,
  removeTaskStreamSubscriber,
  isUserStreamSubscriberLimitReached,
  emitLocalTaskStreamEvent,
  SSE_PER_USER_LIMIT,
} from '../server/generation-tasks/local-runtime'

let passed = 0
let failed = 0
const check = (name: string, fn: () => void) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`)
  }
}
const assert = (cond: unknown, message: string) => {
  if (!cond) throw new Error(message)
}

const makeRes = (writeBehavior: 'ok' | 'throw' | 'slow') => {
  const res: any = {
    ended: false,
    statusCode: 0,
    setHeader() {},
    flushHeaders() {},
    write() {
      if (writeBehavior === 'throw') throw new Error('socket destroyed')
      return writeBehavior !== 'slow'
    },
    end() {
      res.ended = true
    },
    on() {},
  }
  return res
}

check('加订阅后达上限判定为 true，退订后立刻释放', () => {
  const userId = 'accounting-user-a'
  const res = makeRes('ok')
  addTaskStreamSubscriber('task-a', res, userId)
  assert(isUserStreamSubscriberLimitReached(userId) === false, '1 个订阅不该算满')
  removeTaskStreamSubscriber('task-a', res, userId)
  assert(isUserStreamSubscriberLimitReached(userId) === false, '退订后应保持未满')
})

check(`同一用户攒满 ${SSE_PER_USER_LIMIT} 个订阅后才算满`, () => {
  const userId = 'accounting-user-b'
  const subs: any[] = []
  for (let i = 0; i < SSE_PER_USER_LIMIT; i += 1) {
    const res = makeRes('ok')
    subs.push(res)
    addTaskStreamSubscriber(`task-b-${i}`, res, userId)
  }
  assert(isUserStreamSubscriberLimitReached(userId) === true, '到上限应判定为满')
  for (let i = 0; i < subs.length; i += 1) {
    removeTaskStreamSubscriber(`task-b-${i}`, subs[i], userId)
  }
  assert(isUserStreamSubscriberLimitReached(userId) === false, '全部退订后应恢复未满')
})

check('下发事件时写入失败的订阅者会被主动断开（不再永久占据额度）', () => {
  const userId = 'accounting-user-c'
  const broken = makeRes('throw')
  const healthy = makeRes('ok')
  addTaskStreamSubscriber('task-c', broken, userId)
  addTaskStreamSubscriber('task-c', healthy, userId)
  emitLocalTaskStreamEvent('task-c', { type: 'progress', recordId: 'task-c', done: false } as any)
  assert(broken.ended === true, '写入失败必须调 res.end()（触发订阅侧 close 统一退订）')
  assert(healthy.ended === false, '健康订阅不该被误断')
  removeTaskStreamSubscriber('task-c', broken, userId)
  removeTaskStreamSubscriber('task-c', healthy, userId)
})

check('下发事件时缓冲已满（write 返回 false）的订阅者也会被断开', () => {
  const userId = 'accounting-user-d'
  const slow = makeRes('slow')
  addTaskStreamSubscriber('task-d', slow, userId)
  emitLocalTaskStreamEvent('task-d', { type: 'progress', recordId: 'task-d', done: false } as any)
  assert(slow.ended === true, '缓冲已满必须断开，避免内存堆积')
  removeTaskStreamSubscriber('task-d', slow, userId)
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
