/**
 * 「素材清单」收敛的验证（2026-09-26）
 *
 * 这块逻辑决定**下游这一次到底提交了哪些素材、按什么顺序**。以前这件事由四条通道
 * （连线自动注入 / @ 显式引用 / AutoLink / 手动上传）各自算一遍，关掉 AutoLink
 * 还在带上游图这种静默错误在界面上看不出来，只能靠测试钉住。
 *
 * 要钉死的事：
 *   1. 顺序固定为 显式 → 手动 → 自动，且各组内部保持各自的先后（顺序稳定）；
 *   2. 同一 url 只进一次，来源取更强的那条（显式 > 手动 > 自动）；
 *   3. AutoLink 关闭时自动那部分整体消失，显式与手动一张不少；
 *   4. 视频的画面角色由 role 决定（首帧→尾帧→参考图），不按数组位置猜；
 *   5. 空输入 / 空 url / 上限这些边界不炸。
 *
 * 跑法：npx tsx tests/reference-collection.test.ts（由 npm run test:unit 统一跑）
 */

import {
  buildReferenceCollection,
  type ReferenceCandidate,
} from '../src/shared/reference-collection'

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

/** 简写：url + 可选字段 */
const c = (url: string, extra?: Partial<ReferenceCandidate>): ReferenceCandidate => ({ url, ...extra })

/** 只留「来源:url」，断言去重与顺序时不被无关字段干扰 */
const shape = (result: { items: Array<{ source: string; url: string }> }) =>
  result.items.map((item) => `${item.source}:${item.url}`)

console.log('空输入：')
check('三个来源都空 → 清单为空', buildReferenceCollection({ explicit: [], edge: [], autoLinkEnabled: true }), {
  items: [],
  frameItems: [],
})
check('没传 manual / edge 也是安全空值', shape(buildReferenceCollection({ explicit: [], edge: [], autoLinkEnabled: false })), [])
check('空 / 纯空格的 url 被丢掉', shape(buildReferenceCollection({
  explicit: [c(''), c('   '), c('https://cdn/a.png')],
  edge: [c('')],
  autoLinkEnabled: true,
})), ['explicit:https://cdn/a.png'])
check('url 两端空格被归一（同一张图不会算两条）', shape(buildReferenceCollection({
  explicit: [c(' https://cdn/a.png ')],
  edge: [c('https://cdn/a.png')],
  autoLinkEnabled: true,
})), ['explicit:https://cdn/a.png'])

console.log('\n顺序：显式 → 手动 → 自动，组内保持原顺序')
check('三来源各一条：顺序固定', shape(buildReferenceCollection({
  explicit: [c('/e1.png')],
  manual: [c('/m1.png')],
  edge: [c('/a1.png')],
  autoLinkEnabled: true,
})), ['explicit:/e1.png', 'manual:/m1.png', 'auto-from-edge:/a1.png'])
check('显式内部按提示词出现顺序', shape(buildReferenceCollection({
  explicit: [c('/e2.png'), c('/e1.png')],
  edge: [],
  autoLinkEnabled: true,
})), ['explicit:/e2.png', 'explicit:/e1.png'])
check('手动内部按上传顺序', shape(buildReferenceCollection({
  explicit: [],
  manual: [c('/m2.png'), c('/m1.png')],
  edge: [],
  autoLinkEnabled: true,
})), ['manual:/m2.png', 'manual:/m1.png'])
check('自动内部按连线顺序', shape(buildReferenceCollection({
  explicit: [],
  edge: [c('/a2.png'), c('/a1.png')],
  autoLinkEnabled: true,
})), ['auto-from-edge:/a2.png', 'auto-from-edge:/a1.png'])

console.log('\n去重与来源优先级：显式 > 手动 > 自动')
check('三来源同一条 url → 只留显式，且落在显式的位置', shape(buildReferenceCollection({
  explicit: [c('/same.png'), c('/e.png')],
  manual: [c('/same.png'), c('/m.png')],
  edge: [c('/same.png'), c('/a.png')],
  autoLinkEnabled: true,
})), ['explicit:/same.png', 'explicit:/e.png', 'manual:/m.png', 'auto-from-edge:/a.png'])
check('手动 + 自动同一条 → 留手动（手动那张不会被自动挤走）', shape(buildReferenceCollection({
  explicit: [],
  manual: [c('/same.png')],
  edge: [c('/same.png')],
  autoLinkEnabled: true,
})), ['manual:/same.png'])
check('只在自动里 → 归自动', shape(buildReferenceCollection({
  explicit: [],
  edge: [c('/a.png')],
  autoLinkEnabled: true,
})), ['auto-from-edge:/a.png'])
check('重复计数：同一 url 在清单里只出现一次', buildReferenceCollection({
  explicit: [c('/x.png')],
  manual: [c('/x.png')],
  edge: [c('/x.png')],
  autoLinkEnabled: true,
}).items.length, 1)

console.log('\nAutoLink 关闭：自动那部分整体消失，显式与手动一张不少')
check('关掉后只剩显式与手动', shape(buildReferenceCollection({
  explicit: [c('/e.png')],
  manual: [c('/m.png')],
  edge: [c('/a1.png'), c('/a2.png')],
  autoLinkEnabled: false,
})), ['explicit:/e.png', 'manual:/m.png'])
check('关掉后自动那条的 url 完全不在结果里', buildReferenceCollection({
  explicit: [],
  manual: [],
  edge: [c('/a.png')],
  autoLinkEnabled: false,
}).items, [])
check('开着才带上自动', shape(buildReferenceCollection({
  explicit: [],
  edge: [c('/a.png')],
  autoLinkEnabled: true,
})), ['auto-from-edge:/a.png'])

console.log('\n视频画面角色：由 role 决定，不按数组第 0 / 1 个猜')
check('首帧 → 尾帧 → 参考图重排', buildReferenceCollection({
  explicit: [],
  edge: [
    c('/ref.png', { role: 'reference' }),
    c('/last.png', { role: 'last-frame' }),
    c('/first.png', { role: 'first-frame' }),
  ],
  autoLinkEnabled: true,
}).frameItems.map((item) => item.url), ['/first.png', '/last.png', '/ref.png'])
check('手动首帧 / 尾帧由上传槽位定角色', buildReferenceCollection({
  explicit: [],
  edge: [],
  manualFirstFrame: '/m-first.png',
  manualLastFrame: '/m-last.png',
  autoLinkEnabled: true,
}).frameItems.map((item) => `${item.url}=${item.role}`), ['/m-first.png=first-frame', '/m-last.png=last-frame'])
check('手动尾帧不会被当成首帧（位置猜测的反例场景）',
  buildReferenceCollection({
    explicit: [],
    edge: [],
    manualLastFrame: '/only-last.png',
    autoLinkEnabled: true,
  }).frameItems.map((item) => item.role), ['last-frame'])
check('没标角色的按普通参考图排在首尾帧之后', buildReferenceCollection({
  explicit: [c('/plain.png')],
  edge: [c('/first.png', { role: 'first-frame' })],
  autoLinkEnabled: true,
}).frameItems.map((item) => `${item.url}=${item.role}`), ['/first.png=first-frame', '/plain.png=reference'])
check('无角色项的组内顺序不变（排序稳定）', buildReferenceCollection({
  explicit: [c('/p1.png'), c('/p2.png')],
  edge: [],
  autoLinkEnabled: true,
}).frameItems.map((item) => item.url), ['/p1.png', '/p2.png'])
check('items 仍是「提交顺序」，frameItems 只是视频用的重排', buildReferenceCollection({
  explicit: [c('/ref.png')],
  edge: [c('/first.png', { role: 'first-frame' })],
  autoLinkEnabled: true,
}).items.map((item) => item.url), ['/ref.png', '/first.png'])

console.log('\n元信息与上限：')
check('token / 来源节点 / 种类原样带出（界面靠它显示 @ 与跳转）', buildReferenceCollection({
  explicit: [c('/e.png', { token: '图片1', sourceNodeId: 'n_img', kind: 'image' })],
  edge: [],
  autoLinkEnabled: true,
}).items, [{ url: '/e.png', source: 'explicit', token: '图片1', sourceNodeId: 'n_img', kind: 'image', role: 'reference' }])
check('上限只截断结果，不改顺序', shape(buildReferenceCollection({
  explicit: [c('/1.png'), c('/2.png'), c('/3.png')],
  edge: [],
  autoLinkEnabled: true,
  limit: 2,
})), ['explicit:/1.png', 'explicit:/2.png'])
check('limit <= 0 表示不限', buildReferenceCollection({
  explicit: [c('/1.png'), c('/2.png'), c('/3.png')],
  edge: [],
  autoLinkEnabled: true,
  limit: 0,
}).items.length, 3)

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
reverseAssert('若去重不认来源优先级，自动会盖过手动那张',
  shape(buildReferenceCollection({
    explicit: [],
    manual: [c('/same.png')],
    edge: [c('/same.png')],
    autoLinkEnabled: true,
  })).join() === 'auto-from-edge:/same.png')
reverseAssert('若 AutoLink 关闭仍保留自动项，关掉开关等于没关',
  buildReferenceCollection({
    explicit: [],
    manual: [],
    edge: [c('/a.png')],
    autoLinkEnabled: false,
  }).items.map((item) => item.url).includes('/a.png'))
reverseAssert('若按位置而非角色排视频画面，尾帧会跑到首帧前面',
  buildReferenceCollection({
    explicit: [],
    edge: [c('/last.png', { role: 'last-frame' }), c('/first.png', { role: 'first-frame' })],
    autoLinkEnabled: true,
  }).frameItems[0]?.url === '/last.png')
check('反证组本身没有意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
