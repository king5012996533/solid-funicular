/**
 * 连线上「插入中间节点」的合法性判定单测（2026-09-26，工作包 A1）
 *
 * 要钉死的事：在 A→B 上插入 N 之后，必须变成 A→N→B 且**两条边都仍然有人消费**。
 * 只满足一条的组合不能给入口 —— 否则会造出一条没人读的边，正是要削掉的假交互。
 *
 * 跑法：npx tsx tests/canvas-edge-insert.test.ts（由 npm run test:unit 统一跑）
 */

import {
  describeInsertionRefusal,
  isCoherentConnection,
  resolveInsertableNodeTypes,
} from '../src/views/workflow/config/node-suggestions'
import { resolveCardSize, resolveInsertedNodePosition } from '../src/views/workflow/config/node-size'

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

console.log('可插入类型（A→N→B 两条边都要合规）：')
check('文本 → 图片：只有图片（文本可当提示词、图片可当参考图）',
  resolveInsertableNodeTypes('text', 'image'), ['image'])
check('文本 → 视频：只有图片（图片可当首帧）',
  resolveInsertableNodeTypes('text', 'video'), ['image'])
check('图片 → 图片：只有图片（图生图）',
  resolveInsertableNodeTypes('image', 'image'), ['image'])
check('图片 → 视频：只有图片（图片当首帧）',
  resolveInsertableNodeTypes('image', 'video'), ['image'])
check('素材 → 视频：只有图片（素材当首帧）',
  resolveInsertableNodeTypes('asset', 'video'), ['image'])

console.log('\n没有合法中间节点 → 不给入口：')
check('视频没有任何下游 → 插不进',
  resolveInsertableNodeTypes('video', 'video'), [])
check('目标是文本节点（谁都不读文本节点）→ 插不进',
  resolveInsertableNodeTypes('image', 'text'), [])
check('起点是编组框（不连线）→ 插不进',
  resolveInsertableNodeTypes('group', 'image'), [])
check('终点是编组框 → 插不进',
  resolveInsertableNodeTypes('image', 'group'), [])

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
reverseAssert('若只看 A→N 就会把 video 也当成可插入类型',
  resolveInsertableNodeTypes('text', 'image').includes('video'))
reverseAssert('若编组框能被当成中间节点，group 会出现在候选里',
  resolveInsertableNodeTypes('image', 'video').includes('group'))
reverseAssert('若自身不参与合规判定，image→text→? 会给出候选',
  resolveInsertableNodeTypes('image', 'text').length > 0)
check('反证组本身没有意外失败', reverseFailed, 0)

console.log('\n拒绝时可读：')
check('有候选时拒绝文案为空串',
  describeInsertionRefusal('text', 'image'), '')
check('无候选时给一句带两端类型的人话',
  describeInsertionRefusal('video', 'video').includes('视频生成') &&
    describeInsertionRefusal('video', 'video').includes('之间没有可插入的节点'), true)
check('目标为文本时也给出带名称的拒绝文案',
  describeInsertionRefusal('video', 'text').includes('文本节点'), true)

console.log('\n插入落点（A→B 中点偏上）：')
check('中点偏移：源中心(100,100) 目标中心(500,100)、插入节点 200×100、上偏 64',
  resolveInsertedNodePosition({ x: 100, y: 100 }, { x: 500, y: 100 }, { width: 200, height: 100 }),
  { x: 200, y: -14 })
check('上偏量默认把节点抬到连线之上（y 比不偏时更小）',
  resolveInsertedNodePosition({ x: 0, y: 0 }, { x: 0, y: 0 }, { width: 100, height: 100 }, 0).y
    > resolveInsertedNodePosition({ x: 0, y: 0 }, { x: 0, y: 0 }, { width: 100, height: 100 }).y,
  true)

console.log('\n按类型解析插入节点尺寸：')
check('文本节点 = 工具类正方形', resolveCardSize({ type: 'text' }), { width: 350, height: 350 })
check('图片节点竖版跟比例走', resolveCardSize({ type: 'image', ratio: '9:16' }), { width: 350, height: 622 })
check('图片节点缺比例回落到横版', resolveCardSize({ type: 'image' }), { width: 622, height: 350 })

console.log('\n合规表本身（防止 resolveInsertableNodeTypes 的筛选条件被改空）：')
check('图片 → 图片 合规', isCoherentConnection('image', 'image'), true)
check('图片 → 编组框 不合规', isCoherentConnection('image', 'group'), false)
check('视频 → 图片 不合规（视频没有下游）', isCoherentConnection('video', 'image'), false)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
