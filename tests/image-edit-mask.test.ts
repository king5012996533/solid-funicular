/**
 * 图生图 multipart 组装（含局部重绘蒙版）
 *
 * 为什么单测这个：mask 出错的形态很不友好 —— 蒙版类型不对（比如误用 jpg，
 * 没有 alpha 通道）时上游要么回一句含糊的错、要么干脆当成"整张都可重绘"，
 * 从错误信息里根本看不出是蒙版的问题。所以这里钉住两件事：
 *   1. 不给 mask 时**不能**凭空多出 mask 字段（否则会把普通图生图也带坏）；
 *   2. 给了 mask 时必须校验成 PNG，不合法就在本地拦下并说清原因。
 *
 * 上游确实认这个参数（2026-09-21 实测：带 mask 时圆内像素改动量是圆外的 3.9 倍），
 * 所以这条通路是真的会被用到的，不是纸面功能。
 *
 * 用 Node 自带的 FormData / Blob（Node 18+ 全局可用），不需要额外依赖。
 */

import { buildImageEditRequestFormData } from '../src/shared/upstream-request-normalizer'

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

/** 用固定 type 的假 blob 代替真实取文件，专注测组装逻辑 */
const blobResolver = (typeByValue: Record<string, string>) => async (value: string) => {
  const type = typeByValue[value]
  if (!type) throw new Error(`测试里没给 ${value} 配类型`)
  return new Blob([new Uint8Array([1, 2, 3])], { type })
}

const readField = async (formData: FormData, name: string) => {
  const value = formData.get(name)
  if (value === null) return null
  return value instanceof File ? { name: value.name, type: value.type } : String(value)
}

console.log('\n【1】不给 mask：不能凭空多出 mask 字段（否则普通图生图会被带坏）')
{
  const form = await buildImageEditRequestFormData({
    modelKey: 'gpt-image-2',
    prompt: '换成纯白背景',
    size: '1024x1024',
    count: 1,
    referenceImages: ['/uploads/asset/a.png'],
    resolveReferenceImageBlob: blobResolver({ '/uploads/asset/a.png': 'image/png' }),
  })
  check('没有 mask 字段', form.get('mask'), null)
  check('model 照常带上', await readField(form, 'model'), 'gpt-image-2')
  check('prompt 照常带上', await readField(form, 'prompt'), '换成纯白背景')
  check('size 照常带上', await readField(form, 'size'), '1024x1024')
  check('image 只带一张', form.getAll('image').length, 1)
  // 不传 fileNamePrefix 时用默认值 reference-image；服务端会显式传 'reference'
  check('image 文件名用默认前缀', (form.get('image') as File).name, 'reference-image-1.png')
}

console.log('\n【1b】fileNamePrefix 生效（服务端传的是 reference）')
{
  const form = await buildImageEditRequestFormData({
    modelKey: 'gpt-image-2',
    prompt: 'x',
    count: 1,
    referenceImages: ['/uploads/asset/a.png', '/uploads/asset/b.png'],
    fileNamePrefix: 'reference',
    resolveReferenceImageBlob: blobResolver({
      '/uploads/asset/a.png': 'image/png',
      '/uploads/asset/b.png': 'image/png',
    }),
  })
  const names = (form.getAll('image') as File[]).map(file => file.name)
  check('文件名按前缀 + 序号', names, ['reference-1.png', 'reference-2.png'])
}

console.log('\n【2】给了合法 PNG 蒙版：追加成 mask 字段，文件名固定 mask.png')
{
  const form = await buildImageEditRequestFormData({
    modelKey: 'gpt-image-2',
    prompt: '只把涂掉的地方换成玫瑰',
    count: 1,
    referenceImages: ['/uploads/asset/a.png'],
    mask: '/uploads/asset/mask.png',
    resolveReferenceImageBlob: blobResolver({
      '/uploads/asset/a.png': 'image/png',
      '/uploads/asset/mask.png': 'image/png',
    }),
  })
  const mask = form.get('mask') as File
  check('mask 字段存在', Boolean(mask), true)
  check('mask 文件名是 mask.png', mask.name, 'mask.png')
  check('mask 类型是 png', mask.type, 'image/png')
  check('image 与 mask 同时存在', [form.getAll('image').length, Boolean(mask)], [1, true])
}

console.log('\n【3】蒙版不是 PNG：本地就拦下，并且说清是蒙版的问题')
{
  let message = ''
  try {
    await buildImageEditRequestFormData({
      modelKey: 'gpt-image-2',
      prompt: 'x',
      count: 1,
      referenceImages: ['/uploads/asset/a.png'],
      mask: '/uploads/asset/mask.jpg',
      resolveReferenceImageBlob: blobResolver({
        '/uploads/asset/a.png': 'image/png',
        '/uploads/asset/mask.jpg': 'image/jpeg',
      }),
    })
  } catch (error) {
    message = (error as Error).message
  }
  check('抛错而不是放过', message.length > 0, true)
  check('错误信息点明是蒙版', message.includes('蒙版'), true)
  check('错误信息点明要 PNG', message.includes('PNG'), true)
}

console.log('\n【4】多张参考图 + 蒙版：互不干扰')
{
  const form = await buildImageEditRequestFormData({
    modelKey: 'gpt-image-2',
    prompt: '合成',
    count: 2,
    referenceImages: ['/uploads/asset/a.png', '/uploads/asset/b.png'],
    mask: '/uploads/asset/mask.png',
    resolveReferenceImageBlob: blobResolver({
      '/uploads/asset/a.png': 'image/png',
      '/uploads/asset/b.png': 'image/png',
      '/uploads/asset/mask.png': 'image/png',
    }),
  })
  check('两张参考图', form.getAll('image').length, 2)
  check('n 透传', await readField(form, 'n'), '2')
  check('只有一个 mask', form.getAll('mask').length, 1)
  check('mask 没被当成参考图', (form.getAll('image') as File[]).every(file => file.name !== 'mask.png'), true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
