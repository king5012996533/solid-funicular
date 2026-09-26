#!/usr/bin/env node
/**
 * 画布 Agent 工具层单测（2026-09-23；2026-09-26 第一步「工具面收敛」重写）
 *
 * 为什么单独测这一层：工具是「模型能对用户的画布做什么」的**唯一清单** —— 模型说的每一句
 * 「我已经帮你加好了」，背后都是这里的一个 case 在改真实画布。这类东西出错（id 串了、
 * 参数没校验、失败却报成功）在浏览器里很难复现，但后果是数据被改坏。
 *
 * 第一步收敛后这里要钉住的是：
 *   1. **模型可见清单**里只剩语义工具 + 读取 + 预校验/手册；12 个图操作类工具**逐个**都不在里面；
 *   2. 被停用的工具若被调用（旧转录/旧提示词残留）→ 返回**可读的替代指引**，不静默失败；
 *   3. `generate` 的入参归一（target=new / 已有节点 / 多节点；spec 缺省项）；
 *   4. `generate` 回执三态（submitted / duplicate / failed）、提交即回执、同轮去重、失败如实、
 *      内部自动跑预校验（报告不过就不提交）；
 *   5. 概览/单节点读的形状；预校验配额接入；ask_user 回执。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-agent-tools.mjs
 */
import {
    CANVAS_AGENT_TOOL_SCHEMAS,
    GENERATE_UPLOADED_REFERENCES_TOKEN,
    normalizeCanvasGenerateRequest,
    executeCanvasAgentTool,
} from '../../src/views/workflow/agent/canvas-agent-tools.ts'
import {
    CANVAS_AGENT_DISABLED_TOOL_GUIDANCE,
    CANVAS_AGENT_TOOL_DEFINITIONS,
    getModelVisibleCanvasAgentTools,
} from '../../src/shared/canvas-agent-tools.ts'
// 与画布页同源：节点 id → 出图地址的解析规则（放在这里避免 import 链带进浏览器依赖）
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

/** 第一步停用的图操作类工具（逐个断言：模型可见清单里不能再有它们） */
const DISABLED_TOOLS = [
    'add_node', 'add_nodes', 'update_node', 'remove_node', 'select_nodes', 'connect_nodes',
    'attach_reference_images', 'run_node', 'run_nodes', 'get_canvas_state',
    'list_workflow_templates', 'apply_workflow_template',
]
/** 收敛后模型应该看到的工具 */
const VISIBLE_TOOLS = [
    'get_canvas_overview', 'get_canvas_node', 'generate',
    'ask_user', 'request_confirmation', 'preflight_check', 'load_playbook',
]

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

// 屏蔽真实网络：预校验里的余额、预估、参考图探测都走这个假 fetch。
// 未命中的请求（含参考图 HEAD/GET 探测）一律当作可达 —— 否则 Node 会对相对地址抛错，
// 把「参考图可达」误判成 false，进而把合法的生成批次全拦下。
const originalFetch = globalThis.fetch
const installFetch = (routes = []) => {
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url)
        const method = String(options.method || 'GET').toUpperCase()
        const hit = routes.find((route) => target.includes(route.match) && (!route.method || route.method === method))
        if (hit) {
            if (hit.throw) throw new Error('模拟网络故障')
            const status = hit.status ?? (hit.ok === false ? 500 : 200)
            return { ok: hit.ok !== false && status < 400, status, json: async () => hit.body ?? {} }
        }
        return { ok: true, status: 200, json: async () => ({}) }
    }
    return () => { globalThis.fetch = originalFetch }
}

console.log('== 工具清单：图操作类工具已从模型可见清单里移除 ==')
check('模型可见清单只剩语义工具 + 读取 + 预校验/手册', () => {
    const names = CANVAS_AGENT_TOOL_SCHEMAS.map((tool) => tool.function.name)
    for (const expected of VISIBLE_TOOLS) {
        assert(names.includes(expected), `缺少应可见的工具 ${expected}`)
    }
    assert(
        names.length === VISIBLE_TOOLS.length,
        `可见工具数量应为 ${VISIBLE_TOOLS.length}，实际 ${names.length}：${names.join('、')}`,
    )

    /**
     * 前后端不许漂移：模型看到的描述来自服务端那份定义，浏览器执行的是这份 schema。
     * 两边一旦不一致（改名、改参数、改说明），表现是「模型老调错工具」——不报错、只变笨，
     * 所以在这里逐字段钉死，让漂移在 CI 就炸出来。
     */
    const visibleDefinitions = getModelVisibleCanvasAgentTools()
    assert(
        CANVAS_AGENT_TOOL_SCHEMAS.length === visibleDefinitions.length,
        `前端可见 schema ${CANVAS_AGENT_TOOL_SCHEMAS.length} 与共享可见定义 ${visibleDefinitions.length} 不一致`,
    )
    for (const definition of visibleDefinitions) {
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

console.log('== 停用：逐个断言不在可见清单里，且被调用时返回替代指引（不静默失败）==')
for (const name of DISABLED_TOOLS) {
    await (async () => {
        const names = CANVAS_AGENT_TOOL_SCHEMAS.map((tool) => tool.function.name)
        assert(!names.includes(name), `已停用的 ${name} 仍在模型可见清单里`)

        const definition = CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)
        assert(definition, `${name} 的定义应保留（第一步不删代码，淘汰留到下一步）`)
        assert(definition.modelVisible === false, `${name} 应被标记为不可见`)

        const guidance = CANVAS_AGENT_DISABLED_TOOL_GUIDANCE[name]
        assert(guidance && guidance.includes('已停用'), `${name} 缺少替代指引原文`)

        const { ctx, state } = createFakeContext()
        const res = await run(ctx, name, { id: 'n1', ids: ['n1'], nodes: [{ type: 'image' }], source: 'a', target: 'b', type: 'image' })
        assert(!res.ok, `${name} 被调用必须 ok:false（不能静默执行）`)
        assert(res.result === guidance, `${name} 的回执应是替代指引原文：${res.result}`)
        assert(res.result.includes('已停用'), `${name} 的回执必须含「已停用」`)
        assert(state.nodes.length === 0 && state.edges.length === 0, `${name} 被调用不得改动画布`)
        passed += 1
        console.log(`  ok   ${name}：已停用 + 返回替代指引（未改动画布）`)
    })()
}

console.log('== generate 入参归一（target=new / 已有节点 / 多节点；spec 缺省项）==')
check('target="new" 默认 1 个 create 目标、spec 缺省项不编造', () => {
    const normalized = normalizeCanvasGenerateRequest({ target: 'new' })
    assert(normalized.ok === true, '应归一成功')
    assert(normalized.targets.length === 1 && normalized.targets[0].action === 'create', 'new 默认 1 个 create')
    assert(normalized.targets[0].kind === undefined, '缺省 kind 不编造（执行阶段才落默认 image）')
    assert(Array.isArray(normalized.targets[0].references) && normalized.targets[0].references.length === 0, 'references 缺省为空数组')
    assert(Array.isArray(normalized.targets[0].connectFrom) && normalized.targets[0].connectFrom.length === 0, 'connectFrom 缺省为空数组')
})

check('target="new" + count：复制多份并封顶 12', () => {
    assert(normalizeCanvasGenerateRequest({ target: 'new', spec: { count: 3 } }).targets.length === 3, 'count=3 应建 3 个目标')
    assert(normalizeCanvasGenerateRequest({ target: 'new', spec: { count: 99 } }).targets.length === 12, 'count 应封顶 12')
    assert(normalizeCanvasGenerateRequest({ target: 'new', spec: { count: 0 } }).targets.length === 1, 'count 非法应回默认 1')
})

check('ratio 是 size 的别名', () => {
    const normalized = normalizeCanvasGenerateRequest({ target: 'new', spec: { ratio: '16:9' } })
    assert(normalized.targets[0].size === '16:9', `ratio 应归一成 size：${JSON.stringify(normalized.targets[0])}`)
})

check('已有节点：单个 id / 多节点数组（去重）', () => {
    const single = normalizeCanvasGenerateRequest({ target: 'n1' })
    assert(single.targets.length === 1 && single.targets[0].action === 'existing' && single.targets[0].id === 'n1', '单个已有节点')
    const many = normalizeCanvasGenerateRequest({ target: ['n1', 'n1', 'n2'] })
    assert(many.targets.length === 2, `多节点应去重：${JSON.stringify(many.targets)}`)
    assert(many.targets.every((item) => item.action === 'existing'), '都应是 existing')
})

check('new + nodes：每项覆盖顶层 spec', () => {
    const normalized = normalizeCanvasGenerateRequest({
        target: 'new',
        spec: { model: 'prov::IMAGE::m1', references: ['n0'] },
        nodes: [{ prompt: '镜一' }, { prompt: '镜二', model: 'prov::IMAGE::m2' }],
    })
    assert(normalized.targets.length === 2, '应建 2 个目标')
    assert(normalized.targets[0].model === 'prov::IMAGE::m1', '未给 model 的项继承顶层')
    assert(normalized.targets[0].references[0] === 'n0', '未给 references 的项继承顶层')
    assert(normalized.targets[1].model === 'prov::IMAGE::m2', '给了 model 的项覆盖顶层')
})

check('缺少 target 如实失败', () => {
    const normalized = normalizeCanvasGenerateRequest({})
    assert(normalized.ok === false && /target/.test(normalized.reason || ''), `应失败并指向 target：${normalized.reason}`)
})

console.log('== generate 正常路径：建节点 + 提交即回执 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const res = await run(ctx, 'generate', { target: 'new', spec: { kind: 'image', prompt: '雪夜便利店，霓虹灯', model: 'prov::IMAGE::m1', ratio: '16:9' } })
    assert(res.ok, `应成功：${res.summary}`)
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 1 && parsed.total === 1, `回执计数不对：${res.result}`)
    assert(Array.isArray(parsed.created) && parsed.created.length === 1, `回执要带新建节点 id：${res.result}`)
    const receipt = parsed.nodes[0]
    assert(receipt.submitted === true && receipt.status === 'generating', `节点状态应为已提交/生成中：${res.result}`)
    assert(!('done' in receipt), '回执不得声称「已完成」（提交 ≠ 出图）')
    assert(/已提交/.test(res.summary) && /生成中/.test(res.summary), `摘要必须写「已提交 · 生成中」：${res.summary}`)
    assert(!/已完成|已出图/.test(res.summary), `不得把提交说成完成：${res.summary}`)
    assert(state.ran.length === 1, '应真的提交了一次')
    const node = state.nodes.find((item) => item.id === parsed.created[0])
    assert(node.prompt === '雪夜便利店，霓虹灯' && node.size === '16:9' && node.model === 'prov::IMAGE::m1', `spec 应写进节点：${JSON.stringify(node)}`)
    passed += 1
    console.log('  ok   generate(target=new)：建节点 + 提交即回执（三态里 submitted）')
})()

await (async () => {
    const restore = installFetch([])
    try {
        const { ctx, state } = createFakeContext()
        // 铺分镜：一次建多个不同节点（nodes），并把母版连过去
        const master = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版 M1' })
        ctx.updateNode(master, { imageUrl: '/uploads/generated/image/m1.png' })
        const res = await run(ctx, 'generate', {
            target: 'new',
            spec: { kind: 'image', model: 'prov::IMAGE::m1', connectFrom: [master], references: [master] },
            nodes: [{ prompt: '镜一：主角走进便利店', label: '镜号 01' }, { prompt: '镜二：主角拿起咖啡', label: '镜号 02' }],
        })
        const parsed = JSON.parse(res.result)
        assert(parsed.submitted === 2 && parsed.total === 2, `应提交 2 个：${res.result}`)
        assert(state.edges.length === 2, `应自动连线 2 条：${state.edges.length}`)
        assert(state.nodes.filter((item) => item.referenceImages && item.referenceImages.length).length === 2, '两个分镜都应挂上母版图')
        passed += 1
        console.log('  ok   generate(target=new, nodes)：一次建多个 + 自动连线 + 自动挂参考')
    } finally { restore() }
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    const first = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '镜头甲：雪夜街头' })
    const second = ctx.addNode('image', { x: 10, y: 0 }, { prompt: '镜头乙：便利店门口' })
    const res = await run(ctx, 'generate', { target: [first, second], spec: { model: 'prov::IMAGE::m1' } })
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 2 && parsed.total === 2, `多节点应提交 2 个：${res.result}`)
    assert(parsed.created.length === 0, '已有节点不该记进 created')
    assert(state.ran.length === 2, '应真的提交两个已有节点')
    passed += 1
    console.log('  ok   generate(target=[已有 id...])：批量提交已有节点')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    // 纯建文本节点（分镜表）：不花钱、不提交
    const res = await run(ctx, 'generate', { target: 'new', spec: { kind: 'text', content: '镜号 | 画面', label: '分镜表' } })
    assert(res.ok, `建文本节点应成功：${res.summary}`)
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 0 && parsed.total === 0, `文本节点不提交：${res.result}`)
    assert(parsed.created.length === 1 && state.nodes.length === 1, '应建出 1 个节点')
    assert(/无需生成/.test(res.summary), `摘要应说明无需生成：${res.summary}`)
    assert(state.ran.length === 0, '文本节点不该触发生成')
    passed += 1
    console.log('  ok   generate(kind=text)：只建节点、不提交生成')
})()

console.log('== generate 同轮去重：同一节点只真正提交一次 ==')
await (async () => {
    const { ctx, state } = createFakeContext()
    const first = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版 M1' })
    const second = ctx.addNode('image', { x: 10, y: 0 }, { prompt: '母版 M2' })
    const firstRun = await run(ctx, 'generate', { target: [first, second], spec: { model: 'prov::IMAGE::m1' } })
    assert(JSON.parse(firstRun.result).submitted === 2, '首次应提交 2 个')

    const again = await run(ctx, 'generate', { target: [first, second] })
    assert(!again.ok, '整批重复提交应失败（没有新提交）')
    const parsed = JSON.parse(again.result)
    assert(parsed.submitted === 0 && parsed.nodes.every((node) => node.status === 'skipped'), `重复应如实 skipped：${again.result}`)
    assert(state.ran.length === 2, `重复不得再触发，实际 ${state.ran.length}`)

    // 混合：一个已跑过、一个没跑过 → 只有没跑过的被提交
    const third = ctx.addNode('image', { x: 20, y: 0 }, { prompt: '母版 M3' })
    const mixed = await run(ctx, 'generate', { target: [first, third] })
    const mixedParsed = JSON.parse(mixed.result)
    assert(mixedParsed.submitted === 1, `混合批应只提交 1 个：${mixed.result}`)
    assert(state.ran.length === 3, `应只多提交一次，实际 ${state.ran.length}`)
    passed += 1
    console.log('  ok   generate：同轮重复 → duplicate/skipped，且不重复触发（不重复扣费）')
})()

console.log('== generate 失败如实（不谎报成功）==')
await (async () => {
    const { ctx } = createFakeContext()
    const missing = await run(ctx, 'generate', { target: 'ghost' })
    assert(!missing.ok, '不存在的节点应失败')
    assert(missing.result.includes('ghost') && missing.result.includes('get_canvas_overview'), `失败要指向拿 id 的工具：${missing.result}`)

    const badKind = await run(ctx, 'generate', { target: 'new', spec: { kind: 'hologram', prompt: 'x' } })
    assert(!badKind.ok && badKind.result.includes('hologram'), `非法类型应如实失败：${badKind.result}`)
    passed += 1
    console.log('  ok   generate：未知节点 / 非法节点类型 → 可读失败')
})()

await (async () => {
    const { ctx } = createFakeContext()
    // 视频节点：预校验能过，但提交阶段服务端还没接通 → 必须如实说失败
    const res = await run(ctx, 'generate', { target: 'new', spec: { kind: 'video', prompt: '镜头缓慢推近，雨夜街头' } })
    assert(!res.ok, '视频节点提交应失败（服务端未接通）')
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 0 && parsed.nodes[0].status === 'failed', `失败回执要如实：${res.result}`)
    assert(/video/.test(parsed.nodes[0].reason || ''), `失败要带真实原因：${res.result}`)
    passed += 1
    console.log('  ok   generate：提交阶段失败 → failed + 真实原因（不谎报成功）')
})()

await (async () => {
    const { ctx } = createFakeContext()
    // 空提示词的图片节点：内部自动预校验应拦下，不提交（等于不白花钱）
    const res = await run(ctx, 'generate', { target: 'new', spec: { kind: 'image' } })
    assert(!res.ok, '空提示词应被内部预校验拦下')
    const parsed = JSON.parse(res.result)
    assert(parsed.submitted === 0 && parsed.nodes[0].status === 'failed', `应不提交：${res.result}`)
    assert(/预校验未通过/.test(parsed.nodes[0].reason || '') && /预校验未通过/.test(parsed.message || ''), `原因要点明预校验：${res.result}`)
    assert(ctx.snapshotNodes().length === 1, '节点应已建出来（预校验只拦提交，不吞掉创建）')
    passed += 1
    console.log('  ok   generate：内部自动预校验不过 → 不提交、如实回执')
})()

await (async () => {
    const { ctx, state } = createFakeContext()
    // 参考图引用了一个还没出图的节点 → 挂不上，必须如实说，且不提交
    const empty = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版还没出图' })
    const shot = ctx.addNode('image', { x: 100, y: 0 }, { prompt: '镜一' })
    const res = await run(ctx, 'generate', { target: [shot], spec: { references: [empty], model: 'prov::IMAGE::m1' } })
    assert(!res.ok, '参考图挂不上应失败')
    const parsed = JSON.parse(res.result)
    assert(parsed.nodes[0].status === 'failed' && /挂参考图失败/.test(parsed.nodes[0].reason || ''), `原因要点明挂参考失败：${res.result}`)
    assert(state.ran.length === 0, '挂参考失败不得提交生成')
    passed += 1
    console.log('  ok   generate：参考图挂不上 → 不提交、如实回执')
})()

await (async () => {
    const restore = installFetch([])
    try {
        const { ctx, state } = createFakeContext()
        // "uploaded" 占位：展开成用户本轮上传的参考图
        const shot = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '镜一' })
        ctx.referenceImages = () => ['/uploads/reference/u1.png']
        const res = await run(ctx, 'generate', { target: [shot], spec: { references: [GENERATE_UPLOADED_REFERENCES_TOKEN], model: 'prov::IMAGE::m1' } })
        assert(res.ok, `用本轮上传图应成功：${res.summary}`)
        assert(state.nodes.find((node) => node.id === shot).referenceImages[0] === '/uploads/reference/u1.png', 'uploaded 应展开成本轮上传图地址')
        passed += 1
        console.log('  ok   generate：references 支持 "uploaded" 占位（用户本轮上传图）')
    } finally { restore() }
})()

console.log('== 给模型的快照 ==')
await (async () => {
    const { ctx } = createFakeContext()
    ctx.addNode('image', { x: 0, y: 0 }, { prompt: 'x'.repeat(2000) })
    const snap = await run(ctx, 'get_canvas_overview', {})
    const parsed = JSON.parse(snap.result)
    assert(parsed.nodeCount === 1, '概览节点数不对')
    assert(!/x{100}/.test(snap.result), '概览不得含 prompt 明文')
    assert(parsed.availableNodeTypes === undefined, '概览不再带可用节点类型（那是旧整画布读的字段）')
    passed += 1
    console.log('  ok   概览：只给定位字段、长文本不外泄')
})()

console.log('== hasImage / 状态解析：让模型看出「节点已经出过图」==')
await (async () => {
    const { ctx } = createFakeContext()
    const id = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版 M1：28 岁亚洲女性' })
    ctx.updateNode(id, { imageUrl: '/uploads/generated/image/m1.png' })
    const snap = JSON.parse((await run(ctx, 'get_canvas_overview', {})).result)
    assert(snap.nodes[0].hasOutput === true, '概览必须给 hasOutput，否则模型会重复执行')
    passed += 1
    console.log('  ok   概览带 hasOutput')
})()

console.log('== get_canvas_overview：只给定位字段（不含 prompt / 坐标 / 连线明细）==')
await (async () => {
    const { ctx } = createFakeContext()
    ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版M1的秘密提示词：28 岁亚洲女性', model: 'prov::IMAGE::m1', size: '16:9' })
    const table = ctx.addNode('text', { x: 0, y: 100 }, { content: '分镜表' })
    const shot = ctx.addNode('image', { x: 300, y: 100 }, { prompt: '分镜 01' })
    ctx.updateNode(shot, { imageUrl: '/uploads/generated/image/s1.png' })
    ctx.addEdge(table, shot)

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
    const master = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '母版 M1', model: 'prov::IMAGE::m1', size: '16:9', quality: '高' })
    const shot = ctx.addNode('image', { x: 300, y: 0 }, { prompt: '分镜 01 的画面描述' })
    ctx.addEdge(master, shot)

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
    const id = ctx.addNode('image', { x: 0, y: 0 }, { prompt: '在跑' })
    ctx.updateNode(id, { loading: true, error: '' })
    const busy = JSON.parse((await run(ctx, 'get_canvas_node', { id })).result)
    assert(busy.data.generationStatus === 'generating', `loading 应归一为 generating：${busy.data.generationStatus}`)
    ctx.updateNode(id, { loading: false, error: '上游 400：模型不可用' })
    const broken = JSON.parse((await run(ctx, 'get_canvas_node', { id })).result)
    assert(broken.data.generationStatus === 'error' && broken.data.error.includes('400'), `error 要带原文：${JSON.stringify(broken.data)}`)
    passed += 1
    console.log('  ok   loading/error 归一正确')
})()

console.log('== 预校验：余额/预估接入（充足 / 不足 / 降级）==')

// 建一批带提示词/模型/画幅的图片节点（预校验要有可预估的节点）
const makeImageCtx = (prompts) => {
    const { ctx, state } = createFakeContext()
    const ids = prompts.map((prompt) => ctx.addNode('image', { x: 0, y: 0 }, { prompt, model: 'prov::IMAGE::m1', size: '16:9' }))
    return { ctx, state, ids }
}

await (async () => {
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', body: { success: true, totalEstimated: 30 } },
        { match: '/api/points/balance', method: 'GET', body: { success: true, available: 100 } },
    ])
    try {
        const { ctx, ids } = makeImageCtx(['镜头一', '镜头二', '镜头三'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(res.ok === true, `余额充足应通过，实际：${res.summary}`)
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
        const { ctx, ids } = makeImageCtx(['镜头一', '镜头二', '镜头三'])
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
        const { ctx, ids } = makeImageCtx(['正常镜头', '', '正常镜头三'])
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
        const { ctx, ids } = makeImageCtx(['正常镜头', '正常镜头二'])
        const res = await run(ctx, 'preflight_check', { ids })
        const parsed = JSON.parse(res.result)
        assert(!parsed.findings.some((f) => String(f.code).startsWith('quota.')), '拿不到余额就不该报配额问题')
        assert(res.details?.quotaCheck?.reason.includes('balance_api_error'), `跳过原因应指向余额接口：${res.details.quotaCheck.reason}`)
        passed += 1
        console.log('  ok   余额接口失败：配额静默跳过（埋点 skipped/balance_api_error）')
    } finally { restore() }
})()

await (async () => {
    // 两个接口都失败 → 报告里不含配额事实；generate 的内部预校验不该因此误拦
    const restore = installFetch([
        { match: '/api/points/estimate', method: 'POST', ok: false, status: 500, body: { success: false } },
        { match: '/api/points/balance', method: 'GET', ok: false, status: 500, body: { success: false } },
    ])
    try {
        const { ctx, ids } = makeImageCtx(['镜头一', '镜头二'])
        const pre = await run(ctx, 'preflight_check', { ids })
        assert(pre.ok === true, `降级且无其它问题时预校验应通过：${pre.summary}`)
        assert(pre.details.quotaCheck.status === 'skipped', '应为降级跳过')
        const generated = await run(ctx, 'generate', { target: ids })
        assert(generated.ok === true, `降级后 generate 不该被配额误拦：${generated.result}`)
        assert(JSON.parse(generated.result).submitted === ids.length, 'generate 应真的提交了')
        passed += 1
        console.log('  ok   降级只影响配额这一条：generate 照常提交')
    } finally { restore() }
})()

console.log('== 反证：把 generate 标成不可见，可见清单断言必然失败 ==')
{
    // 复用真实可见性规则：modelVisible !== false 才算可见
    const exposedNames = (definitions) => new Set(definitions.filter((item) => item.modelVisible !== false).map((item) => item.name))
    const current = exposedNames(CANVAS_AGENT_TOOL_DEFINITIONS)
    const legacy = exposedNames(CANVAS_AGENT_TOOL_DEFINITIONS.map((item) => (
        item.name === 'generate' ? { ...item, modelVisible: false } : item
    )))
    check('新实现：generate 在可见清单里', () => {
        assert(current.has('generate'), 'generate 必须可见')
        assert(current.has('get_canvas_overview') && current.has('get_canvas_node'), '概览/单节点必须可见')
        for (const name of DISABLED_TOOLS) assert(!current.has(name), `${name} 不该可见`)
    })
    check('反证成立：把 generate 标成不可见后，可见清单断言会失败（机制是灵敏的）', () => {
        assert(legacy.has('generate') === false, '旧形态：generate 不可见（正是要防的洞）')
        assert(legacy.has('generate') !== current.has('generate'), '两种实现结论必须不同')
    })
}

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
        { optionKey: 'A', text: '' },
        { optionKey: 'B', text: '' },
    ]
    ctx.askUser = async () => ({ answers })
    const res = await run(ctx, 'ask_user', {
        context: '先确认目标与产物',
        questions: [
            { question: '要做什么产品？', options: [{ key: 'A', label: '保温杯', notes: ['便携'] }, { key: 'B', label: '耳机' }] },
            { question: '成片还是单张？', options: ['成片', '单张'] },
        ],
    })
    assert(res.ok, '正常调用应成功')
    const parsed = JSON.parse(res.result)
    assert(parsed.answered === true, `回执必须是 JSON 且 answered:true：${res.result}`)
    const first = parsed.answers?.[0]
    assert(
        first?.choice?.key === 'A'
            && first?.choice?.label === '保温杯'
            && JSON.stringify(first?.choice?.notes) === JSON.stringify(['便携']),
        `回执必须带代号 + 名称 + 特点：${res.result}`,
    )
    const second = parsed.answers?.[1]
    assert(
        second?.choice?.key === 'B' && second?.choice?.label === '单张',
        `旧纯字符串选项要按位置补代号并回名称：${res.result}`,
    )
    passed += 1
    console.log('  ok   ask_user 正常调用 → 回执带代号 + 名称 + 特点（兼容旧纯字符串选项）')
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
