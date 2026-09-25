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

/**
 * 服务端发完终态事件**不会自己关连接**（它只发事件，靠 15s 心跳保活到寿命上限，默认 30 分钟）。
 * 客户端若不主动断开，这条订阅就一直占着用户的实时订阅额度 —— 每条任务白占半小时，攒满 20 条
 * 之后全线 429。这里用一个「发完 completed 就再也不关」的流模拟真实服务端，钉住主动断开行为。
 */
const terminalThenHangStream = (init?: { signal?: AbortSignal }) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: completed\ndata: {"type":"completed","recordId":"task-y","done":true}\n\n',
      ))
      // 故意不 close()：模拟服务端挂着的连接
      // 真实 fetch 在 signal 触发时会取消响应体，让挂起的 read() 以 AbortError 失败（这里如实模拟）
      init?.signal?.addEventListener('abort', () => {
        try {
          controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        } catch {
          // 流已关闭
        }
      })
    },
  })
}

await check('收到终态事件即主动断开：不再白占订阅额度半小时', async () => {
  const originalFetch = globalThis.fetch
  let capturedSignal: AbortSignal | undefined
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    capturedSignal = init?.signal
    return { ok: true, status: 200, body: terminalThenHangStream(init) } as unknown as Response
  }) as unknown as typeof fetch
  try {
    let events = 0
    const hangGuard = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('终态后订阅没有主动断开（等 3 秒仍未返回，真实场景下这会占住额度直到 30 分钟寿命上限）')), 3000)
    })
    await Promise.race([
      subscribeGenerationTaskEvents('task-y', { onEvent: () => { events += 1 } }),
      hangGuard,
    ])
    assert(events === 1, `应恰好派发一次终态事件，实际 ${events}`)
    assert(capturedSignal?.aborted === true, '终态事件后应断开本轮连接（signal.aborted 应为 true）')
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
