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
 * 3. **兜底一律不返回 0**：三种回落原因分开报，后台据此标红提醒运营补录定价。
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
  kind: 'image' | 'video'
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
  /** 最终积分数（整数，非负） */
  points: number
  /** 命中的档位（回落时为 null） */
  tier: PricingTier | null
  /** 是否走了草案兜底 */
  usingDraft: boolean
  /** 走兜底的原因（用于日志分类与后台标红） */
  fallbackReason?: PricingFallbackReason
  /** 给人看的说明（后台/日志用） */
  detail: string
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
 * 把上游请求里的原始规格归一化成定价入参（结算与预估都从它拿值，避免两边各自解释请求）。
 *
 * - `size` 形如 `1024x1024`（个别渠道用 `×`）：拆成长宽供 longEdge/shortEdge 归档，
 *   同时把原样字符串塞进 `label`（label 模式的上游档位值就是它）。
 * - 视频 `seconds` 必须先经 `normalizeVideoSeconds` clamp —— 只归一化定价、不归一化时长，
 *   就会出现「预估 30 秒、实扣 20 秒」这种对不上的账。
 * - `count` 保底 1（perTask 渠道不随张数变化，perImage 渠道则要按张乘）。
 */
export const buildNormalizedGenerationParams = (input: {
  kind: 'image' | 'video'
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
  /** 读到的定价配置；null 表示读取失败（→ 走草案兜底） */
  spec: ModelPricingSpec | null
  params: NormalizedGenerationParams
  /** 读取定价配置本身的错误（区分「读不到」与「没配」两种兜底原因） */
  configLoadFailed?: boolean
  /** 该模型的草案兜底价（来自代码常量，见 DRAFT_MODEL_PRICING） */
  draftPrice: TierPrice
}

/**
 * 统一入口：**读到的配置 → 档位匹配 → 定价**，失败则回落草案价。
 *
 * 预估接口与真实扣费都必须调它，不许各自实现 —— 这是「预估 = 实扣」的唯一保证方式。
 */
export const getGenerationCost = (input: GetGenerationCostInput): GenerationCostResult => {
  const { spec, params, draftPrice } = input

  const fallback = (reason: PricingFallbackReason, detail: string): GenerationCostResult => ({
    points: computeTierPoints(draftPrice, params),
    tier: null,
    usingDraft: true,
    fallbackReason: reason,
    detail,
  })

  /**
   * 两种「拿不到定价」必须分开报 —— 它们对应完全不同的运营动作：
   *   读取失败 → 查数据库/服务是否异常（环境问题）
   *   没配价   → 让运营去后台补录（配置缺失）
   * 之前把两者并成一个条件，结果没配价的模型被报成「读配置失败」，
   * 排查时会朝错误方向查 —— 这是真机跑出来才发现的。
   */
  if (input.configLoadFailed) {
    return fallback('pricing_config_load_failed', '读取定价配置失败，按草案兜底价计费（先查数据库/服务是否异常）')
  }
  if (!spec) {
    return fallback('pricing_model_not_configured', '该模型尚无定价配置，按草案兜底价计费（请在后台补录）')
  }
  if (!spec.tiers?.length) {
    return fallback('pricing_model_not_configured', '该模型尚无定价配置，按草案兜底价计费（请在后台补录）')
  }
  // 有档位却没声明匹配方式：**不猜模式**（猜就是静默算错价），按未标定回落
  if (spec.matchMode !== 'none' && (!spec.matchMode || (spec.matchMode === 'label' && !spec.labelAxis))) {
    return fallback('pricing_mode_not_calibrated', '定价未标定匹配模式，按草案兜底价计费（接入上游后需标定）')
  }

  const tier = matchPricingTier(spec, params)
  if (!tier) {
    return fallback(
      'tier_match_failed',
      `规格匹配不到任何档位（${spec.matchMode}${params.label ? `，label=${params.label}` : ''}），按草案兜底价计费`,
    )
  }

  return {
    points: computeTierPoints(tier.price, params),
    tier,
    usingDraft: false,
    detail: `命中档位「${tier.resolutionLabel}」`,
  }
}

/**
 * 草案兜底价（**仅应急**：配置读不到 / 模型未配价 / 档位匹配失败时用）。
 *
 * 数值待从旧项目（SceneFlow）经过真实流量验证的那份价目表照搬 —— 那份知道盈亏边界。
 * 在此之前一律给一个**非零**的上界值：宁可略高，也不静默 0 分白送（这是踩过的坑）。
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
