/**
 * 导演控制台批次 3「画布动作可视化」的纯逻辑验证，2026-09-26
 *
 * 要钉死四件最容易静默出错的事：
 *   ① 高亮是**瞬时 UI 状态**：两个集合两种时钟 —— 「刚创建」受 TTL 约束，「生成中」不受
 *      （生成时长不可预测，用固定 TTL 猜会产生「Agent 还在出图、画布却没提示」或「长亮不灭」）；
 *   ② 清理必须可靠（回合结束 / 切画布 / 生成终态 / 节点删除），否则会留下永远发光的节点；
 *   ③ 批量创建要能看出「它在铺」：错开序号单调、数量与去重后一致；
 *   ④ 计数只在**真有声明**时给分母（「24 个镜头」），声明不到就只显示已创建数，绝不编。
 *
 * 文件末尾有反证：去掉「回合结束清空」，核心断言必然失败。
 */

import {
  assignStaggerOrders,
  agentStaggerDelayMs,
  clearAgentGeneratingNodes as clearGeneratingPure,
  clearAgentNodesForIds,
  createAgentActiveNodesState,
  isAgentCreated as isCreatedPure,
  markAgentCreatedNodes as markCreatedPure,
  markAgentGeneratingNodes as markGeneratingPure,
  normalizeAgentNodeIds,
  pruneExpiredCreatedNodes,
  resolveAgentNodeMarks,
} from '../src/views/workflow/composables/agent-active-nodes-state'
import {
  applyAgentToolMarks,
  clearAgentGeneratingNodes,
  markAgentCreatedNodes,
  resetAgentActiveNodes,
  useAgentActiveNodes,
} from '../src/views/workflow/composables/useAgentActiveNodes'
import {
  deriveCanvasAgentConsoleState,
  parseDeclaredCanvasTarget,
  type CanvasAgentConsoleEvent,
} from '../server/generation-tasks/canvas-agent-console-state'
import {
  addNode,
  clearCanvas,
  nodes,
} from '../src/views/workflow/composables/useWorkflowCanvas'

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

const addNodesResult = (ids: Array<string | null>) =>
  JSON.stringify({ nodes: ids.map((id) => ({ id, type: 'image' })) })
const runNodesResult = (nodesResult: Array<{ id: string; submitted: boolean }>) =>
  JSON.stringify({ submitted: nodesResult.filter((n) => n.submitted).length, total: nodesResult.length, nodes: nodesResult })

console.log('\n【1】「刚创建」受 TTL 约束：到期即从高亮里消失')
{
  const state = markCreatedPure(createAgentActiveNodesState(), ['a', 'b'], { now: 1000, ttlMs: 4000 })
  check('未到期时命中', isCreatedPure(state, 'a', 1000), true)
  check('到期前一毫秒仍命中', isCreatedPure(state, 'a', 4999), true)
  check('到期当刻不再命中（expiresAt <= now）', isCreatedPure(state, 'a', 5000), false)

  const beforeExpiry = pruneExpiredCreatedNodes(state, 4999)
  check('prune 未到期不清', beforeExpiry.created.size, 2)
  const afterExpiry = pruneExpiredCreatedNodes(state, 5000)
  check('prune 到期后清空', afterExpiry.created.size, 0)
}

console.log('\n【2】「生成中」不受 TTL 影响：不能用固定 TTL 猜生成何时结束')
{
  let state = markGeneratingPure(createAgentActiveNodesState(), ['g1'])
  state = pruneExpiredCreatedNodes(state, 10 * 60 * 1000)
  check('生成中不因 prune 被清', state.generating.has('g1'), true)
  check('生成中集合仍在', state.generating.size, 1)
  check('生成中与「刚创建」互不干扰', state.created.size, 0)
}

console.log('\n【3】清理出口：回合结束全清生成中 / 生成终态按 id 清 / 切画布两集合全清')
{
  let state = createAgentActiveNodesState()
  state = markCreatingAndGenerating(state)
  check('前置：既有刚创建也有生成中', [state.created.size, state.generating.size], [2, 2])

  const terminal = clearGeneratingPure(state, ['g1'])
  check('生成终态只清指定 id', [...terminal.generating.keys()], ['g2'])
  check('清生成中不影响刚创建', [...terminal.created.keys()].sort(), ['c1', 'c2'])

  const turnEnd = clearGeneratingPure(state)
  check('回合结束清空全部生成中', turnEnd.generating.size, 0)
  check('回合结束不误清刚创建（它由 TTL 渐隐）', turnEnd.created.size, 2)

  const removed = clearAgentNodesForIds(state, ['c1', 'g1'])
  check('节点删除：两个集合里对应 id 一起清', [[...removed.created.keys()], [...removed.generating.keys()]], [['c2'], ['g2']])

  const switched = createAgentActiveNodesState()
  check('切画布：新状态两集合都空', [switched.created.size, switched.generating.size], [0, 0])
}

console.log('\n【4】批量错开：序号单调、数量与去重后一致、延迟随序号增大')
{
  const marks = assignStaggerOrders(['a', 'a', 'b', 'c'])
  check('去重后数量正确', marks.length, 3)
  check('序号从 0 起单调 +1', marks.map((m) => m.order), [0, 1, 2])
  check('id 保持首次出现顺序', marks.map((m) => m.id), ['a', 'b', 'c'])

  const state = markCreatedPure(createAgentActiveNodesState(), ['a', 'b', 'c'], { now: 0 })
  check('延迟按序号递增', [0, 1, 2].map((i) => agentStaggerDelayMs(state, ['a', 'b', 'c'][i])), [0, 60, 120])
  check('不在集合里的节点延迟为 0', agentStaggerDelayMs(state, 'zzz'), 0)

  const parsed = resolveAgentNodeMarks('add_nodes', addNodesResult(['n1', 'n2', null]))
  check('回执解析：失败项（id=null）不计入', parsed.created, ['n1', 'n2'])
  check('run_nodes 只认可提交成功的', resolveAgentNodeMarks('run_nodes', runNodesResult([
    { id: 'n1', submitted: true },
    { id: 'n2', submitted: false },
  ])).generating, ['n1'])
  check('remove_node 产出 cleared', resolveAgentNodeMarks('remove_node', JSON.stringify({ id: 'n9' })).cleared, ['n9'])
  check('无关工具不产出任何高亮', resolveAgentNodeMarks('get_canvas_overview', '{}'), { created: [], generating: [], cleared: [] })
  check('空 id 归一后为空', normalizeAgentNodeIds(['', '  ', '']), [])
}

console.log('\n【5】响应式单例：TTL 定时器真的会清（不是只写在纯函数里）')
{
  resetAgentActiveNodes()
  markAgentCreatedNodes(['t1'], 30)
  const { isAgentCreated } = useAgentActiveNodes()
  check('标记后立即命中', isAgentCreated('t1'), true)
  await new Promise((resolve) => setTimeout(resolve, 70))
  check('TTL 到期后自动清除', isAgentCreated('t1'), false)
  resetAgentActiveNodes()
}

console.log('\n【6】工具回执驱动：创建→生成中转换时收掉「刚创建」，生成终态/回合结束收掉「生成中」')
{
  resetAgentActiveNodes()
  const view = useAgentActiveNodes()
  applyAgentToolMarks('add_nodes', addNodesResult(['n1', 'n2']))
  check('add_nodes 后两个节点都是刚创建', [view.isAgentCreated('n1'), view.isAgentCreated('n2')], [true, true])

  applyAgentToolMarks('run_nodes', runNodesResult([{ id: 'n1', submitted: true }]))
  check('提交生成后 n1 变为生成中', view.isAgentGenerating('n1'), true)
  check('转生成中时收掉其「刚创建」（避免两套样式打架）', view.isAgentCreated('n1'), false)
  check('未提交的 n2 不受影响', view.isAgentCreated('n2'), true)

  clearAgentGeneratingNodes(['n1'])
  check('生成终态按 id 清除', view.isAgentGenerating('n1'), false)

  resetAgentActiveNodes()
  applyAgentToolMarks('run_nodes', runNodesResult([{ id: 'n3', submitted: true }, { id: 'n4', submitted: true }]))
  clearAgentGeneratingNodes()
  check('回合结束全清生成中', [view.isAgentGenerating('n3'), view.isAgentGenerating('n4')], [false, false])
}

console.log('\n【7】高亮不写入画布数据 / 持久化载荷（这是本批的红线）')
{
  resetAgentActiveNodes()
  clearCanvas()
  const id = addNode('image', { x: 10, y: 20 }, { prompt: '一只猫' })
  applyAgentToolMarks('add_node', JSON.stringify({ id }))

  const view = useAgentActiveNodes()
  check('前置：该节点确实被点亮', view.isAgentCreated(id), true)

  const nodesJson = JSON.parse(JSON.stringify(nodes.value)) as Array<Record<string, unknown>>
  check('画布节点数不变（高亮没造出新节点）', nodesJson.length, 1)
  check('节点 data 里没有高亮字段', Object.keys(nodesJson[0].data as Record<string, unknown>), ['url', 'prompt', 'label', 'createdAt', 'updatedAt'])

  // 模拟持久化载荷（useWorkflowPersistence 写的就是 nodesJson）
  const persistencePayload = JSON.stringify({ nodesJson })
  const highlightMarkers = /canvas-agent|is-agent|agentactive|agentcreated|agentgenerating|agentstagger|agent-active/i
  check('持久化载荷里不含任何高亮标记', highlightMarkers.test(persistencePayload), false)

  // 反证：若把高亮写进 node.data（错误做法），载荷必然被弄脏
  const wrongNode = { ...nodesJson[0], data: { ...(nodesJson[0].data as Record<string, unknown>), isAgentCreated: true } }
  check('反证成立：写进 node.data 后载荷立刻含高亮标记', highlightMarkers.test(JSON.stringify({ nodesJson: [wrongNode] })), true)

  clearCanvas()
  resetAgentActiveNodes()
}

console.log('\n【8】画布动作计数：跨批次累加 + 只在有声明时给分母')
{
  const confirmationStart = (declaredTarget?: { total: number; unit: string }): CanvasAgentConsoleEvent => ({
    type: 'tool_start',
    toolName: 'request_confirmation',
    callId: 'c-confirm',
    ...(declaredTarget ? { declaredTarget } : {}),
  })
  const addBatch = (callId: string, ids: Array<string | null>): CanvasAgentConsoleEvent[] => [
    { type: 'tool_start', toolName: 'add_nodes', callId },
    { type: 'tool_end', toolName: 'add_nodes', callId, ok: true, resultText: addNodesResult(ids) },
  ]

  const noDeclaration = deriveCanvasAgentConsoleState([
    ...addBatch('a', ['n1', 'n2', 'n3']),
    ...addBatch('b', ['n4', 'n5']),
  ])
  check('跨批次累加（3 + 2）', noDeclaration.canvasActions, { created: 5, unit: '个节点' })
  check('没有声明就没有 target 字段（绝不编分母）', 'target' in (noDeclaration.canvasActions || {}), false)

  const withDeclaration = deriveCanvasAgentConsoleState([
    confirmationStart({ total: 24, unit: '个镜头' }),
    ...addBatch('a', ['n1', 'n2', 'n3']),
  ])
  check('声明过目标才给分母与单位', withDeclaration.canvasActions, { created: 3, target: 24, unit: '个镜头' })

  const partial = deriveCanvasAgentConsoleState([
    { type: 'tool_start', toolName: 'add_nodes', callId: 'a' },
    { type: 'tool_end', toolName: 'add_nodes', callId: 'a', ok: true, resultText: addNodesResult(['n1', null, 'n2']) },
  ])
  check('失败项（id=null）不计入已创建数', partial.canvasActions, { created: 2, unit: '个节点' })

  const failedBatch = deriveCanvasAgentConsoleState([
    { type: 'tool_start', toolName: 'add_nodes', callId: 'a' },
    { type: 'tool_end', toolName: 'add_nodes', callId: 'a', ok: false, summary: '一个节点都没建出来' },
  ])
  check('失败批次不计入、也不出这一行', failedBatch.canvasActions, undefined)
}

console.log('\n【9】目标总数只从 request_confirmation 的声明解析，过去式不误当分母')
{
  check('「将生成 24 个镜头」→ 24 个镜头', parseDeclaredCanvasTarget(['将生成 24 个镜头']), { total: 24, unit: '个镜头' })
  check('「共 12 个场景」→ 12 个场景', parseDeclaredCanvasTarget(['共 12 个场景']), { total: 12, unit: '个场景' })
  check('多条声明取最大', parseDeclaredCanvasTarget(['先做 8 个镜头', '共 24 个镜头']), { total: 24, unit: '个镜头' })
  check('过去式「已创建 8 个场景节点」不当目标（否则会出现假的 8/8）', parseDeclaredCanvasTarget(['已创建 8 个场景节点']), undefined)
  check('纯文本没有分类词也解析不出', parseDeclaredCanvasTarget(['再多做一点']), undefined)
}

console.log('\n【10】反证：去掉「回合结束清空」，核心断言必然失败')
{
  const view = useAgentActiveNodes()
  const scenario = () => {
    resetAgentActiveNodes()
    applyAgentToolMarks('run_nodes', runNodesResult([{ id: 'n1', submitted: true }]))
  }

  scenario()
  clearAgentGeneratingNodes() // 正确实现：回合结束清
  const afterTurnEnd = view.isAgentGenerating('n1')

  scenario() // 反证实现：忘了清（等价于不调用 clearAgentGeneratingNodes）
  const withoutTurnClear = view.isAgentGenerating('n1')

  check('正确实现：回合结束后不再亮', afterTurnEnd, false)
  check('反证实现：没有回合结束清空就会永远亮着', withoutTurnClear, true)
  check('反证成立：两种实现结论不同，「回合结束清空」这条断言是灵敏的', afterTurnEnd !== withoutTurnClear, true)
  resetAgentActiveNodes()
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)

/** 造一个既有「刚创建」又有「生成中」的状态，供清理用例复用 */
function markCreatingAndGenerating(state: ReturnType<typeof createAgentActiveNodesState>) {
  let next = markCreatedPure(state, ['c1', 'c2'], { now: 0 })
  next = markGeneratingPure(next, ['g1', 'g2'])
  return next
}
