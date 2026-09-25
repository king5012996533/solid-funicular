/**
 * 制片 Agent 会话跨轮存活的纯逻辑验证（2026-09-26）
 *
 * 要钉死的四件事，它们共同构成「画布 Agent 像个真正的智能体」的地基：
 *   1. **跨轮记忆**：上一轮 Pi 的转录（含工具调用与结果）能落库、下一轮能恢复，
 *      system 头每轮重建（否则本轮新 systemPrompt 会被旧转录里那条 system 顶掉）；
 *   2. **按 sessionId + 画布隔离**：助手会话在浏览器里是全局的，不按画布隔离就会串台；
 *   3. **超预算裁剪**：按用户回合边界丢最旧的，toolCall / toolResult 必须成对留下；
 *   4. **fallback 不受条数限制**：旧的「固定 6/8 条 × 每条 500 字」不再腰斩上下文；
 *   5. **主动压缩（2026-09-26）**：超预算时把最旧一段压成一条结构化摘要（摘要累积、失败安全回退），
 *      以及 `transformContext` 兜底裁剪必须保留头部 system（否则工作手册与工具声明会静默消失）。
 *   6. **摘要承载位置（2026-09-26）**：摘要从「转录里的 user 消息」挪进「每轮重建的 system 提示」并点名
 *      唯一历史来源 —— 因为真机上它被模型当成陈旧指令、问过去时答「看不到第 1 轮的对话记录」
 *      （记录 cmuhd62cn000q4k923m7vvhle）。库里仍按消息存（旧格式可读），累积靠落库前把旧摘要拼回最前。
 *
 * 这些都是「不报错、形状不变、模型照样答得通，只是没记忆」的静默错误 ——
 * typecheck / 构建 / e2e 一个都抓不住，只能靠这里的断言。文件末尾有**反证**：
 * 关掉恢复（拿不到画布 id）时记忆必须消失，用例会因此失败。
 */

import {
  CANVAS_AGENT_SESSION_META_KEY,
  CANVAS_AGENT_SESSION_VERSION,
  buildCanvasAgentRestoredContext,
  buildCanvasAgentSessionMeta,
  buildCanvasAgentSummaryMessage,
  buildCanvasAgentSummarySource,
  buildCanvasAgentSummarySystemSection,
  compactCanvasAgentTranscript,
  countTranscriptChars,
  extractCanvasAgentSummaryText,
  isCanvasAgentSummaryMessage,
  planCanvasAgentCompaction,
  readCanvasAgentSession,
  resolveCanvasAgentCanvasId,
  resolveCanvasAgentSessionBootstrap,
  selectCanvasAgentFallbackHistory,
  splitCanvasAgentSummary,
  toPersistedTranscriptMessages,
  trimTranscriptToBudget,
  trimTranscriptToBudgetPreservingSystem,
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

// ─────────────────────────────────────────────────────────────────────────────
// 【10】–【14】主动压缩（2026-09-26）：超预算时把最旧一段压成摘要，而不是直接丢
// ─────────────────────────────────────────────────────────────────────────────

/** 造一份「第一回合超预算、第二回合很短」的转录，用来断言压哪一段、留哪些 */
const buildOverBudgetTranscript = () => {
  const huge = 'x'.repeat(5_000)
  return [
    { role: 'user', content: `第一回合${huge}`, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 't', arguments: {} }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c1', toolName: 't', content: [{ type: 'text', text: huge }], isError: false, timestamp: 3 },
    { role: 'user', content: '第二回合', timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 5 },
  ]
}

console.log('\n【10】压缩决策：不超预算不压；超预算压最旧、留近期，且 toolCall/toolResult 成对')
{
  const under = planCanvasAgentCompaction(buildRoundOneTranscript(), { budget: 1_000_000 })
  check('不超预算 → 不压（不花冤枉钱）', under.shouldCompact, false)
  check('不压时原样保留非 system 消息', under.retained.length, 4)
  check('不压时 span 为空', under.span.length, 0)

  const plan = planCanvasAgentCompaction(buildOverBudgetTranscript(), { budget: 6_000, keepRecentBudget: 1_000 })
  check('超预算 → 要压', plan.shouldCompact, true)
  check('压的是最旧一段', rolesOf(plan.span), ['user', 'assistant', 'toolResult'])
  check('保留近期段', rolesOf(plan.retained), ['user', 'assistant'])
  check('发起工具调用的 assistant 落在待压段（不会与结果拆开）', JSON.stringify(plan.span).includes('c1'), true)
  check('近期段里没有被拆开的 toolResult', plan.retained.some((m) => (m as { role?: string }).role === 'toolResult'), false)
  check('单回合超预算 → 无更旧段可压，不压', planCanvasAgentCompaction(
    [{ role: 'user', content: 'x'.repeat(9_000) }],
    { budget: 6_000, keepRecentBudget: 1_000 },
  ).shouldCompact, false)
}

console.log('\n【11】摘要累积：第二次压缩把「旧摘要 + 中间那段」一起重压，不丢之前的结论')
{
  const oldSummary = buildCanvasAgentSummaryMessage('第一轮摘要：主角阿星、画幅 16:9')
  const messages = [
    oldSummary,
    { role: 'user', content: '第二轮：改用 9:16'.repeat(600), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
    { role: 'user', content: '第三轮：输出一张图', timestamp: 3 },
  ]

  const plan = planCanvasAgentCompaction(messages, { budget: 5_000, keepRecentBudget: 500 })
  check('要压', plan.shouldCompact, true)
  check('旧摘要落进待压段（累积的根据）', isCanvasAgentSummaryMessage(plan.span[0]), true)
  check('标记本轮是累积压缩', plan.carriesPreviousSummary, true)
  check('旧摘要不会被当成近期消息留下（否则会与新摘要重复）', plan.retained.some((m) => isCanvasAgentSummaryMessage(m)), false)

  let summaryInput = ''
  const result = await compactCanvasAgentTranscript({
    messages,
    budget: 5_000,
    keepRecentBudget: 500,
    summarize: async (span) => {
      summaryInput = buildCanvasAgentSummarySource(span)
      return '第二轮摘要：主角阿星、画幅 9:16、已出 1 张图'
    },
  })
  check('摘要调用看得到旧摘要（旧设定没丢）', summaryInput.includes('第一轮摘要'), true)
  check('压缩后首条是新摘要', isCanvasAgentSummaryMessage(result.messages[0]), true)
  check('近期消息跟在摘要之后', rolesOf(result.messages), ['user', 'user'])
  check('压缩后体积落回预算内', result.afterChars <= 5_000, true)
  check('压缩后消息数变少', result.afterMessageCount < result.beforeMessageCount, true)
}

console.log('\n【12】失败安全：摘要调用失败/返回空 → 不抛错，退回「丢最旧一段」裁剪')
{
  const messages = [
    buildCanvasAgentSummaryMessage('第一轮摘要：主角阿星'),
    { role: 'user', content: '第二轮：改用 9:16'.repeat(600), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
    { role: 'user', content: '第三轮：输出一张图', timestamp: 3 },
  ]

  const thrown = await compactCanvasAgentTranscript({
    messages,
    budget: 5_000,
    keepRecentBudget: 500,
    summarize: async () => {
      throw new Error('上游对话接口返回 HTTP 502')
    },
  })
  check('失败不抛错', thrown.compacted, false)
  check('标记走了回退', thrown.fellBack, true)
  check('回退结果非空', thrown.messages.length > 0, true)
  check('回退结果在总预算内', countTranscriptChars(thrown.messages) <= 5_000, true)
  check('失败原因带出来（供日志）', thrown.failureReason.includes('502'), true)

  const empty = await compactCanvasAgentTranscript({
    messages,
    budget: 5_000,
    keepRecentBudget: 500,
    summarize: async () => '   ',
  })
  check('空摘要也走回退', empty.fellBack, true)
  check('回退后仍是合法转录（首条是 user）', rolesOf(empty.messages)[0], 'user')
}

console.log('\n【13】transformContext 兜底：必须保留头部 system，否则工作手册与工具声明会被裁掉')
{
  const systemHead = {
    role: 'system',
    content: '你是制片 Agent（工作手册）',
    toolsAdded: [{ name: 'get_canvas_overview', description: '看画布', parameters: { type: 'object' } }],
    timestamp: 0,
  }
  const withSystem = [systemHead, ...buildOverBudgetTranscript()]

  const kept = trimTranscriptToBudgetPreservingSystem(withSystem, 6_000)
  check('system 头仍在最前', rolesOf(kept)[0], 'system')
  check('非 system 部分被裁到预算内', countTranscriptChars(kept.slice(1)) <= 6_000, true)
  check('近期对话仍在', JSON.stringify(kept).includes('第二回合'), true)

  // 反证：直接拿同一个函数用的裁剪器会导致 system 头被丢掉 —— 这正是要单独一个「保留 system」函数的原因
  const naive = trimTranscriptToBudget(withSystem, 6_000)
  check('反证：直接裁剪会丢掉 system 头', naive.some((m) => (m as { role?: string }).role === 'system'), false)
}

console.log('\n【14】反证：把「摘要累积」改成「用新摘要覆盖旧摘要」，本条必然失败')
{
  // 正确的实现：待压段必须从最旧的旧摘要开始（累积），旧摘要由新的摘要「继承」。
  // 若某次改动把待压段起点挪到旧摘要之后（覆盖式重压），旧摘要既不在 span、也不在 retained —— 直接丢失。
  const messages = [
    buildCanvasAgentSummaryMessage('第一轮摘要：主角阿星、画幅 16:9'),
    { role: 'user', content: '第二轮：改用 9:16'.repeat(600), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
    { role: 'user', content: '第三轮：输出一张图', timestamp: 3 },
  ]
  const plan = planCanvasAgentCompaction(messages, { budget: 5_000, keepRecentBudget: 500 })

  check('累积实现：待压段首条就是旧摘要', isCanvasAgentSummaryMessage(plan.span[0]), true)
  // 模拟「覆盖式」：把旧摘要从待压段里摘出去
  const overwriteStyleSpan = plan.span.slice(1)
  const overwriteKeepsOldSummary = overwriteStyleSpan.some((m) => isCanvasAgentSummaryMessage(m))
    || plan.retained.some((m) => isCanvasAgentSummaryMessage(m))
  check(
    '反证成立：覆盖式压缩会让旧摘要彻底消失（若实现退化成覆盖式，上面那条断言会失败）',
    overwriteKeepsOldSummary,
    false,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 【15】–【16】摘要的承载位置（2026-09-26）：从「转录里的 user 消息」挪进「每轮重建的 system 提示」
//
// 真机事故（记录 cmuhd62cn000q4k923m7vvhle）：库里存的摘要写着「统一 16:9 画幅、写实电影感」，
// 问「第 1 轮让你记住的两条设定」，模型却回「我看不到第 1 轮的对话记录，因此无法准确确认」。
// 根因是摘要当时是 role=user 的旧消息，被模型读成「用户以前说过的话」而不是「历史记录」。
// 修复：喂模型前把摘要摘出来、注入 system 提示（权威位）并点名唯一历史来源；库里仍按消息存（旧格式可读）。
// 最容易静默退化的三条：摘要没进 system、摘要从转录里丢了、承载位置改了却把累积弄丢 —— 下面钉死。
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n【15】摘要承载位置：从转录摘出 → 注入 system 段；库里仍按消息存（旧格式可读）')
{
  const restoredMessages = [
    buildCanvasAgentSummaryMessage('用户偏好 / 已确定的设定：统一 16:9 画幅、写实电影感'),
    { role: 'user', content: '继续做分镜', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
  ]

  check('取出摘要正文（去掉前缀）', extractCanvasAgentSummaryText(restoredMessages[0]), '用户偏好 / 已确定的设定：统一 16:9 画幅、写实电影感')
  check('普通 user 消息取不出摘要', extractCanvasAgentSummaryText({ role: 'user', content: '普通一句' }), '')
  check('助手消息取不出摘要', extractCanvasAgentSummaryText({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), '')

  const ctx = buildCanvasAgentRestoredContext(restoredMessages)
  check('摘要正文被摘出', ctx.summaryText.includes('16:9'), true)
  check('摘要把对话留全，自己不再进转录', rolesOf(ctx.messages), ['user', 'assistant'])
  check('摘要消息本体留着（落库压缩要拼回最前面）', isCanvasAgentSummaryMessage(ctx.summaryMessage), true)

  const section = buildCanvasAgentSummarySystemSection(ctx.summaryText)
  check('system 段里有摘要正文', section.includes('统一 16:9 画幅、写实电影感'), true)
  check('system 段点名「唯一的历史来源」', section.includes('唯一的历史来源'), true)
  check('system 段明令不许说看不到记录', section.includes('看不到记录'), true)
  check('空摘要不往 system 塞标题', buildCanvasAgentSummarySystemSection(''), '')
  check('空白摘要同样为空', buildCanvasAgentSummarySystemSection('   '), '')

  // 没有摘要的转录：原样留对话，不注入任何东西
  const noSummary = buildCanvasAgentRestoredContext([{ role: 'user', content: '你好', timestamp: 1 }])
  check('无摘要时 summaryText 为空', noSummary.summaryText, '')
  check('无摘要时 summaryMessage 为 null', noSummary.summaryMessage, null)
  check('无摘要时对话不变', rolesOf(noSummary.messages), ['user'])

  // 陈旧数据兜底：多条摘要取最后一条（最新的累积结果），更旧的丢弃
  const many = splitCanvasAgentSummary([
    buildCanvasAgentSummaryMessage('旧摘要 A'),
    buildCanvasAgentSummaryMessage('新摘要 B'),
    { role: 'user', content: '问', timestamp: 1 },
  ])
  check('多条摘要取最后一条', many.summaryText, '新摘要 B')
  check('多条摘要都不进转录', rolesOf(many.rest), ['user'])

  // 前缀必须出现在开头才算摘要：正文里提到「[会话摘要]」的普通消息不能被误判
  check('正文提到 [会话摘要] 的普通消息不算摘要', isCanvasAgentSummaryMessage({ role: 'user', content: '你说的 [会话摘要] 是什么' }), false)

  // 旧格式兼容：摘要作为 messages[0] 存在 metaJson 里，仍要读得回、还得能摘出来
  const legacyMeta = {
    [CANVAS_AGENT_SESSION_META_KEY]: {
      version: CANVAS_AGENT_SESSION_VERSION,
      canvasId: 'canvas-A',
      savedAt: '2026-09-26T00:00:00.000Z',
      messages: restoredMessages,
    },
  }
  const restored = readCanvasAgentSession(legacyMeta, 'canvas-A')
  check('旧格式读得回', restored?.messages.length, 3)
  check('metaJson.canvasAgentSession 里看得出这批消息里有摘要', isCanvasAgentSummaryMessage((restored?.messages || [])[0]), true)
  const legacyCtx = buildCanvasAgentRestoredContext(restored?.messages || [])
  check('旧格式的摘要也能摘进 system 段', buildCanvasAgentSummarySystemSection(legacyCtx.summaryText).includes('16:9'), true)
}

console.log('\n【16】承载位置改动不许破坏累积：落库压缩前把旧摘要拼回最前面，仍能「旧摘要 + 中间段 → 新摘要」')
{
  const huge = 'x'.repeat(8_000)
  const restoredMessages = [
    buildCanvasAgentSummaryMessage('用户偏好：统一 16:9 画幅、写实电影感'),
    { role: 'user', content: `第二轮${huge}`, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
    { role: 'user', content: '第三轮：输出一张图', timestamp: 3 },
  ]
  const ctx = buildCanvasAgentRestoredContext(restoredMessages)
  // 模拟执行器落库时的输入：摘要在喂模型前被摘走，压缩时必须把它拼回最前面
  const messagesForCompaction = [ctx.summaryMessage, ...ctx.messages]

  let summaryInput = ''
  const result = await compactCanvasAgentTranscript({
    messages: messagesForCompaction,
    budget: 6_000,
    keepRecentBudget: 500,
    summarize: async (span) => {
      summaryInput = buildCanvasAgentSummarySource(span)
      return '新摘要：主角阿星、统一 16:9、写实电影感、已出 1 张图'
    },
  })
  check('重挂后压缩输入看得到旧摘要（累积没被承载位置改动破坏）', summaryInput.includes('16:9'), true)
  check('标记本轮是累积压缩', result.carriesPreviousSummary, true)
  check('压缩后首条是新摘要', isCanvasAgentSummaryMessage(result.messages[0]), true)
  check('压缩后体积落回预算内', result.afterChars <= 6_000, true)

  const session = buildCanvasAgentSessionMeta({ canvasId: 'canvas-A', messages: result.messages })
  check('落库后 messages 首条仍是摘要（metaJson 里看得出有摘要）', isCanvasAgentSummaryMessage((session?.messages || [])[0]), true)
  check('下一轮恢复后摘要仍能进 system 段', buildCanvasAgentSummarySystemSection(
    buildCanvasAgentRestoredContext(session?.messages || []).summaryText,
  ).includes('16:9'), true)

  // 失败安全在新承载下同样成立：摘要调用抛错 → 不抛，退回裁剪
  const failed = await compactCanvasAgentTranscript({
    messages: messagesForCompaction,
    budget: 6_000,
    keepRecentBudget: 500,
    summarize: async () => { throw new Error('上游对话接口返回 HTTP 502') },
  })
  check('摘要调用失败不抛错', failed.fellBack, true)
  check('失败回退结果非空且在预算内', failed.messages.length > 0 && countTranscriptChars(failed.messages) <= 6_000, true)
}

console.log('\n【17】反证：若退回「摘要只留在转录中」（不摘出、不注入 system），采用断言必然失败')
{
  const restoredMessages = [
    buildCanvasAgentSummaryMessage('用户偏好 / 已确定的设定：统一 16:9 画幅、写实电影感'),
    { role: 'user', content: '继续做分镜', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 },
  ]

  // 新实现（当前）：摘要摘出来灌进 system 段 → 模型在权威位读到它
  const fixedSection = buildCanvasAgentSummarySystemSection(
    buildCanvasAgentRestoredContext(restoredMessages).summaryText,
  )
  check('新实现：摘要进了 system 段', fixedSection.includes('16:9'), true)

  // 旧实现（真机事故形态）：摘要只作为一条 user 消息留在转录里，system 段里根本没有它。
  // 模拟「不调用 buildCanvasAgentRestoredContext、直接原样喂转录」——system 段是空的。
  const legacySection = buildCanvasAgentSummarySystemSection('')
  check('旧实现：system 段里没有摘要（模型只能把它当陈旧 user 消息读）', legacySection.includes('16:9'), false)
  check(
    '反证成立：若实现退回「摘要只留在转录中」，第一条断言（摘要进 system 段）会失败',
    legacySection.includes('16:9') === fixedSection.includes('16:9'),
    false,
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
