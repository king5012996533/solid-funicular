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
 * 把「比例」参数解析成宽高比。
 *
 * 参数可能是比例写法（`16x9`）也可能是像素档（`2048x2048` / `1440x2560`），
 * 两种都要认 —— 图片节点存的是像素档，视频节点存的是比例写法。
 * 认不出来（`auto` / 空值）时返回 null，由调用方决定回落。
 */
export const parseRatioAspect = (ratio?: string): number | null => {
  const matched = String(ratio || '').trim().match(/^(\d+(?:\.\d+)?)\s*[x×:]\s*(\d+(?:\.\d+)?)$/)
  if (!matched) return null
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!width || !height) return null
  return width / height
}

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
