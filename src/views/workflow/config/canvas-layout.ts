/**
 * 画布自动布局（对齐 LibTV 的「整理画布」，快捷键 Option+Shift+F）
 *
 * 为什么做成纯函数：布局算错了比没有更糟 —— 一屏节点被堆到一起，
 * 用户还得手动一个个挪回去。所以把计算抽出来单测，界面上只负责把结果写回节点位置。
 *
 * 采用**分层布局**而不是简单网格：工作流天然是从左到右的流向
 * （文本 → 生成 → 加工），按「离根的层数」分列比按序号排更符合阅读习惯，
 * 也让连线基本不会回绕。
 *
 * 三层规则：
 *   1. 分层：每个节点的列号 = 从任一入口节点到它的**最长**路径长度。
 *      取最长而不是最短，是为了让「有多个上游的节点」落在所有上游的右边 ——
 *      用最短路径会出现连线往左指的情况。
 *   2. 列内排序：按节点**当前**的纵坐标排。不按拓扑序号重排 ——
 *      用户手动调整过的相对顺序应该被保留，整理画布只解决「乱」，不该重排意图。
 *   3. 摆放：列内纵向等距堆叠，整列相对整体高度居中。
 */

export interface LayoutNodeLike {
  id: string
  position: { x: number; y: number }
  width?: number
  height?: number
}

export interface LayoutEdgeLike {
  source: string
  target: string
}

export interface CanvasLayoutOptions {
  /** 列间距 */
  gapX?: number
  /** 行间距 */
  gapY?: number
  /** 节点未测量时的兜底尺寸 */
  fallbackWidth?: number
  fallbackHeight?: number
}

export interface CanvasLayoutResult {
  positions: Map<string, { x: number; y: number }>
  /** 分了多少列，便于测试与调试 */
  columnCount: number
}

const DEFAULT_OPTIONS: Required<CanvasLayoutOptions> = {
  gapX: 120,
  gapY: 60,
  fallbackWidth: 320,
  fallbackHeight: 220,
}

/**
 * 计算每个节点的列号（最长路径分层）。
 *
 * 环的处理：工作流理论上不该有环，但用户能连出来（A→B→A）。
 * 用「已访问集合」切断回边，保证算法一定终止，而不是靠 try/catch 兜底。
 */
const computeColumns = (
  nodeIds: string[],
  inbound: Map<string, string[]>,
  outbound: Map<string, string[]>,
): Map<string, number> => {
  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  const roots = nodeIds.filter(id => (inbound.get(id) || []).length === 0)
  // 没有任何入口时（整张图是一个环）随便挑一个当起点，保证每个节点都会被算到
  const seeds = roots.length ? roots : nodeIds.slice(0, 1)

  const walk = (id: string, current: number) => {
    if (visiting.has(id)) return   // 回边：切断
    const known = depth.get(id)
    if (known !== undefined && known >= current) return

    depth.set(id, current)
    visiting.add(id)
    for (const next of outbound.get(id) || []) {
      walk(next, current + 1)
    }
    visiting.delete(id)
  }

  for (const seed of seeds) walk(seed, 0)

  // 环上的节点可能一次都没走到（整图皆环），补成第 0 列
  for (const id of nodeIds) {
    if (!depth.has(id)) depth.set(id, 0)
  }

  return depth
}

export const computeCanvasLayout = (
  nodes: LayoutNodeLike[],
  edges: LayoutEdgeLike[],
  options: CanvasLayoutOptions = {},
): CanvasLayoutResult => {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const nodeIds = nodes.map(node => node.id)
  const validIds = new Set(nodeIds)

  const inbound = new Map<string, string[]>()
  const outbound = new Map<string, string[]>()

  for (const edge of edges) {
    // 只认得两端都存在的边；悬空边会让分层算出一个不存在的节点
    if (!validIds.has(edge.source) || !validIds.has(edge.target)) continue
    if (edge.source === edge.target) continue
    if (!outbound.has(edge.source)) outbound.set(edge.source, [])
    if (!inbound.has(edge.target)) inbound.set(edge.target, [])
    outbound.get(edge.source)!.push(edge.target)
    inbound.get(edge.target)!.push(edge.source)
  }

  const depth = computeColumns(nodeIds, inbound, outbound)

  // 按列分组，列内保持「当前纵坐标」的顺序 —— 保留用户的手动意图
  const columns = new Map<number, LayoutNodeLike[]>()
  for (const node of nodes) {
    const column = depth.get(node.id) || 0
    const list = columns.get(column)
    if (list) list.push(node)
    else columns.set(column, [node])
  }

  const columnKeys = [...columns.keys()].sort((a, b) => a - b)

  // 先算每列的宽度与总高度，才能让整列居中
  const measured = columnKeys.map((key) => {
    const columnNodes = columns.get(key) || []
    columnNodes.sort((a, b) => a.position.y - b.position.y)
    const width = Math.max(...columnNodes.map(n => n.width || config.fallbackWidth))
    const height = columnNodes.reduce((sum, n, index) => (
      sum + (n.height || config.fallbackHeight) + (index > 0 ? config.gapY : 0)
    ), 0)
    return { key, columnNodes, width, height }
  })

  const tallest = Math.max(...measured.map(item => item.height), 0)

  const positions = new Map<string, { x: number; y: number }>()
  let cursorX = 0

  for (const item of measured) {
    // 整列垂直居中：视觉重心一致，比全部顶对齐更容易一眼扫完
    let cursorY = (tallest - item.height) / 2

    for (const node of item.columnNodes) {
      const nodeWidth = node.width || config.fallbackWidth
      const nodeHeight = node.height || config.fallbackHeight
      // 列内按宽度居中对齐，宽窄不一的卡片看起来才是齐的
      positions.set(node.id, {
        x: cursorX + (item.width - nodeWidth) / 2,
        y: cursorY,
      })
      cursorY += nodeHeight + config.gapY
    }

    cursorX += item.width + config.gapX
  }

  return { positions, columnCount: columnKeys.length }
}
