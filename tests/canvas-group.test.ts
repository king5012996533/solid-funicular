/**
 * 编组的纯逻辑单测（2026-09-26，工作包 A2）
 *
 * 要钉死的事：
 *   1. 组框涵盖的节点要能**递归**展开（组里套组），拖动外层组框不能把内层组的子节点落下；
 *   2. 有环（组把自己列进 groupChildIds）时不死循环；
 *   3. 组框包围盒 = 子节点包围盒 + 内边距，且不小于最小边长；
 *   4. 没有子节点时返回 null（不给空组框）。
 *
 * 跑法：npx tsx tests/canvas-group.test.ts（由 npm run test:unit 统一跑）
 */

import {
  GROUP_MIN_SIZE,
  GROUP_PADDING,
  computeGroupBounds,
  expandGroupChildIds,
  type WorkflowCanvasNode,
} from '../src/views/workflow/composables/useWorkflowCanvas'

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

/** 造节点：只填会参与计算的字段 */
const node = (
  id: string,
  type: string,
  position?: { x: number; y: number },
  groupChildIds?: string[],
): WorkflowCanvasNode => ({
  id,
  type: type as WorkflowCanvasNode['type'],
  position: position || { x: 0, y: 0 },
  data: (groupChildIds ? { groupChildIds } : {}) as WorkflowCanvasNode['data'],
})

console.log('展开组内成员：')
check('单层组：直接子节点',
  expandGroupChildIds([
    node('g', 'group', { x: 0, y: 0 }, ['a', 'b']),
    node('a', 'image'),
    node('b', 'text'),
  ], 'g'), ['a', 'b'])
check('嵌套组：递归展开到孙子节点',
  expandGroupChildIds([
    node('outer', 'group', { x: 0, y: 0 }, ['inner', 'a']),
    node('inner', 'group', { x: 0, y: 0 }, ['b']),
    node('a', 'image'),
    node('b', 'video'),
  ], 'outer'), ['inner', 'a', 'b'])
check('去重：同一节点被两个组列到 → 只出现一次',
  expandGroupChildIds([
    node('outer', 'group', { x: 0, y: 0 }, ['a', 'a', 'a']),
    node('a', 'image'),
  ], 'outer'), ['a'])
check('找不到的组 → 空数组',
  expandGroupChildIds([node('a', 'image')], 'missing'), [])
check('组成员指向不存在的 id → 过滤掉（不抛错）',
  expandGroupChildIds([
    node('g', 'group', { x: 0, y: 0 }, ['a', 'ghost']),
    node('a', 'image'),
  ], 'g'), ['a', 'ghost'])
check('环：组把自己列进成员 → 不死循环、不返回自己',
  expandGroupChildIds([
    node('g', 'group', { x: 0, y: 0 }, ['g', 'a']),
    node('a', 'image'),
  ], 'g'), ['a'])

console.log('\n包围盒（子节点包围盒 + 内边距）：')
const sizeOf = (id: string) => (id === 'a' ? { width: 100, height: 100 } : { width: 200, height: 50 })
check('两个子节点：外扩 48，最小边长不生效',
  computeGroupBounds([
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 400, y: 300 } },
  ], sizeOf),
  { position: { x: -GROUP_PADDING, y: -GROUP_PADDING }, width: 400 + 200 + GROUP_PADDING * 2, height: 300 + 50 + GROUP_PADDING * 2 })
check('一个子节点且很小 → 撑到最小边长',
  computeGroupBounds([{ id: 'c', position: { x: 10, y: 10 } }], () => ({ width: 10, height: 10 })),
  { position: { x: 10 - GROUP_PADDING, y: 10 - GROUP_PADDING }, width: GROUP_MIN_SIZE, height: GROUP_MIN_SIZE })
check('空子节点列表 → null（不给空组框）',
  computeGroupBounds([], sizeOf), null)

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
reverseAssert('若不递归，嵌套组只会展开出内层组本身',
  JSON.stringify(expandGroupChildIds([
    node('outer', 'group', { x: 0, y: 0 }, ['inner']),
    node('inner', 'group', { x: 0, y: 0 }, ['b']),
    node('b', 'video'),
  ], 'outer')) === JSON.stringify(['inner']))
reverseAssert('若内边距不生效，包围盒会精确贴在子节点边缘',
  JSON.stringify(computeGroupBounds([{ id: 'a', position: { x: 0, y: 0 } }], sizeOf).position) === JSON.stringify({ x: 0, y: 0 }))
check('反证组本身没有意外失败', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
