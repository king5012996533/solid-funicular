/**
 * 节点工具栏贴边收敛的验证
 *
 * 这段算法的由来：LibTV 的节点工具栏是**死板地按卡片中心对齐**的，节点贴左/右边时
 * 整条会被裁出屏幕（实测：节点中心在 x=183，工具栏第一项却跑到 x=-355）。
 * 我们抄它的行为，但修掉这个缺陷。
 *
 * 第 2 组用例用的是浏览器实测的那组真实数字（窗口 820 宽、工具栏 396、卡片中心 749），
 * 是用来防止「改个边距就把位置算偏」这类不会报错、只表现为看着有点偏的回归。
 */

import { resolveToolbarShift } from '../src/views/workflow/composables/useNodeToolbar'

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

const CANVAS_1400 = { left: 0, right: 1400, width: 1400 }

console.log('\n【1】不需要收敛时不能动位置')
{
  check('卡片居中、工具栏放得下 → 不位移', resolveToolbarShift({ cardCenterScreenX: 700, toolbarWidth: 396, canvas: CANVAS_1400 }), 0)
  check('量不到画布 → 一律不位移', resolveToolbarShift({ cardCenterScreenX: 100, toolbarWidth: 396, canvas: null }), 0)
  check(
    '工具栏比画布还宽 → 放弃收敛（否则会左右横跳）',
    resolveToolbarShift({ cardCenterScreenX: 200, toolbarWidth: 900, canvas: { left: 0, right: 820, width: 820 } }),
    0,
  )
  check(
    '刚好放下（宽度 = 画布 - 2×边距）→ 不位移',
    resolveToolbarShift({ cardCenterScreenX: 400, toolbarWidth: 796, canvas: { left: 0, right: 820, width: 820 } }),
    0,
  )
}

console.log('\n【2】浏览器实测的那组数字（820 宽窗口、工具栏 396、卡片中心 749）')
{
  const canvas = { left: 0, right: 820, width: 820 }
  // 不收敛时工具栏会落在 551..947，右边被裁掉 127px；收敛后应该落在 412..808
  check('卡片中心 749 → 左移 139px', resolveToolbarShift({ cardCenterScreenX: 749, toolbarWidth: 396, canvas }), -139)
  const shift = resolveToolbarShift({ cardCenterScreenX: 749, toolbarWidth: 396, canvas })
  check('收敛后右边缘正好留 12px 边距', Math.round(749 + shift + 396 / 2), 820 - 12)
}

console.log('\n【3】左右两边都要收敛')
{
  const canvas = { left: 100, right: 900, width: 800 }
  check('卡片中心贴左边界 100 → 右移到 100+12+198', resolveToolbarShift({ cardCenterScreenX: 100, toolbarWidth: 396, canvas }), 100 + 12 + 198 - 100)
  check('卡片中心贴右边界 900 → 左移到 900-12-198', resolveToolbarShift({ cardCenterScreenX: 900, toolbarWidth: 396, canvas }), 900 - 12 - 198 - 900)
  check('画布左边距不为 0 时也按可视区算', resolveToolbarShift({ cardCenterScreenX: 0, toolbarWidth: 200, canvas }), 100 + 12 + 100 - 0)
}

console.log('\n【4】收敛后一定完全落在画布里（随机扫一遍）')
{
  const canvas = { left: 40, right: 1240, width: 1200 }
  const widths = [120, 396, 620]
  let allInside = true
  let worst = ''
  for (const toolbarWidth of widths) {
    for (let center = -500; center <= 1800; center += 17) {
      const shift = resolveToolbarShift({ cardCenterScreenX: center, toolbarWidth, canvas })
      const visualCenter = center + shift
      const left = visualCenter - toolbarWidth / 2
      const right = visualCenter + toolbarWidth / 2
      if (left < canvas.left - 0.001 || right > canvas.right + 0.001) {
        allInside = false
        worst = `W=${toolbarWidth} center=${center} → ${Math.round(left)}..${Math.round(right)}`
      }
    }
  }
  check('所有位置与宽度下都完整可见', allInside, true)
  if (worst) console.log(`     越界样例：${worst}`)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
