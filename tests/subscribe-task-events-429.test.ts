/**
 * 任务事件订阅遇到 429 的行为单测（2026-09-25）
 *
 * 起因：用户看到「Agent 调用失败：订阅任务状态失败 (429)」——既没说清是什么上限，也没有恢复路径。
 * 429 在这里的含义是「该用户的实时订阅数量已达上限」，多半是别的页面还挂着连接、稍等就腾出来了，
 * 所以应**当作可重试**（退避后重连），而不是像其它 4xx 一样立刻失败。
 *
 * 跑法：npx tsx tests/subscribe-task-events-429.test.ts
 */
import { subscribeGenerationTaskEvents } from '../src/api/generation-tasks'

let passed = 0
let failed = 0
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn()
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

const completedStream = () => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: completed\ndata: {"type":"completed","recordId":"task-x","done":true}\n\n',
      ))
      controller.close()
    },
  })
}

await check('429 会被当作可重试：退避后重连成功，不抛错', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ message: '当前用户的实时订阅数量已达上限（20），请关闭部分页面后重试' }),
      } as unknown as Response
    }
    return { ok: true, status: 200, body: completedStream() } as unknown as Response
  }) as typeof fetch
  try {
    let events = 0
    await subscribeGenerationTaskEvents('task-x', {
      onEvent: () => { events += 1 },
    })
    assert(calls === 2, `应在 429 后重连一次，fetch 调用次数=${calls}`)
    assert(events >= 1, '重连后应收到终止事件')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('其它 4xx（如 404 任务不存在）仍然立即失败、不重试', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return { ok: false, status: 404, text: async () => '{}' } as unknown as Response
  }) as typeof fetch
  try {
    let message = ''
    try {
      await subscribeGenerationTaskEvents('task-missing', { onEvent: () => {} })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(calls === 1, `永久性 4xx 不该重试，fetch 调用次数=${calls}`)
    assert(/404/.test(message), `应保留原始状态码：${message}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
