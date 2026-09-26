/**
 * 模型定价规则（纯函数，不碰 IO）—— 预估与真实扣费**共用的唯一入口**
 *
 * 这个文件存在的唯一理由：让「预估要多少分」和「实际扣多少分」在结构上不可能不一致。
 * 两条链路都调 getGenerationCost，任何分歧都只能来自入参不同，不可能来自两套算法。
 *
 * 三个已定稿的设计约束都落在这里：
 * 1. **计价轴由渠道决定，不由模型名决定**。同一个 `gpt-image-2`，Replicate 上是一口价，
 *    经 ggwk1 是按次（perTask）；同名不同渠道必须各自标定（实测已确认）。
 * 2. **参数归一化也在这一条链路上**（含视频时长 clamp）。只共享「定价」是不够的：
 *    如果预估用请求里的 30 秒、扣费用 clamp 后的 20 秒，两个数必然对不上。
 * 3. **只有「读配置本身失败」才用草案兜底**（那是真异常，先让业务能跑）；模型未配价 /
 *    有档位却没标定匹配模式 / 规格匹配不到档位，一律**拒绝生成**（返回 refuse=true，
 *    由调用方转成 4xx），绝不静默按一个假价扣费 —— 「按 6 分收视频任务的钱」就是踩过的坑。
 */

export type PricingMatchMode = 'none' | 'label' | 'longEdge' | 'shortEdge'

/** label 模式下，档位标签取自哪个入参 */
export type PricingLabelAxis = 'size' | 'quality'

/** 单个档位的价格。三者互斥：perImage（按张）/ perTask（按次）/ perSecond（按秒） */
export interface TierPrice {
  perImage?: number
  perTask?: number
  perSecond?: number
  /** 按秒计费时的保底秒数（上游常按秒结算且有最小值） */
  minSeconds?: number
  /** 按秒计费时的固定起步费 */
  baseFee?: number
}

export interface PricingTier {
  /** 运营可读的档位名，必填（后台靠它核对） */
  resolutionLabel: string
  /** label 模式：上游的档位值原样（如 quality 的 'high'、size 的 '1024x1024'） */
  upstreamLabel?: string
  /**
   * 边归档模式的区间（闭区间）。
   *
   * 命名故意不带 long/short：同一个字段在 longEdge 模式装长边、在 shortEdge 模式装短边。
   * 之前叫 longEdgeMin/Max，到了 shortEdge 模式下就变成「字段名说长边、实际装短边」——
   * 单测里那条失败用例正是这么抓出来的。名字中性与匹配模式解耦，少一个踩坑点。
   */
  edgeMin?: number
  edgeMax?: number
  price: TierPrice
}

export interface ModelPricingSpec {
  matchMode: PricingMatchMode
  /** label 模式必填：标签来自 size 还是 quality */
  labelAxis?: PricingLabelAxis
  tiers: PricingTier[]
}

/** 归一化后、用于定价的参数（各渠道的原始参数先经 normalize 变成它） */
export interface NormalizedGenerationParams {
  kind: 'image' | 'video' | 'audio'
  /** 图片：请求的尺寸；视频：分辨率档 */
  width?: number
  height?: number
  /** label 模式用：归一化后的档位标签（size 字符串或 quality 值） */
  label?: string
  /** 视频：**归一化后**的时长（秒）。必须是传给上游的那个值，不是用户原始请求值 */
  seconds?: number
  /** 一次请求产出几个（图片张数） */
  count?: number
}

export type PricingFallbackReason =
  | 'pricing_config_load_failed'
  | 'pricing_model_not_configured'
  | 'pricing_mode_not_calibrated'
  | 'tier_match_failed'

export interface GenerationCostResult {
  /** 最终积分数（整数，非负）。**被拒绝时为 0** —— 调用方必须先看 refuse 再决定用不用它 */
  points: number
  /** 命中的档位（未命中时为 null） */
  tier: PricingTier | null
  /** 是否走了草案兜底（仅「读配置本身失败」这一种真异常） */
  usingDraft: boolean
  /** 走草案兜底的原因（仅 usingDraft 为 true 时出现） */
  fallbackReason?: PricingFallbackReason
  /**
   * 是否**拒绝**计费：模型没配价 / 定价未标定 / 规格匹配不到档位时为 true。
   * 调用方必须据此拒绝生成（转成明确的 4xx），**绝不允许**忽略它按 points 扣费。
   */
  refuse: boolean
  /** 拒绝原因（refuse 为 true 时必有），与 FallbackReason 共用同一套枚举值 */
  refuseReason?: PricingFallbackReason
  /** 给人看的说明（正常价/草案兜底/拒绝三种情况都有可读文案） */
  detail: string
}

/** 拒绝计费的语义化错误码：接口层据此返回 4xx，而不是把「未配价」伪装成 500 */
export const MODEL_PRICING_REFUSED_CODE = 'MODEL_PRICING_REFUSED'

/**
 * 「模型未配价 / 定价未标定 / 规格匹配不到档位」时抛出的错误。
 *
 * 为什么单独一个类而不是返回 0：0 分会被当成「免费」静默放行，用户拿到一次白嫖、
 * 平台倒贴一次上游成本。用异常把这条路径**显式挡在扣费之前**，接口层再转成可读的 4xx。
 */
export class ModelPricingRefusedError extends Error {
  code = MODEL_PRICING_REFUSED_CODE
  statusCode = 400
  reason: PricingFallbackReason

  constructor(reason: PricingFallbackReason, message: string) {
    super(message)
    this.name = 'ModelPricingRefusedError'
    this.reason = reason
  }
}

/** 识别拒绝计费错误（跨模块 catch 里用，避免各处 instanceof 时漏 import） */
export const isModelPricingRefusedError = (error: unknown): error is ModelPricingRefusedError => {
  return (error as { code?: string } | null | undefined)?.code === MODEL_PRICING_REFUSED_CODE
}

/**
 * 视频时长归一化：**clamp 到 1~20 秒**。
 *
 * 这条与旧项目 `normalizeVideoSeconds` 的口径保持一致 —— 之前的问题正是「两边各 clamp 一次、
 * 或者一边 clamp 一边不 clamp」，于是 30 秒的请求按 20 秒记账，差价平台自己吃。
 * 现在只有一个实现，预估与扣费都从它拿值。
 */
export const normalizeVideoSeconds = (input: number, max = 20, min = 1): number => {
  const value = Math.trunc(Number(input) || 0)
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * 音频时长归一化：**clamp 到 1~600 秒**。
 *
 * 为什么不复用 `normalizeVideoSeconds`：那个的上限是 20 秒，是视频模型的档位决定的。
 * 音频/音乐常见 30s / 60s / 180s，套 20 秒的上限会把它们统统砍成 20 ——
 * 「请求 180 秒、按 20 秒记账」正是我们已经在视频上踩过的坑，不能在新分类上再犯一遍。
 */
export const AUDIO_SECONDS_MIN = 1
export const AUDIO_SECONDS_MAX = 600

export const normalizeAudioSeconds = (
  input: unknown,
  max = AUDIO_SECONDS_MAX,
  min = AUDIO_SECONDS_MIN,
): number => {
  const value = Math.trunc(Number(input) || 0)
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * 把上游请求里的原始规格归一化成定价入参（结算与预估都从它拿值，避免两边各自解释请求）。
 *
 * - `size` 形如 `1024x1024`（个别渠道用 `×`）：拆成长宽供 longEdge/shortEdge 归档，
 *   同时把原样字符串塞进 `label`（label 模式的上游档位值就是它）。
 * - 视频 `seconds` 必须先经 `normalizeVideoSeconds` clamp —— 只归一化定价、不归一化时长，
 *   就会出现「预估 30 秒、实扣 20 秒」这种对不上的账。
 * - `count` 保底 1（perTask 渠道不随张数变化，perImage 渠道则要按张乘）。
 */
export const buildNormalizedGenerationParams = (input: {
  kind: 'image' | 'video' | 'audio'
  /** 上游尺寸字符串，如 `1024x1024` / `1536x1024` */
  size?: unknown
  /** 一次请求产出几个（图片张数）；缺省按 1 */
  count?: unknown
  /** 视频时长（秒），传用户原始请求值即可，clamp 由这里负责 */
  seconds?: unknown
}): NormalizedGenerationParams => {
  const sizeText = String(input.size ?? '').trim()
  const sizeMatch = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(sizeText)
  const count = Math.max(1, Math.trunc(Number(input.count) || 1))
  const secondsValue = Number(input.seconds)
  return {
    kind: input.kind,
    count,
    ...(sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : {}),
    ...(sizeText ? { label: sizeText } : {}),
    ...(input.kind === 'video' && Number.isFinite(secondsValue) && secondsValue > 0
      ? { seconds: normalizeVideoSeconds(secondsValue) }
      : {}),
    // 音频走自己的区间（见 normalizeAudioSeconds 的注释：不能用视频的 1~20）
    ...(input.kind === 'audio' && Number.isFinite(secondsValue) && secondsValue > 0
      ? { seconds: normalizeAudioSeconds(secondsValue) }
      : {}),
  }
}

/** 图片档位归档用的边长：图片取长边、视频取短边（竖屏 1080×1920 也算 1080p） */
export const pickEdgeForMode = (
  mode: PricingMatchMode,
  params: NormalizedGenerationParams,
): number | null => {
  const width = Number(params.width) || 0
  const height = Number(params.height) || 0
  if (!width || !height) return null
  if (mode === 'longEdge') return Math.max(width, height)
  if (mode === 'shortEdge') return Math.min(width, height)
  return null
}

/** 按 matchMode 找档位；找不到返回 null（由调用方转成 tier_match_failed 回落） */
export const matchPricingTier = (
  spec: ModelPricingSpec,
  params: NormalizedGenerationParams,
): PricingTier | null => {
  if (spec.matchMode === 'none') {
    return spec.tiers[0] ?? null
  }
  if (spec.matchMode === 'label') {
    const label = String(params.label || '').trim()
    if (!label) return null
    return spec.tiers.find((tier) => String(tier.upstreamLabel || '').trim() === label) ?? null
  }
  const edge = pickEdgeForMode(spec.matchMode, params)
  if (edge === null) return null
  return (
    spec.tiers.find((tier) => {
      const min = Number.isFinite(tier.edgeMin as number) ? (tier.edgeMin as number) : Number.NEGATIVE_INFINITY
      const max = Number.isFinite(tier.edgeMax as number) ? (tier.edgeMax as number) : Number.POSITIVE_INFINITY
      return edge >= min && edge <= max
    }) ?? null
  )
}

/** 按档位价格算出总积分（整数，向上取整 —— 宁可略高也不白送） */
export const computeTierPoints = (price: TierPrice, params: NormalizedGenerationParams): number => {
  const count = Math.max(1, Math.trunc(Number(params.count) || 1))
  let total = 0
  if (typeof price.perTask === 'number') {
    total += price.perTask
  }
  if (typeof price.perImage === 'number') {
    total += price.perImage * count
  }
  if (typeof price.perSecond === 'number') {
    const seconds = Math.max(Number(price.minSeconds) || 0, Number(params.seconds) || 0)
    total += (Number(price.baseFee) || 0) + price.perSecond * seconds
  }
  return Math.max(0, Math.ceil(total))
}

export interface GetGenerationCostInput {
  /** 读到的定价配置；null 表示「没有定价记录」或读取失败（由 configLoadFailed 区分） */
  spec: ModelPricingSpec | null
  params: NormalizedGenerationParams
  /** 读取定价配置本身的错误（只有它为 true 才走草案兜底） */
  configLoadFailed?: boolean
  /** 该模型的草案兜底价（来自代码常量，见 DRAFT_MODEL_PRICING） */
  draftPrice: TierPrice
}

/**
 * 拒绝时给用户看的文案：必须说清「为什么不能生成、要找谁」，不能只报「服务器错误」。
 *
 * 三种拒绝分别对应不同的运营动作，所以要分别措辞；匹配失败还要把规格值带出来，
 * 否则用户只知道「不能用」，不知道是尺寸不对还是时长不对。
 */
export const buildPricingRefusalMessage = (
  reason: PricingFallbackReason,
  spec: ModelPricingSpec | null,
  params: NormalizedGenerationParams,
): string => {
  if (reason === 'pricing_model_not_configured') {
    return '该模型未配置定价，暂时无法生成。请联系运营为该模型补录定价后重试。'
  }
  if (reason === 'pricing_mode_not_calibrated') {
    return '该模型的定价未标定匹配模式，暂时无法生成。请联系运营补全定价配置。'
  }

  const mode = spec?.matchMode || 'none'
  const specParts: string[] = []
  if (params.label) specParts.push(`label=${params.label}`)
  if (params.width && params.height) specParts.push(`尺寸=${params.width}x${params.height}`)
  if (params.kind === 'video' && params.seconds) specParts.push(`时长=${params.seconds}秒`)
  if (params.count && params.count > 1) specParts.push(`数量=${params.count}`)
  const edge = pickEdgeForMode(mode, params)
  const edgePart = edge === null ? '' : `，匹配边值=${edge}`
  const specPart = specParts.length ? `，规格：${specParts.join('、')}` : ''
  return `当前规格匹配不到该模型的定价档位（匹配模式 ${mode}${edgePart}${specPart}），无法生成。请调整规格，或联系运营补全对应档位。`
}

/**
 * 统一入口：**读到的配置 → 档位匹配 → 定价**；拿不到正式价时**拒绝**，绝不静默收假价。
 *
 * 预估接口与真实扣费都必须调它，不许各自实现 —— 这是「预估 = 实扣」的唯一保证方式。
 * 唯一的草案兜底是「读配置本身失败」（真异常，先让业务能跑并告警）；
 * 「没配价 / 没标定 / 匹配不到档位」是**配置缺失**，一律 refuse，由调用方转 4xx。
 */
export const getGenerationCost = (input: GetGenerationCostInput): GenerationCostResult => {
  const { spec, params, draftPrice } = input

  const draftFallback = (detail: string): GenerationCostResult => ({
    points: computeTierPoints(draftPrice, params),
    tier: null,
    usingDraft: true,
    fallbackReason: 'pricing_config_load_failed',
    refuse: false,
    detail,
  })

  const refuse = (reason: PricingFallbackReason): GenerationCostResult => ({
    // 拒绝时不给任何「假价」：points 记 0，真正拦下来的是调用方对 refuse 的处理
    points: 0,
    tier: null,
    usingDraft: false,
    refuse: true,
    refuseReason: reason,
    detail: buildPricingRefusalMessage(reason, spec, params),
  })

  /**
   * 只有「读配置本身失败」才走草案兜底 —— 它对应「数据库/服务异常」这类环境问题，
   * 让业务先能跑并打日志告警；其余三种拿不到价都是配置缺失，直接拒绝。
   */
  if (input.configLoadFailed) {
    return draftFallback('读取定价配置失败，按草案兜底价计费（先查数据库/服务是否异常）')
  }
  // 「没有定价记录」与「档位为空」都归为未配价：两者对运营都是「去补录」同一个动作
  if (!spec || !spec.tiers?.length) {
    return refuse('pricing_model_not_configured')
  }
  // 有档位却没声明匹配方式：**不猜模式**（猜就是静默算错价），按未标定拒绝
  if (spec.matchMode !== 'none' && (!spec.matchMode || (spec.matchMode === 'label' && !spec.labelAxis))) {
    return refuse('pricing_mode_not_calibrated')
  }

  const tier = matchPricingTier(spec, params)
  if (!tier) {
    return refuse('tier_match_failed')
  }

  return {
    points: computeTierPoints(tier.price, params),
    tier,
    usingDraft: false,
    refuse: false,
    detail: `命中档位「${tier.resolutionLabel}」`,
  }
}

/**
 * 草案兜底价（**仅用于「读取定价配置失败」这一种真异常**）。
 *
 * 模型未配价 / 未标定 / 规格匹配失败都改成了拒绝生成（见 getGenerationCost），
 * 不再套用这个价 —— 那样做等于「视频按图片价卖」，平台倒贴。
 * 数值仍保留为非零上界值：宁可略高，也不静默 0 分白送（这是踩过的坑）。
 */
export const DRAFT_MODEL_PRICING: TierPrice = { perImage: 6 }

/** 保存定价时的校验：能力声明的档位必须有价、单位互斥、同轴区间不重叠、label 必填 */
export const validateModelPricing = (spec: ModelPricingSpec): string[] => {
  const problems: string[] = []
  if (!spec.tiers?.length) {
    problems.push('至少要有一个档位')
    return problems
  }
  if (spec.matchMode === 'label' && !spec.labelAxis) {
    problems.push('label 模式必须声明 labelAxis（size 或 quality）')
  }

  const seenLabels = new Set<string>()
  const ranges: Array<{ min: number; max: number; label: string }> = []

  for (const tier of spec.tiers) {
    const where = `档位「${tier.resolutionLabel || '(未命名)'}」`
    if (!String(tier.resolutionLabel || '').trim()) {
      problems.push('每个档位必须有 resolutionLabel（运营靠它核对）')
    }
    const { perImage, perTask, perSecond } = tier.price || {}
    const units = [perImage, perTask, perSecond].filter((value) => typeof value === 'number')
    if (!units.length) problems.push(`${where} 没有任何价格`)
    if (units.length > 1) problems.push(`${where} 同时配了多种计价单位（perImage / perTask / perSecond 只能选一种）`)
    if (units.some((value) => Number(value) <= 0)) problems.push(`${where} 的价格必须大于 0`)

    if (spec.matchMode === 'label') {
      const label = String(tier.upstreamLabel || '').trim()
      if (!label) problems.push(`${where} 缺少 upstreamLabel`)
      else if (seenLabels.has(label)) problems.push(`${where} 的 upstreamLabel「${label}」与其它档位重复`)
      else seenLabels.add(label)
    }

    if (spec.matchMode === 'longEdge' || spec.matchMode === 'shortEdge') {
      const min = tier.edgeMin
      const max = tier.edgeMax
      if (typeof min !== 'number' || typeof max !== 'number') {
        problems.push(`${where} 缺少 ${spec.matchMode} 的区间（edgeMin / edgeMax）`)
      } else if (min > max) {
        problems.push(`${where} 的区间上下界反了`)
      } else {
        ranges.push({ min, max, label: tier.resolutionLabel || '?' })
      }
    }
  }

  // 同一轴上的区间不允许重叠 —— 重叠意味着同一个规格可能命中两个价，匹配结果不确定
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i]
      const b = ranges[j]
      if (a.min <= b.max && b.min <= a.max) {
        problems.push(`档位「${a.label}」与「${b.label}」的区间重叠，同一规格可能命中两个价`)
      }
    }
  }

  return problems
}
