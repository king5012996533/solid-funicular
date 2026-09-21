/**
 * @ 引用面板分组的验证
 *
 * 面板一级显示什么、按什么顺序显示，是用户在两次打开之间形成的肌肉记忆。
 * 这条规则很容易被「顺手按数量排一下」「空种类也留着占位」改坏，所以钉死：
 * 固定顺序 图片 → 文本 → 视频、空种类不出现、同类内保持输入顺序（否则菜单顺序
 * 会和 token 里的序号对不上）、全空返回空数组（面板据此显示空态文案）。
 */

import {
  REFERENCE_KIND_ORDER,
  groupReferenceAssets,
} from '../src/components/generate/mention-groups'
import type {
  ReferenceKind,
  ReferenceableAsset,
} from '../src/components/generate/mention-groups'

const KIND_LABELS: Record<ReferenceKind, string> = {
  image: '图片',
  text: '文本',
  video: '视频',
}

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

/** 造一个资产。字段与 reference-resolver 的 ReferenceableAsset 一致（值取什么无关紧要） */
function asset(kind: ReferenceKind, index: number, displayName: string): ReferenceableAsset {
  const kindLabel = KIND_LABELS[kind] ?? String(kind)
  return {
    index,
    kind,
    sourceNodeId: `node-${kind}-${index}`,
    kindLabel,
    token: `${kindLabel}${index}`,
    displayName,
    value: `${kind}-value-${index}`,
  }
}

console.log('\n【1】一级顺序固定为 图片 → 文本 → 视频（与传入顺序无关）')
{
  // 故意按 视频/文本/图片 传进来，分组后必须回到固定顺序
  const groups = groupReferenceAssets([
    asset('video', 1, '成片'),
    asset('text', 1, '文案'),
    asset('image', 1, '产品图'),
  ])
  check('固定顺序常量就是 图片/文本/视频', REFERENCE_KIND_ORDER, ['image', 'text', 'video'])
  check('种类顺序不受传入顺序影响', groups.map(g => g.kind), ['image', 'text', 'video'])
  check('种类名用中文', groups.map(g => g.label), ['图片', '文本', '视频'])
}

console.log('\n【2】没有资产的种类不出现')
{
  // 只有文本：图片、视频都不该占位
  const groups = groupReferenceAssets([asset('text', 1, '文案'), asset('text', 2, '文案二')])
  check('只剩下有资产的那一类', groups.map(g => g.kind), ['text'])
  check('空种类不产生分组项', groups.filter(g => g.items.length === 0), [])

  // 图片 + 视频，跳过中间的文本
  const sparse = groupReferenceAssets([asset('image', 1, '图'), asset('video', 1, '片')])
  check('跳过没有资产的中间种类', sparse.map(g => g.kind), ['image', 'video'])
}

console.log('\n【3】一个资产都没有时返回空数组')
{
  check('空输入 → 空数组', groupReferenceAssets([]), [])
  // 面板靠 length === 0 判断空态，所以这里必须是真的空数组，而不是含空分组
  check('空输入的分组数', groupReferenceAssets([]).length, 0)
}

console.log('\n【4】每组的数量就是该类资产数')
{
  const groups = groupReferenceAssets([
    asset('video', 1, '片1'),
    asset('image', 1, '图1'),
    asset('video', 2, '片2'),
    asset('image', 2, '图2'),
    asset('text', 1, '文案'),
    asset('video', 3, '片3'),
  ])
  check('数量按种类正确统计', groups.map(g => [g.kind, g.items.length]), [
    ['image', 2],
    ['text', 1],
    ['video', 3],
  ])
  check('数量之和等于输入总数', groups.reduce((sum, g) => sum + g.items.length, 0), 6)
}

console.log('\n【5】同类内保持传入顺序（与 token 序号对齐）')
{
  // 上游已按连线顺序编好序号，分组不能把它重排（比如按 displayName 排序）
  const groups = groupReferenceAssets([
    asset('image', 3, 'C 图'),
    asset('image', 1, 'A 图'),
    asset('image', 2, 'B 图'),
  ])
  check('图片按传入顺序排列', groups[0].items.map(i => i.displayName), ['C 图', 'A 图', 'B 图'])
  check('token 顺序与传入顺序一致', groups[0].items.map(i => i.token), ['图片3', '图片1', '图片2'])
}

console.log('\n【6】每组只装自己那一类的资产')
{
  const groups = groupReferenceAssets([
    asset('image', 1, '图'),
    asset('text', 1, '文'),
    asset('video', 1, '片'),
  ])
  check('没有错类资产', groups.map(g => g.items.every(i => i.kind === g.kind)), [true, true, true])
}

console.log('\n【7】不修改传入数组（纯函数）')
{
  const input = [asset('video', 1, '片'), asset('image', 1, '图')]
  const snapshot = JSON.stringify(input)
  groupReferenceAssets(input)
  check('调用后输入数组原样不动', JSON.stringify(input), snapshot)
}

console.log('\n【8】将来新增种类时资产不会被静默吞掉')
{
  // ReferenceKind 目前是闭集；这里模拟一个未知种类，它应排在固定三类之后而不是消失
  const unknown = asset('audio' as ReferenceKind, 1, '配乐')
  const groups = groupReferenceAssets([asset('image', 1, '图'), unknown])
  check('未知种类被追加在末尾', groups.map(g => g.kind), ['image', 'audio'])
  check('未知种类里的资产还在', groups[1].items.map(i => i.displayName), ['配乐'])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
