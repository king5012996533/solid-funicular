#!/usr/bin/env node
/**
 * 定价规则单测（纯函数，零 IO）。
 *
 * 这组用例要钉死的是「钱算得对不对」这件事上最容易出错的几处：
 *   · 视频时长 clamp 必须与上游实际收到的值一致（30 秒请求不能按别的数记账）
 *   · perTask 与 perImage 的语义差异（按次计费的渠道，一次出 10 张不能扣 10 倍）
 *   · 兜底绝不返回 0（静默白送是踩过的坑），且四种回落原因要分得清
 *   · 有档位但没标定匹配模式时**不许猜模式**
 *
 * 跑法：npx tsx scripts/tests/test-model-pricing-rules.mjs
 */
import {
  computeTierPoints,
  getGenerationCost,
  matchPricingTier,
  normalizeVideoSeconds,
  validateModelPricing,
} from '../../src/shared/model-pricing-rules.ts'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

const img = (over = {}) => ({ kind: 'image', count: 1, ...over })
const DRAFT = { perImage: 6 }

console.log('== 时长归一化（预估与扣费必须用同一个值）==')

check('30 秒会被 clamp 到 20 —— 这正是「按 20 秒记账、按 30 秒出片」的那个坑', () => {
  assert(normalizeVideoSeconds(30) === 20, `应 clamp 到 20，实际 ${normalizeVideoSeconds(30)}`)
})
check('0 / 负数 / 非法值 → 保底 1 秒（不产生 0 或负价）', () => {
  assert(normalizeVideoSeconds(0) === 1 && normalizeVideoSeconds(-5) === 1, '应保底 1')
  assert(normalizeVideoSeconds(Number.NaN) === 1, 'NaN 应保底 1')
})
check('范围内的值原样通过', () => {
  assert(normalizeVideoSeconds(8) === 8, '8 秒不该被改')
})

console.log('\n== 档位匹配（同名模型不同渠道，匹配方式不同）==')

const noneSpec = { matchMode: 'none', tiers: [{ resolutionLabel: '每次请求', price: { perTask: 6 } }] }
check('none 模式：一口价，取第一个档位', () => {
  assert(matchPricingTier(noneSpec, img())?.resolutionLabel === '每次请求', '应命中唯一档位')
})

const labelSpec = { matchMode: 'label', labelAxis: 'quality', tiers: [
  { resolutionLabel: '草稿', upstreamLabel: 'low', price: { perImage: 1 } },
  { resolutionLabel: '高', upstreamLabel: 'high', price: { perImage: 5 } },
] }
check('label 模式：按上游枚举命中（quality=high）', () => {
  assert(matchPricingTier(labelSpec, img({ label: 'high' }))?.resolutionLabel === '高', '应命中 high 档')
})
check('label 模式：枚举值不认识时返回 null（交给兜底，而不是猜一个价）', () => {
  assert(matchPricingTier(labelSpec, img({ label: 'xhigh' })) === null, '不认识的 label 必须 miss')
})

const edgeSpec = { matchMode: 'longEdge', tiers: [
  { resolutionLabel: '1K', edgeMin: 0, edgeMax: 1280, price: { perImage: 1 } },
  { resolutionLabel: '2K', edgeMin: 1281, edgeMax: 2048, price: { perImage: 2.5 } },
] }
check('longEdge 模式：2048×1152 按长边归到 2K（这正是选长边判定的理由）', () => {
  assert(matchPricingTier(edgeSpec, img({ width: 2048, height: 1152 }))?.resolutionLabel === '2K', '长边 2048 应归 2K')
})
const shortEdgeSpec = { matchMode: 'shortEdge', tiers: [
  { resolutionLabel: '720p', edgeMin: 0, edgeMax: 720, price: { perSecond: 0.2 } },
  { resolutionLabel: '1080p', edgeMin: 721, edgeMax: 1080, price: { perSecond: 0.4 } },
] }
check('shortEdge 模式：竖屏 1080×1920 归 1080p 档（短边判定，竖屏短剧不会被漏到兜底）', () => {
  assert(matchPricingTier(shortEdgeSpec, img({ width: 1080, height: 1920 }))?.resolutionLabel === '1080p', '短边 1080 应归 1080p')
})
check('shortEdge 模式：短边超出所有档位 → miss（宁可走兜底告警，也不塞进最接近的档）', () => {
  assert(matchPricingTier(shortEdgeSpec, img({ width: 3840, height: 2160 })) === null, '2160 短边超出 1080 上限，必须 miss')
})

console.log('\n== 计价单位语义 ==')

check('perTask 按次：一次出 10 张仍是 6 分（按张算就会多扣 10 倍）', () => {
  assert(computeTierPoints({ perTask: 6 }, img({ count: 10 })) === 6, 'perTask 不应随张数变化')
})
check('perImage 按张：3 张 = 单价×3', () => {
  assert(computeTierPoints({ perImage: 2 }, img({ count: 3 })) === 6, '应 6 分')
})
check('perSecond 按秒：minSeconds 保底 + baseFee 起步费', () => {
  const points = computeTierPoints({ perSecond: 2, minSeconds: 5, baseFee: 1 }, { kind: 'video', seconds: 3 })
  assert(points === 1 + 2 * 5, `应按保底 5 秒算（1+10），实际 ${points}`)
})
check('小数向上取整（宁可略高，不白送）', () => {
  assert(computeTierPoints({ perImage: 1.2 }, img({ count: 1 })) === 2, '应向上取整为 2')
})

console.log('\n== 统一入口的兜底（一律不返回 0）==')

check('读取配置失败 → 用草案价，原因是 pricing_config_load_failed', () => {
  const result = getGenerationCost({ spec: null, params: img(), configLoadFailed: true, draftPrice: DRAFT })
  assert(result.usingDraft === true && result.fallbackReason === 'pricing_config_load_failed', '原因应为读配置失败')
  assert(result.points > 0, '绝不允许返回 0')
})
check('模型没有定价记录 → pricing_model_not_configured', () => {
  const result = getGenerationCost({ spec: { matchMode: 'none', tiers: [] }, params: img(), draftPrice: DRAFT })
  assert(result.fallbackReason === 'pricing_model_not_configured' && result.points > 0, `实际 ${JSON.stringify(result)}`)
})
check('有档位但 label 模式没声明 labelAxis → pricing_mode_not_calibrated（不猜模式）', () => {
  const spec = { matchMode: 'label', tiers: [{ resolutionLabel: 'x', upstreamLabel: 'high', price: { perImage: 5 } }] }
  const result = getGenerationCost({ spec, params: img({ label: 'high' }), draftPrice: DRAFT })
  assert(result.fallbackReason === 'pricing_mode_not_calibrated', `未标定就不该硬匹配，实际 ${JSON.stringify(result)}`)
})
check('规格匹配不到档位 → tier_match_failed', () => {
  const result = getGenerationCost({ spec: labelSpec, params: img({ label: 'nope' }), draftPrice: DRAFT })
  assert(result.fallbackReason === 'tier_match_failed' && result.points > 0, '应回落且非 0')
})

console.log('\n== 试点用例：gpt-image-2 @ ggwk1（按次 6 分）==')

check('一次请求 1 张 → 6 分，且不走兜底', () => {
  const result = getGenerationCost({ spec: noneSpec, params: img(), draftPrice: DRAFT })
  assert(result.points === 6 && result.usingDraft === false, `应命中定价 6 分，实际 ${JSON.stringify(result)}`)
})
check('一次请求 10 张 → 仍是 6 分（渠道按次计费，不能按张扣 60）', () => {
  const result = getGenerationCost({ spec: noneSpec, params: img({ count: 10 }), draftPrice: DRAFT })
  assert(result.points === 6, `按次应仍为 6，实际 ${result.points}`)
})

console.log('\n== 后台保存校验 ==')

check('同时配 perSecond 与 perTask → 拦下', () => {
  const problems = validateModelPricing({ matchMode: 'none', tiers: [{ resolutionLabel: 'x', price: { perSecond: 1, perTask: 2 } }] })
  assert(problems.some((p) => p.includes('只能选一种')), `应报单位互斥：${JSON.stringify(problems)}`)
})
check('价格 <= 0 或缺失 → 拦下', () => {
  const problems = validateModelPricing({ matchMode: 'none', tiers: [{ resolutionLabel: 'x', price: {} }] })
  assert(problems.length > 0, '空价格应被拦')
})
check('label 模式缺 upstreamLabel / 重复 → 拦下', () => {
  const missing = validateModelPricing({ matchMode: 'label', labelAxis: 'size', tiers: [{ resolutionLabel: 'a', price: { perImage: 1 } }] })
  assert(missing.some((p) => p.includes('upstreamLabel')), '缺 label 应被拦')
  const dup = validateModelPricing({ matchMode: 'label', labelAxis: 'size', tiers: [
    { resolutionLabel: 'a', upstreamLabel: '1K', price: { perImage: 1 } },
    { resolutionLabel: 'b', upstreamLabel: '1K', price: { perImage: 2 } },
  ] })
  assert(dup.some((p) => p.includes('重复')), `重复 label 应被拦：${JSON.stringify(dup)}`)
})
check('区间重叠 → 拦下（否则同一规格可能命中两个价）', () => {
  const problems = validateModelPricing({ matchMode: 'longEdge', tiers: [
    { resolutionLabel: '1K', edgeMin: 0, edgeMax: 1500, price: { perImage: 1 } },
    { resolutionLabel: '2K', edgeMin: 1281, edgeMax: 2048, price: { perImage: 2 } },
  ] })
  assert(problems.some((p) => p.includes('重叠')), `应报重叠：${JSON.stringify(problems)}`)
})
check('合法配置 → 无问题', () => {
  assert(validateModelPricing(noneSpec).length === 0, `不该有问题：${JSON.stringify(validateModelPricing(noneSpec))}`)
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
