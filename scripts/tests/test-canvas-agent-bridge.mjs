#!/usr/bin/env node
/**
 * 画布 Agent 的「服务端 → 浏览器」桥 + 服务端消息映射的单测（2026-09-23，M2）
 *
 * 为什么这批要单独测：M2 把 Agent 从浏览器搬到了服务端，于是这条链路上**最容易静默出错**
 * 的两段都跑在服务端、浏览器里看不见：
 *
 *   1. **消息映射**（`toOpenAiMessages`）：Pi 的内部工具结果叫 `role: toolResult`，
 *      上游只认 `role: tool` + `tool_call_id`。映射错了不报错——模型只是「看不见工具结果」，
 *      然后把同一个工具一遍遍重调。M1 里就是这么卡住的。
 *   2. **桥**：服务端挂起等浏览器回执。超时不清理 → Promise 永久泄漏；callId 配对错了 →
 *      Agent 拿到别人的结果；取消不生效 → 任务停不下来。这些都是「偶发、难复现」的类型。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-agent-bridge.mjs
 */
import {
  waitForClientToolResult,
  resolveClientToolResult,
  cancelPendingClientToolCalls,
  getPendingClientToolCallCount,
} from '../../server/generation-tasks/canvas-agent-bridge.ts'
import {
  toOpenAiMessages,
} from '../../server/generation-tasks/pi-gateway-stream.ts'
import {
  buildPromptWithHistory,
} from '../../server/generation-tasks/canvas-agent-executor.ts'
import {
  PAID_CANVAS_AGENT_TOOLS,
  createSpendGuard,
} from '../../server/generation-tasks/canvas-agent-guard.ts'
import {
  CANVAS_AGENT_SKILL_KEY,
  CANVAS_AGENT_TOOL_DEFINITIONS,
  describeConfirmationDecision,
  getModelVisibleCanvasAgentTools,
} from '../../src/shared/canvas-agent-tools.ts'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
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

console.log('== 桥：服务端挂起等浏览器回执 ==')

await check('回执能兑现挂起的调用，并原样带回结果', async () => {
  const promise = waitForClientToolResult({
    recordId: 'rec-1',
    callId: 'call-a',
    toolName: 'add_node',
    timeoutMs: 5000,
  })
  const accepted = resolveClientToolResult('rec-1', {
    callId: 'call-a',
    ok: true,
    result: '{"id":"n1"}',
  })
  assert(accepted === true, '有等待者时应返回 true')
  const payload = await promise
  assert(payload.ok === true && payload.result === '{"id":"n1"}', '回执内容应原样传回')
  assert(getPendingClientToolCallCount('rec-1') === 0, '兑现后不该还挂着')
})

await check('不同任务的同名 callId 不会串台', async () => {
  const first = waitForClientToolResult({ recordId: 'rec-A', callId: 'same', toolName: 'x', timeoutMs: 5000 })
  const second = waitForClientToolResult({ recordId: 'rec-B', callId: 'same', toolName: 'x', timeoutMs: 5000 })
  assert(resolveClientToolResult('rec-A', { callId: 'same', ok: true, result: 'A' }) === true)
  assert(resolveClientToolResult('rec-B', { callId: 'same', ok: true, result: 'B' }) === true)
  assert((await first).result === 'A', 'A 任务应拿到 A 的结果')
  assert((await second).result === 'B', 'B 任务应拿到 B 的结果')
})

await check('没有等待者时回执返回 false（服务端已超时收口，不是错误）', async () => {
  assert(resolveClientToolResult('rec-none', { callId: 'ghost', ok: true, result: '' }) === false)
})

await check('超时会以可读原因失败，而不是永久挂着', async () => {
  const startedAt = Date.now()
  let message = ''
  try {
    await waitForClientToolResult({ recordId: 'rec-2', callId: 'call-slow', toolName: 'run_node', timeoutMs: 60 })
  } catch (error) {
    message = error.message
  }
  assert(Date.now() - startedAt < 2000, '应很快失败')
  assert(/run_node/.test(message) && /超/.test(message), `失败原因要说清是哪个工具、为什么：${message}`)
  assert(getPendingClientToolCallCount('rec-2') === 0, '超时后要清理挂起项')
})

await check('任务结束时统一取消该任务剩下的等待者', async () => {
  const pending = waitForClientToolResult({ recordId: 'rec-3', callId: 'c1', toolName: 'x', timeoutMs: 60_000 })
  assert(getPendingClientToolCallCount('rec-3') === 1, '应有一个挂起项')
  cancelPendingClientToolCalls('rec-3', '任务已结束')
  let failedWith = ''
  try {
    await pending
  } catch (error) {
    failedWith = error.message
  }
  assert(failedWith === '任务已结束', `取消原因应传下去：${failedWith}`)
  assert(getPendingClientToolCallCount('rec-3') === 0, '取消后不该还挂着')
})

await check('abort 信号能取消等待（用户点停止后不该再等浏览器）', async () => {
  const controller = new AbortController()
  const pending = waitForClientToolResult({
    recordId: 'rec-4',
    callId: 'c2',
    toolName: 'x',
    timeoutMs: 60_000,
    signal: controller.signal,
  })
  controller.abort()
  let cancelled = false
  try {
    await pending
  } catch {
    cancelled = true
  }
  assert(cancelled, 'abort 后应当抛错结束等待')
  assert(getPendingClientToolCallCount('rec-4') === 0, 'abort 后要清理挂起项')
})

console.log('\n== Pi 转录 → 上游消息形状 ==')

await check('toolResult 映射成 role:tool + tool_call_id（不映射模型就看不到结果）', () => {
  const mapped = toOpenAiMessages([
    { role: 'user', content: [{ type: 'text', text: '加个节点' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'toolCall', id: 'call_1', name: 'add_node', arguments: { type: 'image' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'add_node',
      content: [{ type: 'text', text: '{"id":"n1"}' }],
    },
  ])

  assert(mapped.length === 3, `应产出 3 条消息，实际 ${mapped.length}`)
  assert(mapped[0].role === 'user' && mapped[0].content === '加个节点', 'user 正文应抽成纯文本')
  assert(mapped[1].role === 'assistant', 'assistant 角色要保留')
  assert(mapped[1].content === '好的', 'assistant 的正文要保留')
  assert(
    mapped[1].tool_calls?.[0]?.id === 'call_1'
      && mapped[1].tool_calls?.[0]?.function.name === 'add_node'
      && mapped[1].tool_calls?.[0]?.function.arguments === '{"type":"image"}',
    `tool_calls 形状不对：${JSON.stringify(mapped[1].tool_calls)}`,
  )
  assert(mapped[2].role === 'tool', '工具结果必须是 role: tool（上游只认这个）')
  assert(mapped[2].tool_call_id === 'call_1', 'tool_call_id 必须与 assistant 的调用配对')
  assert(mapped[2].content === '{"id":"n1"}', '工具结果正文要原样带过去')
})

await check('assistant 只有工具调用、没有正文时不编造空字符串', () => {
  const mapped = toOpenAiMessages([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'x', arguments: {} }],
    },
  ])
  assert(mapped[0].content === null, '纯工具调用时 content 应为 null，而不是空串')
})

await check('思考内容不会混进正文（否则模型把自己的思考当成答案）', () => {
  const mapped = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'thinking', thinking: '让我想想' }, { type: 'text', text: '结论' }] },
  ])
  assert(mapped[0].content === '结论', `正文应只含 text 块：${mapped[0].content}`)
})

await check('工具结果为空时给占位，避免上游因空 content 报错', () => {
  const mapped = toOpenAiMessages([{ role: 'toolResult', toolCallId: 'c9', content: [] }])
  assert(mapped[0].content === '(空结果)', `应给占位：${mapped[0].content}`)
})

console.log('\n== 对话历史并进本轮用户消息 ==')

await check('没有历史时也把「本轮执行要求」附上（实测缺了它模型会在中途收尾汇报）', () => {
  const result = buildPromptWithHistory('干个活', null)
  assert(result.startsWith('干个活'), `用户的要求要原样在最前面，实际：${result.slice(0, 40)}`)
  assert(result.includes('【本轮执行要求】'), '要贴上执行要求')
  assert(result.includes('不要中途停下来汇报'), '执行要求要说清「别中途收尾」')
  assert(result.includes('ask_user'), '执行要求要写清「猜不出来的信息用 ask_user 问」')
  assert(result.includes('提交即回执'), '执行要求要说清生成工具是「提交即回执」（这是去轮询的关键一条）')
  assert(/不要用读取工具反复轮询/.test(result), '执行要求要明确禁止用读取工具反复轮询等结果')
})

await check('有历史时贴成背景，并标明「用户现在的要求」', () => {
  const prompt = buildPromptWithHistory('继续', {
    history: [
      { role: 'user', content: '帮我把剧本拆成分镜' },
      { role: 'assistant', content: '已拆成 6 个分镜' },
    ],
  })
  assert(prompt.includes('用户：帮我把剧本拆成分镜'), '应带上用户历史')
  assert(prompt.includes('你：已拆成 6 个分镜'), '应带上助手历史')
  assert(prompt.includes('【用户现在的要求】\n继续'), '当前要求要有明确分隔')
})

console.log('\n== 半自动闸门的两块拼图 ==')

await check('技能键与工具定义是唯一真源，且确认工具在清单里', () => {
  assert(CANVAS_AGENT_SKILL_KEY === 'canvas-agent', '技能键被改动了，前后端会因此错位')
  const confirmation = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'request_confirmation')
  assert(confirmation, '确认工具必须存在于共享定义里')
  assert(confirmation.requiresClient, '确认要走前端——由浏览器弹卡片给用户')
  /**
   * 第一步收敛：服务端声明给模型的工具不再是「定义数组全集」，而是**可见子集**。
   * generate 必须在可见子集里（否则模型根本没有生成入口），图操作类工具必须不在（逐个断言）。
   */
  const visibleNames = getModelVisibleCanvasAgentTools().map((tool) => tool.name)
  assert(visibleNames.includes('generate'), 'generate 必须在模型可见工具清单里')
  for (const name of [
    'add_node', 'add_nodes', 'update_node', 'remove_node', 'select_nodes', 'connect_nodes',
    'attach_reference_images', 'run_node', 'run_nodes', 'get_canvas_state',
    'list_workflow_templates', 'apply_workflow_template',
  ]) {
    assert(!visibleNames.includes(name), `已停用的 ${name} 不该出现在模型可见清单里`)
  }
})

await check('工具描述不再教模型轮询整画布，且默认读取路径指向概览/单节点', () => {
  /**
   * 病灶原文：「run_node 的描述写着『等待请用 get_canvas_state 看状态』」——
   * 我们自己把模型教会了「用整画布读轮询」，配合 MAX_TOOL_CALLS 就把每一轮预算烧在等待上。
   * 这条用例把「教轮询」的措辞钉死为不允许复现。
   */
  for (const name of ['run_node', 'run_nodes']) {
    const def = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)
    assert(def, `${name} 必须存在`)
    assert(!/等待请用\s*get_canvas_state/.test(def.description), `${name} 不得再教「等待用 get_canvas_state」`)
    assert(/不等出图|提交即回执|不要用读取工具反复轮询/.test(def.description), `${name} 要说清「提交即回执、不要轮询」`)
  }
  const state = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'get_canvas_state')
  assert(state, 'get_canvas_state 必须保留（旧提示词与测试仍在引用）')
  assert(/get_canvas_overview/.test(state.description) && /get_canvas_node/.test(state.description), 'get_canvas_state 描述要把默认路径指向 overview/单节点')
  const overview = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'get_canvas_overview')
  const node = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'get_canvas_node')
  assert(overview && node, '新增的概览/单节点读必须在共享定义里（前后端唯一真源）')
  assert(/不含提示词/.test(overview.description), '概览描述要说清它不含提示词等细节')
  assert(node.parameters?.required?.includes('id'), 'get_canvas_node 必须要求 id 参数')
})

await check('确认回执的措辞：同意与拒绝都要让模型知道下一步怎么做', () => {
  const request = { title: '生成 6 张分镜图', summary: '将执行 6 个图片节点' }
  const approved = describeConfirmationDecision(request, { approved: true, note: '第 3 张换角度' })
  assert(approved.includes('同意') && approved.includes('第 3 张换角度'), `同意文案不对：${approved}`)

  const rejected = describeConfirmationDecision(request, { approved: false })
  assert(rejected.includes('拒绝'), '拒绝要写明')
  assert(rejected.includes('不要执行该动作'), '拒绝时必须明确告诉模型不要执行——否则它会当默认同意')
})

console.log('\n== 花钱闸门（半自动的核心约束：Agent 不能自己刷卡）==')

await check('没有确认之前，付费动作一律被拦下，且说明里点名要去调 request_confirmation', () => {
  const guard = createSpendGuard()
  const decision = guard.check('run_node')
  assert(decision.blocked === true, 'run_node 在未确认时必须被拦')
  assert(/request_confirmation/.test(decision.reason || ''), '被拦原因要告诉模型正确做法是什么')
  assert(/积分/.test(decision.reason || ''), '要说清为什么被拦（会花钱）')
})

await check('批量生成（run_nodes）与单个一样被拦 —— 这是 2026-09-26 补的钱洞', () => {
  /**
   * 提示词一直让模型「批量出分镜图用 run_nodes」，而拦阻清单里曾经只有 run_node ——
   * 于是批量出图整条路绕过了服务端硬拦（一次确认都不用就能刷掉一整套分镜的钱）。
   * 这条用例专盯这个洞：它必须和 run_node 同生共死。
   */
  assert(PAID_CANVAS_AGENT_TOOLS.has('run_nodes'), 'run_nodes 必须在花钱清单里（否则批量生成绕过硬拦）')
  const guard = createSpendGuard()
  const decision = guard.check('run_nodes')
  assert(decision.blocked === true, 'run_nodes 在未确认时必须被拦')
  assert(/request_confirmation/.test(decision.reason || ''), 'run_nodes 被拦也要指向 request_confirmation')
  assert(/积分/.test(decision.reason || ''), 'run_nodes 被拦也要说清会花钱')
})

await check('generate 是第一步收敛后的唯一生成入口，未确认同样被硬拦', () => {
  /**
   * 第一步把 add_node(s)/run_node(s)/connect_nodes… 收进 generate —— 而 generate 一次调用会
   * **建节点 + 连线 + 挂参考 + 提交生成**，会真的花钱。它必须在付费清单里，否则收敛反而
   * 造出一个新的绕行洞（模型不用确认就能刷一整套分镜的钱）。
   */
  assert(PAID_CANVAS_AGENT_TOOLS.has('generate'), 'generate 必须在花钱清单里（否则收敛后生成绕过硬拦）')
  const guard = createSpendGuard()
  const decision = guard.check('generate')
  assert(decision.blocked === true, 'generate 在未确认时必须被拦')
  assert(/request_confirmation/.test(decision.reason || ''), 'generate 被拦要指向 request_confirmation')
  assert(/积分/.test(decision.reason || ''), 'generate 被拦要说清会花钱')
  guard.markApproved('call_confirm_generate')
  assert(guard.check('generate').blocked === false, '同意后 generate 应放行（与 run_node(s) 同一道确认）')
})

await check('反证：把 generate 从付费清单里去掉，闸门就不再拦它（正是要防的洞）', () => {
  // 用可注入清单的 guard 复刻「漏配 generate」的旧形态：证明这条断言是灵敏的，不是空转
  const withoutGenerate = new Set([...PAID_CANVAS_AGENT_TOOLS].filter((name) => name !== 'generate'))
  const leaked = createSpendGuard(withoutGenerate)
  assert(leaked.check('generate').blocked === false, '旧形态：漏配 generate 时它不被拦（洞）')
  assert(createSpendGuard().check('generate').blocked === true, '新形态：generate 被拦')
  assert(
    leaked.check('generate').blocked !== createSpendGuard().check('generate').blocked,
    '反证成立：两种清单下结论不同，付费闸门覆盖 generate 的断言是灵敏的',
  )
})

await check('一次确认同时解锁单节点与批量（批量不必再确认一次，也不能绕过）', () => {
  const guard = createSpendGuard()
  assert(guard.check('run_node').blocked === true && guard.check('run_nodes').blocked === true, '确认前两个都该被拦')
  guard.markApproved('call_confirm_batch')
  assert(guard.check('run_node').blocked === false, '同意后单节点应放行')
  assert(guard.check('run_nodes').blocked === false, '同意后批量也应放行（同一道确认）')
})

await check('不花钱的工具不会被误拦（拦过头会让 Agent 完全干不了活）', () => {
  const guard = createSpendGuard()
  for (const tool of ['get_canvas_state', 'get_canvas_overview', 'get_canvas_node', 'add_node', 'update_node', 'connect_nodes', 'select_nodes']) {
    assert(guard.check(tool).blocked === false, `${tool} 不该被拦`)
  }
})

await check('用户同意之后闸门打开', () => {
  const guard = createSpendGuard()
  assert(guard.check('run_node').blocked === true, '先确认还未开启')
  guard.markApproved('call_confirm_1')
  assert(guard.approvedCallId === 'call_confirm_1', '要记住是哪一次确认开的闸')
  assert(guard.check('run_node').blocked === false, '同意后应放行')
})

await check('闸门是「任务内」状态：新任务从零开始（不会跨任务继承授权）', () => {
  const first = createSpendGuard()
  first.markApproved('call_a')
  const second = createSpendGuard()
  assert(second.check('run_node').blocked === true, '新任务必须重新取得确认')
})

await check('付费工具清单非空，且与工具定义里的名字对得上（拼错就是静默放行）', () => {
  assert(PAID_CANVAS_AGENT_TOOLS.size > 0, '清单不能为空')
  const known = new Set(CANVAS_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name))
  for (const name of PAID_CANVAS_AGENT_TOOLS) {
    assert(known.has(name), `花钱清单里的「${name}」在工具定义里不存在（多半是拼错了）`)
  }
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
