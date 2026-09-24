import type { ModelCategory } from '@prisma/client'
import { prisma } from '../db/prisma'
import {
  DRAFT_MODEL_PRICING,
  getGenerationCost,
  validateModelPricing,
  type ModelPricingSpec,
  type NormalizedGenerationParams,
  type PricingMatchMode,
  type PricingTier,
  type TierPrice,
} from '../../src/shared/model-pricing-rules'

/**
 * 管理端读写 `model_pricing` 定价表。
 *
 * 为什么需要它：模型配置里那个「计费规则」（defaultParamsJson.billingRule.power）对图 / 视频
 * **完全不生效** —— 图片/视频结算与预估走的是 `resolveModelPricingCost`，只认 `model_pricing.priceJson`。
 * 之前全库只有两条定价是手工脚本写进去的，运营既改不了价、也加不了新模型定价。
 *
 * 保存时一律过 `validateModelPricing`（单位互斥 / 价格 > 0 / label 必填且不重复 / 边归档区间不重叠），
 * 把非法配置挡在写库之前；校验与扣费算法共用同一份规则，避免「后台存进去了、扣费时却匹配不到」。
 */

const PRICING_MATCH_MODES: PricingMatchMode[] = ['none', 'label', 'longEdge', 'shortEdge']
const PRICING_LABEL_AXES = ['size', 'quality'] as const

export interface ModelPricingSavePayload {
  spec?: unknown
  /** 只校验不写库（界面保存前的预览校验用） */
  dryRun?: boolean
}

const assertPlainObject = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

const readOptionalNumber = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`价格必须是数字，收到 ${JSON.stringify(value)}`)
  }
  return parsed
}

const normalizeTierPrice = (raw: unknown, where: string): TierPrice => {
  const record = assertPlainObject(raw, `${where} 缺少 price 对象`)
  const price: TierPrice = {}
  const perImage = readOptionalNumber(record.perImage)
  const perTask = readOptionalNumber(record.perTask)
  const perSecond = readOptionalNumber(record.perSecond)
  const minSeconds = readOptionalNumber(record.minSeconds)
  const baseFee = readOptionalNumber(record.baseFee)
  if (perImage !== undefined) price.perImage = perImage
  if (perTask !== undefined) price.perTask = perTask
  if (perSecond !== undefined) price.perSecond = perSecond
  if (minSeconds !== undefined) price.minSeconds = minSeconds
  if (baseFee !== undefined) price.baseFee = baseFee
  return price
}

const normalizeTier = (raw: unknown, index: number): PricingTier => {
  const record = assertPlainObject(raw, `第 ${index + 1} 个档位必须是对象`)
  const resolutionLabel = String(record.resolutionLabel || '').trim()
  const upstreamLabel = String(record.upstreamLabel || '').trim()
  const edgeMin = readOptionalNumber(record.edgeMin)
  const edgeMax = readOptionalNumber(record.edgeMax)
  return {
    resolutionLabel,
    ...(upstreamLabel ? { upstreamLabel } : {}),
    ...(edgeMin !== undefined ? { edgeMin } : {}),
    ...(edgeMax !== undefined ? { edgeMax } : {}),
    price: normalizeTierPrice(record.price, `档位「${resolutionLabel || index + 1}」`),
  }
}

/** 把管理端传来的宽松 JSON 收口成 ModelPricingSpec（字段类型/枚举先过一遍） */
export const normalizeModelPricingSpec = (raw: unknown): ModelPricingSpec => {
  const record = assertPlainObject(raw, '定价配置必须是一个 JSON 对象')
  const matchMode = String(record.matchMode || '').trim() as PricingMatchMode
  if (!PRICING_MATCH_MODES.includes(matchMode)) {
    throw new Error('matchMode 只能是 none / label / longEdge / shortEdge 之一')
  }

  const labelAxisRaw = String(record.labelAxis || '').trim()
  if (labelAxisRaw && !PRICING_LABEL_AXES.includes(labelAxisRaw as (typeof PRICING_LABEL_AXES)[number])) {
    throw new Error('labelAxis 只能是 size 或 quality')
  }

  const tiersRaw = record.tiers
  if (!Array.isArray(tiersRaw)) {
    throw new Error('tiers 必须是数组')
  }

  return {
    matchMode,
    ...(labelAxisRaw ? { labelAxis: labelAxisRaw as 'size' | 'quality' } : {}),
    tiers: tiersRaw.map((tier, index) => normalizeTier(tier, index)),
  }
}

/** 校验定价配置：类型收口 → validateModelPricing（与扣费算法共用同一份规则） */
export const validateModelPricingPayload = (raw: unknown): { spec: ModelPricingSpec; problems: string[] } => {
  const spec = normalizeModelPricingSpec(raw)
  return { spec, problems: validateModelPricing(spec) }
}

const readDefaultSize = (defaultParamsJson: unknown) => {
  if (!defaultParamsJson || typeof defaultParamsJson !== 'object' || Array.isArray(defaultParamsJson)) {
    return ''
  }
  return String((defaultParamsJson as Record<string, unknown>).size || '').trim()
}

const readDefaultVideoSeconds = (defaultParamsJson: unknown) => {
  if (!defaultParamsJson || typeof defaultParamsJson !== 'object' || Array.isArray(defaultParamsJson)) {
    return 5
  }
  const record = defaultParamsJson as Record<string, unknown>
  const raw = Number(record.duration ?? record.seconds)
  return Number.isFinite(raw) && raw > 0 ? raw : 5
}

/** 用该模型类别的默认参数算一遍，给运营看「照这个配置实际会扣多少分」 */
const buildPricingPreview = (input: {
  spec: ModelPricingSpec | null
  category: ModelCategory
  defaultParamsJson: unknown
}) => {
  const size = readDefaultSize(input.defaultParamsJson)
  const params: NormalizedGenerationParams =
    input.category === 'VIDEO'
      ? {
          kind: 'video',
          seconds: readDefaultVideoSeconds(input.defaultParamsJson),
          count: 1,
        }
      : { kind: 'image', count: 1, ...(size ? { label: size } : {}) }

  const result = getGenerationCost({
    spec: input.spec,
    params,
    draftPrice: DRAFT_MODEL_PRICING,
  })

  return {
    pointCost: result.points,
    usingDraft: result.usingDraft,
    // 拒绝计费（未配价/未标定/匹配失败）：界面据此提示「该模型会拒绝生成」，而不是显示假价
    refused: result.refuse,
    detail: result.detail,
    params,
  }
}

const buildPricingItem = (input: {
  model: {
    id: string
    providerId: string
    category: ModelCategory
    name: string
    modelKey: string
    defaultParamsJson: unknown
    pricing: {
      priceJson: unknown
      usingDraft: boolean
      updatedAt: Date
    } | null
  }
}) => {
  const rawSpec = input.model.pricing?.priceJson ?? null
  let spec: ModelPricingSpec | null = null
  let draftReason = ''
  if (!rawSpec) {
    draftReason = '未配置定价，生成会被拒绝（请在「计费定价」页签补录）'
  } else {
    spec = rawSpec as ModelPricingSpec
    if (!Array.isArray(spec.tiers) || !spec.tiers.length) {
      draftReason = '定价档位为空，生成会被拒绝（请补录档位）'
    } else {
      const problems = validateModelPricing(spec)
      if (problems.length) {
        draftReason = `现有定价配置不合法（${problems.join('；')}），生成会被拒绝（请修正后再用）`
      }
    }
  }

  return {
    modelId: input.model.id,
    providerId: input.model.providerId,
    category: input.model.category,
    modelName: input.model.name,
    modelKey: input.model.modelKey,
    hasPricing: Boolean(input.model.pricing),
    // 运营要能一眼看到「这个模型现在不能用」→ 提醒补录正式定价
    usingDraft: Boolean(draftReason),
    draftReason,
    updatedAt: input.model.pricing?.updatedAt?.toISOString() || null,
    spec,
    preview: buildPricingPreview({
      spec,
      category: input.model.category,
      defaultParamsJson: input.model.defaultParamsJson,
    }),
  }
}

const PRICING_MODEL_SELECT = {
  id: true,
  providerId: true,
  category: true,
  name: true,
  modelKey: true,
  defaultParamsJson: true,
  pricing: {
    select: { priceJson: true, usingDraft: true, updatedAt: true },
  },
} as const

/** 列出全部模型及其定价状态（含 usingDraft 标记），供管理端定价总览。 */
export const listModelPricingOverview = async (input: { providerId?: string; category?: ModelCategory } = {}) => {
  const providerId = String(input.providerId || '').trim()
  const models = await prisma.aiModel.findMany({
    where: {
      ...(providerId ? { providerId } : {}),
      ...(input.category ? { category: input.category } : {}),
    },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: PRICING_MODEL_SELECT,
  })

  const items = models.map((model) => buildPricingItem({ model }))
  return {
    items,
    summary: {
      modelCount: items.length,
      pricedCount: items.filter((item) => item.hasPricing).length,
      draftCount: items.filter((item) => item.usingDraft).length,
    },
  }
}

const findModelForPricing = async (providerId: string, modelId: string) => {
  const normalizedProviderId = String(providerId || '').trim()
  const normalizedModelId = String(modelId || '').trim()
  if (!normalizedProviderId || !normalizedModelId) {
    throw new Error('缺少厂商 ID 或模型 ID')
  }
  const model = await prisma.aiModel.findUnique({
    where: { id: normalizedModelId },
    select: PRICING_MODEL_SELECT,
  })
  if (!model || model.providerId !== normalizedProviderId) {
    throw new Error('模型配置不存在')
  }
  return model
}

/** 读取单个模型的定价配置（含 usingDraft 标记与试算价）。 */
export const getModelPricing = async (providerId: string, modelId: string) => {
  const model = await findModelForPricing(providerId, modelId)
  return buildPricingItem({ model })
}

/**
 * 保存单个模型的定价。
 *
 * 先 `validateModelPricing` 校验；不通过直接抛错（接口层转 400），绝不把非法配置写进库。
 * dryRun 只校验不写，供界面保存前预检。
 */
export const saveModelPricing = async (providerId: string, modelId: string, payload: ModelPricingSavePayload) => {
  const model = await findModelForPricing(providerId, modelId)
  const { spec, problems } = validateModelPricingPayload(payload.spec)
  if (problems.length) {
    throw new Error(`定价校验不通过：${problems.join('；')}`)
  }

  if (payload.dryRun) {
    return {
      saved: false,
      item: buildPricingItem({ model: { ...model, pricing: null } }),
      spec,
    }
  }

  await prisma.modelPricing.upsert({
    where: { modelId: model.id },
    create: {
      modelId: model.id,
      type: model.category,
      priceJson: spec as any,
      // 手工录入的是正式定价，不再走草案兜底
      usingDraft: false,
    },
    update: {
      type: model.category,
      priceJson: spec as any,
      usingDraft: false,
    },
  })

  return { saved: true, item: await getModelPricing(providerId, modelId) }
}

/** 删除单个模型的定价（删掉后该模型的生成会被拒绝，直到重新配置）。 */
export const deleteModelPricing = async (providerId: string, modelId: string) => {
  const model = await findModelForPricing(providerId, modelId)
  await prisma.modelPricing.deleteMany({ where: { modelId: model.id } })
  return { modelId: model.id, deleted: true }
}
