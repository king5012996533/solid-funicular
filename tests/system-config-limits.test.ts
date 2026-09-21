/**
 * 后台「限流 / 并发」配置项的归一化逻辑
 *
 * 这段代码有个很隐蔽的坑，值得单独钉住：
 *   `Number(null)` 与 `Number('')` 都等于 0，而 0 是有限数。
 *   所以 `Number.isFinite(Number(value))` 这种写法会把"没填"判成"填了 0"，
 *   再被 Math.max(1, ...) 抬成 1 —— 于是所有没显式配置的限流都变成 1 次/分钟。
 *
 * 这里不只测函数，也把"用户实际会遇到的后果"写成断言：
 * 登录限流不能是 1（那意味着点第二次就是"登录请求过于频繁"）。
 *
 * 与 tests/redis-config.test.ts 是同一类回归的另一半：
 * 那边是环境变量层（server/redis/config.ts），这边是后台配置层。
 */

import { normalizeRuntimeLimit } from '../server/system-config/service'

let passed = 0
let failed = 0
const check = (label: string, actual: unknown, expected: unknown) => {
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

console.log('\n【1】空值一律回落到默认值（这是本次修的 bug 本体）')
{
  const fallback = 10
  check('undefined → 默认', normalizeRuntimeLimit(undefined, fallback, 200), 10)
  check('null → 默认', normalizeRuntimeLimit(null, fallback, 200), 10)
  check('空串 → 默认', normalizeRuntimeLimit('', fallback, 200), 10)
  check('全是空格 → 默认', normalizeRuntimeLimit('   ', fallback, 200), 10)
  check('0 → 默认（0 是"没配"，不是"限 0 次"）', normalizeRuntimeLimit(0, fallback, 200), 10)
  check('字符串 0 → 默认', normalizeRuntimeLimit('0', fallback, 200), 10)
  check('负数 → 默认', normalizeRuntimeLimit(-5, fallback, 200), 10)
  check('NaN → 默认', normalizeRuntimeLimit(Number.NaN, fallback, 200), 10)
  check('非数字字符串 → 默认', normalizeRuntimeLimit('abc', fallback, 200), 10)
}

console.log('\n【2】明确的数值要用起来，并夹在合法区间内')
{
  check('10 → 10', normalizeRuntimeLimit(10, 6, 200), 10)
  check('字符串 "20" → 20', normalizeRuntimeLimit('20', 6, 200), 20)
  check('小数 7.9 → 向下取整 7', normalizeRuntimeLimit(7.9, 6, 200), 7)
  check('超上限 → 夹到上限', normalizeRuntimeLimit(9999, 6, 200), 200)
  check('上限 500 的字段不受 200 影响', normalizeRuntimeLimit(9999, 8, 500), 500)
  check('1 是合法值（真的是"只允许 1 次"也不会被改写）', normalizeRuntimeLimit(1, 6, 200), 1)
}

console.log('\n【3】真实后果：登录限流不允许回落到 1')
{
  // 后台保存时若传了空对象，得到的必须是默认的 10 次/60 秒，
  // 而不是 1 —— 1 意味着"点第二次就说登录过于频繁"，用户根本登不进来。
  const fallbackLogin = 10
  const resolved = normalizeRuntimeLimit({} as any, fallbackLogin, 200)
  check('空配置落到默认而不是 1', resolved, 10)
  check('而且必须大于 1（否则用户第二次登录就被限流）', resolved > 1, true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
