/**
 * 入边「第 N 张」与图片角色的排序规则单测（2026-09-26）
 *
 * 为什么值得单独钉死：这两条规则以前**没有任何消费者** ——
 * 用户在画布边上点出来的 ③ 和选出来的「尾帧」都是空操作。
 * 现在三条取上游的路径（图片节点参考图、视频节点输入画面、@ 引用编号）都从这两个纯函数拿值，
 * 所以它们必须：稳定、可预测、并且**不改变老画布的表现**。
 *
 * 要钉死的事：
 *   1. 没编号时保持连线插入顺序（用户什么都没改，顺序不能自己跳）；
 *   2. 有编号时按编号，且编号的排在没编号的前面；
 *   3. 非法值（0 / 负数 / NaN / 非数字）一律当「没编号」；
 *   4. 未标注角色的边按「首帧」处理 —— 这是老画布行为不变的关键；
 *   5. 角色顺序是 首帧 → 尾帧 → 参考图，组内再看编号。
 *
 * 跑法：npx tsx tests/upstream-edge-order.test.ts（由 npm run test:unit 统一跑）
 */

import {
  orderImageEdgesByRole,
  readEdgeImageRole,
  readEdgeOrder,
  sortEdgesByExplicitOrder,
} from '../src/views/workflow/composables/upstream-inputs'

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

/** 造边：id 用来肉眼确认顺序，data 是边上挂的字段 */
const e = (id: string, data?: Record<string, unknown>) => ({ id, data })

console.log('读序号：')
check('正常数字', readEdgeOrder(e('a', { imageOrder: 3 }), 'imageOrder'), 3)
check('没写 → null', readEdgeOrder(e('a'), 'imageOrder'), null)
check('0 → null（0 不是有效位次）', readEdgeOrder(e('a', { imageOrder: 0 }), 'imageOrder'), null)
check('负数 → null', readEdgeOrder(e('a', { imageOrder: -1 }), 'imageOrder'), null)
check('NaN → null', readEdgeOrder(e('a', { imageOrder: Number.NaN }), 'imageOrder'), null)
check('非数字字符串 → null', readEdgeOrder(e('a', { imageOrder: 'abc' }), 'imageOrder'), null)
check('数字字符串可用', readEdgeOrder(e('a', { imageOrder: '2' }), 'imageOrder'), 2)
check('两个键互不串（promptOrder 不影响 imageOrder）',
  readEdgeOrder(e('a', { promptOrder: 5 }), 'imageOrder'), null)

console.log('\n按序号排序：')
check('都没编号 → 原样（稳定，顺序不自己跳）',
  sortEdgesByExplicitOrder([e('a'), e('b'), e('c')], 'imageOrder').map((x) => x.id), ['a', 'b', 'c'])
check('有编号按编号',
  sortEdgesByExplicitOrder([e('a', { imageOrder: 3 }), e('b', { imageOrder: 1 }), e('c', { imageOrder: 2 })], 'imageOrder').map((x) => x.id),
  ['b', 'c', 'a'])
check('编号的排在没编号的前面',
  sortEdgesByExplicitOrder([e('a'), e('b', { imageOrder: 2 }), e('c')], 'imageOrder').map((x) => x.id),
  ['b', 'a', 'c'])
check('编号相同 → 回到插入顺序',
  sortEdgesByExplicitOrder([e('a', { imageOrder: 2 }), e('b', { imageOrder: 2 })], 'imageOrder').map((x) => x.id),
  ['a', 'b'])
check('文本边（promptOrder）也走同一套',
  sortEdgesByExplicitOrder([e('a', { promptOrder: 2 }), e('b', { promptOrder: 1 })], 'promptOrder').map((x) => x.id),
  ['b', 'a'])
check('文本边不带 imageOrder → 原样（不会因为换了键就乱序）',
  sortEdgesByExplicitOrder([e('a', { promptOrder: 2 }), e('b', { promptOrder: 1 })], 'imageOrder').map((x) => x.id),
  ['a', 'b'])

console.log('\n读角色：')
check('没标注 → 首帧（老画布行为不变的关键）', readEdgeImageRole(e('a')), 'first_frame_image')
check('首帧', readEdgeImageRole(e('a', { imageRole: 'first_frame_image' })), 'first_frame_image')
check('尾帧', readEdgeImageRole(e('a', { imageRole: 'last_frame_image' })), 'last_frame_image')
check('参考图', readEdgeImageRole(e('a', { imageRole: 'input_reference' })), 'input_reference')
check('写了个不认识的值 → 首帧', readEdgeImageRole(e('a', { imageRole: 'whatever' })), 'first_frame_image')

console.log('\n按角色排序（这才是「首帧/尾帧」真正生效的地方）：')
check('老画布：两张都没标注 → 顺序不变（第一张=首帧、第二张=尾帧）',
  orderImageEdgesByRole([e('a'), e('b')]).map((x) => x.id), ['a', 'b'])
check('把第二张标成尾帧 → 还是 a,b（本来就该这样）',
  orderImageEdgesByRole([e('a'), e('b', { imageRole: 'last_frame_image' })]).map((x) => x.id), ['a', 'b'])
check('把第一张标成尾帧 → 顺序变成 b,a（用户的意思终于生效）',
  orderImageEdgesByRole([e('a', { imageRole: 'last_frame_image' }), e('b')]).map((x) => x.id), ['b', 'a'])
check('参考图排到首尾帧之后',
  orderImageEdgesByRole([e('a', { imageRole: 'input_reference' }), e('b'), e('c', { imageRole: 'last_frame_image' })]).map((x) => x.id),
  ['b', 'c', 'a'])
check('组内仍看「第 N 张」',
  orderImageEdgesByRole([
    e('a', { imageRole: 'first_frame_image', imageOrder: 2 }),
    e('b', { imageRole: 'first_frame_image', imageOrder: 1 }),
    e('c', { imageRole: 'last_frame_image' }),
  ]).map((x) => x.id), ['b', 'a', 'c'])
check('空输入安全', orderImageEdgesByRole([]).map((x) => x.id), [])

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
reverseAssert('不做角色排序时，标了尾帧的第一张必须还在原位',
  orderImageEdgesByRole([e('a', { imageRole: 'last_frame_image' }), e('b')]).map((x) => x.id).join() === 'a,b')
reverseAssert('排序若不稳定，全无编号的输入会被打乱',
  sortEdgesByExplicitOrder([e('c'), e('a'), e('b')], 'imageOrder').map((x) => x.id).join() === 'a,b,c')
reverseAssert('0 若被当成有效位次，它会插到所有编号前面',
  readEdgeOrder(e('a', { imageOrder: 0 }), 'imageOrder') === 0)
check('反证组本身没有意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
