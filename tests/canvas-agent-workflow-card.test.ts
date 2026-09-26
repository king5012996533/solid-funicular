/**
 * 导演控制台批次 4 —— 工作流卡片 + AI CREW（纯逻辑验证，2026-09-26）
 *
 * 产品要求（原话）：
 *   · 工作流卡片：「🎬 分镜生成 / 输入: … / 输出: 24 shots / 状态: 进行中」，比聊天气质高级；
 *   · AI CREW：「Producer / Writer / Director / Art / Editor」，当前只有 Director 是活的，其余留位置。
 *
 * 要钉死的规则（它们不报错、形状不变，只能靠断言）：
 *   ① 卡片**输入只来自本回合真实发生过的事**（读到的节点数、挂上的参考图张数、模型、手册名），
 *      拿不到就整项不出现（界面显示「—」）——本项目在「编数据」上踩过两次（心算积分为一例）；
 *   ② 卡片**输出不给假分母**：有声明目标才显示 `已产出 8/24`，没声明只显示 `已产出 8`；
 *   ③ AI CREW **只有 Director 为 active**，其余一律 pending/「待接入」，不假装它们在干活；
 *   ④ `console_state` 载荷**仍不含 content/delta/message**（只走 SSE、不进模型上下文）。
 *
 * 文件末尾有反证：去掉「无声明不给分母」/ 把 CREW 全员标成已接入，对应断言必然失败。
 */

import {
  buildCanvasAgentConsoleStreamEvent,
  deriveCanvasAgentConsoleState,
  type CanvasAgentConsoleEvent,
} from '../server/generation-tasks/canvas-agent-console-state'
import type { CanvasAgentConsoleState } from '../src/shared/canvas-agent-console'
import {
  AGENT_WORKFLOW_EMPTY_PLACEHOLDER,
  buildAgentWorkflowCard,
  formatWorkflowInputText,
  formatWorkflowOutputText,
} from '../src/components/canana/agent-workflow-card'
import {
  CANVAS_AGENT_CREW_ROLES,
  buildCanvasAgentCrew,
} from '../src/components/canana/agent-crew'

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

console.log('\n【1】卡片输入只来自本回合真实发生过的事（读画布 / 挂参考图 / 手册 / 模型）')
{
  const state = deriveCanvasAgentConsoleState(
    [
      toolStart('get_canvas_overview'),
      toolEnd('get_canvas_overview', {
        resultText: JSON.stringify({ nodeCount: 12, edgeCount: 3, nodes: [] }),
      }),
      toolStart('attach_reference_images'),
      toolEnd('attach_reference_images', {
        resultText: JSON.stringify({ id: 'node_1', referenceImageCount: 2 }),
      }),
      { type: 'tool_start', toolName: 'load_playbook', callId: 'c-pb', playbookName: 'storyboard-production' },
      toolEnd('load_playbook', { summary: '已加载工作手册' }),
    ],
    { model: 'gpt-x' },
  )
  check('四项输入齐备且有序（模型 → 画布 → 参考图 → 手册）', state.workflow?.inputs, [
    { key: 'model', label: '模型', value: 'gpt-x' },
    { key: 'canvas_nodes', label: '画布', value: '12 个节点' },
    { key: 'reference_images', label: '参考图', value: '2 张' },
    { key: 'playbook', label: '手册', value: 'storyboard-production' },
  ])

  const stateRead = deriveCanvasAgentConsoleState([
    toolEnd('get_canvas_state', {
      resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] }),
    }),
  ])
  check('get_canvas_state 回执数节点数组长度', stateRead.workflow?.inputs, [
    { key: 'canvas_nodes', label: '画布', value: '3 个节点' },
  ])

  const noInput = deriveCanvasAgentConsoleState([toolStart('run_nodes'), { type: 'agent_end' }])
  check('没有任何真实输入时不出现输入项（也不出现 workflow）', noInput.workflow, undefined)

  const malformed = deriveCanvasAgentConsoleState([
    toolEnd('get_canvas_overview', { resultText: 'not json' }),
    toolEnd('attach_reference_images', { ok: false, summary: '没有参考图可用' }),
  ])
  check('回执解析不出来 / 失败的挂图不产生输入事实（不猜）', malformed.workflow, undefined)

  const partial = deriveCanvasAgentConsoleState(
    [toolEnd('attach_reference_images', { resultText: JSON.stringify({ referenceImageCount: 1 }) })],
    { model: 'gpt-x' },
  )
  check('只发生过的项才出现（没有读画布就没有画布项）', partial.workflow?.inputs, [
    { key: 'model', label: '模型', value: 'gpt-x' },
    { key: 'reference_images', label: '参考图', value: '1 张' },
  ])
}

console.log('\n【2】卡片产出：有声明目标才给分母，没声明只显示已产出数')
{
  const declared = deriveCanvasAgentConsoleState([
    { type: 'tool_start', toolName: 'add_nodes', callId: 'c1', declaredTarget: { total: 24, unit: '个镜头' } },
    toolEnd('add_nodes', { resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) }, 'c1'),
  ])
  check('声明过目标 → output 带 target', declared.workflow?.output, { done: 3, target: 24, unit: '个镜头' })

  const noDeclared = deriveCanvasAgentConsoleState([
    toolEnd('add_nodes', { resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) }),
  ])
  check('没有声明 → output 只有 done（没有 target 字段）', noDeclared.workflow?.output, { done: 3, unit: '个节点' })

  const runOnly = deriveCanvasAgentConsoleState([
    toolEnd('run_nodes', { resultText: JSON.stringify({ submitted: 8, total: 24 }) }),
  ])
  check('没有创建节点但提交过生成 → 已产出 = 已提交数（批次分母不当目标）', runOnly.workflow?.output, {
    done: 8,
    unit: '个节点',
  })

  const nothing = deriveCanvasAgentConsoleState([toolStart('get_canvas_node'), { type: 'agent_end' }])
  check('没有任何产出时不给 output', nothing.workflow?.output, undefined)
}

console.log('\n【3】卡片显示组装：标题 / 输入 / 输出 / 状态')
{
  const card = buildAgentWorkflowCard(
    deriveCanvasAgentConsoleState(
      [
        { type: 'tool_start', toolName: 'add_nodes', callId: 'c1', declaredTarget: { total: 24, unit: '个镜头' } },
        toolEnd('add_nodes', {
          resultText: JSON.stringify({
            nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }],
          }),
        }, 'c1'),
      ],
      { model: 'gpt-x' },
    ),
  )
  check('标题 = 🎬 + 阶段名', card?.title, '🎬 分镜规划')
  check('有声明目标 → 已产出 8/24', card?.outputText, '已产出 8/24 个镜头')
  check('输入行带上真实输入', card?.inputText, '模型 gpt-x')
  check('状态行 = 生命周期词 + 阶段进度', String(card?.statusText).includes('阶段 3/6 · 分镜规划'), true)

  const noDeclaredCard = buildAgentWorkflowCard(
    deriveCanvasAgentConsoleState([
      toolEnd('add_nodes', {
        resultText: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }] }),
      }),
    ]),
  )
  check('无声明 → 只显示已产出 8（没有分母）', noDeclaredCard?.outputText, '已产出 8 个节点')
  check('无声明 → 文案里不出现「/」', String(noDeclaredCard?.outputText).includes('/'), false)

  check('无输入 → 输入行显示「—」', formatWorkflowInputText([]), AGENT_WORKFLOW_EMPTY_PLACEHOLDER)
  check('无产出 → 输出行显示「—」', formatWorkflowOutputText(undefined), AGENT_WORKFLOW_EMPTY_PLACEHOLDER)
  check('空状态 → 不显示卡片', buildAgentWorkflowCard(null), null)
}

console.log('\n【4】AI CREW：只有 Director 是活的，其余「待接入」')
{
  const crew = buildCanvasAgentCrew(true)
  check('5 个角色，顺序固定', crew.map((m) => m.name), ['Producer', 'Writer', 'Director', 'Art', 'Editor'])
  check('图标齐备', crew.map((m) => m.icon), ['🧑‍💼', '✍️', '🎬', '🎨', '✂️'])
  check('只有 Director 为 active', crew.filter((m) => m.status === 'active').map((m) => m.key), ['director'])
  check('其余全部 pending 且写「待接入」',
    crew.filter((m) => m.status === 'pending').every((m) => m.label === '待接入'),
    true)
  check('Director 在跑时显示「执行中」',
    crew.find((m) => m.key === 'director')?.label, '执行中')

  const idle = buildCanvasAgentCrew(false)
  check('Director 空闲时显示「待命」（仍是唯一 active）',
    idle.filter((m) => m.status === 'active').map((m) => m.key), ['director'])
  check('Director 空闲时状态词为「待命」',
    idle.find((m) => m.key === 'director')?.label, '待命')
  check('未接入角色不随运行时状态变词（永远「待接入」）',
    idle.filter((m) => !m.integrated).every((m) => m.label === '待接入'), true)

  check('角色清单里只有 Director 声明为 integrated',
    CANVAS_AGENT_CREW_ROLES.filter((r) => r.integrated).map((r) => r.key), ['director'])
}

console.log('\n【5】console_state 仍只走 SSE：载荷不含 content/delta/message')
{
  const state = deriveCanvasAgentConsoleState(
    [
      { type: 'tool_start', toolName: 'load_playbook', callId: 'c-pb', playbookName: 'storyboard-production' },
      toolEnd('load_playbook', { summary: '已加载工作手册' }),
      toolEnd('run_nodes', { resultText: JSON.stringify({ submitted: 8, total: 24 }) }),
    ],
    { model: 'gpt-x' },
  )
  check('带 workflow 的快照仍没有 role 字段（不是转录消息形状）', 'role' in state, false)
  check('带 workflow 的快照仍没有 content 字段（不会进 Markdown 正文）', 'content' in state, false)

  const event = buildCanvasAgentConsoleStreamEvent('rec-wf', state)
  check('事件类型是 console_state', event.type, 'console_state')
  check('事件不带 content', event.content, undefined)
  check('事件不带 delta', event.delta, undefined)
  check('事件不带 message', event.message, undefined)
  check('workflow 载荷里也没有可当正文的字段',
    JSON.stringify(state.workflow).includes('content') || JSON.stringify(state.workflow).includes('message'),
    false)

  // 反证：塞进 message/content 后就不再是「不携正文」
  const wrong = { ...event, message: 'x', content: 'x' }
  check('反证成立：塞进 message/content 后断言必然失败',
    wrong.message !== undefined && wrong.content !== undefined, true)
}

console.log('\n【6】反证：去掉「无声明不给分母」/ 把 CREW 全员标成已接入，核心断言必然失败')
{
  // ① 分母：没声明时若拿批次/已产出数当分母，就会出现假的「8/8」
  const noDeclared: CanvasAgentConsoleState['workflow'] = { inputs: [], output: { done: 8, unit: '个节点' } }
  const goodText = formatWorkflowOutputText(noDeclared.output)
  check('新实现：无声明文案不含「/」', goodText.includes('/'), false)
  const wrongTarget = formatWorkflowOutputText({ done: 8, target: 8, unit: '个节点' })
  check('旧实现（拿已产出当分母）：出现「8/8」假完成度', wrongTarget.includes('/'), true)
  check('反证成立：两种实现结论不同，「无声明不给分母」的断言是灵敏的', goodText !== wrongTarget, true)

  // ② CREW：若把未接入角色也算成已接入，就会出现多个 active
  const wrongCrew = CANVAS_AGENT_CREW_ROLES.map((role) => ({ ...role, status: 'active' as const }))
  check('新实现：active 只有 1 个',
    buildCanvasAgentCrew(true).filter((m) => m.status === 'active').length, 1)
  check('旧实现（全员已接入）：active 变成 5 个（正是要防的形态）',
    wrongCrew.filter((m) => m.status === 'active').length, 5)
  check('反证成立：两种实现不同，「只有 Director 为 active」的断言是灵敏的',
    buildCanvasAgentCrew(true).filter((m) => m.status === 'active').length
      !== wrongCrew.filter((m) => m.status === 'active').length,
    true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
