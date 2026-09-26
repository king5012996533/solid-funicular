/**
 * 视频抽帧「取哪一秒」换算的单测（2026-09-26）
 *
 * 要钉死的事：
 *   1. duration 不可用（NaN / 0 / 负数 / Infinity，= 视频元数据还没加载完）时**一律返回 0**，
 *      绝不返回 NaN —— NaN 喂给 video.currentTime 会抛错或表现为「点了没反应」；
 *   2. current 用 currentTime，但必须 clamp 到 [0, duration]；currentTime 为 NaN 时保底 0；
 *   3. first 恒为 0；
 *   4. last 不能直接用 duration，要回退一个小量（否则部分浏览器 seek 不出帧、画出黑图）；
 *   5. 文件名按位置区分，且**不含时间戳**（避免非法字符/编码问题）；
 *   6. 反证：若把边界当成「怎么改都过」，下面几条反向断言必然失败。
 *
 * 跑法：npx tsx tests/video-frame-capture.test.ts（也由 npm run test:unit 统一跑）
 */

import {
  LAST_FRAME_BACKOFF_SECONDS,
  buildFrameFileName,
  resolveFrameTimestamp,
} from '../src/shared/video-frame-capture'

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

console.log('首帧：')
check('first 恒为 0（与 currentTime / duration 无关）', resolveFrameTimestamp('first', 12.5, 30), 0)
check('first 在 duration 缺失时也是 0', resolveFrameTimestamp('first', 12.5, Number.NaN), 0)
check('first 的 currentTime 为 NaN 时仍是 0', resolveFrameTimestamp('first', Number.NaN, 30), 0)

console.log('\n当前帧（clamp）：')
check('区间内原样返回', resolveFrameTimestamp('current', 3.2, 30), 3.2)
check('负数 clamp 到 0', resolveFrameTimestamp('current', -1, 30), 0)
check('超出 duration clamp 到 duration', resolveFrameTimestamp('current', 40, 30), 30)
check('正好等于 duration 保留（当前帧由用户停在末点）', resolveFrameTimestamp('current', 30, 30), 30)
check('currentTime 为 NaN 时保底 0（不是 NaN）', resolveFrameTimestamp('current', Number.NaN, 30), 0)

console.log('\n尾帧（回退量）：')
check('last 回退一个很小的量', resolveFrameTimestamp('last', 0, 30), 30 - LAST_FRAME_BACKOFF_SECONDS)
check('回退量固定为 0.05s', resolveFrameTimestamp('last', 0, 30), 29.95)
check('极短视频也不会回退成负数', resolveFrameTimestamp('last', 0, 0.02), 0)

console.log('\nduration 不可用（元数据未加载）：')
check('NaN → 0（current）', resolveFrameTimestamp('current', 5, Number.NaN), 0)
check('NaN → 0（last）', resolveFrameTimestamp('last', 5, Number.NaN), 0)
check('0 → 0（current）', resolveFrameTimestamp('current', 5, 0), 0)
check('0 → 0（last）', resolveFrameTimestamp('last', 5, 0), 0)
check('负数 → 0', resolveFrameTimestamp('last', 5, -30), 0)
check('Infinity → 0', resolveFrameTimestamp('last', 5, Number.POSITIVE_INFINITY), 0)
check('current 的 currentTime 有效也照样被 duration 缺失拦成 0', resolveFrameTimestamp('current', 8, Number.NaN), 0)

console.log('\n返回值必须永远是有限、非负的数：')
const positions = ['current', 'first', 'last'] as const
const durations = [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 0.001, 12.34]
const times = [Number.NaN, -5, 0, 3.2, 999]
let allSafe = true
for (const position of positions) {
  for (const duration of durations) {
    for (const time of times) {
      const value = resolveFrameTimestamp(position, time, duration)
      if (!Number.isFinite(value) || value < 0) {
        allSafe = false
        console.log(`     ↳ 越界：position=${position} currentTime=${time} duration=${duration} → ${value}`)
      }
    }
  }
}
check('穷举组合下全部是有限非负数', allSafe, true)

console.log('\n文件名：')
check('首帧文件名', buildFrameFileName('first', 0), 'frame-first.jpg')
check('当前帧文件名（不含时间戳）', buildFrameFileName('current', 3.2), 'frame-current.jpg')
check('尾帧文件名', buildFrameFileName('last', 29.95), 'frame-last.jpg')
check('文件名不含冒号（跨平台安全）', buildFrameFileName('current', 12345).includes(':'), false)
check('同一位置不同时间点文件名相同（时间戳不进名字）',
  buildFrameFileName('current', 1) === buildFrameFileName('current', 99), true)

console.log('\n反证（这些断言必须失败，用来证明前面的边界不是「怎么改都过」）：')
const reverseAssert = (label: string, condition: boolean) => {
  if (condition) {
    failed++
    console.log(`  ❌ 反证未生效：${label}`)
  } else {
    passed++
    console.log(`  ✅ 反证成立：${label}`)
  }
}
reverseAssert('直接把 duration 当尾帧时间点会与「回退一小量」相矛盾',
  resolveFrameTimestamp('last', 0, 30) === 30)
reverseAssert('把 duration 缺失时的 NaN 原样返回会与「保底 0」相矛盾',
  Number.isNaN(resolveFrameTimestamp('current', 5, Number.NaN)))
reverseAssert('current 不 clamp 就会越过 duration（越界才说明 clamp 真在起作用）',
  resolveFrameTimestamp('current', 40, 30) === 40)
reverseAssert('把时间戳拼进文件名就会与「只用位置命名」相矛盾',
  buildFrameFileName('last', 29.95) === 'frame-last-29.95.jpg')

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
