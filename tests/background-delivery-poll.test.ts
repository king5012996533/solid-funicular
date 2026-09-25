/**
 * 「不等了，让它后台跑完」轮询判定单测（2026-09-26）。
 *
 * 为什么单独测：这段判定是「钱不白花」在客户端的最后一道闸 ——
 *   判完成太早 / 判失败太早，用户会以为任务没了，其实成果还在；
 *   判继续等太宽，节点会一直挂着后台态不落结果。
 * 画布图片节点与生成页图片记录共用这一个函数（src/shared/background-delivery-poll.ts），
 * 所以在这里把它钉死，参数无 db、无网络、纯函数可跑。
 *
 * 跑法：npx tsx tests/background-delivery-poll.test.ts
 */
import {
  BACKGROUND_POLL_FIRST_DELAY_MS,
  BACKGROUND_POLL_INTERVAL_MS,
  BACKGROUND_POLL_MAX_DURATION_MS,
  decideBackgroundDelivery,
} from '../src/shared/background-delivery-poll'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed += 1
    console.log(`  ok   ${label} = ${a}`)
    return
  }
  failed += 1
  console.error(`  FAIL ${label}: 期望 ${e}，实际 ${a}`)
}

console.log('\n【1】节奏常量：首次 3 秒、间隔 20 秒、上限 30 分钟')
check('首次延迟 = 3 秒', BACKGROUND_POLL_FIRST_DELAY_MS, 3_000)
check('轮询间隔 = 20 秒', BACKGROUND_POLL_INTERVAL_MS, 20_000)
check('总上限 = 30 分钟', BACKGROUND_POLL_MAX_DURATION_MS, 30 * 60 * 1000)

console.log('\n【2】六种判定各一条')
check(
  '完成了且有图 → completed',
  decideBackgroundDelivery({ done: true, images: ['https://x/a.png'] }, 1_000),
  'completed',
)
check(
  '完成了但没有图 → failed（可重试）',
  decideBackgroundDelivery({ done: true, images: [] }, 1_000),
  'failed',
)
check(
  '被停止 → stopped',
  decideBackgroundDelivery({ done: false, stopped: true }, 1_000),
  'stopped',
)
check(
  '带错误 → failed',
  decideBackgroundDelivery({ done: false, error: '上游返回 500' }, 1_000),
  'failed',
)
check(
  '还在跑且未超预算 → keep-waiting',
  decideBackgroundDelivery({ done: false, images: [] }, 1_000),
  'keep-waiting',
)
check(
  '超过预算且未完成 → give-up',
  decideBackgroundDelivery({ done: false }, BACKGROUND_POLL_MAX_DURATION_MS + 1),
  'give-up',
)

console.log('\n【3】边界：刚好等于上限 / 刚超上限 / 差 1 毫秒')
check(
  '刚好等于上限 → give-up（不再等）',
  decideBackgroundDelivery({ done: false }, BACKGROUND_POLL_MAX_DURATION_MS),
  'give-up',
)
check(
  '刚超上限 → give-up',
  decideBackgroundDelivery({ done: false }, BACKGROUND_POLL_MAX_DURATION_MS + 1),
  'give-up',
)
check(
  '差 1 毫秒到上限 → keep-waiting',
  decideBackgroundDelivery({ done: false }, BACKGROUND_POLL_MAX_DURATION_MS - 1),
  'keep-waiting',
)
check(
  'elapsed 为 0 → keep-waiting',
  decideBackgroundDelivery({ done: false }, 0),
  'keep-waiting',
)

console.log('\n【4】优先级：拿到成果优先于一切终态标记')
check(
  'done + stopped + 有图 → completed（别把到手的成果判成停止）',
  decideBackgroundDelivery({ done: true, stopped: true, images: ['https://x/a.png'] }, 1_000),
  'completed',
)
check(
  '超过预算但有图 → completed（成果优先于超时）',
  decideBackgroundDelivery({ done: true, images: ['https://x/a.png'] }, BACKGROUND_POLL_MAX_DURATION_MS + 999),
  'completed',
)
check(
  'done + 无图 + error → failed（完成但无产出）',
  decideBackgroundDelivery({ done: true, images: [], error: '内部错误' }, 1_000),
  'failed',
)
check(
  'record 为 null → 只看时长（未超预算继续等）',
  decideBackgroundDelivery(null, 1_000),
  'keep-waiting',
)
check(
  'record 为 null 且超预算 → give-up',
  decideBackgroundDelivery(null, BACKGROUND_POLL_MAX_DURATION_MS),
  'give-up',
)
check(
  'images 里混入空值 → 只算真图',
  decideBackgroundDelivery({ done: true, images: ['', null, 'https://x/a.png'] }, 1_000),
  'completed',
)
check(
  'images 全是空值 → 视为无图 failed',
  decideBackgroundDelivery({ done: true, images: ['', null] }, 1_000),
  'failed',
)

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
