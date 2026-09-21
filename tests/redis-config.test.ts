/**
 * Redis 配置解析的验证
 *
 * 这一小段代码出过一次影响面很大的 bug，必须用测试钉住：
 *   调用方一律写 `process.env.X || ''`，环境变量未设置时传进来的是**空字符串**。
 *   而 `Number('')` 等于 0（不是 NaN），`Number.isFinite(0)` 为真 ——
 *   于是"未设置"被当成"显式配了 0"，最后 `Math.max(minValue, 0)` 返回 1。
 *   后果：所有没在 .env 里配置的 Redis 参数都变成 1，其中
 *   `taskLockTtlMs = 1 毫秒` 让执行锁瞬间过期，**任何超过 5 秒的生成任务都被中断**，
 *   也就是这个库长期出不了图的直接原因。
 */

import { normalizeInteger } from '../server/redis/config'

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

console.log('\n【1】空值一律用默认值（就是出 bug 的那条路径）')
{
  // 调用方实际传的就是空字符串
  check('空字符串 → 默认值', normalizeInteger('', 30000), 30000)
  check('空字符串 → 默认值（第二例）', normalizeInteger('', 60), 60)
  check('纯空格 → 默认值', normalizeInteger('   ', 30000), 30000)
  // 原来这里返回 1，是 bug 的核心
  check('空字符串不等于 0', normalizeInteger('', 30000) === 1, false)
}

console.log('\n【2】合法数值正常解析')
{
  check('数字字符串', normalizeInteger('240', 1), 240)
  check('带空格', normalizeInteger(' 240 ', 1), 240)
  check('小数向下取整', normalizeInteger('240.9', 1), 240)
  check('0 显式配置 → 被 minValue 抬起', normalizeInteger('0', 30000), 1)
  check('负数 → 被 minValue 抬起', normalizeInteger('-5', 30000), 1)
}

console.log('\n【3】非法值回落默认值')
{
  check('非数字文本', normalizeInteger('abc', 30000), 30000)
  check('NaN', normalizeInteger('NaN', 30000), 30000)
}

console.log('\n【4】minValue 可定制')
{
  check('降低下限以允许 0', normalizeInteger('0', 100, 0), 0)
  check('下限 5', normalizeInteger('2', 100, 5), 5)
}

console.log('\n【5】关键回归：执行锁 TTL 不能再变成 1 毫秒')
{
  // .env.development 里 REDIS_TASK_LOCK_TTL_MS 是注释掉的 → 传空字符串
  const lockTtl = normalizeInteger('', 30_000)
  check('默认锁 TTL 是 30 秒而不是 1 毫秒', lockTtl, 30_000)
  check('锁 TTL 必须远大于续期间隔 5 秒', lockTtl > 5_000, true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
