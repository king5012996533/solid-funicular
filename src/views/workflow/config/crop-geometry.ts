/**
 * 裁剪框几何运算（纯函数，好测）
 *
 * 为什么单独抽出来：裁剪的坑全在数学上 —— 拖到边界要夹住、切比例时要保持
 * 视觉锚点不跳、最后换算成原图像素时别越界。这些用鼠标点在浏览器里试
 * 很难穷举（尤其是贴边和极小尺寸），但作为纯函数几行就能钉死。
 *
 * 坐标约定：rect 用**归一化比例**（0~1）而不是像素 —— 这样图片显示尺寸
 * 怎么缩放都不影响裁剪结果，换算成原图像素只在最后一步做一次。
 */

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export type CropHandle = 'move' | 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se'

/** 裁剪框最小边长（归一化）：太小就点不准，也没法拖 */
export const MIN_CROP_SIZE = 0.05

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 保留 6 位小数。
 * 裁剪框是会回显、会互相比较的 UI 状态，而 0.2 + 0.1 = 0.30000000000000004 ——
 * 这种噪声会让"框没动"被判成"动了"，也会让保存下来的框每次读都不一样。
 */
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/** 把裁剪框夹进 0~1，并保证不小于最小边长 */
export const clampRect = (rect: CropRect, minSize = MIN_CROP_SIZE): CropRect => {
  const width = clamp(rect.width, minSize, 1)
  const height = clamp(rect.height, minSize, 1)
  return {
    x: round6(clamp(rect.x, 0, 1 - width)),
    y: round6(clamp(rect.y, 0, 1 - height)),
    width: round6(width),
    height: round6(height),
  }
}

/**
 * 按目标宽高比调整裁剪框：**以中心为锚点**，再整体夹回画面内。
 * 锚点选中心而不是左上角，是为了切比例时框不会突然往一侧窜。
 */
export const applyAspect = (rect: CropRect, ratio: number | null): CropRect => {
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return clampRect(rect)
  }

  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2

  // 先尝试保持面积感：用原框的对角尺度推导新边长，视觉变化最小
  let width = rect.width
  let height = width / ratio
  if (height > 1) {
    height = 1
    width = height * ratio
  }
  if (width > 1) {
    width = 1
    height = width / ratio
  }

  // 保证不小于最小边长（横竖两个方向都要满足）
  if (width < MIN_CROP_SIZE) {
    width = MIN_CROP_SIZE
    height = width / ratio
  }
  if (height < MIN_CROP_SIZE) {
    height = MIN_CROP_SIZE
    width = height * ratio
  }

  return clampRect({ x: centerX - width / 2, y: centerY - height / 2, width, height })
}

/**
 * 拖动裁剪框。
 * @param handle 'move' 整体平移，其余是拖对应边/角
 * @param dx/dy 归一化位移
 * @param ratio 锁定的宽高比（null = 自由）
 */
export const dragRect = (
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null = null,
): CropRect => {
  if (handle === 'move') {
    return clampRect({ ...start, x: start.x + dx, y: start.y + dy })
  }

  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height

  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP_SIZE)
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP_SIZE, 1)
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP_SIZE)
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP_SIZE, 1)

  const next: CropRect = { x: left, y: top, width: right - left, height: bottom - top }
  if (!ratio) return clampRect(next)

  // 锁比例：以**没被拖的那条边**为基准反推另一条边，手感才是"拖谁动谁"
  const widthDriven = handle.includes('e') || handle.includes('w')
  let width = next.width
  let height = next.height
  if (widthDriven) {
    height = width / ratio
  } else {
    width = height * ratio
  }

  // 反推后可能超界，按可用空间回缩（保持比例不破）
  const maxWidth = handle.includes('w') ? right : 1 - left
  const maxHeight = handle.includes('n') ? bottom : 1 - top
  if (width > maxWidth) {
    width = maxWidth
    height = width / ratio
  }
  if (height > maxHeight) {
    height = maxHeight
    width = height * ratio
  }

  const anchorRight = handle.includes('w') ? right : left + width
  const anchorBottom = handle.includes('n') ? bottom : top + height
  return clampRect({
    x: handle.includes('w') ? anchorRight - width : left,
    y: handle.includes('n') ? anchorBottom - height : top,
    width,
    height,
  })
}

/** 归一化裁剪框 → 原图像素（四舍五入，且至少 1px，不越界） */
export const cropToPixels = (rect: CropRect, naturalWidth: number, naturalHeight: number) => {
  const safe = clampRect(rect)
  const sx = Math.round(safe.x * naturalWidth)
  const sy = Math.round(safe.y * naturalHeight)
  const sw = Math.max(1, Math.min(naturalWidth - sx, Math.round(safe.width * naturalWidth)))
  const sh = Math.max(1, Math.min(naturalHeight - sy, Math.round(safe.height * naturalHeight)))
  return { sx, sy, sw, sh }
}
