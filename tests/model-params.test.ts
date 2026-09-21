/**
 * 生成参数 schema 的逻辑验证
 *
 * 这段逻辑回答的是「这个模型到底允许哪些尺寸 / 画质 / 比例 / 时长」，
 * 也就是用户要求里「参数由上游模型决定，不是写死的」那一条。
 * 全是纯函数，直接跑 Node 比点界面更精确，也能覆盖「后台没声明」这类分支。
 */

import {
  describeAspectRatio,
  describeResolutionTier,
  pickValidChoice,
  resolveImageParamSchema,
  resolveVideoParamSchema,
} from '../src/config/model-params'
import type { ImageModel, VideoModel } from '../src/config/models'

const imageModel = (overrides: Partial<ImageModel> = {}): ImageModel => ({
  id: 'm1',
  key: 'doubao-seedream-4-5-251128',
  label: 'Seedream 4.5',
  modelKey: 'doubao-seedream-4-5-251128',
  providerId: 'p1',
  providerCode: 'volcengine',
  providerName: '火山方舟',
  description: '',
  capabilityJson: null,
  defaultParams: {},
  sortOrder: 0,
  isDefault: true,
  sizes: [],
  maxImagesPerRequest: 1,
  ...overrides,
})

const videoModel = (overrides: Partial<VideoModel> = {}): VideoModel => ({
  id: 'v1',
  key: 'doubao-seedance-1-0',
  label: 'Seedance',
  modelKey: 'doubao-seedance-1-0',
  providerId: 'p1',
  providerCode: 'volcengine',
  providerName: '火山方舟',
  description: '',
  capabilityJson: null,
  defaultParams: {},
  sortOrder: 0,
  isDefault: true,
  ratios: [],
  durs: [],
  ...overrides,
})

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

console.log('\n【1】尺寸档位推导：像素尺寸有档位，比例写法没有')
{
  check('2048x2048 → 2K', describeResolutionTier('2048x2048'), '2K')
  check('3024x1296 → 2K（同一张 2K 表里长边不一致也算 2K）', describeResolutionTier('3024x1296'), '2K')
  check('4096x4096 → 4K', describeResolutionTier('4096x4096'), '4K')
  check('6198x2656 → 4K', describeResolutionTier('6198x2656'), '4K')
  check('1024x1024 → 1K', describeResolutionTier('1024x1024'), '1K')
  // '16x9' 这种是比例而不是像素，不能误判成 16×9 像素的 1K
  check('16x9 → 无档位', describeResolutionTier('16x9'), '')
  check('1x1 → 无档位', describeResolutionTier('1x1'), '')
  check('空值 → 无档位', describeResolutionTier(''), '')
}

console.log('\n【2】比例推导：像素尺寸反推原始比例，且不出现无意义的约分数')
{
  check('2048x2048 → 1:1', describeAspectRatio('2048x2048'), '1:1')
  check('2560x1440 → 16:9', describeAspectRatio('2560x1440'), '16:9')
  check('2304x1728 → 4:3', describeAspectRatio('2304x1728'), '4:3')
  check('1440x2560 → 9:16', describeAspectRatio('1440x2560'), '9:16')
  check('3024x1296 → 21:9', describeAspectRatio('3024x1296'), '21:9')
  // 4K 表里的 6198x2656 约等于 21:9，直接约分会得到 3099:1328
  check('6198x2656 → 21:9', describeAspectRatio('6198x2656'), '21:9')
  check('比例写法原样输出', describeAspectRatio('16x9'), '16:9')
  check('9x21 比例写法', describeAspectRatio('9x21'), '9:21')
}

console.log('\n【3】豆包 Seedream：画质切换会换整张像素表')
{
  const model = imageModel()
  const standard = resolveImageParamSchema(model, 'standard')
  const fourK = resolveImageParamSchema(model, '4k')

  check('标准画质有 9 档尺寸', standard.sizes.length, 9)
  check('标准画质 1:1 是 2048', standard.sizes.find(s => s.label === '1:1')?.key, '2048x2048')
  check('4K 画质 1:1 是 4096', fourK.sizes.find(s => s.label === '1:1')?.key, '4096x4096')
  check('两档画质可选', standard.qualities.map(q => q.key), ['standard', '4k'])
  check('尺寸带上了档位 hint', standard.sizes[0].hint, '2K')
  check('默认画质是 standard', standard.defaultQuality, 'standard')
}

console.log('\n【4】Nano Banana：只有比例，没有画质维度')
{
  const model = imageModel({
    key: 'nano-banana',
    modelKey: 'nano-banana',
    providerCode: 'google',
    label: 'Nano Banana',
  })
  const schema = resolveImageParamSchema(model, '')

  check('比例型 key', schema.sizes.map(s => s.key), ['21x9', '16x9', '3x2', '4x3', '1x1', '3x4', '2x3', '9x16', '9x21'])
  // 没有画质档就不该渲染画质控件 —— 这正是「不摆假选项」
  check('无画质维度', schema.qualities, [])
  check('比例型尺寸不带档位', schema.sizes[0].hint, undefined)
}

console.log('\n【5】后台 capabilityJson 显式声明优先于厂商族默认值')
{
  const model = imageModel({
    capabilityJson: {
      maxImagesPerRequest: 4,
      params: {
        size: [{ label: '竖版 9:16', key: '1024x1792' }, { label: '方图', key: '1024x1024' }],
        quality: { options: [{ label: '草稿', key: 'draft' }, { label: '精细', key: 'fine' }], default: 'fine' },
      },
    },
  })
  const schema = resolveImageParamSchema(model, '')

  check('用声明的尺寸而不是 Seedream 表', schema.sizes.map(s => s.key), ['1024x1792', '1024x1024'])
  check('用声明的画质（含新 key）', schema.qualities.map(q => q.key), ['draft', 'fine'])
  check('画质默认值取声明里的 default', schema.defaultQuality, 'fine')
  check('单次张数取声明的 4', schema.maxCount, 4)
}

console.log('\n【5b】声明的 qualitySizeMap：切画质换整张尺寸表')
{
  const model = imageModel({
    capabilityJson: {
      params: {
        quality: { options: [{ label: '标准', key: 'standard' }, { label: '4K', key: '4k' }], default: 'standard' },
        size: [{ label: '1:1', key: '2048x2048', hint: '2K' }],
      },
      qualitySizeMap: {
        '4k': [{ label: '1:1', key: '4096x4096', hint: '4K' }],
      },
    },
  })

  check('标准画质走主表', resolveImageParamSchema(model, 'standard').sizes.map(s => s.key), ['2048x2048'])
  check('4K 画质走映射表', resolveImageParamSchema(model, '4k').sizes.map(s => s.key), ['4096x4096'])
}

console.log('\n【6】单次张数：未声明时保守落到 1，不猜上游上限')
{
  check('未声明 → 1', resolveImageParamSchema(imageModel(), '').maxCount, 1)
  check('声明 10 → 10', resolveImageParamSchema(imageModel({ capabilityJson: { maxImagesPerRequest: 10 } }), '').maxCount, 10)
  check('非法值 → 落到 1', resolveImageParamSchema(imageModel({ capabilityJson: { maxImagesPerRequest: 0 } }), '').maxCount, 1)
}

console.log('\n【7】默认尺寸：优先取该模型 defaultParams 里真实存在的档位')
{
  const model = imageModel({ defaultParams: { size: '1440x2560' } })
  check('取模型默认尺寸', resolveImageParamSchema(model, 'standard').defaultSize, '1440x2560')

  // 默认尺寸不属于当前画质表（4K 表里没有 1440x2560）时，退回该表首项而不是留一个无效值
  check('4K 下无效则退回首项', resolveImageParamSchema(model, '4k').defaultSize, '6198x2656')
}

console.log('\n【8】未知厂商：不给尺寸选项，并给出说明文案')
{
  const model = imageModel({
    key: 'mystery-model',
    modelKey: 'mystery-model',
    providerCode: 'unknown-vendor',
    label: '某厂自研图像模型',
  })
  const schema = resolveImageParamSchema(model, '')

  check('不编造尺寸', schema.sizes, [])
  check('给出提示文案', schema.sizeHint, '该模型不支持指定尺寸，请在提示词里描述画面比例')
}

console.log('\n【9】视频参数：比例 / 时长 / 分辨率 / 输入模式')
{
  const schema = resolveVideoParamSchema(videoModel())

  check('Seedance 有 6 档比例', schema.ratios.length, 6)
  check('时长两档', schema.durations.map(d => d.key), ['5', '10'])
  check('时长带可读文案', schema.durations[0].label, '5 秒')
  check('分辨率两档', schema.resolutions.map(r => r.key), ['720p', '1080p'])
  check('支持三种输入模式', schema.features.map(f => f.key), ['text-to-video', 'image-to-video', 'first-last-frame'])
  check('默认比例 16x9', schema.defaultRatio, '16x9')
  check('默认时长 5', schema.defaultDuration, '5')
}

console.log('\n【10】视频：Kling 只支持图生视频，且按模型默认值选比例')
{
  const schema = resolveVideoParamSchema(videoModel({
    key: 'kling-v2',
    modelKey: 'kling-v2',
    providerCode: 'kling',
    defaultParams: { ratio: '9x16', duration: 10 },
  }))

  check('不支持文生视频', schema.features.map(f => f.key), ['image-to-video', 'first-last-frame'])
  check('三档比例', schema.ratios.length, 3)
  check('默认比例取模型配置', schema.defaultRatio, '9x16')
  check('默认时长取模型配置', schema.defaultDuration, '10')
}

console.log('\n【11】视频：后台声明的分辨率生效')
{
  const schema = resolveVideoParamSchema(videoModel({
    capabilityJson: { params: { resolution: [{ label: '540P', key: '540p' }, { label: '2K', key: '2k' }] } },
  }))
  check('用声明的分辨率', schema.resolutions.map(r => r.key), ['540p', '2k'])
}

console.log('\n【12】失效值校验：旧画布里的占位值不能透传到上游')
{
  const seedream = imageModel()
  const sizes = resolveImageParamSchema(seedream, 'standard').sizes
  const qualities = resolveImageParamSchema(seedream, '').qualities

  // 早期版本在模型目录为空时把 '1x1' 写进了画布，Seedream 并不认这个值
  check('非法尺寸退回兜底', pickValidChoice(sizes, '1x1', '2048x2048'), '2048x2048')
  check('合法尺寸保留', pickValidChoice(sizes, '1440x2560', '2048x2048'), '1440x2560')
  check('空值退回兜底', pickValidChoice(sizes, '', '2048x2048'), '2048x2048')
  check('undefined 退回兜底', pickValidChoice(sizes, undefined, '2048x2048'), '2048x2048')

  // 编造的画质（旧工具栏写死的 '高清 2K'）同样不能通过
  check('非法画质退回兜底', pickValidChoice(qualities, '高清 2K', 'standard'), 'standard')
  check('合法画质保留', pickValidChoice(qualities, '4k', 'standard'), '4k')

  // Banana 只认比例型 key，Seedream 的像素 key 在这里应当被拒
  const banana = imageModel({ key: 'nano-banana-pro', modelKey: 'nano-banana-pro', providerCode: 'nano-banana', label: 'Nano Banana Pro' })
  check(
    '跨模型的尺寸不通用',
    pickValidChoice(resolveImageParamSchema(banana, '').sizes, '2048x2048', '1x1'),
    '1x1',
  )
}

console.log('\n【13】参数维度按节点类型分开：图片和视频不能互相泄漏维度')
{
  // 对齐 LibTV 的依据：图片节点的摘要形如 `16:9 · 标准画质 · 2K · 1张`，
  // 视频节点是 `16:9 · 720P · 5s · 1个` —— 两边暴露的参数维度完全不同。
  // 这条守的是「同一个模型在图片节点和视频节点上问的是不同的东西」。
  const img = resolveImageParamSchema(imageModel(), 'standard')
  const vid = resolveVideoParamSchema(videoModel())

  const imgDims = Object.keys(img).filter(k => Array.isArray((img as Record<string, unknown>)[k]))
  const vidDims = Object.keys(vid).filter(k => Array.isArray((vid as Record<string, unknown>)[k]))

  check('图片侧暴露尺寸维度', imgDims.includes('sizes'), true)
  check('图片侧暴露画质维度', imgDims.includes('qualities'), true)
  check('图片侧不暴露视频的维度',
    imgDims.some(k => ['ratios', 'durations', 'resolutions', 'features'].includes(k)), false)

  check('视频侧暴露比例维度', vidDims.includes('ratios'), true)
  check('视频侧暴露时长维度', vidDims.includes('durations'), true)
  check('视频侧暴露分辨率维度', vidDims.includes('resolutions'), true)
  check('视频侧暴露输入模式维度', vidDims.includes('features'), true)
  check('视频侧不暴露图片的维度',
    vidDims.some(k => ['sizes', 'qualities'].includes(k)), false)

  // 数量上限两边都读同一个字段，但各自独立解析
  check('图片数量上限默认 1', img.maxCount, 1)
  check('视频数量上限默认 1', vid.maxCount, 1)
}

console.log('\n【14】数量上限：声明了才放开，没声明保守为 1')
{
  check('图片：声明 4 → 4', resolveImageParamSchema(
    imageModel({ capabilityJson: { maxImagesPerRequest: 4 } }), 'standard').maxCount, 4)
  // 视频侧同样读 capabilityJson，字段名兼容 maxImagesPerRequest / maxCount
  check('视频：声明 maxImagesPerRequest 2 → 2', resolveVideoParamSchema(
    videoModel({ capabilityJson: { maxImagesPerRequest: 2 } })).maxCount, 2)
  check('视频：声明 maxCount 3 → 3', resolveVideoParamSchema(
    videoModel({ capabilityJson: { maxCount: 3 } })).maxCount, 3)
  check('视频：非法值 → 回落到 1', resolveVideoParamSchema(
    videoModel({ capabilityJson: { maxCount: 0 } })).maxCount, 1)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
