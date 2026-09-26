/**
 * `/api/points/estimate` 纯逻辑核心单测（2026-09-26）
 *
 * 要钉死的事（对应真机 bug：一张实际扣 6 分的 gpt-image-2 被估成 0）：
 *   1. 合法输入（1 个 gpt-image-2 节点，三段式选择键）→ 算出 **6**（用真实定价规则，不是桩数字）；
 *   2. 模型未在计价表 → **明确「估不出」**（totalEstimated 缺失、cost=null、unestimatable 有原因），**不是 0**；
 *   3. 空节点列表 → 保持现有语义（totalEstimated 0、details 空、不报错）；
 *   4. 裸 modelKey（解析不出 providerId）→ 同样是「估不出」，不是 0；
 *   5. 任一项估不出 → **整批不给总额**（不拿部分数字冒充整批）；
 *   6. 反证：把 refuse 当 0（旧行为）会得到 0 —— 正是要消灭的形态。
 *
 * 跑法：npx tsx tests/points-estimate.test.ts（由 npm run test:unit 统一跑）
 */

import {
  DRAFT_MODEL_PRICING,
  buildNormalizedGenerationParams,
  getGenerationCost,
  type ModelPricingSpec,
} from '../src/shared/model-pricing-rules'
import {
  computePointsEstimate,
  parseModelSelectionKey,
  type ResolveEstimateCost,
} from '../server/points/estimate-core'

let passed = 0
let failed = 0

function check(label: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}

/** 与 scripts/setup-pilot-account.mjs 写入的一致：gpt-image-2 @ ggwk1 = 6 分/次（matchMode=none） */
const PILOT_SPEC: ModelPricingSpec = {
  matchMode: 'none',
  tiers: [{ resolutionLabel: '每次请求', price: { perTask: 6 } }],
}

const specFor = (providerId: string, modelKey: string): ModelPricingSpec | null => (
  providerId === 'p-sceneflow-ggk' && modelKey === 'gpt-image-2' ? PILOT_SPEC : null
)

/** 复刻服务端 handler 传入的解析器：真实定价规则 + 同一套参数归一化 */
const resolve: ResolveEstimateCost = async ({ providerId, modelKey, endpointType, size, count }) => {
  const result = getGenerationCost({
    spec: specFor(providerId, modelKey),
    params: buildNormalizedGenerationParams({ kind: endpointType === 'video' ? 'video' : 'image', size, count }),
    draftPrice: DRAFT_MODEL_PRICING,
  })
  return { pointCost: result.points, refuse: result.refuse, refuseReason: result.refuseReason, detail: result.detail }
}

console.log('\n【1】模型选择键解析：三段式才认，裸键解析不出')
{
  const parsed = parseModelSelectionKey('p-sceneflow-ggk::IMAGE::gpt-image-2')
  check('providerId', parsed?.providerId === 'p-sceneflow-ggk')
  check('endpointType 小写化', parsed?.endpointType === 'image')
  check('modelKey', parsed?.modelKey === 'gpt-image-2')
  check('裸 modelKey → null', parseModelSelectionKey('gpt-image-2') === null)
  check('两段 → null', parseModelSelectionKey('p-x::IMAGE') === null)
  check('缺 modelKey → null', parseModelSelectionKey('p-x::IMAGE::') === null)
  check('空串 → null', parseModelSelectionKey('') === null)
}

console.log('\n【2】合法输入：1 个 gpt-image-2 节点 → 6（用真实定价规则算出的 6）')
{
  const outcome = await computePointsEstimate(
    [{ model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', size: '1:1', count: 1 }],
    resolve,
  )
  check('整批总额 = 6', outcome.totalEstimated === 6)
  check('明细 cost = 6', outcome.details[0]?.cost === 6)
  check('明细 estimated = true', outcome.details[0]?.estimated === true)
  check('没有估不出的项', outcome.unestimatable.length === 0)
}

console.log('\n【3】合法输入：不带 size 也是 6（按次计费不吃画幅），不静默变 0')
{
  const outcome = await computePointsEstimate(
    [{ model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', count: 1 }],
    resolve,
  )
  check('缺 size 仍算出 6', outcome.totalEstimated === 6)
}

console.log('\n【4】模型未在计价表 → 明确「估不出」，不是 0')
{
  const outcome = await computePointsEstimate(
    [{ model: 'p-sceneflow-quanzil::IMAGE::gpt-image-2-c', size: '1:1', count: 1 }],
    resolve,
  )
  check('totalEstimated 缺失（不是 0）', !('totalEstimated' in outcome))
  check('明细 cost = null（不是 0）', outcome.details[0]?.cost === null)
  check('明细 estimated = false', outcome.details[0]?.estimated === false)
  check('unestimatable 带原因（pricing_model_not_configured）', outcome.unestimatable[0]?.reason === 'pricing_model_not_configured')
}

console.log('\n【5】裸 modelKey → 也是「估不出」（服务端不再静默按 0）')
{
  const outcome = await computePointsEstimate(
    [{ model: 'gpt-image-2', size: '1:1', count: 1 }],
    resolve,
  )
  check('totalEstimated 缺失', !('totalEstimated' in outcome))
  check('明细 cost = null', outcome.details[0]?.cost === null)
  check('unestimatable 原因可辨（model_key_unresolvable）', outcome.unestimatable[0]?.reason === 'model_key_unresolvable')
  check('明细里保留原始 model（日志可定位）', outcome.details[0]?.model === 'gpt-image-2')
}

console.log('\n【6】空节点列表 → 保持现有语义（总额 0、明细空、不报错）')
{
  const outcome = await computePointsEstimate([], resolve)
  check('totalEstimated = 0', outcome.totalEstimated === 0)
  check('details 为空', outcome.details.length === 0)
  check('unestimatable 为空', outcome.unestimatable.length === 0)
}

console.log('\n【7】反证：任一项估不出 → 整批不给部分总额')
{
  const outcome = await computePointsEstimate(
    [
      { model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', size: '1:1', count: 1 },
      { model: 'p-sceneflow-quanzil::IMAGE::gpt-image-2-c', size: '1:1', count: 1 },
    ],
    resolve,
  )
  check('有估不出的项 → totalEstimated 缺失（不拿 6 冒充整批）', !('totalEstimated' in outcome))
  check('估得出的那项仍如实给 cost=6', outcome.details[0]?.cost === 6)
  check('估不出的那项 cost=null', outcome.details[1]?.cost === null)

  // 反证：若按旧的「refuse 当 0」求和，两项会凑出一个假的 6（预校验说 6、实扣可能是 6+?）
  const naiveOldSum = outcome.details.reduce((sum, item) => sum + (item.cost ?? 0), 0)
  check('反证成立：旧的「null 当 0」会算出 PartialTotal=6（正是要消灭的形态）', naiveOldSum === 6)
}

console.log('\n【8】反证：旧的「静默把估不出当 0」会让整批 = 0（真机 bug 的形态）')
{
  // 旧服务端：解析失败 / refuse 一律 return 0。这里用桩把它重现出来。
  const oldResolve: ResolveEstimateCost = async () => ({ pointCost: 0, refuse: true, refuseReason: 'pricing_model_not_configured' })
  const legacyTotal = (await computePointsEstimate(
    [{ model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', size: '1:1', count: 1 }],
    oldResolve,
  )).totalEstimated
  check('新实现：拒价时 totalEstimated 缺失（上层走降级）', legacyTotal === undefined)
  // 若照旧把 refuse 当 0，会得到 0 —— 一张实际 6 分的图被写成「预扣 0 分」
  const oldSum = (await computePointsEstimate(
    [{ model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', size: '1:1', count: 1 }],
    async () => ({ pointCost: 0, refuse: false }),
  )).totalEstimated
  check('反证成立：旧路径会得到 0（真机确认这是报错的数字）', oldSum === 0)
}

console.log('\n【9】去重：同「模型 + 规格 + 张数」只解析一次价')
{
  let calls = 0
  const countingResolve: ResolveEstimateCost = async (input) => {
    calls++
    return resolve(input)
  }
  const items = Array.from({ length: 10 }, () => ({ model: 'p-sceneflow-ggk::IMAGE::gpt-image-2', size: '1:1', count: 1 }))
  const outcome = await computePointsEstimate(items, countingResolve)
  check('10 个同规格节点只查一次价', calls === 1)
  check('总额 = 10 × 6', outcome.totalEstimated === 60)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
