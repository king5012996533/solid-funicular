#!/usr/bin/env node
/**
 * 画布 Agent 工具层单测（2026-09-23）
 *
 * 为什么单独测这一层：工具是「模型能对用户的画布做什么」的**唯一清单** —— 模型说的每一句
 * 「我已经帮你加好了」，背后都是这里的一个 case 在改真实画布。这类东西出错（id 串了、
 * 参数没校验、失败却报成功）在浏览器里很难复现，但后果是数据被改坏。
 *
 * 用一个假的画布上下文（内存数组）驱动，验证：
 *   1. 每个工具的「正常路径」确实改了状态、返回的 id/摘要对得上；
 *   2. 非法输入（不存在的节点、空 id、自己连自己、未知类型）一律 ok:false + 可读原因，**不改状态**；
 *   3. get_canvas_state 给模型的快照包含定位节点所需的字段，且不把超长文本整段塞进上下文。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-agent-tools.mjs
 */
import {
    CANVAS_AGENT_TOOL_SCHEMAS,
    executeCanvasAgentTool,
} from '../../src/views/workflow/agent/canvas-agent-tools.ts'

let passed = 0
let failed = 0
const check = (name, fn) => {
    try {
        fn()
        passed += 1
        console.log(`  ok   ${name}`)
    } catch (error) {
        failed += 1
        console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`)
    }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

/** 记忆一个最小画布：节点数组 + 连线数组 + 选中集合 */
const createFakeContext = () => {
    const state = {
        nodes: [],
        edges: [],
        selected: [],
        ran: [],
        counter: 0,
    }
    const ctx = {
        snapshotNodes: () => state.nodes.map((node) => ({
            id: node.id, type: node.type, label: node.label || '', text: node.prompt || node.content || '',
            model: node.model, size: node.size, quality: node.quality, status: node.status,
        })),
        snapshotEdges: () => state.edges.map((edge) => ({ source: edge.source, target: edge.target })),
        selectedIds: () => [...state.selected],
        defaultPosition: () => ({ x: 100, y: 200 }),
        addNode: (type, position, data = {}) => {
            state.counter += 1
            const id = `n${state.counter}`
            state.nodes.push({ id, type, ...position, ...data, label: data.label || `${type} 节点` })
            return id
        },
        updateNode: (id, patch) => {
            const hit = state.nodes.find((node) => node.id === id)
            if (!hit) return false
            Object.assign(hit, patch)
            return true
        },
        removeNode: (id) => {
            const before = state.nodes.length
            state.nodes = state.nodes.filter((node) => node.id !== id)
            state.edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id)
            return state.nodes.length < before
        },
        addEdge: (source, target) => {
            if (state.edges.some((edge) => edge.source === source && edge.target === target)) return false
            state.edges.push({ source, target })
            return true
        },
        selectNodes: (ids) => { state.selected = [...ids] },
        runNode: async (id) => {
            const hit = state.nodes.find((node) => node.id === id)
            if (!hit) return { ok: false, reason: '节点不存在' }
            if (hit.type === 'video') return { ok: false, reason: '视频生成尚未接通：服务端还没有 video 执行策略' }
            state.ran.push(id)
            return { ok: true }
        },
        applyTemplate: (templateId, position) => {
            if (templateId !== 'tpl-demo') return null
            const first = ctx.addNode('text', position, { content: '模板文本' })
            const second = ctx.addNode('image', { x: position.x + 400, y: position.y })
            ctx.addEdge(first, second)
            return { nodes: 2, edges: 1 }
        },
        listTemplates: () => [{ id: 'tpl-demo', name: '演示模板', description: '两个节点' }],
        nodeTypeHints: () => [
            { type: 'text', name: '文本输入' },
            { type: 'image', name: '图片' },
            { type: 'video', name: '视频' },
            { type: 'asset', name: '素材' },
        ],
    }
    return { ctx, state }
}

const run = (ctx, name, args) => executeCanvasAgentTool(name, args, ctx)

console.log('== 工具清单 ==')
check('暴露给模型的工具名与说明齐全', () => {
    const names = CANVAS_AGENT_TOOL_SCHEMAS.map((tool) => tool.function.name)
    for (const expected of ['get_canvas_state', 'add_node', 'update_node', 'connect_nodes', 'remove_node', 'select_nodes', 'run_node', 'list_workflow_templates', 'apply_workflow_template']) {
        assert(names.includes(expected), `缺少工具 ${expected}`)
    }
    for (const tool of CANVAS_AGENT_TOOL_SCHEMAS) {
        assert(tool.function.description.length > 10, `${tool.function.name} 的 description 太短，模型看不出用途`)
        assert(tool.function.parameters?.type === 'object', `${tool.function.name} 的参数必须是 object schema`)
    }
})

console.log('== 正常路径 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const res = await run(ctx, 'add_node', { type: 'image', prompt: '雪夜便利店', size: '16:9', model: 'deepseek-x' })
    assert(res.ok, '应该成功')
    assert(state.nodes.length === 1, '应该新增 1 个节点')
    const node = state.nodes[0]
    assert(node.type === 'image' && node.prompt === '雪夜便利店' && node.size === '16:9', '参数没写进节点')
    assert(res.result.includes(node.id), '返回里应带节点 id，模型下一步要用')
    assert(res.summary.includes('雪夜便利店'), '摘要应让用户看懂做了什么')
    passed += 1
    console.log('  ok   add_node 落点/参数生效并返回 id')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    const created = await run(ctx, 'add_node', { type: 'text', content: 'hello' })
    const id = JSON.parse(created.result).id
    const updated = await run(ctx, 'update_node', { id, prompt: '新提示词', label: '改名' })
    assert(updated.ok, '更新应该成功')
    assert(state.nodes[0].prompt === '新提示词' && state.nodes[0].label === '改名', '字段没更新')
    const finalState = await run(ctx, 'get_canvas_state', {})
    assert(finalState.result.includes('新提示词'), '快照里应能看到更新后的内容')
    passed += 1
    console.log('  ok   update_node 写入并在快照里可见')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    const a = JSON.parse((await run(ctx, 'add_node', { type: 'text', content: 'a' })).result).id
    const b = JSON.parse((await run(ctx, 'add_node', { type: 'image' })).result).id
    const linked = await run(ctx, 'connect_nodes', { source: a, target: b })
    assert(linked.ok && state.edges.length === 1, '连线没成功')
    const again = await run(ctx, 'connect_nodes', { source: a, target: b })
    assert(!again.ok, '重复连线应该报失败而不是静默再加一条')
    const removed = await run(ctx, 'remove_node', { id: b })
    assert(removed.ok && state.nodes.length === 1 && state.edges.length === 0, '删节点应连带清掉它的连线')
    passed += 1
    console.log('  ok   connect_nodes / remove_node（含连带清线、重复连线拦截）')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    const id = JSON.parse((await run(ctx, 'add_node', { type: 'image' })).result).id
    const selected = await run(ctx, 'select_nodes', { ids: [id] })
    assert(selected.ok && state.selected[0] === id, '选中没生效')
    const executed = await run(ctx, 'run_node', { id })
    assert(executed.ok && state.ran[0] === id, '执行没触发')
    passed += 1
    console.log('  ok   select_nodes / run_node 真的触发了执行')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    const listed = await run(ctx, 'list_workflow_templates', {})
    assert(listed.ok && listed.result.includes('tpl-demo'), '模板清单不对')
    const applied = await run(ctx, 'apply_workflow_template', { templateId: 'tpl-demo' })
    assert(applied.ok && state.nodes.length === 2 && state.edges.length === 1, '模板没铺开')
    passed += 1
    console.log('  ok   list_workflow_templates / apply_workflow_template')
})()

console.log('== 非法输入：必须 ok:false 且不动状态 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const cases = [
        ['未知节点类型', await run(ctx, 'add_node', { type: 'hologram' })],
        ['更新不存在的节点', await run(ctx, 'update_node', { id: 'nope', prompt: 'x' })],
        ['更新但没给字段', await run(ctx, 'update_node', { id: 'n1' })],
        ['缺少节点 id', await run(ctx, 'update_node', {})],
        ['连线到不存在的节点', await run(ctx, 'connect_nodes', { source: 'a', target: 'b' })],
        ['自己连自己', await run(ctx, 'connect_nodes', { source: 'n1', target: 'n1' })],
        ['删除不存在的节点', await run(ctx, 'remove_node', { id: 'nope' })],
        ['选中空列表', await run(ctx, 'select_nodes', { ids: [] })],
        ['未知模板', await run(ctx, 'apply_workflow_template', { templateId: 'nope' })],
        ['未知工具', await run(ctx, 'drop_database', {})],
    ]
    for (const [label, res] of cases) {
        assert(!res.ok, `${label}：应该失败`)
        assert(res.result && res.result.length > 4, `${label}：失败必须带可读原因（模型据此改正）`)
    }
    assert(state.nodes.length === 0 && state.edges.length === 0, '失败路径不该改动画布')
    passed += 1
    console.log(`  ok   10 类非法输入全部被拦、状态未变`)
})()

await (async () => {
    const { ctx } = createFakeContext()
    const denied = await run(ctx, 'run_node', { id: JSON.parse((await run(ctx, 'add_node', { type: 'video' })).result).id })
    assert(!denied.ok && denied.result.includes('video'), '视频节点应如实报「尚未接通」，不能谎报成功')
    passed += 1
    console.log('  ok   视频节点执行如实失败（不谎报）')
})()

console.log('== 给模型的快照 ==')
await (async () => {
    const { ctx } = createFakeContext()
    await run(ctx, 'add_node', { type: 'image', prompt: 'x'.repeat(2000) })
    const snap = await run(ctx, 'get_canvas_state', {})
    const parsed = JSON.parse(snap.result)
    assert(parsed.nodes.length === 1, '快照节点数不对')
    assert(parsed.nodes[0].text.length < 200, `快照里的文本没截断：${parsed.nodes[0].text.length}`)
    assert(Array.isArray(parsed.availableNodeTypes) && parsed.availableNodeTypes.length > 0, '快照应带上可用节点类型，否则模型会瞎猜')
    passed += 1
    console.log('  ok   快照含定位字段、长文本已截断')
})()

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
