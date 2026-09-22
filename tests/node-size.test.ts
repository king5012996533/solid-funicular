/**
 * 节点卡片尺寸规则的验证（对齐 LibTV 实测）
 *
 * 这套规则最容易退化的地方是「又变成每个类型写死一对数」，所以这里钉死两件事：
 *   1. 生成类节点的尺寸**跟比例参数走**（横 622×350 / 竖 350×622 / 方 350×350）；
 *   2. 比例缺失或写坏时必须回落成横版，不能随便给个竖版或 0 尺寸。
 *
 * 依据是登录 LibTV 真实画布量出来的数据，其中「跟比例走」这条是**判别实验**得到的：
 * 把空视频节点的比例从 16:9 换成 9:16，节点从 622×350 变成 350×622。
 */

import {
  CANVAS_GENERATION_LONG_EDGE,
  CANVAS_GENERATION_SHORT_EDGE,
  CANVAS_TOOL_NODE_SIZE,
  cardSizeStyle,
  parseRatioAspect,
  resolveGenerationCardSize,
} from '../src/views/workflow/config/node-size'

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

console.log('\n【1】比例参数解析：比例写法与像素档都要认')
{
  check('16x9 → 16/9', parseRatioAspect('16x9'), 16 / 9)
  check('9x16 → 9/16', parseRatioAspect('9x16'), 9 / 16)
  check('2048x2048 → 1（像素档）', parseRatioAspect('2048x2048'), 1)
  check('1440x2560 → 9/16（像素档竖版）', parseRatioAspect('1440x2560'), 1440 / 2560)
  check('冒号写法也认', parseRatioAspect('16:9'), 16 / 9)
  check('全角乘号也认', parseRatioAspect('16×9'), 16 / 9)
  check('auto 认不出来', parseRatioAspect('auto'), null)
  check('空值认不出来', parseRatioAspect(''), null)
  check('undefined 认不出来', parseRatioAspect(undefined), null)
  check('缺一半认不出来', parseRatioAspect('16x'), null)
  check('零不能算比例', parseRatioAspect('0x9'), null)
}

console.log('\n【2】生成类节点尺寸跟比例走（这是实测纠正过的那条）')
{
  check('16:9 → 622×350', resolveGenerationCardSize('16x9'), { width: CANVAS_GENERATION_LONG_EDGE, height: CANVAS_GENERATION_SHORT_EDGE })
  check('9:16 → 350×622', resolveGenerationCardSize('9x16'), { width: CANVAS_GENERATION_SHORT_EDGE, height: CANVAS_GENERATION_LONG_EDGE })
  check('1:1 → 350×350', resolveGenerationCardSize('1x1'), CANVAS_TOOL_NODE_SIZE)
  check('像素档方形 → 350×350', resolveGenerationCardSize('2048x2048'), CANVAS_TOOL_NODE_SIZE)
  check('像素档竖版 → 350×622', resolveGenerationCardSize('1440x2560'), { width: 350, height: 622 })
  check('21:9 横版 → 622×350', resolveGenerationCardSize('21x9'), { width: 622, height: 350 })
  check('3:4 竖版 → 350×622', resolveGenerationCardSize('3x4'), { width: 350, height: 622 })
}

console.log('\n【3】回落：认不出来的比例一律横版，绝不返回 0 或竖版')
{
  for (const bad of ['', 'auto', undefined, 'x', 'abc']) {
    const size = resolveGenerationCardSize(bad as string)
    check(`「${String(bad)}」回落到 622×350`, size, { width: 622, height: 350 })
  }
  check('任何输入都不会出现 0 尺寸', ['', 'auto', '9x16', '1x1', '16x9'].every((r) => {
    const s = resolveGenerationCardSize(r)
    return s.width > 0 && s.height > 0
  }), true)
}

console.log('\n【4】两个方向的短边/长边保持一致（不是两套写死的数）')
{
  const landscape = resolveGenerationCardSize('16x9')
  const portrait = resolveGenerationCardSize('9x16')
  check('横版的长边 = 竖版的长边', landscape.width, portrait.height)
  check('横版的短边 = 竖版的短边', landscape.height, portrait.width)
  check('长边 622 / 短边 350', [landscape.width, landscape.height], [622, 350])
}

console.log('\n【5】绑定到 style 时是 px 字符串（直接喂给 :style 不会掉单位）')
{
  check('输出带 px', cardSizeStyle({ width: 622, height: 350 }), { width: '622px', height: '350px' })
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
