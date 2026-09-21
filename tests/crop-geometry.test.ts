/**
 * 裁剪框几何运算的回归测试
 *
 * 这些边界在浏览器里靠手拖很难穷举（贴边、极小框、锁比例后超界），
 * 但恰好是最容易出 bug 的地方，所以用纯函数直接钉。
 */

import {
  MIN_CROP_SIZE,
  applyAspect,
  clampRect,
  cropToPixels,
  dragRect,
} from '../src/views/workflow/config/crop-geometry'

let passed = 0
let failed = 0
const check = (label: string, actual: unknown, expected: unknown) => {
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
const near = (value: number, target: number, tolerance = 0.001) => Math.abs(value - target) <= tolerance

console.log('\n【1】夹取：任何输入都要落在画面内，且不小于最小边长')
{
  check('负坐标被推回 0', clampRect({ x: -0.3, y: -0.2, width: 0.5, height: 0.5 }), { x: 0, y: 0, width: 0.5, height: 0.5 })
  check('右下越界被拉回', clampRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }), { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
  check('过小的框被抬到最小边长', clampRect({ x: 0.5, y: 0.5, width: 0.001, height: 0.001 }),
    { x: 0.5, y: 0.5, width: MIN_CROP_SIZE, height: MIN_CROP_SIZE })
  check('超大的框被压到 1', clampRect({ x: 0, y: 0, width: 2, height: 3 }), { x: 0, y: 0, width: 1, height: 1 })
}

console.log('\n【2】切比例：以中心为锚点，比例被精确满足，且不越界')
{
  const free = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  const square = applyAspect(free, 1)
  check('1:1 宽度 = 高度', near(square.width, square.height), true)
  check('1:1 中心没跑', [near(square.x + square.width / 2, 0.5), near(square.y + square.height / 2, 0.5)], [true, true])

  const wide = applyAspect(free, 16 / 9)
  check('16:9 比例正确', near(wide.width / wide.height, 16 / 9), true)
  check('16:9 没有越界', wide.x >= 0 && wide.x + wide.width <= 1.0001 && wide.y >= 0 && wide.y + wide.height <= 1.0001, true)

  // 贴边的框切比例后不能跑出画面
  const corner = applyAspect({ x: 0, y: 0, width: 0.4, height: 0.4 }, 16 / 9)
  check('贴左上角切 16:9 仍在画面内', corner.x >= 0 && corner.y >= 0 && corner.x + corner.width <= 1.0001, true)

  check('null 比例 = 自由（只夹取）', applyAspect(free, null), clampRect(free))
  check('非法比例不炸', applyAspect(free, 0), clampRect(free))
}

console.log('\n【3】拖动：平移夹取，拖边改变对应边')
{
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
  check('整体平移', dragRect(start, 'move', 0.1, 0.05), { x: 0.3, y: 0.25, width: 0.4, height: 0.4 })
  check('平移到底被夹住（尺寸不变）', dragRect(start, 'move', 5, 5), { x: 0.6, y: 0.6, width: 0.4, height: 0.4 })

  const right = dragRect(start, 'e', 0.1, 0)
  check('拖右边界：左边不动', right.x, 0.2)
  check('拖右边界：宽度变大', near(right.width, 0.5), true)
  check('拖右边界：高度不变', near(right.height, 0.4), true)

  const left = dragRect(start, 'w', 0.1, 0)
  check('拖左边界：右边界不动', near(left.x + left.width, 0.6), true)
  check('拖左边界：宽度变小', near(left.width, 0.3), true)

  check('拖到 0 宽度时停在最小边长', near(dragRect(start, 'e', -0.4, 0).width, MIN_CROP_SIZE), true)
}

console.log('\n【4】锁比例拖动：比例不被破坏，且不越界')
{
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
  const e1 = dragRect(start, 'e', 0.2, 0, 1)
  check('锁 1:1 拖右边：仍是正方形', near(e1.width, e1.height), true)
  check('锁 1:1 拖右边：左侧没动', near(e1.x, 0.2), true)

  const n1 = dragRect(start, 'n', 0, -0.1, 1)
  check('锁 1:1 拖上边：仍是正方形', near(n1.width, n1.height), true)
  check('锁 1:1 拖上边：下边没动', near(n1.y + n1.height, 0.6), true)

  // 往画面外拖：比例要保持，尺寸回缩
  const over = dragRect(start, 'e', 5, 0, 16 / 9)
  check('拖出画面仍保持 16:9', near(over.width / over.height, 16 / 9), true)
  check('拖出画面不越界', over.x + over.width <= 1.0001 && over.y + over.height <= 1.0001, true)
}

console.log('\n【5】换算到原图像素：不越界、至少 1px')
{
  check('中间裁一半', cropToPixels({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1024, 1024),
    { sx: 256, sy: 256, sw: 512, sh: 512 })
  check('贴右下角', cropToPixels({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 800),
    { sx: 500, sy: 400, sw: 500, sh: 400 })
  check('非方形图按各自轴换算', cropToPixels({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 1536, 1024),
    { sx: 768, sy: 512, sw: 768, sh: 512 })
  const tiny = cropToPixels({ x: 0, y: 0, width: 0.0001, height: 0.0001 }, 100, 100)
  check('极小框也至少 1px', [tiny.sw >= 1, tiny.sh >= 1], [true, true])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
