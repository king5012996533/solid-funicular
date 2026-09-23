import { ref } from 'vue'

/**
 * 画布对齐辅助线
 *
 * 拖拽节点时，把它与其他节点的「左/中/右」和「上/中/下」三条参考线做比对，
 * 命中阈值内就吸附过去，并把命中的参考线位置暴露出来用于渲染虚线。
 *
 * 设计取舍
 *   - 阈值按「屏幕像素」定义，再除以当前缩放换算到画布坐标。
 *     这样无论放大到 200% 还是缩小到 30%，吸附的手感距离都是一致的。
 *   - 只在拖拽期间计算与吸附；拖拽结束由调用方清理辅助线。
 *   - 计算是 O(n) 的（每个 peer 比 9 组参考线），对几十个节点的画布无压力；
 *     节点数量很大时再考虑空间索引。
 */

/** 吸附阈值（屏幕像素） */
const SNAP_THRESHOLD_PX = 6

/**
 * 参与对齐计算的最小节点形状。
 *
 * 为什么不用 Vue Flow 的 GraphNode：调用方手上是**本项目的** WorkflowCanvasNode[]
 * （画布自己的类型），与 GraphNode 结构不完全兼容，硬传会报 TS2345；而这个函数真正用到的
 * 只有 id / position / dimensions / hidden 四个字段。按需声明形状，两边都能直接传。
 */
export interface AlignmentNodeLike {
  id: string
  position: { x: number; y: number }
  dimensions?: { width: number; height: number } | null
  hidden?: boolean
}

export interface AlignmentGuides {
  /** 命中的竖向辅助线 x 坐标（画布坐标） */
  v: number[]
  /** 命中的横向辅助线 y 坐标（画布坐标） */
  h: number[]
}

export interface AlignmentDelta {
  /** 需要施加到 x 的修正量；null 表示未命中 */
  dx: number | null
  /** 需要施加到 y 的修正量；null 表示未命中 */
  dy: number | null
}

const EMPTY: AlignmentGuides = { v: [], h: [] }

function edges(values: [number, number]): [number, number, number] {
  const [start, size] = values
  return [start, start + size / 2, start + size]
}

export function useCanvasAlignmentGuides() {
  const guides = ref<AlignmentGuides>(EMPTY)

  function clear() {
    if (guides.value.v.length || guides.value.h.length) {
      guides.value = EMPTY
    }
  }

  /**
   * 计算拖拽节点与其余节点的对齐情况，并更新辅助线。
   *
   * @param dragged 正在拖拽的节点
   * @param peers   参与比对的节点集合（通常直接传 Vue Flow 给的 nodes）
   * @param zoom    当前画布缩放
   */
  function computeAlignment(
    dragged: AlignmentNodeLike,
    peers: AlignmentNodeLike[],
    zoom: number,
  ): AlignmentDelta {
    const dim = dragged.dimensions ?? { width: 0, height: 0 }
    const width = dim.width || 0
    const height = dim.height || 0

    // 宽高还没测量出来时不做吸附，避免把节点吸到错误位置
    if (!width || !height) {
      clear()
      return { dx: null, dy: null }
    }

    const tolerance = SNAP_THRESHOLD_PX / (zoom || 1)

    const [myLeft, myCenterX, myRight] = edges([dragged.position.x, width])
    const [myTop, myCenterY, myBottom] = edges([dragged.position.y, height])
    const myXs = [myLeft, myCenterX, myRight]
    const myYs = [myTop, myCenterY, myBottom]

    let dx: number | null = null
    let dy: number | null = null
    // 每个轴只保留「获胜」的那条参考线。
    // 否则两个同尺寸节点对齐时，顶边/中心/底边会同时命中，
    // 显示成 3 条横贯画布的虚线 —— 那是最常见的对齐场景，必须收敛成 1 条。
    //
    // 并列时的取舍：多个候选的 |delta| 相等时，取扫描顺序中的第一条
    // （横向为 左→中→右，纵向为 上→中→下）。这是确定性的，不随数据顺序抖动。
    let bestVerticalX: number | null = null
    let bestHorizontalY: number | null = null

    for (const peer of peers) {
      if (peer.id === dragged.id || peer.hidden) continue

      const peerDim = peer.dimensions
      if (!peerDim?.width || !peerDim?.height) continue

      const peerXs = edges([peer.position.x, peerDim.width])
      const peerYs = edges([peer.position.y, peerDim.height])

      for (const mine of myXs) {
        for (const theirs of peerXs) {
          if (Math.abs(mine - theirs) > tolerance) continue
          const delta = theirs - mine
          if (dx === null || Math.abs(delta) < Math.abs(dx)) {
            dx = delta
            bestVerticalX = theirs
          }
        }
      }

      for (const mine of myYs) {
        for (const theirs of peerYs) {
          if (Math.abs(mine - theirs) > tolerance) continue
          const delta = theirs - mine
          if (dy === null || Math.abs(delta) < Math.abs(dy)) {
            dy = delta
            bestHorizontalY = theirs
          }
        }
      }
    }

    if (bestVerticalX !== null || bestHorizontalY !== null) {
      guides.value = {
        v: bestVerticalX !== null ? [bestVerticalX] : [],
        h: bestHorizontalY !== null ? [bestHorizontalY] : [],
      }
    } else {
      clear()
    }

    return { dx, dy }
  }

  return { guides, computeAlignment, clear }
}
