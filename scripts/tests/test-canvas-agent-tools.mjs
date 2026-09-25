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
 *   3. get_canvas_state 给模型的快照包含定位节点所需的字段，且不把超长文本整段塞进上下文；
 *   4. get_canvas_overview 只给定位字段（不含 prompt/坐标/连线明细）、get_canvas_node 给单节点全量 + 连线摘要；
 *   5. run_node / run_nodes 是「提交即回执」：回执带逐节点提交状态、同轮重复提交如实说明、提交失败如实回执。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-agent-tools.mjs
 */
import {
    CANVAS_AGENT_TOOL_SCHEMAS,
    executeCanvasAgentTool,
} from '../../src/views/workflow/agent/canvas-agent-tools.ts'
import { CANVAS_AGENT_TOOL_DEFINITIONS } from '../../src/shared/canvas-agent-tools.ts'
import { resolveAttachedReferences } from '../../src/views/workflow/composables/resolveAttachedReferences.ts'

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

/** 记忆一个最小画布：节点数组 + 连线数组 + 选中集合 + 本轮已触发集合 */
const createFakeContext = () => {
    const state = {
        nodes: [],
        edges: [],
        selected: [],
        ran: [],
        // 「本轮已经提交过」的去重集合：与 useCanvasNodeRunner 的 triggeredNodeIds 同一语义
        triggered: new Set(),
        counter: 0,
    }
    const ctx = {
        snapshotNodes: () => state.nodes.map((node) => ({
            id: node.id, type: node.type, label: node.label || '', text: node.prompt || node.content || '',
            // 必须分开给 prompt/content 与参考图/出图地址：预校验按节点类型分派字段，
            // 只给合并后的 text 会把有提示词的节点误报成「没有提示词」。
            prompt: node.prompt, content: node.content,
            model: node.model, size: node.size, quality: node.quality, status: node.status,
            // 生成状态的三态原始事实（概览/单节点读据此归一成 idle|generating|error）
            loading: node.loading, error: node.error, taskRecordId: node.taskRecordId,
            position: { x: Number(node.x) || 0, y: Number(node.y) || 0 },
            selected: state.selected.includes(node.id),
            imageUrl: node.imageUrl, referenceImages: node.referenceImages,
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
        // 与画布页同源：把节点 id 解析成该节点的出图地址（8 张分镜图全废就是因为这里没做）
        attachReferenceImages: (id, images) => {
            const hit = state.nodes.find((node) => node.id === id)
            if (!hit) return { ok: false, reason: `找不到节点 ${id}` }
            const { resolved, unresolved } = resolveAttachedReferences(images, (nodeId) => {
                const node = state.nodes.find((item) => item.id === nodeId)
                return { exists: Boolean(node), imageUrl: String(node?.imageUrl || '') }
            })
            if (!resolved.length) return { ok: false, reason: `没有可用的参考图：${unresolved.join('；') || 'images 为空'}` }
            hit.referenceImages = [...resolved]
            return unresolved.length ? { ok: true, reason: `忽略了 ${unresolved.length} 项` } : { ok: true }
        },
        runNode: async (id) => {
            const hit = state.nodes.find((node) => node.id === id)
            if (!hit) return { ok: false, status: 'failed', reason: '节点不存在' }
            if (hit.type === 'video') return { ok: false, status: 'failed', reason: '视频生成尚未接通：服务端还没有 video 执行策略' }
            // 与 useCanvasNodeRunner.runNodeById 同一套去重：同轮同一节点只真正提交一次
            if (state.triggered.has(id)) {
                return { ok: false, status: 'duplicate', reason: '本轮已经触发过该节点（重复提交会重复扣费），已忽略；要重新生成请新开一轮' }
            }
            state.triggered.add(id)
            state.ran.push(id)
            // 提交即回执：ok 只代表「已提交」，不代表已出图
            return { ok: true, status: 'submitted' }
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
    for (const expected of ['get_canvas_state', 'get_canvas_overview', 'get_canvas_node', 'add_node', 'update_node', 'connect_nodes', 'remove_node', 'select_nodes', 'run_node', 'list_workflow_templates', 'apply_workflow_template']) {
        assert(names.includes(expected), `缺少工具 ${expected}`)
    }
    /**
     * 前后端不许漂移：模型看到的描述来自服务端那份定义，浏览器执行的是这份 schema。
     * 两边一旦不一致（改名、改参数、改说明），表现是「模型老调错工具」——不报错、只变笨，
     * 所以在这里逐字段钉死，让漂移在 CI 就炸出来。
     */
    assert(
        CANVAS_AGENT_TOOL_SCHEMAS.length === CANVAS_AGENT_TOOL_DEFINITIONS.length,
        `前后端工具数量不一致：前端 ${CANVAS_AGENT_TOOL_SCHEMAS.length}、共享定义 ${CANVAS_AGENT_TOOL_DEFINITIONS.length}`,
    )
    for (const definition of CANVAS_AGENT_TOOL_DEFINITIONS) {
        const schema = CANVAS_AGENT_TOOL_SCHEMAS.find((item) => item.function.name === definition.name)
        assert(schema, `共享定义里的「${definition.name}」没有派生出 schema`)
        assert(schema.function.description === definition.description, `${definition.name} 的描述前后端不一致`)
        assert(schema.function.label === definition.label, `${definition.name} 的展示名前后端不一致`)
        assert(
            JSON.stringify(schema.function.parameters) === JSON.stringify(definition.parameters),
            `${definition.name} 的参数 schema 前后端不一致`,
        )
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

console.log('== 快照必须让模型看出「节点已经出过图」（否则它会重复执行、重复扣费）==')
await (async () => {
    const { ctx } = createFakeContext()
    const created = await run(ctx, 'add_node', { type: 'image', prompt: '母版 M1：28 岁亚洲女性' })
    const id = JSON.parse(created.result).id
    ctx.updateNode(id, { imageUrl: '/uploads/generated/image/m1.png' })
    const snap = await run(ctx, 'get_canvas_state', {})
    const node = JSON.parse(snap.result).nodes[0]
    assert(node.hasImage === true, '快照必须给 hasImage，否则「跑完的节点」和「从没跑过的节点」长得一样，模型会补跑一次')
    passed += 1
    console.log('  ok   快照带 hasImage')
})()

console.log('== get_canvas_overview：只给定位字段（不含 prompt / 坐标 / 连线明细）==')
await (async () => {
    const { ctx } = createFakeContext()
    await run(ctx, 'add_node', { type: 'image', prompt: '母版M1的秘密提示词：28 岁亚洲女性', model: 'prov::IMAGE::m1', size: '16:9' })
    const table = JSON.parse((await run(ctx, 'add_node', { type: 'text', content: '分镜表' })).result).id
    const shot = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '分镜 01' })).result).id
    ctx.updateNode(shot, { imageUrl: '/uploads/generated/image/s1.png' })
    await run(ctx, 'connect_nodes', { source: table, target: shot })

    const res = await run(ctx, 'get_canvas_overview', {})
    assert(res.ok, `概览应成功：${res.summary}`)
    const parsed = JSON.parse(res.result)
    assert(parsed.nodeCount === 3 && parsed.edgeCount === 1, `计数不对：${res.result}`)
    assert(parsed.countsByKind.image === 2 && parsed.countsByKind.text === 1, `按类型计数不对：${JSON.stringify(parsed.countsByKind)}`)
    assert(parsed.countsByGenerationStatus.idle === 3, `按状态计数不对：${JSON.stringify(parsed.countsByGenerationStatus)}`)

    const shotSummary = parsed.nodes.find((node) => node.id === shot)
    assert(shotSummary, '概览应列出每个节点')
    assert(shotSummary.kind === 'image' && shotSummary.hasOutput === true, `节点摘要要有 kind/hasOutput：${JSON.stringify(shotSummary)}`)
    assert(shotSummary.generationStatus === 'idle', `已出图的节点应为 idle：${shotSummary.generationStatus}`)

    // 概览的价值就在「便宜」：任何细节都不许混进来
    assert(!/秘密提示词/.test(res.result), '概览不得含 prompt 明文（那正是旧整画布读的负担）')
    for (const node of parsed.nodes) {
        assert(!('prompt' in node) && !('text' in node), `概览节点不得含文本字段：${JSON.stringify(node)}`)
        assert(!('position' in node), `概览不得含坐标：${JSON.stringify(node)}`)
        assert(!('incomingConnections' in node) && !('outgoingConnections' in node), '概览不得含连线明细')
    }
    assert(!('edges' in parsed), '概览不得返回连线数组（只给 edgeCount）')
    passed += 1
    console.log('  ok   概览只给 id/kind/标题/生成状态/产物 + 计数')
})()

console.log('== get_canvas_node：单节点全量 + 精简连线摘要 ==')
await (async () => {
    const { ctx } = createFakeContext()
    const master = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '母版 M1', model: 'prov::IMAGE::m1', size: '16:9', quality: '高' })).result).id
    const shot = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '分镜 01 的画面描述' })).result).id
    await run(ctx, 'connect_nodes', { source: master, target: shot })

    const res = await run(ctx, 'get_canvas_node', { id: shot })
    assert(res.ok, `单节点读应成功：${res.summary}`)
    const parsed = JSON.parse(res.result)
    assert(parsed.id === shot && parsed.kind === 'image', `基本字段不对：${res.result}`)
    assert(typeof parsed.position?.x === 'number' && typeof parsed.position?.y === 'number', '单节点读必须给坐标（概览刻意没有）')
    assert(parsed.data.prompt === '分镜 01 的画面描述', `单节点读要给完整提示词：${JSON.stringify(parsed.data)}`)
    assert(parsed.data.generationStatus === 'idle', '应有归一后的生成状态')
    assert(
        parsed.incomingConnections.length === 1 && parsed.incomingConnections[0].id === master,
        `入线摘要不对：${JSON.stringify(parsed.incomingConnections)}`,
    )
    assert(Array.isArray(parsed.outgoingConnections) && parsed.outgoingConnections.length === 0, '出线摘要应是数组')

    // 参数细节（模型/画幅/画质）也要给得出，不能只剩提示词
    const masterDetail = JSON.parse((await run(ctx, 'get_canvas_node', { id: master })).result)
    assert(
        masterDetail.data.model === 'prov::IMAGE::m1' && masterDetail.data.size === '16:9' && masterDetail.data.quality === '高',
        `单节点读要给模型/画幅/画质：${JSON.stringify(masterDetail.data)}`,
    )

    const missing = await run(ctx, 'get_canvas_node', { id: 'nope' })
    assert(!missing.ok && missing.result.includes('nope'), `找不到节点要如实失败：${missing.result}`)
    passed += 1
    console.log('  ok   单节点读：全量字段 + 入/出线摘要；未知 id 如实失败')
})()

console.log('== 生成状态归一：loading→generating，error→error ==')
await (async () => {
    const { ctx } = createFakeContext()
    const id = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '在跑' })).result).id
    ctx.updateNode(id, { loading: true, error: '' })
    const busy = JSON.parse((await run(ctx, 'get_canvas_node', { id })).result)
    assert(busy.data.generationStatus === 'generating', `loading 应归一为 generating：${busy.data.generationStatus}`)
    ctx.updateNode(id, { loading: false, error: '上游 400：模型不可用' })
    const broken = JSON.parse((await run(ctx, 'get_canvas_node', { id })).result)
    assert(broken.data.generationStatus === 'error' && broken.data.error.includes('400'), `error 要带原文：${JSON.stringify(broken.data)}`)
    passed += 1
    console.log('  ok   loading/error 归一正确')
})()

console.log('== run_node / run_nodes：提交即回执（不等出图）、去重与失败都如实 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const id = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '母版 M1' })).result).id
    const res = await run(ctx, 'run_node', { id })
    assert(res.ok, `提交应成功：${res.summary}`)
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 1 && parsed.total === 1, `回执要有提交计数：${res.result}`)
    assert(parsed.nodes.length === 1 && parsed.nodes[0].id === id, `回执要含每个节点：${res.result}`)
    assert(parsed.nodes[0].submitted === true && parsed.nodes[0].status === 'generating', `节点状态应为已提交/生成中：${res.result}`)
    assert(!parsed.nodes[0].done, '回执不得声称「已完成」（提交 ≠ 出图）')
    assert(/已提交/.test(res.summary) && /生成中/.test(res.summary), `步骤摘要必须写「已提交 · 生成中」：${res.summary}`)
    assert(!/已完成|已出图/.test(res.summary), `不得把提交说成完成：${res.summary}`)

    // 同轮重复提交：如实说明，且不重复真正触发（不重复扣费）
    const again = await run(ctx, 'run_node', { id })
    assert(!again.ok, '同轮重复提交应被挡下')
    const againParsed = JSON.parse(again.result)
    assert(againParsed.nodes[0].status === 'skipped', `重复提交应回 skipped：${again.result}`)
    assert(againParsed.nodes[0].submitted === false, '重复提交不得声称已提交')
    assert(state.ran.length === 1, `重复提交不得再次触发，实际触发 ${state.ran.length} 次`)
    passed += 1
    console.log('  ok   run_node：提交回执带状态；重复提交如实跳过且不重复触发')
})()

await (async () => {
    const { ctx } = createFakeContext()
    const res = await run(ctx, 'run_node', { id: 'ghost' })
    assert(!res.ok, '不存在的节点提交应失败')
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 0 && parsed.nodes[0].status === 'failed', `失败回执要如实：${res.result}`)
    assert(parsed.nodes[0].reason && /不存在/.test(parsed.nodes[0].reason), `失败要带真实原因：${res.result}`)
    passed += 1
    console.log('  ok   run_node 提交失败 → failed + 真实原因（不谎报成功）')
})()

console.log('== attach_reference_images：把节点 id 翻译成出图地址 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const master = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '母版 M1' })).result).id
    ctx.updateNode(master, { imageUrl: '/uploads/generated/image/m1.png' })
    const shot = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '分镜 01' })).result).id
    const attached = await run(ctx, 'attach_reference_images', { id: shot, images: [master] })
    assert(attached.ok, `用节点 id 挂参考图应成功：${attached.summary}`)
    const shotNode = state.nodes.find((node) => node.id === shot)
    assert(shotNode.referenceImages?.length === 1, '参考图应挂上 1 张')
    assert(
        shotNode.referenceImages[0] === '/uploads/generated/image/m1.png',
        `挂上的应是出图地址，而不是节点 id（否则服务端会 new URL("node_x") 抛错）：${shotNode.referenceImages[0]}`,
    )

    // 未出图的节点 id + 乱写的字符串：都应被如实挑出，而不是塞进节点导致服务端失败
    const empty = JSON.parse((await run(ctx, 'add_node', { type: 'image', prompt: '空节点' })).result).id
    const bad = await run(ctx, 'attach_reference_images', { id: shot, images: [empty, 'node_2'] })
    assert(!bad.ok, '全是无效引用时应失败')
    assert(bad.result.includes('还没有出图') && bad.result.includes('node_2'), `失败原因要逐项说清：${bad.result}`)
    passed += 1
    console.log('  ok   节点 id → 出图地址；无效引用逐项挑出')
})()

console.log('== 预校验：余额/预估接入（充足 / 不足 / 降级）==')

// 屏蔽真实网络：预校验里的余额、预估、参考图探测都走这个假 fetch
const originalFetch = globalThis.fetch
const installFetch = (routes) => {
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url)
        const method = String(options.method || 'GET').toUpperCase()
        const hit = routes.find((route) => target.includes(route.match) && (!route.method || route.method === method))
        if (hit) {
            if (hit.throw) throw new Error('模拟网络故障')
            const status = hit.status ?? (hit.ok === false ? 500 : 200)
            return { ok: hit.ok !== false && status < 400, status, json: async () => hit.body ?? {} }
        }
        // 未命中的请求（例如参考图 HEAD 探测）当作可达
        return { ok: true, status: 200, json: async () => ({}) }
    }
    return () => { globalThis.fetch = originalFetch }
}

// 建一批带提示词/模型/画幅的图片节点（预校验要有可预估的节点）
const makeImageCtx = async (prompts) => {
    const { ctx, state } = createFakeContext()
    const ids = []
    for (const prompt of prompts) {
        const res = await run(ctx, 'add_node', { type: 'image', prompt, model: 'prov::IMAGE::m1', size: '16:9' })
        ids.push(JSON.parse(res.result).id)
    }
    return { ctx, state, ids }
}

await (async () => {
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', body: { success: true, totalEstimated: 30 } },
        { match: '/api/points/balance', method: 'GET', body: { success: true, available: 100 } },
    ])
    try {
        const { ctx, ids } = await makeImageCtx(['镜头一', '镜头二', '镜头三'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(res.ok === true, `余额充足应通过，实际：${res.summary}`)
        assert(!parsed.findings.some((f) => String(f.code).startsWith('quota.')), '余额充足不该报配额问题')
        assert(parsed.validators.includes('quota'), '配额校验器应参与本次校验')
        assert(res.details?.quotaCheck?.status === 'checked', `埋点应为 checked：${JSON.stringify(res.details)}`)
        assert(res.details.quotaCheck.available === 100 && res.details.quotaCheck.totalEstimated === 30, '埋点应带 available/totalEstimated')
        passed += 1
        console.log('  ok   余额充足：预校验通过、配额已校验（checked 且带数字）')
    } finally { restore() }
})()

await (async () => {
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', body: { success: true, totalEstimated: 30 } },
        { match: '/api/points/balance', method: 'GET', body: { success: true, available: 5 } },
    ])
    try {
        const { ctx, ids } = await makeImageCtx(['镜头一', '镜头二', '镜头三'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(res.ok === false, '余额不足应被拦下')
        const quotaHit = parsed.findings.find((f) => f.code === 'quota.insufficient_for_batch')
        assert(quotaHit, `应给出整批配额不足：${JSON.stringify(parsed.findings)}`)
        assert(quotaHit.message.includes('30') && quotaHit.message.includes('5'), `要说清预估与现状：${quotaHit.message}`)
        assert(quotaHit.hint.includes('充值') && quotaHit.hint.includes('节点'), `修复信号要可执行：${quotaHit.hint}`)
        assert(res.details?.quotaCheck?.status === 'checked', '埋点应为 checked')
        passed += 1
        console.log('  ok   余额不足：拦下并给出「预估 X / 当前 Y / 可减少节点或充值」')
    } finally { restore() }
})()

await (async () => {
    // 预估接口 404 → 降级；同时留一个空提示词节点，验证「配额跳过了，其余规则照常」
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', ok: false, status: 404, body: { success: false } },
        { match: '/api/points/balance', method: 'GET', body: { success: true, available: 999 } },
    ])
    try {
        const { ctx, ids } = await makeImageCtx(['正常镜头', '', '正常镜头三'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(!parsed.findings.some((f) => String(f.code).startsWith('quota.')), '拿不到预估就不该报配额问题')
        assert(parsed.findings.some((f) => f.code === 'prompt.empty'), '其余校验规则必须照常执行（空提示词要被抓到）')
        assert(res.details?.quotaCheck?.status === 'skipped', '埋点应为 skipped')
        assert(res.details.quotaCheck.reason.includes('estimate_api_error'), `跳过原因应指向预估接口：${res.details.quotaCheck.reason}`)
        passed += 1
        console.log('  ok   预估接口失败：配额静默跳过、其余规则照常（埋点 skipped/estimate_api_error）')
    } finally { restore() }
})()

await (async () => {
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', body: { success: true, totalEstimated: 30 } },
        { match: '/api/points/balance', method: 'GET', throw: true },
    ])
    try {
        const { ctx, ids } = await makeImageCtx(['正常镜头', '正常镜头二'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(!parsed.findings.some((f) => String(f.code).startsWith('quota.')), '拿不到余额就不该报配额问题')
        assert(res.details?.quotaCheck?.reason.includes('balance_api_error'), `跳过原因应指向余额接口：${res.details.quotaCheck.reason}`)
        passed += 1
        console.log('  ok   余额接口失败：配额静默跳过（埋点 skipped/balance_api_error）')
    } finally { restore() }
})()

await (async () => {
    // 两个接口都失败 → 报告里不含配额事实；run_nodes 的运行期 gate 不该因此误拦
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', ok: false, status: 500, body: { success: false } },
        { match: '/api/points/balance', method: 'GET', ok: false, status: 500, body: { success: false } },
    ])
    try {
        const { ctx, state, ids } = await makeImageCtx(['镜头一', '镜头二'])
        const pre = await run(ctx, 'preflight_check', { ids })
        assert(pre.ok === true, `降级且无其它问题时预校验应通过：${pre.summary}`)
        assert(pre.details.quotaCheck.status === 'skipped', '应为降级跳过')
        const ran = await run(ctx, 'run_nodes', { ids })
        assert(ran.ok === true, `降级后 run_nodes 不该被配额误拦：${ran.result}`)
        assert(state.ran.length === ids.length, '批量执行应真的触发了')
        passed += 1
        console.log('  ok   降级只影响配额这一条：run_nodes 照常执行')
    } finally { restore() }
})()

console.log('== run_nodes：逐节点提交回执 + 整批重复如实跳过（要带预校验报告才能跑）==')
await (async () => {
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', body: { success: true, totalEstimated: 30 } },
        { match: '/api/points/balance', method: 'GET', body: { success: true, available: 100 } },
    ])
    try {
        const { ctx, state, ids } = await makeImageCtx(['镜一', '镜二', '镜三'])
        const pre = await run(ctx, 'preflight_check', { ids })
        assert(pre.ok === true, `预校验应通过：${pre.summary}`)

        const res = await run(ctx, 'run_nodes', { ids })
        assert(res.ok, `批量提交应成功：${res.summary}`)
        const parsed = JSON.parse(res.result)
        assert(parsed.submitted === 3 && parsed.total === 3, `批量回执计数不对：${res.result}`)
        assert(parsed.nodes.every((node) => node.status === 'generating'), `每个节点都应是已提交/生成中：${res.result}`)
        assert(/已提交/.test(res.summary) && !/已完成|已出图/.test(res.summary), `批量摘要要说「已提交 · 生成中」：${res.summary}`)
        assert(state.ran.length === 3, '批量应真的提交 3 个节点')

        // 整批重复提交：全部如实回 skipped，且不再触发（不重复扣费）
        const again = await run(ctx, 'run_nodes', { ids })
        assert(!again.ok, '整批重复提交应失败（没有新提交）')
        const againParsed = JSON.parse(again.result)
        assert(
            againParsed.submitted === 0 && againParsed.nodes.every((node) => node.status === 'skipped'),
            `整批重复应如实 skipped：${again.result}`,
        )
        assert(state.ran.length === 3, `重复批量不得再触发，实际 ${state.ran.length}`)
        passed += 1
        console.log('  ok   run_nodes：逐节点提交状态 + 整批重复如实跳过')
    } finally { restore() }
})()

console.log('== ask_user：关键信息不足时提问（同一轮里等答复，不把委托拆成好几轮）==')
await (async () => {
    const { ctx } = createFakeContext()
    const res = await run(ctx, 'ask_user', {})
    assert(!res.ok, '没有任何问题时应失败')
    assert(res.result.includes('question'), `失败原因要可读（模型据此改正）：${res.result}`)
    passed += 1
    console.log('  ok   ask_user 没问题 → 失败且原因可读')
})()

await (async () => {
    const { ctx } = createFakeContext()
    let asked = null
    ctx.askUser = async (request) => {
        asked = request
        return { answers: request.questions.map((item) => ({ question: item.question, answer: '随便' })) }
    }
    const res = await run(ctx, 'ask_user', {
        questions: [
            { question: '要做什么产品？' },
            { question: '成片还是单张？' },
            { question: '大概多少镜头？' },
            { question: '给谁用？' },
        ],
    })
    assert(res.ok, `应成功：${res.summary}`)
    assert(asked.questions.length === 3, `最多问 3 个，实际问出 ${asked.questions.length} 个`)
    assert(res.summary.includes('3'), `摘要应说清实际问了几问：${res.summary}`)
    passed += 1
    console.log('  ok   问题超过 3 个 → 截断到 3 个（摘要里说明）')
})()

await (async () => {
    const { ctx } = createFakeContext()
    const answers = [
        { question: '要做什么产品？', answer: '保温杯' },
        { question: '成片还是单张？', answer: '单张' },
    ]
    ctx.askUser = async () => ({ answers })
    const res = await run(ctx, 'ask_user', {
        context: '先确认目标与产物',
        questions: [
            { question: '要做什么产品？', options: ['保温杯', '耳机'] },
            { question: '成片还是单张？', options: ['成片', '单张'] },
        ],
    })
    assert(res.ok, '正常调用应成功')
    const parsed = JSON.parse(res.result)
    assert(parsed.answered === true, `回执必须是 JSON 且 answered:true：${res.result}`)
    assert(
        JSON.stringify(parsed.answers) === JSON.stringify(answers),
        `回执里的 answers 应与注入回调的返回值一致：${res.result}`,
    )
    passed += 1
    console.log('  ok   ask_user 正常调用 → JSON 回执、answers 与注入回调一致')
})()

await (async () => {
    const { ctx } = createFakeContext()
    const res = await run(ctx, 'ask_user', { questions: [{ question: '要做什么产品？' }] })
    assert(!res.ok, '没注入 askUser 必须明确失败 —— 绝不能静默「当作用户已答」')
    assert(res.result.includes('不支持'), `失败原因要说明当前环境不支持提问：${res.result}`)
    passed += 1
    console.log('  ok   没注入 askUser → 明确失败（不当作已答）')
})()

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
