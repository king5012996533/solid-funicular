#!/usr/bin/env node
/**
 * 批量预校验的单测（纯函数，零 IO）。
 *
 * 除了逐条校验规则，这里有一个**架构性断言**：自定义校验器（模拟 ② 的多模态母版校验）
 * 能在不改动 runCanvasPipelineValidation 一行代码的前提下挂进来。这条如果失败，
 * 说明 ③ 做完之后 ② 还得回来开洞重写 —— 那正是这次设计要避免的事。
 *
 * 跑法：npx tsx scripts/tests/test-canvas-pipeline-validation.mjs
 */
import {
  DEFAULT_CANVAS_VALIDATORS,
  verifyPreflightReport,
  runCanvasPipelineValidation,
} from '../../src/shared/canvas-pipeline-validation.ts'

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

const node = (over) => ({ id: 'n1', type: 'image', prompt: '写实电影感，女孩站在便利店门口', ...over })
const codes = (report) => report.findings.map((item) => item.code)

console.log('== 提示词 ==')

check('空提示词 → error（空跑一次就是白花钱）', () => {
  const report = runCanvasPipelineValidation({ targets: [node({ prompt: '' })], allNodes: [], edges: [], context: {} })
  assert(codes(report).includes('prompt.empty'), `应报 prompt.empty，实际 ${JSON.stringify(codes(report))}`)
  assert(report.runnable === false, 'error 存在时 runnable 必须为 false')
})

check('超长提示词 → error，并给出上限', () => {
  const report = runCanvasPipelineValidation({ targets: [node({ prompt: 'x'.repeat(4001) })], allNodes: [], edges: [], context: {} })
  const hit = report.findings.find((item) => item.code === 'prompt.too_long')
  assert(hit, '应报 prompt.too_long')
  assert(hit.message.includes('4000'), '文案里要说清上限')
})

check('未替换的占位符 → error（拼接提示词漏填的典型症状）', () => {
  const report = runCanvasPipelineValidation({ targets: [node({ prompt: '主角是{{character}}，站在{{scene}}' })], allNodes: [], edges: [], context: {} })
  assert(codes(report).includes('prompt.unresolved_placeholder'), '应报占位符未替换')
})

check('视频节点同样按提示词校验（不是只管图片）', () => {
  const report = runCanvasPipelineValidation({ targets: [node({ type: 'video', prompt: '' })], allNodes: [], edges: [], context: {} })
  assert(codes(report).includes('prompt.empty'), '视频空提示词也要拦')
})

console.log('\n== 继承链（参数层面能抓到的「人物崩坏」）==')

check('分镜连了母版却没挂参考图 → error', () => {
  const master = node({ id: 'm1', imageUrl: '/uploads/master.png' })
  const shot = node({ id: 's1', referenceImages: [] })
  const report = runCanvasPipelineValidation({
    targets: [shot], allNodes: [master, shot], edges: [{ source: 'm1', target: 's1' }], context: {},
  })
  assert(codes(report).includes('inheritance.no_reference'), '应报未挂参考图')
})

check('挂了参考图、但母版还没出图 → error', () => {
  const master = node({ id: 'm1', imageUrl: '' })
  const shot = node({ id: 's1', referenceImages: ['/uploads/m1-no-image.png'] })
  const report = runCanvasPipelineValidation({
    targets: [shot], allNodes: [master, shot], edges: [{ source: 'm1', target: 's1' }], context: {},
  })
  assert(codes(report).includes('inheritance.master_not_generated'), '应报母版未出图')
})

check('母版已出图且参考图挂好 → 这一项通过', () => {
  const master = node({ id: 'm1', imageUrl: '/uploads/master.png' })
  const shot = node({ id: 's1', referenceImages: ['/uploads/master.png'] })
  const report = runCanvasPipelineValidation({
    targets: [shot], allNodes: [master, shot], edges: [{ source: 'm1', target: 's1' }], context: {},
  })
  assert(!codes(report).some((code) => code.startsWith('inheritance.')), `不该有继承问题：${JSON.stringify(codes(report))}`)
})

console.log('\n== 参考图可达性 / 配额 / 批量上限 ==')

check('参考图取不到 → error（母版图丢了）', () => {
  const shot = node({ referenceImages: ['/uploads/gone.png'] })
  const report = runCanvasPipelineValidation({
    targets: [shot], allNodes: [shot], edges: [], context: { referenceReachability: { '/uploads/gone.png': false } },
  })
  assert(codes(report).includes('reference.unreachable'), '应报参考图不可达')
})

check('拿不到余额时**不做**配额判断（不假装知道）', () => {
  const report = runCanvasPipelineValidation({ targets: [node({})], allNodes: [], edges: [], context: {} })
  assert(!codes(report).some((code) => code.startsWith('quota.')), '没给余额就不该报配额问题')
})

check('余额不够整批 → error，并说明需要多少', () => {
  const report = runCanvasPipelineValidation({
    targets: [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })],
    allNodes: [], edges: [], context: { availablePoints: 5, estimatedCostPerUnit: 3 },
  })
  const hit = report.findings.find((item) => item.code === 'quota.insufficient_for_batch')
  assert(hit, '应报整批配额不足')
  assert(hit.message.includes('9'), `要算清预计总额（3×3=9），实际：${hit.message}`)
})

check('超过单批上限 → error', () => {
  const targets = Array.from({ length: 5 }, (_, index) => node({ id: `n${index}` }))
  const report = runCanvasPipelineValidation({ targets, allNodes: [], edges: [], context: { maxBatchSize: 3 } })
  assert(codes(report).includes('batch.too_large'), '应报批次过大')
})

check('blockedNodeIds 只列有问题的节点（据此只重跑没问题的那些）', () => {
  const good = node({ id: 'good' })
  const bad = node({ id: 'bad', prompt: '' })
  const report = runCanvasPipelineValidation({ targets: [good, bad], allNodes: [], edges: [], context: {} })
  assert(report.blockedNodeIds.length === 1 && report.blockedNodeIds[0] === 'bad', `blockedNodeIds 不对：${JSON.stringify(report.blockedNodeIds)}`)
  assert(report.runnable === false, '有阻塞节点时不能开跑')
})

console.log('\n== 架构断言：② 的校验器能挂进来而不改流程 ==')

check('注册一个「需要看图」的校验器即可生效，流程代码零改动', () => {
  // 模拟风险② 的母版图校验：看图判定人物是否崩坏（这里用假实现，只验插拔能力）
  const visionValidator = {
    key: 'vision_master_quality',
    label: '母版图质量（多模态）',
    requiresVision: true,
    validate: (target) => (target.imageUrl === '/uploads/broken.png'
      ? [{ level: 'error', code: 'vision.subject_broken', message: '母版图人物主体崩坏', hint: '重新生成母版', nodeId: target.id }]
      : []),
  }

  const shot = node({ id: 's1', imageUrl: '/uploads/broken.png' })
  const report = runCanvasPipelineValidation({
    targets: [shot], allNodes: [shot], edges: [], context: {}, validators: [...DEFAULT_CANVAS_VALIDATORS, visionValidator],
  })

  assert(report.validators.includes('vision_master_quality'), '自定义校验器应出现在报告的 validators 里')
  assert(codes(report).includes('vision.subject_broken'), '自定义校验器的结论应进入报告')
  assert(report.runnable === false, '多模态校验发现问题后同样应拦住这一批')

  // 同一个节点、不带这个校验器时应当通过 —— 证明它是「挂上去才生效」，而不是被写死在流程里
  const withoutVision = runCanvasPipelineValidation({ targets: [shot], allNodes: [shot], edges: [], context: {} })
  assert(!codes(withoutVision).includes('vision.subject_broken'), '不挂校验器时不该出现该结论')
})

console.log('\n== 报告时效（外部事实会变，不能只看「报告存在」）==')

const now = 1_800_000_000_000
const report = (over = {}) => ({
  reportId: 'pf_1',
  workflowId: 'wf_1',
  nodeIds: ['s1', 's2'],
  createdAt: now - 1000,
  expiresAt: now + 60_000,
  facts: { availablePoints: 100, reachableReferences: ['/uploads/master.png'], estimatedCost: 30 },
  ...over,
})
const verify = (over = {}, current = {}) => verifyPreflightReport({
  report: report(over.report), workflowId: over.workflowId ?? 'wf_1', nodeIds: over.nodeIds ?? ['s1'], current, now,
})

check('有效报告 → 通过', () => {
  const result = verify()
  assert(result.ok === true, `应通过，实际 ${JSON.stringify(result)}`)
})

check('没有报告 → 拒绝，并告诉它去调 preflight_check', () => {
  const result = verifyPreflightReport({ report: null, workflowId: 'wf_1', nodeIds: ['s1'], current: {}, now })
  assert(result.ok === false && result.code === 'missing', '应报 missing')
  assert(result.hint.includes('preflight_check'), '修复信号要指向具体动作')
})

check('报告过期 → 拒绝（余额和参考图可能在这期间变了）', () => {
  const result = verify({ report: { expiresAt: now - 1 } })
  assert(result.ok === false && result.code === 'expired', `应报 expired，实际 ${JSON.stringify(result)}`)
})

check('拿旧报告跑新节点 → 拒绝（不能少校验几个就跑）', () => {
  const result = verify({ nodeIds: ['s1', 's9'] })
  assert(result.ok === false && result.code === 'nodes_not_covered', '应报 nodes_not_covered')
  assert(result.reason.includes('s9'), '要说清是哪个节点没被覆盖')
})

check('余额在预校验之后被吃掉 → 拒绝，并说清差多少', () => {
  const result = verify({}, { availablePoints: 10 })
  assert(result.ok === false && result.code === 'cost_changed', '应报 cost_changed')
  assert(result.reason.includes('10') && result.reason.includes('30'), `要说清现状与需要：${result.reason}`)
})

check('报告里没查过配额（降级）→ 运行期不按配额误拦', () => {
  // 降级时 facts 里不放 availablePoints：运行期复核不能拿「没查过」当「当时够钱」，更不能反过来误拦
  const result = verify({ report: { facts: { reachableReferences: [] } } }, { availablePoints: 0 })
  assert(result.ok === true, `降级报告不该被配额误拦，实际 ${JSON.stringify(result)}`)
})

check('参考图在预校验之后被删 → 拒绝（这是「人物崩坏」最常见的来源）', () => {
  const result = verify({}, { unreachableReferences: ['/uploads/master.png'] })
  assert(result.ok === false && result.code === 'reference_lost', '应报 reference_lost')
  assert(result.hint.includes('重新生成母版') || result.hint.includes('重新挂图'), '修复信号要具体')
})

check('报告属于别的画布 → 拒绝', () => {
  const result = verify({ workflowId: 'wf_OTHER' })
  assert(result.ok === false && result.code === 'workflow_mismatch', '应报 workflow_mismatch')
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
