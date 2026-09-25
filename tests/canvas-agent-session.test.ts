/**
 * 制片 Agent 会话跨轮存活的纯逻辑验证（2026-09-26）
 *
 * 要钉死的四件事，它们共同构成「画布 Agent 像个真正的智能体」的地基：
 *   1. **跨轮记忆**：上一轮 Pi 的转录（含工具调用与结果）能落库、下一轮能恢复，
 *      system 头每轮重建（否则本轮新 systemPrompt 会被旧转录里那条 system 顶掉）；
 *   2. **按 sessionId + 画布隔离**：助手会话在浏览器里是全局的，不按画布隔离就会串台；
 *   3. **超预算裁剪**：按用户回合边界丢最旧的，toolCall / toolResult 必须成对留下；
 *   4. **fallback 不受条数限制**：旧的「固定 6/8 条 × 每条 500 字」不再腰斩上下文。
 *
 * 这些都是「不报错、形状不变、模型照样答得通，只是没记忆」的静默错误 ——
 * typecheck / 构建 / e2e 一个都抓不住，只能靠这里的断言。文件末尾有**反证**：
 * 关掉恢复（拿不到画布 id）时记忆必须消失，用例会因此失败。
 */

import {
  CANVAS_AGENT_SESSION_META_KEY,
  CANVAS_AGENT_SESSION_VERSION,
  buildCanvasAgentSessionMeta,
  countTranscriptChars,
  readCanvasAgentSession,
  resolveCanvasAgentCanvasId,
  resolveCanvasAgentSessionBootstrap,
  selectCanvasAgentFallbackHistory,
  toPersistedTranscriptMessages,
  trimTranscriptToBudget,
} from '../server/generation-tasks/canvas-agent-session'
import {
  buildPromptWithExecutionDemand,
  buildPromptWithHistory,
} from '../server/generation-tasks/canvas-agent-executor'

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

/** 造一条第一轮结束时的 Pi 转录（system 头 + 一次工具调用 + 收尾文本） */
const buildRoundOneTranscript = () => ([
  {
    role: 'system',
    content: '你是制片 Agent（第 1 轮系统提示）',
    toolsAdded: [{ name: 'get_canvas_overview', description: '看画布', parameters: { type: 'object' } }],
    timestamp: 0,
  },
  { role: 'user', content: '第一轮：主角叫阿星，短发', timestamp: 1 },
  {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call_1', name: 'get_canvas_overview', arguments: {} }],
    api: 'openai-completions',
    provider: 'canana-gateway',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'get_canvas_overview',
    content: [{ type: 'text', text: '{"nodes":[]}' }],
    isError: false,
    timestamp: 3,
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '记住了：主角叫阿星，短发。' }],
    api: 'openai-completions',
    provider: 'canana-gateway',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 4,
  },
])

const rolesOf = (messages: unknown[]) => messages.map((m) => String((m as { role?: string }).role || ''))

console.log('\n【1】画布 id 来自流水线锁的 workflowId；拿不到就是空（宁可少带记忆，也不串台）')
{
  check('有锁 → 取 workflowId', resolveCanvasAgentCanvasId({ pipelineLock: { workflowId: 'canvas-A' } }), 'canvas-A')
  check('无锁（未保存画布）→ 空串', resolveCanvasAgentCanvasId({}), '')
  check('requestBody 为空 → 空串', resolveCanvasAgentCanvasId(null), '')
  check('workflowId 带空格 → 去掉', resolveCanvasAgentCanvasId({ pipelineLock: { workflowId: '  canvas-A  ' } }), 'canvas-A')
}

console.log('\n【2】落库只留非 system 消息（保留旧 system 头会让本轮新 systemPrompt 失效）')
{
  const persisted = toPersistedTranscriptMessages(buildRoundOneTranscript())
  check('system 头被丢掉', rolesOf(persisted), ['user', 'assistant', 'toolResult', 'assistant'])
  check('工具调用与结果都还在', persisted.some((m) => JSON.stringify(m).includes('call_1')), true)
  check('是纯 JSON 数据（往返不变）', JSON.parse(JSON.stringify(persisted)), persisted)
  check('非数组输入 → 空数组', toPersistedTranscriptMessages(null), [])

  const failedTurn = toPersistedTranscriptMessages([
    { role: 'user', content: '有效提问' },
    { role: 'assistant', content: [], stopReason: 'error' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '只想不说' }], stopReason: 'stop' },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: [{ type: 'text', text: '有用的话' }], stopReason: 'stop' },
  ])
  check(
    '空的/只有思考的失败回合被剔除（否则恢复时上游会 400 content:null）',
    rolesOf(failedTurn),
    ['user', 'assistant'],
  )
  check('有效文本仍保留', JSON.stringify(failedTurn).includes('有用的话'), true)
}

console.log('\n【3】跨轮恢复：第 2 轮拿回第 1 轮的完整会话（核心目标）')
{
  const session = buildCanvasAgentSessionMeta({ canvasId: 'canvas-A', messages: buildRoundOneTranscript(), savedAt: '2026-09-26T00:00:00.000Z' })
  const metaJson = { source: 'canvas-assistant', [CANVAS_AGENT_SESSION_META_KEY]: session }

  const restored = readCanvasAgentSession(metaJson, 'canvas-A')
  check('版本号正确', restored?.version, CANVAS_AGENT_SESSION_VERSION)
  check('画布 id 正确', restored?.canvasId, 'canvas-A')
  check('恢复出 4 条非 system 消息', restored?.messages.length, 4)
  check('恢复的消息里没有 system', rolesOf(restored?.messages || []).includes('system'), false)

  const bootstrap = resolveCanvasAgentSessionBootstrap({
    requestBody: { pipelineLock: { workflowId: 'canvas-A' } },
    sessionId: 'sess-1',
    previousSession: restored,
  })
  check('走恢复路径', bootstrap.source, 'session')
  check('恢复启用', bootstrap.restoreEnabled, true)
  check('记忆里的设定还在', JSON.stringify(bootstrap.restoredMessages).includes('阿星'), true)
}

console.log('\n【4】切画布不串台：同会话但换了画布 id → 必须恢复不到')
{
  const session = buildCanvasAgentSessionMeta({ canvasId: 'canvas-A', messages: buildRoundOneTranscript() })
  const metaJson = { [CANVAS_AGENT_SESSION_META_KEY]: session }

  check('A 画布的转录在 B 画布读不到', readCanvasAgentSession(metaJson, 'canvas-B'), null)

  const bootstrap = resolveCanvasAgentSessionBootstrap({
    requestBody: { pipelineLock: { workflowId: 'canvas-B' } },
    sessionId: 'sess-1',
    previousSession: session,
  })
  check('B 画布退回 fallback', bootstrap.source, 'fallback')
  check('B 画布没有 A 的记忆', bootstrap.restoredMessages.length, 0)
}

console.log('\n【5】版本不符 / 空转录 / 缺画布 id → 一律退回 fallback（绝不用可疑数据拼上下文）')
{
  const badVersion = { [CANVAS_AGENT_SESSION_META_KEY]: { version: 999, canvasId: 'canvas-A', messages: [{ role: 'user', content: 'x' }] } }
  check('版本 999 不可用', readCanvasAgentSession(badVersion, 'canvas-A'), null)
  check('无画布 id 不读', readCanvasAgentSession({ [CANVAS_AGENT_SESSION_META_KEY]: { version: 1, canvasId: 'canvas-A', messages: [] } }, ''), null)
  check('无 canvasId 时 build 返回 null（不落库）', buildCanvasAgentSessionMeta({ canvasId: '', messages: buildRoundOneTranscript() }), null)
  check('空转录 build 返回 null', buildCanvasAgentSessionMeta({ canvasId: 'canvas-A', messages: [] }), null)

  const bootstrap = resolveCanvasAgentSessionBootstrap({ requestBody: {}, sessionId: 'sess-1', previousSession: null })
  check('无锁 → 不启用恢复', bootstrap.restoreEnabled, false)
  check('无锁 → 走 fallback', bootstrap.source, 'fallback')
}

console.log('\n【6】超预算裁剪：从最旧的用户回合丢，且不劈开 toolCall / toolResult')
{
  const huge = 'x'.repeat(5_000)
  const messages = [
    { role: 'user', content: `第一回合${huge}`, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 't', arguments: {} }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c1', toolName: 't', content: [{ type: 'text', text: huge }], isError: false, timestamp: 3 },
    { role: 'user', content: '第二回合', timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 5 },
  ]

  const trimmed = trimTranscriptToBudget(messages, 6_000)
  check('从第二回合开始留（第一回合超预算被丢）', trimmed[0], messages[3])
  check('保留的是尾部', trimmed.length, 2)
  check('助手工具对没被拆开（要么全留要么全丢）', rolesOf(trimmed), ['user', 'assistant'])

  const tight = trimTranscriptToBudget(messages, 10)
  check('预算极小时至少保留最后一个回合', rolesOf(tight), ['user', 'assistant'])
  check('空输入 → 空', trimTranscriptToBudget([], 100), [])
  check('字符量估算随消息增长', countTranscriptChars([{ role: 'user', content: 'abc' }]) > 0, true)
}

console.log('\n【7】fallback 历史：不再固定 6 条 / 每条约 500 字，由字符预算决定')
{
  const longLine = '很长的历史'.repeat(400) // 2000 字，旧实现会被砍到 500
  const lines = selectCanvasAgentFallbackHistory([
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: longLine },
  ])
  check('长消息不再被腰斩', lines[1].content.length, longLine.length)
  check('时间顺序不变（最早在前）', lines.map((l) => l.role), ['user', 'assistant'])

  const manyLines = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}句`.repeat(200) }))
  const bounded = selectCanvasAgentFallbackHistory(manyLines, 3_000)
  check('超预算时丢掉最旧的', bounded.length < manyLines.length, true)
  check('保留的是最新的', bounded[bounded.length - 1].content, manyLines[manyLines.length - 1].content)
  check('过滤非对话角色', selectCanvasAgentFallbackHistory([{ role: 'system', content: 'x' }]), [])
}

console.log('\n【8】fallback 提示词仍能拼历史；恢复路径不重复拼历史')
{
  const body = {
    referenceImages: ['/uploads/a.png'],
    history: [{ role: 'user', content: '上一句' }, { role: 'assistant', content: '上一答' }],
  }
  const withHistory = buildPromptWithHistory('这一轮的新要求', body)
  check('fallback 带上历史', withHistory.includes('上一答'), true)
  check('fallback 带上本轮要求', withHistory.includes('这一轮的新要求'), true)
  check('fallback 带上参考图提示', withHistory.includes('参考图'), true)

  const noHistory = buildPromptWithExecutionDemand('这一轮的新要求', body)
  check('恢复路径不带历史', noHistory.includes('上一答'), false)
  check('恢复路径仍带本轮要求', noHistory.includes('这一轮的新要求'), true)
  check('恢复路径仍带执行要求', noHistory.includes('本轮执行要求'), true)
}

console.log('\n【9】反证：关掉恢复（拿不到画布 id）时，第二轮记忆必然消失')
{
  const session = buildCanvasAgentSessionMeta({ canvasId: 'canvas-A', messages: buildRoundOneTranscript() })

  const restored = resolveCanvasAgentSessionBootstrap({
    requestBody: { pipelineLock: { workflowId: 'canvas-A' } },
    sessionId: 'sess-1',
    previousSession: session,
  })
  const notRestored = resolveCanvasAgentSessionBootstrap({
    requestBody: {}, // 没取到锁 / 未保存画布 → 恢复被跳过
    sessionId: 'sess-1',
    previousSession: session,
  })

  check('恢复开着时能记住', restored.source, 'session')
  check('恢复关掉后 source 变 fallback', notRestored.source, 'fallback')
  check(
    '反证成立：关掉恢复就丢记忆（若恢复逻辑被删，上一行的断言会失败）',
    restored.restoredMessages.length > notRestored.restoredMessages.length,
    true,
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
