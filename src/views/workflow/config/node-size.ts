/**
 * 画布节点卡片的尺寸规则（对齐 LibTV 实测，2026-09-22）
 *
 * 实测数据（登录后在真实画布上量 `offsetWidth/offsetHeight`，与画布缩放无关）：
 *
 *   | 类型 | 布局尺寸 | 说明 |
 *   |---|---|---|
 *   | 文本 / 音频 / 智能剪辑 / 导演台 | 350 × 350 | 工具类，正方形 |
 *   | 逐帧拉片 | 320 × 389 | 唯一的竖长例外 |
 *   | 图片 / 视频 | 622 × 350 | 生成类，16:9 |
 *
 * **关键结论（我一开始猜错、后来实测纠正）**：生成类节点的尺寸不是固定 16:9，
 * 而是**跟着「比例」参数走**。可信的判别实验：新建一个空视频节点，比例从 16:9
 * 换成 9:16，节点从 `622×350` 变成 `350×622`。
 *
 * 所以这里的规则是「长边 / 短边」，不是「每个类型写死一对数」：
 *   横版（16:9 等）→ 622 × 350
 *   竖版（9:16 等）→ 350 × 622
 *   方版（1:1）    → 350 × 350（与工具类同宽，**这一档 LibTV 上没验证过**：
 *                    他们当时的图片模型只提供 16:9，我只能按长/短边规则外推）
 *
 * 内容一律 `object-fit: cover` 填满这张框 —— LibTV 的图片节点就是
 * `h-full w-full object-cover`，也就是说**非当前比例的图会被裁切，而不是让卡片变形**。
 */

import { parseAspectRatio } from '@/config/model-params'

/** 生成类节点的长边（横版时的宽 / 竖版时的高） */
export const CANVAS_GENERATION_LONG_EDGE = 622
/** 生成类节点的短边（横版时的高 / 竖版时的宽） */
export const CANVAS_GENERATION_SHORT_EDGE = 350
/** 工具类节点（文本 / 音频 / 智能剪辑 / 导演台）的边长 */
export const CANVAS_TOOL_NODE_EDGE = 350
/** 工具类节点的完整尺寸（固定正方形） */
export const CANVAS_TOOL_NODE_SIZE: NodeCardSize = { width: CANVAS_TOOL_NODE_EDGE, height: CANVAS_TOOL_NODE_EDGE }
/** 逐帧拉片：LibTV 实测的确是个竖长的例外 */
export const CANVAS_TALL_TOOL_NODE_SIZE: NodeCardSize = { width: 320, height: 389 }

export interface NodeCardSize {
  width: number
  height: number
}


/** 方形判定容差：像素档（2048x2048）与实际比例档（1x1）都要能命中 */
const SQUARE_TOLERANCE = 0.02

/**
 * 比例解析复用共享实现（`@/config/model-params` 的 parseAspectRatio）。
 *
 * 原先这里自己有一份，后来参数面板的比例图形卡也要用同一套规则 ——
 * 两份实现迟早会漂移，所以留一个别名指过去，导出名保持不变（测试与调用方无需改动）。
 */
export const parseRatioAspect = parseAspectRatio

/**
 * 生成类节点（图片 / 视频）的卡片尺寸。
 *
 * 比例缺失或写坏时回落到横版 —— 横版是各类生成节点的默认档（图片 16:9、视频默认 16x9），
 * 回落到竖版会让空节点看起来像被裁了一半。
 */
export const resolveGenerationCardSize = (ratio?: string): NodeCardSize => {
  const aspect = parseRatioAspect(ratio)
  if (aspect === null) {
    return { width: CANVAS_GENERATION_LONG_EDGE, height: CANVAS_GENERATION_SHORT_EDGE }
  }
  if (Math.abs(aspect - 1) <= SQUARE_TOLERANCE) {
    return { width: CANVAS_TOOL_NODE_EDGE, height: CANVAS_TOOL_NODE_EDGE }
  }
  return aspect < 1
    ? { width: CANVAS_GENERATION_SHORT_EDGE, height: CANVAS_GENERATION_LONG_EDGE }
    : { width: CANVAS_GENERATION_LONG_EDGE, height: CANVAS_GENERATION_SHORT_EDGE }
}

/** 把尺寸拼成可直接绑到 style 的对象 */
export const cardSizeStyle = (size: NodeCardSize) => ({
  width: `${size.width}px`,
  height: `${size.height}px`,
})

/**
 * 按节点类型解析卡片尺寸，用于「算插入节点落点」这类不依赖 Vue Flow 测量的场合。
 *
 * 生成类（图片 / 视频）跟比例走；其余（文本 / 素材，以及编组框自身）按工具类正方形。
 * 类型用 string 而不是 WorkflowNodeType —— 这个文件是纯几何层，不反过来依赖状态层。
 */
export const resolveCardSize = (input: { type?: string; ratio?: string }): NodeCardSize => {
  const type = String(input?.type || '')
  if (type === 'image' || type === 'video') return resolveGenerationCardSize(input?.ratio)
  return CANVAS_TOOL_NODE_SIZE
}

/** 连线上插入的新节点相对 A→B 中点向上偏的量：不压住原来的连线 */
export const INSERTED_NODE_UPWARD_BIAS = 64

export interface CanvasPoint {
  x: number
  y: number
}

/**
 * A→B 连线上插入节点 N 时的落点（N 的左上角坐标）。
 *
 * 取 A 与 B 的**中心**连线的中点，再往上抬一点（`upwardBias`），并把 N 自身尺寸的一半退回去，
 * 因为 Vue Flow 节点按左上角定位。抬起来是为了让新节点压在连线之上、一眼能看出它接在中间。
 */
export const resolveInsertedNodePosition = (
  sourceCenter: CanvasPoint,
  targetCenter: CanvasPoint,
  insertedSize: NodeCardSize,
  upwardBias = INSERTED_NODE_UPWARD_BIAS,
): CanvasPoint => ({
  x: (sourceCenter.x + targetCenter.x) / 2 - insertedSize.width / 2,
  y: (sourceCenter.y + targetCenter.y) / 2 - insertedSize.height / 2 - upwardBias,
})
