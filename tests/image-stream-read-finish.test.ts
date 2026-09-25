/**
 * 图片流式响应「什么时候算读完」的单测（2026-09-26）
 *
 * 起因：用户报「上游已经出结果，但画布一直在生成中」。日志实测 —— 一条图片任务从
 * 「开始请求」到「请求上游」用了 **305 秒**，而中转站自己那行调用记录是 **36 秒**
 * （图早就好了）。原因是读取循环只在**上游关掉流**时才收工，`data: [DONE]`
 * （SSE 约定的流结束标记）只被 `continue` 跳过；上游发完图和 [DONE] 却不关连接时，
 * 我们一直干等到连接被空闲超时掐掉。
 *
 * 这里用「发完图和 [DONE] 之后再也不关」的流如实复现那个上游，钉死两个出口：
 *   ① 收到 [DONE] 立即收工（不看 socket 是否关闭）；
 *   ② 已经拿到图之后静默一段时间也收工（上游既不发 [DONE] 也不关连接的兜底）。
 *
 * 跑法：npx tsx tests/image-stream-read-finish.test.ts
 */
import { extractImageUrlsFromStreamResponse } from '../server/generation-tasks/upstream-helpers'

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

const IMAGE_URL = 'https://example.test/generated/coffee.png'
const imageFrame = `data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: IMAGE_URL } }] } }] })}\n\n`

/** 帧发完之后**永不关闭**地挂着 —— 那次 305 秒的服务端就是这个行为 */
const neverClosingStream = (frames: string[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      // 刻意不 close()
    },
  })
}

const makeResponse = (frames: string[]) => ({
  ok: true,
  status: 200,
  body: neverClosingStream(frames),
  headers: new Headers({ 'content-type': 'text/event-stream' }),
}) as unknown as Response

const neverAborted = new AbortController().signal

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

await check('收到 data: [DONE] 就收工：上游不关连接也不该干等', async () => {
  const finishes: unknown[] = []
  const urls = await withTimeout(
    extractImageUrlsFromStreamResponse(
      makeResponse([imageFrame, 'data: [DONE]\n\n']),
      neverAborted,
      { onFinish: (info) => finishes.push(info) },
    ),
    3000,
    '上游已发 [DONE] 却不关连接时，我们仍在干等（这次真机上等了 305 秒）',
  )
  assert(urls.includes(IMAGE_URL), `应解析出图片地址，实际=${JSON.stringify(urls)}`)
  const info = finishes[0] as { endedBy?: string } | undefined
  assert(info?.endedBy === 'done_marker', `收工原因应为 done_marker，实际=${info?.endedBy}`)
})

await check('没发 [DONE] 也不关连接：拿到图后静默一小段就收工', async () => {
  const finishes: Array<{ endedBy?: string }> = []
  const urls = await withTimeout(
    extractImageUrlsFromStreamResponse(
      makeResponse([imageFrame]),
      neverAborted,
      { idleAfterResultMs: 200, onFinish: (info) => finishes.push(info) },
    ),
    3000,
    '拿到图之后仍不放手（上游既不发 [DONE] 也不关连接时会一直挂着）',
  )
  assert(urls.includes(IMAGE_URL), `应解析出图片地址，实际=${JSON.stringify(urls)}`)
  assert(finishes[0]?.endedBy === 'idle_after_result', `收工原因应为 idle_after_result，实际=${finishes[0]?.endedBy}`)
})

await check('正常关闭的流照旧工作，且收工原因是 stream_closed', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(imageFrame))
      controller.close()
    },
  })
  const finishes: Array<{ endedBy?: string }> = []
  const urls = await withTimeout(
    extractImageUrlsFromStreamResponse(
      { ok: true, status: 200, body, headers: new Headers() } as unknown as Response,
      neverAborted,
      { onFinish: (info) => finishes.push(info) },
    ),
    3000,
    '正常关闭的流不该超时',
  )
  assert(urls.includes(IMAGE_URL), `应解析出图片地址，实际=${JSON.stringify(urls)}`)
  assert(finishes[0]?.endedBy === 'stream_closed', `收工原因应为 stream_closed，实际=${finishes[0]?.endedBy}`)
})

await check('读到的地址会被去重前的原样返回（多张图不丢）', async () => {
  const second = 'https://example.test/generated/second.png'
  const secondFrame = `data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: second } }] } }] })}\n\n`
  const urls = await withTimeout(
    extractImageUrlsFromStreamResponse(makeResponse([imageFrame, secondFrame, 'data: [DONE]\n\n']), neverAborted),
    3000,
    '多图流不该超时',
  )
  assert(urls.includes(IMAGE_URL) && urls.includes(second), `两张图都该拿到，实际=${JSON.stringify(urls)}`)
})

/**
 * 这条直接关系到钱：n=2 时第二张图可能比第一张晚很多才来。
 * 如果空闲闸门只看「有没有图」（而不是「够不够张数」），第一张到手 15 秒后就会收工，
 * 第二张连同连接一起被丢掉 —— 用户付了两张的钱只拿到一张。
 */
await check('n=2 且第二张来得比空闲窗口更晚：两张都必须拿到', async () => {
  const second = 'https://example.test/generated/late-second.png'
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(imageFrame))
      // 第二张图远晚于空闲窗口（50ms > idleAfterResultMs=30ms）才到
      setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { images: [{ image_url: { url: second } }] } }] })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }, 50)
    },
  })
  const urls = await withTimeout(
    extractImageUrlsFromStreamResponse(
      { ok: true, status: 200, body, headers: new Headers() } as unknown as Response,
      neverAborted,
      { expectedCount: 2, idleAfterResultMs: 30 },
    ),
    3000,
    'n=2 的流不该超时',
  )
  assert(
    urls.includes(IMAGE_URL) && urls.includes(second),
    `两张都该拿到（少一张等于用户白付一张的钱），实际=${JSON.stringify(urls)}`,
  )
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
