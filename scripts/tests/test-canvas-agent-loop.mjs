#!/usr/bin/env node
/**
 * 画布 Agent 循环的集成测试（2026-09-23）—— 把网关打桩，验证整条链路：
 *
 *   用户提问 → 请求里**带上工具清单** → 模型要求调用工具 → 我们在画布上真的执行
 *            → 把执行结果作为 tool 消息回给模型 → 模型给出最终答复 → 循环结束
 *
 * 为什么值得单独测：这条链路里最容易出的错都不是「报错」，而是**静默错**——
 *   工具结果没回给模型（模型只好瞎编第二轮）、把 assistant 的 tool_calls 丢了、
 *   或者工具失败直接中断整轮。这些在浏览器里表现为「助手说了句莫名其妙的话」，
 *   很难复现，所以在这里用桩把它钉住。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-agent-loop.mjs
 */

// ---- 打桩：模型目录 + 网关响应 -------------------------------------------------
const calls = []          // 记录每次请求（验请求体里带没带工具）
let scripted = []         // 预设的模型响应序列（第一轮要求调工具，第二轮给结论）

const stubCatalog = {
    providers: [{ id: 'p1', code: 'deepseek', name: 'DeepSeek', supportedTypes: ['CHAT'] }],
    models: { chat: [{ id: 'm1', providerId: 'p1', modelKey: 'deepseek-flash', label: 'Flash', category: 'CHAT' }], image: [], video: [] },
    defaults: { chat: 'deepseek-flash', image: '', video: '' },
}
globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/provider-config/catalog')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: stubCatalog }), json: async () => ({ data: stubCatalog }) }
    }
    if (target.includes('/api/ai/request')) {
        calls.push(JSON.parse(String(init?.body || '{}')))
        const next = scripted.shift() || { content: '（没有更多预设响应）' }
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: next }] }), json: async () => ({ choices: [{ message: next }] }) }
    }
    throw new Error(`未打桩的请求：${target}`)
}

const { useCanvasAgent } = await import('../../src/views/workflow/agent/use-canvas-agent.ts')

let passed = 0
let failed = 0
const check = (name, fn) => {
    try { fn(); passed += 1; console.log(`  ok   ${name}`) }
    catch (error) { failed += 1; console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

const createFakeContext = () => {
    const state = { nodes: [], edges: [], selected: [], runnerCalls: [] }
    let counter = 0
    const ctx = {
        snapshotNodes: () => state.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label || '', text: n.prompt || '' })),
        snapshotEdges: () => state.edges.map((e) => ({ source: e.source, target: e.target })),
        selectedIds: () => [...state.selected],
        defaultPosition: () => ({ x: 10, y: 20 }),
        addNode: (type, position, data = {}) => { counter += 1; const id = `n${counter}`; state.nodes.push({ id, type, ...position, ...data }); return id },
        updateNode: () => false,
        removeNode: () => false,
        addEdge: () => false,
        selectNodes: (ids) => { state.selected = [...ids] },
        runNode: async (id) => {
            // 与真实上下文一致：节点不存在/未挂载就如实失败（假上下文不能比真上下文宽松，否则测不出问题）
            const hit = state.nodes.find((node) => node.id === id)
            if (!hit) return { ok: false, reason: '该节点未挂载或暂不支持直接执行' }
            state.runnerCalls.push(id)
            return { ok: true }
        },
        applyTemplate: () => null,
        listTemplates: () => [],
        nodeTypeHints: () => [{ type: 'text', name: '文本' }, { type: 'image', name: '图片' }],
    }
    return { ctx, state }
}

const makeAgent = (ctx) => useCanvasAgent({
    ctx,
    buildBrief: () => '当前选中 0 个节点',
    readHistory: () => [],
})

console.log('== 一轮完整的多步工具调用 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    calls.length = 0
    scripted = [
        // 第一轮：模型要求先读画布
        { content: '先看看画布上有什么', tool_calls: [{ id: 'c1', function: { name: 'get_canvas_state', arguments: '{}' } }] },
        // 第二轮：要求加节点
        { content: '', tool_calls: [{ id: 'c2', function: { name: 'add_node', arguments: JSON.stringify({ type: 'image', prompt: '雪夜便利店' }) } }] },
        // 第三轮：选中它
        { content: '', tool_calls: [{ id: 'c3', function: { name: 'select_nodes', arguments: JSON.stringify({ ids: ['n1'] }) } }] },
        // 第四轮：给结论
        { content: '已在画布上新增图片节点并选中。' },
    ]
    const agent = makeAgent(ctx)
    const reply = await agent.run('帮我在画布上加一个图片节点，提示词是雪夜便利店，然后选中它')

    assert(reply.includes('新增') && reply.includes('选中'), `最终答复不对：${reply}`)
    assert(state.nodes.length === 1 && state.nodes[0].prompt === '雪夜便利店', '节点没真的建出来')
    assert(state.selected[0] === 'n1', '选中没生效')
    assert(agent.steps.value.length === 3, `应记录 3 步，实际 ${agent.steps.value.length}`)
    assert(agent.steps.value.every((step) => step.ok), '三步都该是成功的')
    assert(calls.length === 4, `应发生 4 次模型调用（3 次工具 + 1 次结论），实际 ${calls.length}`)
    // 请求体里必须带工具清单，否则模型根本不知道能动手
    const firstPayload = calls[0]
    const body = firstPayload?.request?.body
    assert(Array.isArray(body?.tools) && body.tools.length >= 8, '请求体里没带工具清单')
    assert(body.tools.some((tool) => tool.function.name === 'add_node'), '工具清单里没有 add_node')
    assert(firstPayload.upstream?.endpointType === 'chat', '应走 chat 端点')
    assert(String(firstPayload.request?.method).toUpperCase() === 'POST', '必须 POST：按 GET 组装会把 messages/tools 整段丢掉')
    // tool 结果必须回给模型（否则模型只能瞎猜）
    const secondPayloadMessages = calls[1]?.request?.body?.messages || []
    const toolMessage = secondPayloadMessages.find((message) => message.role === 'tool')
    assert(toolMessage, '第二轮请求里缺少 tool 结果消息')
    assert(String(toolMessage.content).includes('nodes'), 'tool 结果里应当带上画布快照')
    passed += 1
    console.log('  ok   多步工具调用 + 工具清单外发 + tool 结果回传')
})()

console.log('== 工具失败要回给模型、不能炸整轮 ==')
await (async () => {
    const { ctx } = createFakeContext()
    calls.length = 0
    scripted = [
        { content: '', tool_calls: [{ id: 'c1', function: { name: 'run_node', arguments: JSON.stringify({ id: '从哪儿来的' }) } }] },
        { content: '这个节点不存在，我没法执行它。' },
    ]
    const agent = makeAgent(ctx)
    const reply = await agent.run('帮我跑一下画布上那个节点')
    assert(agent.steps.value.length === 1 && agent.steps.value[0].ok === false, '失败的那一步应记成失败')
    assert(reply.includes('不存在'), `模型应基于失败原因作答，实际：${reply}`)
    const toolMessage = (calls[1]?.request?.body?.messages || []).find((message) => message.role === 'tool')
    assert(toolMessage && String(toolMessage.content).includes('失败'), '失败原因没回给模型')
    passed += 1
    console.log('  ok   工具失败转为 tool 结果（模型据此改正，而不是断线）')
})()

console.log('== 杂项 ==')
await (async () => {
    const { ctx } = createFakeContext()
    calls.length = 0
    scripted = [{ content: '' }, { content: '' }, { content: '' }, { content: '' }, { content: '' }, { content: '' }, { content: '' }]
    const agent = makeAgent(ctx)
    // 模型每轮都要工具但永远不给结论 → 应在上限处停下，而不是无限循环
    scripted = new Array(8).fill({ content: '', tool_calls: [{ id: 'c', function: { name: 'get_canvas_state', arguments: '{}' } }] })
    const reply = await agent.run('一直读画布')
    assert(calls.length === 6, `步数上限应为 6，实际 ${calls.length}`)
    assert(reply.includes('6 步'), `到上限要如实说明，实际：${reply}`)
    passed += 1
    console.log('  ok   步数上限生效（不会无限循环）')
})()

console.log('== 模型直答（不需要工具时不乱动画布）==')
await (async () => {
    const { ctx, state } = createFakeContext()
    calls.length = 0
    scripted = [{ content: '这个画布目前有 0 个节点，你可以先加一个文本节点描述创意。' }]
    const agent = makeAgent(ctx)
    const reply = await agent.run('我这个画布现在是什么状态？')
    assert(reply.includes('0 个节点'), '直答内容不对')
    assert(agent.steps.value.length === 0 && state.nodes.length === 0, '纯问答不该改画布')
    assert(calls.length === 1, '纯问答只该调用一次模型')
    passed += 1
    console.log('  ok   纯问答不触发任何工具')
})()

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
