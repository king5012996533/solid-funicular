/**
 * 「上游已变 / 需重跑」指纹的单测（2026-09-26）
 *
 * 为什么值得单独钉死：这套判断决定了卡片上那个角标的出现与消失。判断的边界一旦松了，
 * 会出现两类很难查的假象：
 *   · 假阳性 —— 用户什么都没干，角标却一直挂着（比如 url 两边只差空白、新增上游被当成「已变」）；
 *   · 假阴性 —— 上游明明重跑出新图了，角标不出，用户拿旧结果当新的用。
 * 所以这里把四条关键规则钉死：
 *   1. 指纹只收**有 url** 的上游产出（没产出的不参与）；
 *   2. 比较时 url 两边都 trim，等价不算变（避免空白造成假阳性）；
 *   3. 指纹里有、当前没有的上游算 removed，**不计入 updated**（删上游不出角标）；
 *   4. 指纹里没有的新上游不算已变（本次生成本来就没用它）。
 *
 * 跑法：npx tsx tests/upstream-staleness.test.ts（由 npm run test:unit 统一跑）
 */

import {
  UPSTREAM_UPDATED_BADGE_TEXT,
  captureUpstreamFingerprint,
  compareUpstreamFingerprint,
  readUpstreamFingerprint,
  resolveUpstreamStaleBadge,
  type UpstreamOutput,
} from '../src/views/workflow/components/nodes/upstream-staleness'

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

const out = (id: string, url?: string | null): UpstreamOutput => ({ id, url })

console.log('捕获指纹：')
check('只收有 url 的产出',
  captureUpstreamFingerprint([out('a', 'https://x/a.png'), out('b', ''), out('c')]),
  { a: 'https://x/a.png' })
check('同 id 去重，后者覆盖',
  captureUpstreamFingerprint([out('a', 'old.png'), out('a', 'new.png')]),
  { a: 'new.png' })
check('空白 url 不算产出',
  captureUpstreamFingerprint([out('a', '   ')]),
  {})
check('空 id 被丢掉',
  captureUpstreamFingerprint([out('', 'x.png')]),
  {})
check('url 两端空白被 trim',
  captureUpstreamFingerprint([out('a', '  x.png  ')]),
  { a: 'x.png' })
check('空输入安全', captureUpstreamFingerprint([]), {})

console.log('\n读指纹（持久化数据可能是脏的）：')
check('非对象 → 空', readUpstreamFingerprint('nonsense'), {})
check('数组 → 空', readUpstreamFingerprint(['a']), {})
check('null / undefined → 空', [readUpstreamFingerprint(null), readUpstreamFingerprint(undefined)], [{}, {}])
check('数字值 → 转字符串', readUpstreamFingerprint({ a: 123 }), { a: '123' })
check('空串值 → 丢掉', readUpstreamFingerprint({ a: '', b: 'b.png' }), { b: 'b.png' })

console.log('\n比较：')
const fingerprint = { a: 'a1.png', b: 'b1.png' }
check('上游没动 → 无变化',
  compareUpstreamFingerprint(fingerprint, [out('a', 'a1.png'), out('b', 'b1.png')]),
  { updated: [], removed: [] })
check('某个上游换了图 → updated',
  compareUpstreamFingerprint(fingerprint, [out('a', 'a2.png'), out('b', 'b1.png')]),
  { updated: ['a'], removed: [] })
check('上游被删 → removed（且不算 updated）',
  compareUpstreamFingerprint(fingerprint, [out('b', 'b1.png')]),
  { updated: [], removed: ['a'] })
check('上游产出被清空（节点还在但没 url）→ removed',
  compareUpstreamFingerprint(fingerprint, [out('a', ''), out('b', 'b1.png')]),
  { updated: [], removed: ['a'] })
check('指纹里没有的新上游 → 两边都不算',
  compareUpstreamFingerprint(fingerprint, [out('a', 'a1.png'), out('b', 'b1.png'), out('z', 'z1.png')]),
  { updated: [], removed: [] })
check('两边只差空白 → 不算变（避免假阳性）',
  compareUpstreamFingerprint({ a: 'a1.png' }, [out('a', ' a1.png ')]),
  { updated: [], removed: [] })
check('空指纹（从没跑过）→ 什么都不报',
  compareUpstreamFingerprint({}, [out('a', 'a2.png')]),
  { updated: [], removed: [] })

console.log('\n角标判定：')
check('有更新 → 出「上游已更新，建议重跑」',
  resolveUpstreamStaleBadge({ updated: ['a'], removed: [] }),
  { kind: 'updated', text: UPSTREAM_UPDATED_BADGE_TEXT, count: 1 })
check('多个更新 → 计数正确',
  resolveUpstreamStaleBadge({ updated: ['a', 'b'], removed: [] }),
  { kind: 'updated', text: UPSTREAM_UPDATED_BADGE_TEXT, count: 2 })
check('只有上游被删 → 静默（不出角标）',
  resolveUpstreamStaleBadge({ updated: [], removed: ['a'] }),
  null)
check('更新 + 删除同时存在 → 更新赢',
  resolveUpstreamStaleBadge({ updated: ['a'], removed: ['b'] }),
  { kind: 'updated', text: UPSTREAM_UPDATED_BADGE_TEXT, count: 1 })
check('都没有 → 静默',
  resolveUpstreamStaleBadge({ updated: [], removed: [] }),
  null)

console.log('\n反证（这些断言必须失败，证明上面不是「怎么改都过」）：')
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
// 若把「删除」也当成 updated，下面这一条就会成立（实际必须不成立）
reverseAssert('上游被删不应被算成「已更新」',
  resolveUpstreamStaleBadge(compareUpstreamFingerprint({ a: 'a1.png' }, []))?.kind === 'updated')
// 若比较时不做 trim，空白就会被判成变化
reverseAssert('只差空白的 url 不应被判成已变',
  compareUpstreamFingerprint({ a: 'a1.png' }, [out('a', ' a1.png ')]).updated.length > 0)
// 若新接入的上游被当成「已变」，这里会成立
reverseAssert('指纹里没有的新上游不应触发角标',
  resolveUpstreamStaleBadge(
    compareUpstreamFingerprint({ a: 'a1.png' }, [out('a', 'a1.png'), out('z', 'z1.png')]),
  ) !== null)
check('反证组本身没有意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
