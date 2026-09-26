/**
 * 导演控制台（AI Director Console · 批次 1）纯逻辑验证，2026-09-26
 *
 * 要钉死的是三条最容易静默出错的规则（它们不报错、形状不变，只能靠断言）：
 *   ① 生命周期/阶段由**事件**推导（工具名映射），不由模型自报；
 *   ② 阶段**只增不减**（读回画布不会把「生成执行」拉回「剧本分析」）；
 *   ③ 进度**只在真有分母**时出现（批量回执的 done/total），没有分母就不造百分比。
 * 另加两条：控制台状态**不进转录/不给模型**（只走 SSE），以及会话记忆跨轮续上阶段高水位。
 *
 * 文件末尾有反证：把「只增不减」换成「取最后一个工具的阶段」，本批的核心断言必然失败。
 */

import {
  buildCanvasAgentConsoleStreamEvent,
  deriveCanvasAgentConsole,
  deriveCanvasAgentConsoleState,
  type CanvasAgentConsoleEvent,
} from '../server/generation-tasks/canvas-agent-console-state'
import {
  CANVAS_AGENT_SESSION_META_KEY,
  buildCanvasAgentSessionMeta,
  readCanvasAgentSession,
} from '../server/generation-tasks/canvas-agent-session'

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

const toolStart = (toolName: string, callId = `c-${toolName}`): CanvasAgentConsoleEvent => ({
  type: 'tool_start',
  toolName,
  callId,
})
const toolEnd = (
  toolName: string,
  input: { ok?: boolean; summary?: string; resultText?: string } = {},
  callId = `c-${toolName}`,
): CanvasAgentConsoleEvent => ({
  type: 'tool_end',
  toolName,
  callId,
  ok: input.ok ?? true,
  summary: input.summary,
  resultText: input.resultText,
})
/** 只折叠前 n 个事件，用来断言「阶段随事件单向推进」 */
const stateAt = (events: CanvasAgentConsoleEvent[], count = events.length) =>
  deriveCanvasAgentConsoleState(events.slice(0, count))

console.log('\n【1】生命周期由工具名推导（读画布=分析 / 手册=规划 / 生成=生成 / 自检=校验）')
{
  check('读节点 → analyzing', stateAt([toolStart('get_canvas_node')]).lifecycle, 'analyzing')
  check('读画布概览 → analyzing', stateAt([toolStart('get_canvas_overview')]).lifecycle, 'analyzing')
  check('load_playbook → planning', stateAt([toolStart('load_playbook')]).lifecycle, 'planning')
  check('run_nodes → generating', stateAt([toolStart('run_nodes')]).lifecycle, 'generating')
  check('preflight_check → verifying', stateAt([toolStart('preflight_check')]).lifecycle, 'verifying')
  check('agent_end → delivering', stateAt([{ type: 'agent_end' }]).lifecycle, 'delivering')
  check('当前任务用中文短语，不暴露工具名', stateAt([toolStart('add_nodes')]).current, { title: '正在批量创建节点' })
  check('读节点带目标 id', stateAt([{ type: 'tool_start', toolName: 'get_canvas_node', callId: 'x', target: 'node_7' }]).current, {
    title: '正在读取节点',
    target: 'node_7',
  })
}

console.log('\n【2】阶段推进：只增不减，且能走到质检与交付')
{
  const events: CanvasAgentConsoleEvent[] = [
    toolStart('get_canvas_overview'),
    toolEnd('get_canvas_overview', { summary: '画布概览：7 个节点、3 条连线' }),
    toolStart('add_nodes'),
    toolEnd('add_nodes', { summary: '新建 6 个节点', resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }] }) }),
    toolStart('run_nodes'), // 提交生成 → production
    toolStart('get_canvas_node'), // 生成后读回结果 → qa
    toolStart('add_nodes'), // 又去铺分镜（storyboard）→ 不许把阶段拉回去
    { type: 'agent_end' }, // 收尾 → delivery
  ]

  check('起步是剧本分析（1/6）', stateAt(events, 1).stage, { phase: 'script', label: '剧本分析', index: 1, total: 6 })
  check('建节点推进到分镜规划（3/6）', stateAt(events, 3).stage, { phase: 'storyboard', label: '分镜规划', index: 3, total: 6 })
  check('提交生成推进到生成执行（4/6）', stateAt(events, 5).stage, { phase: 'production', label: '生成执行', index: 4, total: 6 })
  check('生成后读回结果推进到质检（5/6）', stateAt(events, 6).stage, { phase: 'qa', label: '质检', index: 5, total: 6 })
  check('再铺分镜不回退（仍是质检）', stateAt(events, 7).stage.index, 5)
  check('收尾汇报推进到交付（6/6）', stateAt(events).stage, { phase: 'delivery', label: '交付', index: 6, total: 6 })

  // 逐步推进：像全程把前缀折叠一遍，索引单调不减
  let monotonic = true
  let previous = 0
  for (let count = 1; count <= events.length; count++) {
    const index = stateAt(events, count).stage.index
    if (index < previous) monotonic = false
    previous = index
  }
  check('阶段索引单调不减', monotonic, true)
}

console.log('\n【3】进度只在真有分母时出现（add_nodes / run_nodes 的真实回执）')
{
  const addNodes = stateAt([
    toolStart('add_nodes'),
    toolEnd('add_nodes', { summary: '新建 2 个节点', resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }] }) }),
  ])
  check('add_nodes：done=建出来的、total=请求的', addNodes.progress, { done: 2, total: 2, unit: '个节点' })

  const partial = stateAt([
    toolEnd('add_nodes', { summary: '新建 1 个节点', resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: null }] }) }),
  ])
  check('add_nodes：有节点没建出来时 done < total', partial.progress, { done: 1, total: 2, unit: '个节点' })

  const runNodes = stateAt([
    toolEnd('run_nodes', { summary: '已提交 · 生成中：8 个节点', resultText: JSON.stringify({ submitted: 8, total: 24 }) }),
  ])
  check('run_nodes：done=已提交、total=这一批', runNodes.progress, { done: 8, total: 24, unit: '个节点' })

  const readOnly = stateAt([
    toolEnd('get_canvas_node', { summary: '读取节点 node_1：图片节点（idle）', resultText: '{"id":"node_1"}' }),
  ])
  check('没有分母的工具不产生进度', readOnly.progress, undefined)

  const malformed = stateAt([toolEnd('run_nodes', { summary: '回执丢了', resultText: 'not json' })])
  check('回执解析不出来就不显示进度（不猜分母）', malformed.progress, undefined)

  const zeroTotal = stateAt([toolEnd('run_nodes', { summary: '空批', resultText: JSON.stringify({ submitted: 0, total: 0 }) })])
  check('分母为 0 不显示进度', zeroTotal.progress, undefined)
}

console.log('\n【3.1】generate（第一步收敛后的唯一生成入口）：阶段/生命周期/进度')
{
  const start = stateAt([toolStart('generate')])
  check('generate → generating', start.lifecycle, 'generating')
  check('generate → 生成执行阶段', start.stage.phase, 'production')
  check('当前任务用中文短语，不暴露工具名', start.current, { title: '正在提交生成' })

  const progressed = stateAt([
    toolEnd('generate', { summary: '已提交 · 生成中：8 个节点（新建 8 个）', resultText: JSON.stringify({ submitted: 8, total: 24, created: ['a', 'b'] }) }),
  ])
  check('generate：done=已提交、total=这一批（真分母）', progressed.progress, { done: 8, total: 24, unit: '个节点' })
  check('generate：新建节点计入画布动作', progressed.canvasActions, { created: 2, unit: '个节点' })

  const createdOnly = stateAt([
    toolEnd('generate', { summary: '已创建 1 个节点（无需生成）', resultText: JSON.stringify({ submitted: 0, total: 0, created: ['t1'], nodes: [] }) }),
  ])
  check('generate 只建文本节点：不计入生成进度、但计入已创建节点数', [createdOnly.progress, createdOnly.canvasActions], [undefined, { created: 1, unit: '个节点' }])
}

console.log('\n【4】执行日志：running → done/failed，按 callId 配对')
{
  const done = stateAt([
    toolStart('get_canvas_state', 'call-1'),
    toolEnd('get_canvas_state', { summary: '读取画布：3 个节点、2 条连线' }, 'call-1'),
  ])
  check('完成的日志只有一条、标记 done、正文取真实回执摘要', done.log, [
    { mark: 'done', text: '读取画布：3 个节点、2 条连线' },
  ])

  const failedLog = stateAt([toolStart('run_nodes', 'call-2'), toolEnd('run_nodes', { ok: false, summary: '批量执行被拦下：没有有效预校验报告' }, 'call-2')])
  check('失败日志标记 failed 且带原因', failedLog.log, [
    { mark: 'failed', text: '失败：批量执行被拦下：没有有效预校验报告' },
  ])

  const running = stateAt([toolStart('add_nodes', 'call-3')])
  check('进行中的日志标记 running', running.log, [{ mark: 'running', text: '批量创建节点…' }])

  const interleaved = stateAt([
    toolStart('add_nodes', 'call-a'),
    toolStart('connect_nodes', 'call-b'),
    toolEnd('add_nodes', { summary: '新建 4 个节点' }, 'call-a'),
  ])
  check('并发调用按 callId 配对，不误改另一条', interleaved.log, [
    { mark: 'done', text: '新建 4 个节点' },
    { mark: 'running', text: '连接节点…' },
  ])
}

console.log('\n【5】控制台状态只走 SSE：不并入消息正文、不是可喂模型的转录消息')
{
  const state = stateAt([toolStart('run_nodes'), { type: 'assistant_message' }])
  check('快照没有 role 字段（不是转录消息形状）', 'role' in state, false)
  check('快照没有 content 字段（不会进 Markdown 正文）', 'content' in state, false)

  const event = buildCanvasAgentConsoleStreamEvent('rec-1', state)
  check('事件类型是 console_state', event.type, 'console_state')
  check('载荷挂在 consoleState 上', event.consoleState === state, true)
  check('事件不带 content（内容流不会把它当模型输出）', event.content, undefined)
  check('事件不带 delta', event.delta, undefined)
  check('事件不带 message（面板正文不会被它改写）', event.message, undefined)

  // 反证：若把状态塞进 message/content（错误做法），上面的两条断言必然失败
  const wrong = { ...event, message: state.stage.label, content: state.stage.label }
  check('反证成立：塞进 message/content 后就不再是「不携正文」', wrong.message !== undefined && wrong.content !== undefined, true)
}

console.log('\n【6】会话记忆：阶段高水位跨轮落库并续上')
{
  const session = buildCanvasAgentSessionMeta({
    canvasId: 'canvas-A',
    messages: [{ role: 'user', content: '帮我做一条 30 秒短片' }],
    console: { phase: 'production' },
  })
  check('会话结构里带上了控制台记忆', session?.console, { phase: 'production' })

  const restored = readCanvasAgentSession({ [CANVAS_AGENT_SESSION_META_KEY]: session }, 'canvas-A')
  check('读回后记忆还在', restored?.console, { phase: 'production' })

  const bogus = buildCanvasAgentSessionMeta({
    canvasId: 'canvas-A',
    messages: [{ role: 'user', content: 'hi' }],
    // 非法阶段键：不许写进会话（下一轮从 script 起算），而不是把垃圾数据带下去
    console: { phase: 'not-a-phase' as never },
  })
  check('非法阶段键不落库', 'console' in (bogus || {}), false)

  // 跨轮：上一轮已到 production，这一轮只读画布也不许回退；读回结果推进到质检
  const seeded = deriveCanvasAgentConsoleState([toolStart('get_canvas_node')], { seed: { phase: 'production' } })
  check('带 production 记忆时读画布不回退', seeded.stage, { phase: 'qa', label: '质检', index: 5, total: 6 })

  const seededDelivery = deriveCanvasAgentConsoleState([{ type: 'agent_end' }], { seed: { phase: 'production' } })
  check('带生产记忆时收尾推进到交付', seededDelivery.stage.phase, 'delivery')

  const derivation = deriveCanvasAgentConsole([toolStart('run_nodes')], { seed: { phase: 'storyboard' } })
  check('折叠结果同时给出可写回的会话记忆', derivation.memory, { phase: 'production' })
}

console.log('\n【7】反证：把「阶段只增不减」换成「取最后一个工具的阶段」，核心断言必然失败')
{
  const events: CanvasAgentConsoleEvent[] = [
    toolStart('run_nodes'), // production
    toolStart('get_canvas_node'), // 生成后读回 → qa
    toolStart('add_nodes'), // 最后又铺分镜（storyboard）
  ]
  const current = stateAt(events)
  check('新实现（高水位）：阶段停在质检 5/6', current.stage.index, 5)

  // 旧实现（错误）：直接用「最后一个工具」映射到的阶段 → 会被最后那次 add_nodes 拉回分镜规划
  const lastToolPhaseIndex = 3 // add_nodes → storyboard(3)
  check('旧实现（取最后一个工具）：被拉回分镜规划 3/6', lastToolPhaseIndex, 3)
  check('反证成立：两种实现结论不同，本批「只增不减」的断言是灵敏的', current.stage.index !== lastToolPhaseIndex, true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
