/**
 * 智能引用 AutoLink 的验证（对齐 LibTV）
 *
 * 这里最容易出的错是**静默失效**：开关关了却还在自动带素材、或者该带的时候没带 ——
 * 界面上都看不出来（用户只会发现「怎么多引了一张图」）。所以用测试把三种情形钉死：
 *   开 → 带；关 → 一个都不带；已经显式 @ 过的不重复带。
 */

import { appendAutoLinkedTokens, mergeReferenceImages, pickAutoLinkedAssets } from '../src/components/generate/auto-link'

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

const asset = (kind: string, token: string, value: string) => ({ kind, token, value, kindLabel: kind }) as never

const IMAGE_1 = asset('image', '图片1', 'https://cdn/1.png')
const IMAGE_2 = asset('image', '图片2', 'https://cdn/2.png')
const VIDEO_1 = asset('video', '视频1', 'https://cdn/1.mp4')
const TEXT_1 = asset('text', '文本1', '一段正文')

const base = {
  input: '把背景换成雪夜',
  referencedMediaUrls: [] as string[],
  assets: [IMAGE_1, IMAGE_2, VIDEO_1, TEXT_1],
}

console.log('\n【1】开关关闭 → 一个都不自动带（这是首要职责）')
{
  const result = appendAutoLinkedTokens({ ...base, enabled: false })
  check('提示词与入参逐字节相同', result.prompt, '把背景换成雪夜')
  check('没有自动引用 token', result.tokens, [])
  check('候选也是空的', pickAutoLinkedAssets({ ...base, enabled: false }), [])
}

console.log('\n【2】开关开启 → 补上未被引用的媒体素材 token')
{
  const result = appendAutoLinkedTokens({ ...base, enabled: true })
  check('图片1/图片2/视频1 都补上，文本1 不补', result.tokens, ['图片1', '图片2', '视频1'])
  check('拼在提示词末尾', result.prompt, '把背景换成雪夜 @图片1 @图片2 @视频1')
}

console.log('\n【3】已经显式 @ 过的素材不重复带')
{
  const result = appendAutoLinkedTokens({
    ...base,
    enabled: true,
    referencedMediaUrls: ['https://cdn/1.png'],
  })
  check('只剩没引用过的那两个', result.tokens, ['图片2', '视频1'])
  check('提示词里也不会出现重复的 @图片1', result.prompt.includes('@图片1'), false)
}

console.log('\n【4】文本类素材永远不自动带（语义不同）')
{
  const result = appendAutoLinkedTokens({ ...base, enabled: true, assets: [TEXT_1] })
  check('只有文本资产时什么都不拼', result.prompt, '把背景换成雪夜')
  check('token 为空', result.tokens, [])
}

console.log('\n【5】没有候选资产 → 原样返回（保证既有调用方逐字节不变）')
{
  check('空资产列表', appendAutoLinkedTokens({ ...base, enabled: true, assets: [] }).prompt, '把背景换成雪夜')
  check('没有 token 的资产被跳过', appendAutoLinkedTokens({
    ...base,
    enabled: true,
    assets: [asset('image', '', 'https://cdn/3.png')],
  }).tokens, [])
  check('没有 URL 的资产被跳过', appendAutoLinkedTokens({
    ...base,
    enabled: true,
    assets: [asset('image', '图片9', '')],
  }).tokens, [])
}

console.log('\n【6】空输入时不会留下一个孤零零的 token')
{
  const result = appendAutoLinkedTokens({ ...base, enabled: true, input: '', assets: [IMAGE_1] })
  check('前缀空格被 trim 掉', result.prompt, '@图片1')
}

console.log('\n【7】参考图合并：关掉开关必须摘掉上游那份（这是实测踩到的 bug）')
{
  const own = ['/upload/user.png']
  const external = ['/upstream/from-node-1.png']

  check('开着：用户那份 + 上游那份', mergeReferenceImages({ own, external, enabled: true, limit: 9 }), {
    effective: ['/upload/user.png', '/upstream/from-node-1.png'],
    mergedExternal: ['/upstream/from-node-1.png'],
  })
  check('关掉：只剩用户那份，上游那张不进请求体', mergeReferenceImages({ own, external, enabled: false, limit: 9 }), {
    effective: ['/upload/user.png'],
    mergedExternal: [],
  })
  check('关掉但用户没传图 → 一份都不带', mergeReferenceImages({ own: [], external, enabled: false, limit: 9 }), {
    effective: [],
    mergedExternal: [],
  })
  check('用户显式上传的那份不受开关影响', mergeReferenceImages({ own, external: [], enabled: false, limit: 9 }).effective, ['/upload/user.png'])
}

console.log('\n【8】重复合并不会把上游那张叠成两份')
{
  // 第一次合并（开着）→ 拿到 effective 与 mergedExternal
  const first = mergeReferenceImages({ own: ['/upload/a.png'], external: ['/up.png'], enabled: true, limit: 9 })
  // 第二次合并前，调用方按 mergedExternal 把上游那份从 effective 里排掉再传进来（组件里的做法）
  const ownNext = first.effective.filter(url => !first.mergedExternal.includes(url))
  const second = mergeReferenceImages({ own: ownNext, external: ['/up.png'], enabled: true, limit: 9 })
  check('两次合并结果一致', second.effective, first.effective)
  check('上游部分不会重复', second.effective.filter(u => u === '/up.png').length, 1)
  // 再关掉：上游那份被摘掉，用户那张留下
  const third = mergeReferenceImages({ own: ownNext, external: ['/up.png'], enabled: false, limit: 9 })
  check('关掉后只剩用户那张', third.effective, ['/upload/a.png'])
}

console.log('\n【9】上限仍然生效（合并不能突破张数限制）')
{
  const own = Array.from({ length: 8 }, (_, i) => `/own-${i}.png`)
  const external = Array.from({ length: 5 }, (_, i) => `/ext-${i}.png`)
  const merged = mergeReferenceImages({ own, external, enabled: true, limit: 9 })
  check('总数为上限 9', merged.effective.length, 9)
  check('上游部分也被截到上限内', merged.mergedExternal.length <= 9, true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)

