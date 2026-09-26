/**
 * 音频生成链路单测（2026-09-26）
 *
 * 钉死三件事：
 *   1. 上游三种响应形状都能提出音频地址：OpenAI 内联（data[].url / data[].b64_json）、
 *      任务制取件（output.audio_url / 顶层 audio_url）、纯文本里的音频链接；
 *   2. b64 统一转成 data:audio/...;base64,...（前端能直接播放）；
 *   3. 拿不到音频地址时**必须抛错**，而不是静默写一条「成功但没结果」的记录。
 *
 * 跑法：npx tsx tests/audio-pipeline.test.ts
 */

import {
  extractAudioUrlsFromJsonResponse,
  extractAudioUrlsFromText,
} from '../src/shared/upstream-stream-parser'
import { normalizeAudioGenerationRequestBody } from '../src/shared/upstream-request-normalizer'
import { executeAudioTask, type AudioTaskExecutorContext } from '../server/generation-tasks/audio-task-executor'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

console.log('上游响应提取 —— OpenAI 内联：')
check('data[].url 直接取地址',
  extractAudioUrlsFromJsonResponse({ data: [{ url: 'https://cdn.example.com/a.mp3' }] }),
  ['https://cdn.example.com/a.mp3'])
check('data[].b64_json 转 data URL',
  extractAudioUrlsFromJsonResponse({ data: [{ b64_json: 'QUJDRA==' }] }),
  ['data:audio/mpeg;base64,QUJDRA=='])
check('data[].b64_json 声明 mime_type 时按其类型',
  extractAudioUrlsFromJsonResponse({ data: [{ b64_json: 'QUJDRA==', mime_type: 'audio/wav' }] }),
  ['data:audio/wav;base64,QUJDRA=='])

console.log('\n上游响应提取 —— 任务制取件：')
check('output.audio_url',
  extractAudioUrlsFromJsonResponse({ output: { audio_url: 'https://cdn.example.com/b.wav' } }),
  ['https://cdn.example.com/b.wav'])
check('顶层 audio_url',
  extractAudioUrlsFromJsonResponse({ audio_url: 'https://cdn.example.com/c.ogg' }),
  ['https://cdn.example.com/c.ogg'])
check('output 直接是字符串地址',
  extractAudioUrlsFromJsonResponse({ output: 'https://cdn.example.com/d.m4a' }),
  ['https://cdn.example.com/d.m4a'])
check('output.audio.url 再包一层',
  extractAudioUrlsFromJsonResponse({ output: { audio: { url: 'https://cdn.example.com/e.aac' } } }),
  ['https://cdn.example.com/e.aac'])
check('data[].audio_url',
  extractAudioUrlsFromJsonResponse({ data: [{ audio_url: 'https://cdn.example.com/f.flac' }] }),
  ['https://cdn.example.com/f.flac'])

console.log('\n上游响应提取 —— 纯文本：')
check('裸音频链接',
  extractAudioUrlsFromText('生成完成：https://cdn.example.com/song.mp3 请下载'),
  ['https://cdn.example.com/song.mp3'])
check('markdown 链接里的音频地址',
  extractAudioUrlsFromText('[音频](https://cdn.example.com/song.mp3)'),
  ['https://cdn.example.com/song.mp3'])
check('内联 data:audio',
  extractAudioUrlsFromText('结果 data:audio/wav;base64,QUJD 结束'),
  ['data:audio/wav;base64,QUJD'])
check('路径含 /audio/ 的地址（无扩展名也认）',
  extractAudioUrlsFromText('{"url":"https://gateway.example.com/audio/abc123"}'),
  ['https://gateway.example.com/audio/abc123'])
check('非 JSON 文本里的多个地址去重',
  extractAudioUrlsFromText('两个：https://a.com/x.mp3 与 https://a.com/x.mp3'),
  ['https://a.com/x.mp3'])

console.log('\n请求体归一化：')
check('清掉 providerId 与 _ 前缀内部字段，保留上游字段',
  normalizeAudioGenerationRequestBody({
    requestBody: {
      providerId: 'p1',
      model: '旧模型',
      prompt: '  一段旁白  ',
      duration: '30',
      voice: 'alloy',
      format: 'mp3',
      _traceId: 't-1',
      _idempotencyKey: 'k-1',
    },
    modelKey: 'audio-1',
  }),
  { model: 'audio-1', prompt: '一段旁白', duration: '30', voice: 'alloy', format: 'mp3' })
check('seconds 同 duration 一样保留',
  normalizeAudioGenerationRequestBody({
    requestBody: { seconds: '60' },
    modelKey: 'audio-1',
  }),
  { seconds: '60', model: 'audio-1' })
check('空字符串字段被删除',
  normalizeAudioGenerationRequestBody({
    requestBody: { prompt: '   ', voice: '' },
    modelKey: 'audio-1',
  }),
  { model: 'audio-1' })

console.log('\n执行器收尾：')

type ExecutorTask = Parameters<typeof executeAudioTask>[0]

const buildContext = (input: {
  audioUrls: string[]
  throwOnRequest?: boolean
  captured: { record?: Record<string, unknown>; events: Array<Record<string, unknown>> }
}): AudioTaskExecutorContext => ({
  syncSharedTaskRuntime: async () => {},
  ensureTaskNotAborted: async () => {},
  emitTaskProgressEvent: () => {},
  markTaskRetryState: async () => {},
  requestAudioGeneration: async () => {
    if (input.throwOnRequest) {
      throw new Error('未能获取到生成的音频')
    }
    return { upstreamUrl: 'https://upstream.example.com/audio', audioUrls: input.audioUrls }
  },
  buildInitialRecordPayload: () => ({
    type: 'audio',
    prompt: '一段旁白',
  }),
  updateGenerationRecord: async (_recordId, payload) => {
    input.captured.record = payload as unknown as Record<string, unknown>
  },
  getGenerationRecordById: async () => ({ id: 'record-1' }),
  emitTaskStreamEvent: (_recordId, event) => {
    input.captured.events.push(event as unknown as Record<string, unknown>)
  },
  logGenerationTask: () => {},
})

const buildTask = (): ExecutorTask => ({
  recordId: 'record-1',
  userId: 'user-1',
  abortController: new AbortController(),
} as unknown as ExecutorTask)

const successCaptured = { events: [] as Array<Record<string, unknown>>, record: undefined as Record<string, unknown> | undefined }
await executeAudioTask(
  buildTask(),
  { type: 'audio', prompt: '一段旁白', modelKey: 'audio-1', requestBody: { providerId: 'p1', seconds: 30 } },
  buildContext({ audioUrls: ['data:audio/wav;base64,QUJD'], captured: successCaptured }),
)
const successOutputs = (successCaptured.record?.outputs || []) as Array<Record<string, unknown>>
check('成功时写入 done=true', successCaptured.record?.done, true)
check('成功时写入 stopped=false', successCaptured.record?.stopped, false)
check('输出类型为 audio', successOutputs[0]?.outputType, 'audio')
check('输出 url 为上游地址', successOutputs[0]?.url, 'data:audio/wav;base64,QUJD')
check('输出 mimeType 从 data URL 推导', successOutputs[0]?.mimeType, 'audio/wav')
check('输出 durationSeconds 取自 requestBody.seconds', successOutputs[0]?.durationSeconds, 30)
check('广播 completed 事件', successCaptured.events.some((event) => event.type === 'completed'), true)

let emptyError = ''
try {
  await executeAudioTask(
    buildTask(),
    { type: 'audio', prompt: '一段旁白', modelKey: 'audio-1', requestBody: { providerId: 'p1' } },
    buildContext({ audioUrls: [], captured: { events: [] } }),
  )
} catch (error) {
  emptyError = error instanceof Error ? error.message : String(error)
}
check('上游没回音频地址时抛错（不静默成功）', emptyError, '未能获取到生成的音频')

let missingProviderError = ''
try {
  await executeAudioTask(
    buildTask(),
    { type: 'audio', prompt: '一段旁白', modelKey: 'audio-1', requestBody: {} },
    buildContext({ audioUrls: ['https://x/a.mp3'], captured: { events: [] } }),
  )
} catch (error) {
  missingProviderError = error instanceof Error ? error.message : String(error)
}
check('缺少 providerId 时抛错', missingProviderError, '缺少音频厂商配置')

console.log('\n反证（这些断言必须失败，用来证明上面不是「怎么改都过」）：')
let reverseFailed = 0
const reverseAssert = (label: string, condition: boolean) => {
  if (condition) {
    reverseFailed++
    console.log(`  ❌ 反证未生效：${label}`)
  } else {
    passed++
    console.log(`  ✅ 反证成立：${label}`)
  }
}
// 反证 1：图片地址不能被当成音频地址 —— 否则「拿不到音频就抛错」这条会被假阳性绕过。
reverseAssert('图片链接被误当音频',
  extractAudioUrlsFromText('封面图 https://cdn.example.com/cover.png 与说明文字').length > 0)
// 反证 2：纯报告 JSON（没有音频字段）必须提取为空，否则空结果会被伪装成成功。
reverseAssert('无音频字段的 JSON 被误提取',
  extractAudioUrlsFromJsonResponse({ output: { text: '已完成，但没有音频' } }).length > 0)
// 反证 3：一个没有 providerId 的请求体归一化后仍带 providerId，说明清洗没生效。
reverseAssert('providerId 没被清洗掉',
  Object.prototype.hasOwnProperty.call(
    normalizeAudioGenerationRequestBody({ requestBody: { providerId: 'p1' }, modelKey: 'm' }),
    'providerId',
  ))
check('反证组本身没有出现意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
