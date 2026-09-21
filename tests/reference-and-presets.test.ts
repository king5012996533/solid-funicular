/**
 * 参考图校验 + 提示词预设的验证
 *
 * 这两块都是纯逻辑，放在 Node 里直接跑比点界面精确得多，也能覆盖
 * 「扩展名缺失」「data URL」「重复插入」「移除后残留标点」这类边界。
 */

import {
  isRasterReferenceUrl,
  shouldProbeReferenceUrl,
  validateReferenceUrls,
} from '../src/config/reference-validation'
import {
  STYLE_PRESETS,
  appendPreset,
  hasPreset,
  removePreset,
  type PromptPreset,
} from '../src/config/prompt-presets'

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

console.log('\n【1】栅格格式判定：上游解码得了的才放行')
{
  check('png', isRasterReferenceUrl('/uploads/a.png'), true)
  check('jpeg', isRasterReferenceUrl('/uploads/a.jpeg'), true)
  check('webp', isRasterReferenceUrl('/uploads/a.webp'), true)
  check('带 query 仍能判', isRasterReferenceUrl('/uploads/a.png?token=xyz'), true)
  check('带 hash 仍能判', isRasterReferenceUrl('/uploads/a.jpg#frag'), true)
  check('大写扩展名', isRasterReferenceUrl('/uploads/A.PNG'), true)

  // 这几类会让服务端 PIL 解码失败，必须拦住
  check('svg 拦住', isRasterReferenceUrl('/uploads/logo.svg'), false)
  check('pdf 拦住', isRasterReferenceUrl('/uploads/doc.pdf'), false)
  check('heic 拦住', isRasterReferenceUrl('/uploads/photo.heic'), false)
  check('svg 带 query 也拦住', isRasterReferenceUrl('/uploads/logo.svg?v=2'), false)

  check('data:image 放行', isRasterReferenceUrl('data:image/png;base64,AAAA'), true)
  check('data: 非图片拦住', isRasterReferenceUrl('data:application/pdf;base64,AAAA'), false)
  // 关键边界：SVG 的 data URL 也以 data:image/ 开头，不能放过去。
  // 这条是从 RightPanel 那份旧实现里学到的 —— 我第一版就漏了。
  check('data:image/svg 拦住', isRasterReferenceUrl('data:image/svg+xml;base64,AAAA'), false)
  check('data:image/svg+xml 拦住', isRasterReferenceUrl('data:image/svg+xml,<svg/>'), false)

  // 没有扩展名时宁可不拦 —— 误伤一批本来能用的图更糟
  check('无扩展名放行', isRasterReferenceUrl('/api/asset/12345'), true)
  check('空值拦住', isRasterReferenceUrl(''), false)
  check('纯空格拦住', isRasterReferenceUrl('   '), false)
}

console.log('\n【2】整批校验：分开 valid 与 invalid 并给出原因')
{
  const result = validateReferenceUrls([
    '/uploads/ok1.png',
    '/uploads/bad.svg',
    '/api/asset/12345',
    '/uploads/bad2.heic',
  ])
  check('valid 只留能用的', result.valid, ['/uploads/ok1.png', '/api/asset/12345'])
  check('invalid 数量', result.invalid.length, 2)
  check('invalid 带上原因', result.invalid.every(i => !!i.reason), true)
  check('invalid 顺序稳定', result.invalid.map(i => i.url), ['/uploads/bad.svg', '/uploads/bad2.heic'])
  check('全合法时 invalid 为空', validateReferenceUrls(['/a.png']).invalid, [])
}

console.log('\n【2b】哪些 URL 需要发网络探测（本地内容不探）')
{
  // 这几条决定了「自动校验素材」会不会对本地内容白发请求
  check('普通上传路径要探', shouldProbeReferenceUrl('/uploads/a.png'), true)
  check('外链要探', shouldProbeReferenceUrl('https://cdn.example.com/a.png'), true)
  check('data URL 不探', shouldProbeReferenceUrl('data:image/png;base64,AAAA'), false)
  check('blob URL 不探', shouldProbeReferenceUrl('blob:http://localhost/a-b-c'), false)
  check('空值不探', shouldProbeReferenceUrl(''), false)
}

console.log('\n【3】风格预设：追加到句尾，重复点不会叠加')
{
  const preset = STYLE_PRESETS[0]
  check('预设非空', STYLE_PRESETS.length > 0, true)
  check('每个都有 key/标签/片段', STYLE_PRESETS.every(p => p.key && p.label && p.fragment), true)
  check('key 不重复', new Set(STYLE_PRESETS.map(p => p.key)).size, STYLE_PRESETS.length)

  check('空提示词直接放片段', appendPreset('', preset), preset.fragment)
  check('中文句尾用全角逗号衔接', appendPreset('一只猫', preset), `一只猫，${preset.fragment}`)
  check('已有逗号不重复加', appendPreset('一只猫，', preset), `一只猫，${preset.fragment}`)
  check('已有句号不重复加', appendPreset('一只猫。', preset), `一只猫。${preset.fragment}`)
  // 重复点同一个 chip 不应把片段叠两次
  const once = appendPreset('一只猫', preset)
  check('重复追加不叠加', appendPreset(once, preset), once)
}

console.log('\n【4】风格预设：取消时顺带收拾悬空标点')
{
  const preset = STYLE_PRESETS[1]
  const applied = appendPreset('画面描述', preset)
  check('取消后还原', removePreset(applied, preset), '画面描述')

  // 片段夹在中间：移除后不能留下「，，」
  const middle = `开头，${preset.fragment}，结尾`
  check('中间移除不残留双逗号', removePreset(middle, preset), '开头，结尾')

  check('没插入过则原样返回', removePreset('无关内容', preset), '无关内容')
  check('移除后判断已不在', hasPreset(removePreset(applied, preset), preset), false)
  check('插入后判断已在', hasPreset(applied, preset), true)
}

console.log('\n【5】风格与 @ 引用共存时互不干扰')
{
  const preset = STYLE_PRESETS[5]
  const prompt = appendPreset('把【图片1】的背景换成雪夜', preset)
  check('@ token 标记保留', prompt.includes('【图片1】'), true)
  check('风格片段也在', hasPreset(prompt, preset), true)
  check('移除风格后 token 不受影响', removePreset(prompt, preset).includes('【图片1】'), true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
