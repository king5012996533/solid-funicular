/**
 * 生成器页脚「本次预估积分」的展示口径单测（2026-09-26）
 *
 * 要钉死的事：
 *   1. 拿不到估算（null / 0 / 负数 / NaN）**一律不显示数字** —— 0 只有「不知道」的含义，
 *      不能被当成「免费」（历史上真出现过「本批预扣 0 分」这种错数字）；
 *   2. 余额拿不到时**不上色**（不把「不知道余额」渲染成红色告警）；
 *   3. 缺口三档的边界：等于余额算够（不是 strong）、恰好 80% 算够（不是 medium）；
 *   4. 缓存键必须带 规格 与 数量（漏了会互相串价）；
 *   5. 反证：把 0 当有效值，断言必然失败。
 *
 * 跑法：npx tsx tests/composer-cost-display.test.ts（由 npm run test:unit 统一跑）
 */

import {
  CREDIT_GAP_WARN_RATIO,
  buildComposerEstimateKey,
  formatEstimateText,
  resolveCreditGapLevel,
  resolveUsableEstimate,
} from '../src/shared/composer-cost-display'

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

console.log('估算值可用性：')
check('正常数字原样可用', resolveUsableEstimate(1380), 1380)
check('小数四舍五入', resolveUsableEstimate(6.4), 6)
check('null 视为拿不到', resolveUsableEstimate(null), null)
check('undefined 视为拿不到', resolveUsableEstimate(undefined), null)
check('0 视为拿不到（绝不能显示成「0 分」）', resolveUsableEstimate(0), null)
check('负数视为拿不到', resolveUsableEstimate(-3), null)
check('NaN 视为拿不到', resolveUsableEstimate(Number.NaN), null)
check('非数字字符串视为拿不到', resolveUsableEstimate('abc'), null)
check('数字字符串可用', resolveUsableEstimate('12'), 12)

console.log('\n页脚文案：')
check('拿得到给总额', formatEstimateText(1380), '预估 1380 分')
check('拿不到给空串（调用方据此不渲染）', formatEstimateText(null), '')

console.log('\n缺口档位：')
check('总额远小于余额 → ok（青色）', resolveCreditGapLevel(100, 1000), 'ok')
// 边界定义（写清楚以免以后有人「顺手改回去」）：
//   total > available        → strong（跑不动，会被服务端拦下）
//   total >= available × 0.8 → medium（花掉大部分，包括「正好花光」这一档）
//   else                     → ok
// 「正好等于余额」算 medium 而不是 ok：这一单会把余额花到 0，值得提醒，但它**不是** strong
// —— strong 的含义是「跑不动」，而它跑得动。
check('总额等于余额 → medium（花光但不拦，不是 strong）', resolveCreditGapLevel(1000, 1000), 'medium')
check(`恰好 ${CREDIT_GAP_WARN_RATIO * 100}% → medium（含在这一档里）`, resolveCreditGapLevel(800, 1000), 'medium')
check('略低于 80% → ok', resolveCreditGapLevel(799, 1000), 'ok')
check('超过余额 → strong', resolveCreditGapLevel(1001, 1000), 'strong')
check('余额拿不到 → unknown（不上色，不吓唬也不讨好）', resolveCreditGapLevel(1000, null), 'unknown')
check('估算拿不到 → unknown', resolveCreditGapLevel(null, 10), 'unknown')
check('两者都拿不到 → unknown', resolveCreditGapLevel(null, null), 'unknown')
check('余额为 0 且要花钱 → strong', resolveCreditGapLevel(6, 0), 'strong')

console.log('\n缓存键：')
check('模型 + 规格 + 数量 三段拼接',
  buildComposerEstimateKey('p1::IMAGE::gpt-image-2', '2048x2048', 4),
  'p1::IMAGE::gpt-image-2::2048x2048::4')
check('只换规格 → 键不同（避免串价）',
  buildComposerEstimateKey('m', '1024x1024', 1) === buildComposerEstimateKey('m', '2048x2048', 1), false)
check('只换数量 → 键不同（perImage 随张数变）',
  buildComposerEstimateKey('m', 's', 1) === buildComposerEstimateKey('m', 's', 4), false)
check('数量缺失保底 1',
  buildComposerEstimateKey('m', 's', 0), 'm::s::1')
check('规格缺失用空串占位（三段仍完整）',
  buildComposerEstimateKey('m', '', 2), 'm::::2')

console.log('\n反证（这些断言必须失败，用来证明前两组不是「怎么改都过」）：')
let reverseFailed = 0
const reverseAssert = (label: string, condition: boolean) => {
  if (condition) {
    reverseFailed++
    console.log(`  ❌ 反证未生效：${label}`)
  } else {
    passed++
    console.log(`  ✅ 反证成立：${label}`)
  }
}
reverseAssert('把 0 当有效值就会与「0 是不知道」相矛盾', resolveUsableEstimate(0) === 0)
reverseAssert('把「额度刚好够」当 strong 会与边界定义相矛盾', resolveCreditGapLevel(1000, 1000) === 'strong')
reverseAssert('把「余额拿不到」当 ok 会在不知道的情况下显示青色', resolveCreditGapLevel(10, null) === 'ok')
reverseAssert('缓存键不带数量就无法区分不同张数',
  buildComposerEstimateKey('m', 's', 1) === buildComposerEstimateKey('m', 's', 4))
check('反证组本身没有出现意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
