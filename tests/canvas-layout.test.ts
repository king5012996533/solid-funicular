/**
 * 画布自动布局的验证
 *
 * 布局算错比没有更糟 —— 一屏节点被堆到一起，用户得手动一个个挪回去。
 * 所以这里重点守三件事：
 *   1. 不会把两个节点放到同一个位置（重叠）
 *   2. 多层上游的节点一定落在所有上游的右边（用最长路径分层的原因）
 *   3. 有环时能终止，且不崩
 */

import { computeCanvasLayout } from '../src/views/workflow/config/canvas-layout'

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

const node = (id: string, y = 0, width = 300, height = 200) => ({ id, position: { x: 0, y }, width, height })
const edge = (source: string, target: string) => ({ source, target })

const noOverlap = (positions: Map<string, { x: number; y: number }>) => {
  const list = [...positions.entries()]
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [, a] = list[i]
      const [, b] = list[j]
      if (a.x === b.x && a.y === b.y) return false
    }
  }
  return true
}

console.log('\n【1】单节点与空图')
{
  check('空图不崩', computeCanvasLayout([], []).positions.size, 0)
  const one = computeCanvasLayout([node('a')], [])
  check('单节点落在原点', one.positions.get('a'), { x: 0, y: 0 })
  check('只有一列', one.columnCount, 1)
}

console.log('\n【2】链式流向：按层分列，从左到右')
{
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const { positions, columnCount } = computeCanvasLayout(nodes, edges)

  check('三列', columnCount, 3)
  const ax = positions.get('a')!.x
  const bx = positions.get('b')!.x
  const cx = positions.get('c')!.x
  check('严格递增 a < b < c', ax < bx && bx < cx, true)
  check('同一列内只有一个节点时纵坐标相同', [positions.get('a')!.y, positions.get('b')!.y, positions.get('c')!.y], [0, 0, 0])
}

console.log('\n【3】多上游取最长路径：不会出现连线往左指')
{
  // a → b → d，同时 a → d。d 有两条入边（长度 1 与 2）
  const nodes = [node('a'), node('b'), node('d')]
  const edges = [edge('a', 'b'), edge('b', 'd'), edge('a', 'd')]
  const { positions } = computeCanvasLayout(nodes, edges)

  const ax = positions.get('a')!.x
  const bx = positions.get('b')!.x
  const dx = positions.get('d')!.x
  // 取最短路径的话 d 会和 b 同列，a→b 的箭头方向就乱了
  check('d 在所有上游右侧', dx > ax && dx > bx, true)
  check('b 在 a 右侧', bx > ax, true)
}

console.log('\n【4】分支与汇聚：同一列的节点不重叠')
{
  // a 分出 b、c，再汇聚到 d
  const nodes = [node('a', 0), node('b', 0), node('c', 400), node('d')]
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
  const { positions, columnCount } = computeCanvasLayout(nodes, edges)

  check('三列（a | b,c | d）', columnCount, 3)
  check('无重叠', noOverlap(positions), true)
  check('b 与 c 同列（x 相同）', positions.get('b')!.x, positions.get('c')!.x)
  check('同列内不重叠（y 不同）', positions.get('b')!.y !== positions.get('c')!.y, true)
}

console.log('\n【5】列内保留用户当前的纵向顺序')
{
  // c 本来在 b 上面（y 更小），整理后应当仍是这个相对顺序
  const nodes = [node('a', 0), node('b', 500), node('c', 100)]
  const edges = [edge('a', 'b'), edge('a', 'c')]
  const { positions } = computeCanvasLayout(nodes, edges)

  check('c 仍在 b 上方', positions.get('c')!.y < positions.get('b')!.y, true)
}

console.log('\n【6】孤立节点也算进布局，不会留在原地叠着')
{
  const nodes = [node('a'), node('b'), node('lonely')]
  const edges = [edge('a', 'b')]
  const { positions } = computeCanvasLayout(nodes, edges)

  check('孤立节点有位置', positions.has('lonely'), true)
  check('无重叠', noOverlap(positions), true)
  check('孤立节点落在第 0 列', positions.get('lonely')!.x, positions.get('a')!.x)
}

console.log('\n【7】环：必须能终止，且不崩')
{
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
  const result = computeCanvasLayout(nodes, edges)

  check('返回了全部节点', result.positions.size, 3)
  check('无重叠', noOverlap(result.positions), true)
  // 纯环没有入口，会被线性化成从左到右的三列，回边自然绕回去。
  // 这比"全塞进一列"好得多 —— 后者会把三个节点叠在一起、反而看不出结构。
  // （我原本以为会降级成单列，是测试把这个错误期望抓出来的）
  check('纯环被线性化成三列', result.columnCount, 3)
}

console.log('\n【8】坏数据容错：悬空边、自环、重复边')
{
  const nodes = [node('a'), node('b')]
  const edges = [
    edge('a', 'b'),
    edge('a', 'ghost'),   // 悬空：目标不存在
    edge('ghost', 'b'),   // 悬空：来源不存在
    edge('a', 'a'),       // 自环
    edge('a', 'b'),       // 重复
  ]
  const { positions, columnCount } = computeCanvasLayout(nodes, edges)

  check('只处理合法边后仍是两列', columnCount, 2)
  check('节点都有位置', positions.size, 2)
  check('b 在 a 右侧', positions.get('b')!.x > positions.get('a')!.x, true)
}

console.log('\n【9】间距参数生效')
{
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const tight = computeCanvasLayout(nodes, edges, { gapX: 10 })
  const loose = computeCanvasLayout(nodes, edges, { gapX: 500 })

  const tightSpan = tight.positions.get('c')!.x - tight.positions.get('a')!.x
  const looseSpan = loose.positions.get('c')!.x - loose.positions.get('a')!.x
  check('gapX 越大跨度越大', looseSpan > tightSpan, true)
}

console.log('\n【10】未测量尺寸时用兜底值，仍不重叠')
{
  const nodes = [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'b', position: { x: 0, y: 0 } }]
  const { positions } = computeCanvasLayout(nodes, [])
  check('无尺寸信息也能算出位置', positions.size, 2)
  check('无重叠', noOverlap(positions), true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
