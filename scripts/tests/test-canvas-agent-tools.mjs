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
            // 必须分开给 prompt/content 与参考图/出图地址：预校验按节点类型分派字段，
            // 只给合并后的 text 会把有提示词的节点误报成「没有提示词」。
            prompt: node.prompt, content: node.content,
            model: node.model, size: node.size, quality: node.quality, status: node.status,
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

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
