/**
 * 预校验配额埋点的日志映射验证（2026-09-25）
 *
 * 这套映射要钉死两件事，因为它们是「闸门有没有生效」在服务端的唯一留痕：
 *   1. 配额真的查过 → 必须是 `canvas_agent:preflight_quota_checked`，且带上 available / totalEstimated；
 *   2. 拿不到余额/预估而跳过 → 必须是 `canvas_agent:preflight_quota_check_skipped`，且带上 reason。
 * 之所以能用纯函数覆盖：完整的 Agent 链路要一个可用的对话模型，环境里模型随时会被停用，
 * 而埋点正确性不该依赖那一步。文件名与 stage 里的 token 都保持原样，日志里可直接 grep。
 */

import {
  PREFLIGHT_QUOTA_CHECKED_STAGE,
  PREFLIGHT_QUOTA_SKIPPED_STAGE,
  describePreflightQuotaTelemetry,
} from '../server/generation-tasks/canvas-agent-quota-telemetry'

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

console.log('\n【1】配调查过（checked）→ 必须带 available 与 totalEstimated')
{
  const t = describePreflightQuotaTelemetry({ status: 'checked', available: 6, totalEstimated: 12, nodeCount: 2 })
  check('stage = preflight_quota_checked', t?.stage, PREFLIGHT_QUOTA_CHECKED_STAGE)
  check('可用积分进日志', t?.detail.available, 6)
  check('整批预估进日志', t?.detail.totalEstimated, 12)
  check('节点数进日志', t?.detail.nodeCount, 2)
  check('stage 里保留可 grep 的原文 token', /preflight_quota_checked/.test(String(t?.stage)), true)
}

console.log('\n【2】拿不到余额/预估（skipped）→ 必须带 reason')
{
  const t = describePreflightQuotaTelemetry({ status: 'skipped', reason: 'balance_api_error', nodeCount: 2 })
  check('stage = preflight_quota_check_skipped', t?.stage, PREFLIGHT_QUOTA_SKIPPED_STAGE)
  check('跳过原因进日志', t?.detail.reason, 'balance_api_error')
  check('stage 里保留可 grep 的原文 token', /preflight_quota_check_skipped/.test(String(t?.stage)), true)
}

console.log('\n【3】reason 缺失时兜底为 unknown（有字段总比没有强）')
{
  const t = describePreflightQuotaTelemetry({ status: 'skipped', nodeCount: 1 })
  check('reason 回落到 unknown', t?.detail.reason, 'unknown')
}

console.log('\n【4】没有配额结论（工具没跑/非 preflight）→ 不产生日志')
{
  check('undefined → null', describePreflightQuotaTelemetry(undefined), null)
  check('null → null', describePreflightQuotaTelemetry(null), null)
  check('status 非字符串 → null', describePreflightQuotaTelemetry({ status: 1 as never }), null)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
