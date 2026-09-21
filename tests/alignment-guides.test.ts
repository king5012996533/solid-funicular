/**
 * 对齐辅助线的逻辑验证
 *
 * 为什么用单元测试而不是端到端点击：
 *   Vue Flow 的拖拽依赖 setPointerCapture + 真实指针事件，
 *   合成事件无法驱动。而这段逻辑本身是纯函数（输入节点位置与尺寸，
 *   输出吸附量与辅助线），直接用 Node 跑更可靠也更精确。
 */

import { useCanvasAlignmentGuides } from '../src/views/workflow/composables/useCanvasAlignmentGuides'

type Node = Parameters<ReturnType<typeof useCanvasAlignmentGuides>['computeAlignment']>[0]

const node = (
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 100,
): Node =>
  ({
    id,
    position: { x, y },
    dimensions: { width, height },
    hidden: false,
  }) as unknown as Node

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

const { guides, computeAlignment, clear } = useCanvasAlignmentGuides()

console.log('\n【1】顶边对齐：拖拽节点比参照低 4px（阈值内）')
{
  const dragged = node('a', 0, 104)
  const peer = node('b', 500, 100)
  const { dx, dy } = computeAlignment(dragged, [dragged, peer], 1)
  check('不产生横向吸附', dx, null)
  check('纵向吸附量为 -4', dy, -4)
  check('辅助线含参照顶边 y=100', guides.value.h, [100])
  check('无竖直辅助线', guides.value.v, [])
}

console.log('\n【2】超出阈值：拖拽节点比参照低 30px')
{
  clear()
  const dragged = node('a', 0, 130)
  const peer = node('b', 500, 100)
  const { dx, dy } = computeAlignment(dragged, [dragged, peer], 1)
  check('不吸附', [dx, dy], [null, null])
  check('不显示辅助线', [guides.value.v, guides.value.h], [[], []])
}

console.log('\n【3】缩放影响阈值：同样 4px 偏移，在 0.5 倍缩放下阈值等效翻倍')
{
  clear()
  // zoom=0.5 时阈值 = 6/0.5 = 12 画布单位，4px 仍在范围内
  const dragged = node('a', 0, 104)
  const peer = node('b', 500, 100)
  const { dy } = computeAlignment(dragged, [dragged, peer], 0.5)
  check('仍然吸附', dy, -4)

  clear()
  // zoom=3 时阈值 = 6/3 = 2 画布单位，4px 已超出
  const { dy: dy3 } = computeAlignment(dragged, [dragged, peer], 3)
  check('放大后不再吸附', dy3, null)
}

console.log('\n【4】同尺寸节点的左右中三组并列 → 取扫描顺序第一条（左边）')
{
  clear()
  // 拖拽 x=505 中心 605 右边 705；参照 x=500 中心 600 右边 700
  // 三组差值都是 5，属并列；扫描顺序为 左→中→右，故取左边线 x=500
  const d2 = node('a', 505, 0, 200)
  const peer = node('b', 500, 800, 200)
  const { dx } = computeAlignment(d2, [d2, peer], 1)
  check('中心吸附量 -5', dx, -5)
  check('并列时取左边线 x=500', guides.value.v, [500])
}

console.log('\n【5】尺寸未测量（width/height 为 0）时不做吸附')
{
  clear()
  const dragged = node('a', 0, 100, 0, 0)
  const peer = node('b', 500, 100)
  const { dx, dy } = computeAlignment(dragged, [dragged, peer], 1)
  check('不吸附', [dx, dy], [null, null])
  check('不显示辅助线', [guides.value.v, guides.value.h], [[], []])
}

console.log('\n【6】隐藏节点不参与比对')
{
  clear()
  const dragged = node('a', 0, 104)
  const peer = node('b', 500, 100)
  ;(peer as unknown as { hidden: boolean }).hidden = true
  const { dy } = computeAlignment(dragged, [dragged, peer], 1)
  check('忽略隐藏节点', dy, null)
}

console.log('\n【7】多节点命中：应收集全部命中的参考线位置')
{
  clear()
  const dragged = node('a', 0, 100)
  const p1 = node('b', 500, 100)
  const p2 = node('c', 900, 100)
  const { dy } = computeAlignment(dragged, [dragged, p1, p2], 1)
  check('已对齐无需位移', dy, 0)
  check('两条辅助线都记录', guides.value.h, [100])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
