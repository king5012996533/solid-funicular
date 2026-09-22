/**
 * 生成参数 schema —— 「参数由上游模型决定」的唯一实现处
 *
 * 为什么要单独一个文件：
 *   改造前，图片工具栏的尺寸是组件内写死的 5 个数组项，画质统一写死成 '高清 2K'，
 *   视频工具栏写死 3 个比例 + 2 个时长。换模型时这些选项纹丝不动，
 *   于是 `画质: '高清 2K'` 这种纯 UI 编出来的字符串会被当成真实参数发给上游。
 *   现在所有可选参数只有一个来源，组件不再自带任何清单。
 *
 * 解析优先级（从权威到兜底）：
 *   1. 模型目录 capabilityJson 中显式声明的参数
 *      —— 管理员在后台按该上游的真实能力填写，最权威；
 *   2. 未声明时，按模型所属厂商族的公开文档参数补齐
 *      —— 例如豆包 Seedream 的 2K / 4K 尺寸表、Nano Banana 的比例表；
 *   3. 都不匹配 → 返回空 schema，对应控件不渲染。
 *      宁可不显示，也不要显示一个点了没用的假选项。
 */

import type { ImageModel, VideoModel } from './models'

export interface ParamChoice {
  /** 展示文案 */
  label: string
  /** 提交给上游的值 */
  key: string
  /** 附加说明，例如分辨率档位 '2K' */
  hint?: string
}

export interface ImageParamSchema {
  /** 当前画质下可用的尺寸；空数组表示该模型不支持指定尺寸 */
  sizes: ParamChoice[]
  /** 可选画质；空数组表示该模型没有画质维度，控件不渲染 */
  qualities: ParamChoice[]
  /** 单次出图上限，对应上游 n 参数 */
  maxCount: number
  defaultSize: string
  defaultQuality: string
  /** 模型不支持指定尺寸时的提示文案 */
  sizeHint: string
}

export interface VideoParamSchema {
  ratios: ParamChoice[]
  durations: ParamChoice[]
  resolutions: ParamChoice[]
  features: ParamChoice[]
  maxCount: number
  defaultRatio: string
  defaultDuration: string
  defaultResolution: string
}

// ---------------------------------------------------------------------------
// 尺寸表：豆包 Seedream / Nano Banana 的公开文档参数
// ---------------------------------------------------------------------------

export const SIZE_2K: ParamChoice[] = [
  { label: '21:9', key: '3024x1296' },
  { label: '16:9', key: '2560x1440' },
  { label: '3:2', key: '2496x1664' },
  { label: '4:3', key: '2304x1728' },
  { label: '1:1', key: '2048x2048' },
  { label: '3:4', key: '1728x2304' },
  { label: '2:3', key: '1664x2496' },
  { label: '9:16', key: '1440x2560' },
  { label: '9:21', key: '1296x3024' },
]

export const SIZE_4K: ParamChoice[] = [
  { label: '21:9', key: '6198x2656' },
  { label: '16:9', key: '5404x3040' },
  { label: '3:2', key: '4992x3328' },
  { label: '4:3', key: '4694x3520' },
  { label: '1:1', key: '4096x4096' },
  { label: '3:4', key: '3520x4694' },
  { label: '2:3', key: '3328x4992' },
  { label: '9:16', key: '3040x5404' },
  { label: '9:21', key: '2656x6198' },
]

export const SEEDREAM_QUALITIES: ParamChoice[] = [
  { label: '标准画质', key: 'standard' },
  { label: '4K 高清', key: '4k' },
]

export const BANANA_SIZES: ParamChoice[] = [
  { label: '21:9', key: '21x9' },
  { label: '16:9', key: '16x9' },
  { label: '3:2', key: '3x2' },
  { label: '4:3', key: '4x3' },
  { label: '1:1', key: '1x1' },
  { label: '3:4', key: '3x4' },
  { label: '2:3', key: '2x3' },
  { label: '9:16', key: '9x16' },
  { label: '9:21', key: '9x21' },
]

/**
 * OpenAI 图像族（gpt-image 系列）的尺寸档。
 *
 * **顺序即默认**：`readImageParamSchema` 在没有目录声明时取 `sizes[0]` 作为默认档
 * （实测目录里 gpt-image-2 的 `capability.size` 是 null，就走这条回落）。
 *
 * 横版打头是对齐 LibTV 的结果：他们的图片节点默认是横版画幅（622×350 的卡片）。
 * 我们原先方版打头，新建图片节点是个 350×350 的方块，跟 LibTV 一眼就能看出差别。
 * Seedream / Nano Banana 那两张表本来也是横版打头的，这里只是把这个约定补齐。
 *
 * 只动顺序，不加档位 —— 16:9 不在 gpt-image 的支持列表里，编造一个会写进请求体
 * 让上游报错（「宁缺勿假」）。
 */
const OPENAI_IMAGE_SIZES: ParamChoice[] = [
  { label: '3:2', key: '1536x1024' },
  { label: '1:1', key: '1024x1024' },
  { label: '2:3', key: '1024x1536' },
]

const OPENAI_IMAGE_QUALITIES: ParamChoice[] = [
  { label: '标准画质', key: 'standard' },
  { label: '高清画质', key: 'hd' },
]

// 视频：按厂商族给的比例 / 时长 / 分辨率
const SEEDANCE_RATIOS: ParamChoice[] = [
  { label: '16:9 横版', key: '16x9' },
  { label: '21:9 宽幅', key: '21x9' },
  { label: '4:3', key: '4x3' },
  { label: '1:1 方形', key: '1x1' },
  { label: '3:4', key: '3x4' },
  { label: '9:16 竖版', key: '9x16' },
]

const KLING_RATIOS: ParamChoice[] = [
  { label: '16:9 横版', key: '16x9' },
  { label: '1:1 方形', key: '1x1' },
  { label: '9:16 竖版', key: '9x16' },
]

export const GENERIC_RATIOS: ParamChoice[] = [
  { label: '16:9 横版', key: '16x9' },
  { label: '4:3', key: '4x3' },
  { label: '1:1 方形', key: '1x1' },
  { label: '3:4', key: '3x4' },
  { label: '9:16 竖版', key: '9x16' },
]

export const DURATIONS_5_10: ParamChoice[] = [
  { label: '5 秒', key: '5' },
  { label: '10 秒', key: '10' },
]

const RESOLUTIONS_SD_HD: ParamChoice[] = [
  { label: '720P', key: '720p' },
  { label: '1080P', key: '1080p' },
]

const FEATURES_T2V_I2V_FIRST_LAST: ParamChoice[] = [
  { label: '文生视频', key: 'text-to-video' },
  { label: '图生视频', key: 'image-to-video' },
  { label: '首尾帧', key: 'first-last-frame' },
]

const FEATURES_I2V_ONLY: ParamChoice[] = [
  { label: '图生视频', key: 'image-to-video' },
  { label: '首尾帧', key: 'first-last-frame' },
]

// ---------------------------------------------------------------------------
// 能力归属判断
// ---------------------------------------------------------------------------

type ModelFamily = 'seedream' | 'banana' | 'openai-image' | 'seedance' | 'kling' | 'generic'

const detectFamily = (text: string): ModelFamily | null => {
  if (!text) return null
  if (/seedance|doubao.?video/.test(text)) return 'seedance'
  if (/kling/.test(text)) return 'kling'
  if (/seedream|doubao|volc|ark-/.test(text)) return 'seedream'
  if (/banana|nano|gemini.*image/.test(text)) return 'banana'
  if (/gpt-image|dall-e|openai/.test(text)) return 'openai-image'
  return null
}

/**
 * 判断模型属于哪个厂商族。
 *
 * 这层判断存在的意义：模型目录尚未声明参数时，前端至少要给出该上游文档里
 * 真实存在的选项，而不是随便编几个。
 *
 * 先看厂商代号与模型标识（可信），再退回展示名（管理员可能改过名，只能算线索）。
 * 两个来源分开判定的原因：模型标识里出现 kling 时不应该因为展示名里带
 * “Seedance” 就被归到豆包族。
 */
const readFamily = (codes: string, labels: string): ModelFamily => {
  return detectFamily(codes.toLowerCase()) || detectFamily(labels.toLowerCase()) || 'generic'
}

const readImageFamily = (model: ImageModel | null | undefined): ModelFamily => {
  if (!model) return 'generic'
  return readFamily(
    `${model.providerCode} ${model.modelKey} ${model.key}`,
    `${model.label} ${model.description}`,
  )
}

const readVideoFamily = (model: VideoModel | null | undefined): ModelFamily => {
  if (!model) return 'generic'
  return readFamily(
    `${model.providerCode} ${model.modelKey} ${model.key}`,
    `${model.label} ${model.description}`,
  )
}

// ---------------------------------------------------------------------------
// capabilityJson 显式声明解析
// ---------------------------------------------------------------------------

const readChoiceList = (value: unknown): ParamChoice[] => {
  if (!Array.isArray(value)) return []
  const choices: ParamChoice[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      choices.push({ label: item, key: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = String(record.key ?? record.value ?? '').trim()
    if (!key) continue
    const label = String(record.label ?? key).trim() || key
    const hint = record.hint === undefined ? undefined : String(record.hint)
    choices.push(hint ? { label, key, hint } : { label, key })
  }
  return choices
}

/**
 * 读取一个维度（size / quality / ratio / duration ...）。
 * 支持两种后台写法，避免管理员为了同一个意思学两套结构：
 *   "params": { "size": ["1:1", ...], "ratio": { "options": [...], "default": "16x9" } }
 *   "sizes": [...]       （顶层快捷写法）
 */
const readDeclaredDimension = (
  capability: Record<string, unknown> | null | undefined,
  dimension: string,
): { options: ParamChoice[]; fallbackDefault: string } => {
  if (!capability) return { options: [], fallbackDefault: '' }
  const params = (capability.params && typeof capability.params === 'object')
    ? capability.params as Record<string, unknown>
    : null
  const raw = params?.[dimension] ?? capability[`${dimension}s`] ?? capability[dimension]
  if (raw === undefined || raw === null) return { options: [], fallbackDefault: '' }
  if (Array.isArray(raw)) return { options: readChoiceList(raw), fallbackDefault: '' }
  if (typeof raw !== 'object') return { options: [], fallbackDefault: '' }
  const record = raw as Record<string, unknown>
  return {
    options: readChoiceList(record.options),
    fallbackDefault: String(record.default ?? '').trim(),
  }
}

const readDeclaredCount = (
  capability: Record<string, unknown> | null | undefined,
  fallbackMax: number,
): number => {
  const raw = Number(capability?.maxImagesPerRequest ?? capability?.maxCount)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallbackMax
}

// ---------------------------------------------------------------------------
// 尺寸档位推导
// ---------------------------------------------------------------------------

/**
 * 从尺寸 key 推导分辨率档位。
 * 需要区分两种 key：
 *   '2048x2048' 像素尺寸 → 2K
 *   '16x9'      比例     → 无档位
 * 判据是两边数值都够大（>= 256），比例型 key 不可能满足。
 *
 * 档位界线按上游文档的「档」而不是长边像素数硬切：
 * 豆包 Seedream 的标准画质整张表（长边 2048 ~ 3024）都叫 2K，
 * 4K 那张表（长边 4096 ~ 6198）都叫 4K，中间没有 1.5K 这一档。
 */
export const describeResolutionTier = (key: string): string => {
  const matched = /^(\d+)x(\d+)$/.exec(String(key || '').trim())
  if (!matched) return ''
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!width || !height || width < 256 || height < 256) return ''
  const longEdge = Math.max(width, height)
  if (longEdge >= 4000) return '4K'
  if (longEdge >= 1800) return '2K'
  if (longEdge >= 900) return '1K'
  return ''
}

/** 给尺寸选项补上 hint（分辨率档位 / 像素数），供 UI 直接展示 */
const withSizeHints = (choices: ParamChoice[]): ParamChoice[] => choices.map((choice) => {
  if (choice.hint) return choice
  const tier = describeResolutionTier(choice.key)
  if (tier) return { ...choice, hint: tier }
  return choice
})

/**
 * 常用画面比例的候选表。
 * 用途：节点 data 里只存了尺寸 key（如 '2048x2048' / '16x9'），
 * 卡片上要显示人类可读的比例时，从像素反推原始比例需要这一层映射。
 * 不直接用 gcd 约分，因为上游的像素值不总是精确等比
 * （如 6198x2656 约等于 21:9，但约分结果会是 3099:1328 这种没有意义的数）。
 */
const ASPECT_RATIO_CANDIDATES: Array<{ w: number; h: number; label: string }> = [
  { w: 21, h: 9, label: '21:9' },
  { w: 16, h: 9, label: '16:9' },
  { w: 3, h: 2, label: '3:2' },
  { w: 5, h: 4, label: '5:4' },
  { w: 4, h: 3, label: '4:3' },
  { w: 1, h: 1, label: '1:1' },
  { w: 3, h: 4, label: '3:4' },
  { w: 2, h: 3, label: '2:3' },
  { w: 9, h: 16, label: '9:16' },
  { w: 9, h: 21, label: '9:21' },
  { w: 2, h: 1, label: '2:1' },
  { w: 1, h: 2, label: '1:2' },
]

/** 从尺寸 key 推导可读比例：'2048x2048' → '1:1'，'16x9' → '16:9' */
/**
 * 把尺寸 key 解析成宽高比。
 *
 * 两种写法都要认：比例写法（`16x9`）与像素档（`2048x2048` / `1440x2560`）——
 * 视频节点存的是比例，图片节点存的是像素。
 * 认不出来（`auto` / 空值 / 写坏）时返回 null，由调用方决定回落。
 *
 * 放在这里而不是各组件里：节点卡片的尺寸（`views/workflow/config/node-size.ts`）
 * 与参数面板的比例图形卡（`components/generate/RatioChoiceGrid.vue`）都要用同一套解析，
 * 各写一份必然漂移。
 */
export const parseAspectRatio = (key?: string): number | null => {
  const matched = String(key || '').trim().match(/^(\d+(?:\.\d+)?)\s*[x×:]\s*(\d+(?:\.\d+)?)$/)
  if (!matched) return null
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!width || !height) return null
  return width / height
}

export const describeAspectRatio = (key: string): string => {
  const matched = /^(\d+)x(\d+)$/.exec(String(key || '').trim())
  if (!matched) return String(key || '')
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!width || !height) return String(key || '')

  // 小数值说明 key 本身就是比例写法（16x9 / 9x21），直接换分隔符即可
  if (width < 256 || height < 256) return `${width}:${height}`

  const target = width / height
  let best = ASPECT_RATIO_CANDIDATES[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of ASPECT_RATIO_CANDIDATES) {
    const delta = Math.abs(candidate.w / candidate.h - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = candidate
    }
  }
  // 误差超过 2% 说明不属于任何常用比例，退回像素尺寸本身
  return bestDelta / target <= 0.02 ? best.label : `${width}x${height}`
}

/**
 * 从候选里挑一个「当前模型确实支持」的值，挑不到就用兜底值。
 *
 * 为什么需要它：节点 data 里可能存着当前模型不认的值 ——
 * 早期版本在模型目录还是空的时候把 '1x1' 这类占位值写进了画布，
 * 换模型之后旧值也未必还有效。这种值一旦透传到上游会被直接拒掉，
 * 所以读取时统一校验一次，不合法就退回该模型的默认档。
 */
export const pickValidChoice = (
  choices: ParamChoice[],
  candidate: unknown,
  fallback: string,
): string => {
  const normalized = String(candidate ?? '').trim()
  if (normalized && choices.some(choice => choice.key === normalized)) {
    return normalized
  }
  return fallback
}

/** 模板想要的构图意图：方图 / 竖版 / 横版。 */
export type ImageAspectIntent = 'square' | 'portrait' | 'landscape'

const ASPECT_INTENT_RATIO: Record<ImageAspectIntent, number> = {
  square: 1,
  portrait: 9 / 16,
  landscape: 16 / 9,
}

/**
 * 从模型支持的尺寸里挑最接近目标构图的那一档。
 *
 * 为什么需要它：模板要表达的是「这张图应该是竖版」这种意图，
 * 而具体像素档是模型决定的 —— 写死 1440x2560 只对 Seedream 成立，
 * 换个模型（GPT Image 2 只有 1024x1024 / 1536x1024 / 1024x1536）就透传非法值被上游拒掉。
 * 所以意图保持不变，像素档跟着模型走。
 *
 * 用相对差而不是绝对差：1:1 与 9:16 的距离，不能因为数值大小不同而偏袒某一侧。
 * 挑不到（模型没声明尺寸，或 key 不是 WxH）时返回空串，交给调用方兜底。
 */
export const pickSizeByAspect = (
  choices: ParamChoice[],
  intent: ImageAspectIntent,
): string => {
  const target = ASPECT_INTENT_RATIO[intent]
  let bestKey = ''
  let bestDelta = Number.POSITIVE_INFINITY

  for (const choice of choices) {
    const matched = /^(\d+)x(\d+)$/.exec(String(choice.key || '').trim())
    if (!matched) continue
    const width = Number(matched[1])
    const height = Number(matched[2])
    if (!width || !height) continue

    const delta = Math.abs(width / height - target) / target
    if (delta < bestDelta) {
      bestDelta = delta
      bestKey = choice.key
    }
  }

  return bestKey
}

// ---------------------------------------------------------------------------
// 图片参数解析
// ---------------------------------------------------------------------------

const EMPTY_IMAGE_SCHEMA: ImageParamSchema = {
  sizes: [],
  qualities: [],
  maxCount: 1,
  defaultSize: '',
  defaultQuality: '',
  sizeHint: '',
}

export const resolveImageParamSchema = (
  model: ImageModel | null | undefined,
  quality: string,
): ImageParamSchema => {
  if (!model) return EMPTY_IMAGE_SCHEMA

  const capability = (model.capabilityJson || {}) as Record<string, unknown>
  const declaredSize = readDeclaredDimension(capability, 'size')
  const declaredQuality = readDeclaredDimension(capability, 'quality')

  const family = readImageFamily(model)
  const familyQualities = family === 'seedream'
    ? SEEDREAM_QUALITIES
    : family === 'openai-image'
      ? OPENAI_IMAGE_QUALITIES
      : []

  const qualities = declaredQuality.options.length ? declaredQuality.options : familyQualities

  // 画质 → 尺寸表映射：有些上游换画质时会换整张像素表
  // （豆包 Seedream 的 2K / 4K 就是两张表）。声明了就用声明的那张。
  const qualitySizeMap = (capability.qualitySizeMap && typeof capability.qualitySizeMap === 'object')
    ? capability.qualitySizeMap as Record<string, unknown>
    : null
  const mappedSizes = quality ? readChoiceList(qualitySizeMap?.[quality]) : []

  // 尺寸表优先级：画质映射 > 声明的尺寸 > 厂商族文档表 > 不给
  let sizes: ParamChoice[]
  if (mappedSizes.length) {
    sizes = mappedSizes
  } else if (declaredSize.options.length) {
    sizes = declaredSize.options
  } else if (family === 'seedream') {
    sizes = quality === '4k' ? SIZE_4K : SIZE_2K
  } else if (family === 'banana') {
    sizes = BANANA_SIZES
  } else if (family === 'openai-image') {
    sizes = OPENAI_IMAGE_SIZES
  } else {
    sizes = []
  }
  sizes = withSizeHints(sizes)

  const defaultSize = sizes.some(item => item.key === declaredSize.fallbackDefault)
    ? declaredSize.fallbackDefault
    : sizes.find(item => item.key === String(model.defaultParams?.size || ''))?.key || sizes[0]?.key || ''

  const declaredDefaultQuality = declaredQuality.fallbackDefault
  const defaultQuality = qualities.some(item => item.key === declaredDefaultQuality)
    ? declaredDefaultQuality
    : qualities.find(item => item.key === String(model.defaultParams?.quality || ''))?.key || qualities[0]?.key || ''

  return {
    sizes,
    qualities,
    maxCount: readDeclaredCount(capability, model.maxImagesPerRequest || 1),
    defaultSize,
    defaultQuality,
    sizeHint: sizes.length ? '' : '该模型不支持指定尺寸，请在提示词里描述画面比例',
  }
}

// ---------------------------------------------------------------------------
// 视频参数解析
// ---------------------------------------------------------------------------

const EMPTY_VIDEO_SCHEMA: VideoParamSchema = {
  ratios: [],
  durations: [],
  resolutions: [],
  features: [],
  maxCount: 1,
  defaultRatio: '',
  defaultDuration: '',
  defaultResolution: '',
}

const toSecondsLabel = (key: string) => `${key} 秒`

const withDurationLabels = (choices: ParamChoice[]): ParamChoice[] =>
  choices.map(choice => ({ ...choice, label: choice.label || toSecondsLabel(choice.key) }))

export const resolveVideoParamSchema = (
  model: VideoModel | null | undefined,
): VideoParamSchema => {
  if (!model) return EMPTY_VIDEO_SCHEMA

  const capability = (model.capabilityJson || {}) as Record<string, unknown>
  const declaredRatio = readDeclaredDimension(capability, 'ratio')
  const declaredDuration = readDeclaredDimension(capability, 'duration')
  const declaredResolution = readDeclaredDimension(capability, 'resolution')
  const declaredFeature = readDeclaredDimension(capability, 'feature')

  const family = readVideoFamily(model)
  const familyRatios = family === 'seedance' ? SEEDANCE_RATIOS : family === 'kling' ? KLING_RATIOS : GENERIC_RATIOS

  const ratios = declaredRatio.options.length
    ? declaredRatio.options
    : model.ratios?.length
      ? model.ratios.map(key => familyRatios.find(item => item.key === key) || { label: key, key })
      : familyRatios

  const durations = withDurationLabels(
    declaredDuration.options.length
      ? declaredDuration.options
      // 模型目录已把时长转成 key，这里只负责补一个可读文案
      : model.durs?.length
        ? model.durs.map(item => ({ label: item.label, key: String(item.key) }))
        : DURATIONS_5_10,
  )

  const resolutions = declaredResolution.options.length ? declaredResolution.options : RESOLUTIONS_SD_HD
  const features = declaredFeature.options.length
    ? declaredFeature.options
    : family === 'kling'
      ? FEATURES_I2V_ONLY
      : FEATURES_T2V_I2V_FIRST_LAST

  const pickDefault = (choices: ParamChoice[], declared: string, fromModel: unknown) => {
    if (declared && choices.some(item => item.key === declared)) return declared
    const modelValue = String(fromModel ?? '').trim()
    if (modelValue && choices.some(item => item.key === modelValue)) return modelValue
    return choices[0]?.key || ''
  }

  return {
    ratios,
    durations,
    resolutions,
    features,
    maxCount: readDeclaredCount(capability, 1),
    defaultRatio: pickDefault(ratios, declaredRatio.fallbackDefault, model.defaultParams?.ratio),
    defaultDuration: pickDefault(durations, declaredDuration.fallbackDefault, model.defaultParams?.duration),
    defaultResolution: pickDefault(resolutions, declaredResolution.fallbackDefault, model.defaultParams?.resolution),
  }
}
