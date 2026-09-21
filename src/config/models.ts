/**
 * 模型配置与前端模型注册表
 * 统一从后台公开模型目录读取，不再使用前端静态模型清单。
 */

import { ref } from 'vue'
import { buildApiUrl } from '@/api/http'
import { readApiData } from '@/api/response'
import {
  BANANA_SIZES,
  DURATIONS_5_10,
  GENERIC_RATIOS,
  SEEDREAM_QUALITIES,
  SIZE_2K,
  SIZE_4K,
  resolveImageParamSchema,
  resolveVideoParamSchema,
} from './model-params'

export interface SizeOption {
  label: string
  key: string
}

export interface QualityOption {
  label: string
  key: string
}

export interface DurationOption {
  label: string
  key: number
}

export interface BaseCatalogModel {
  id: string
  key: string
  label: string
  modelKey: string
  providerId: string
  providerCode: string
  providerName: string
  description: string
  capabilityJson: Record<string, any> | null
  defaultParams: Record<string, unknown>
  sortOrder: number
  isDefault: boolean
}

export interface ImageModel extends BaseCatalogModel {
  sizes: string[]
  tips?: string
  qualities?: QualityOption[]
  getSizesByQuality?: (quality: string) => SizeOption[]
  /**
   * 单次请求最多返回多少张图（对应上游 n 参数的硬上限）。
   * 由后台配置在 capabilityJson.maxImagesPerRequest 中提供；
   * 不同上游限制不一样（gpt-image-2 = 4，部分模型 = 1，少数 = 10）。
   * 前端步进器与后端 normalize 均会以此为上限 clamp。
   */
  maxImagesPerRequest: number
}

export interface VideoModel extends BaseCatalogModel {
  ratios: string[]
  durs: DurationOption[]
}

export interface ChatModel extends BaseCatalogModel {}

export interface PublicModelCatalogItem {
  id: string
  selectionKey: string
  providerId: string
  providerCode: string
  providerName: string
  category: 'CHAT' | 'IMAGE' | 'VIDEO'
  label: string
  modelKey: string
  description: string
  capabilityJson: Record<string, any> | null
  defaultParamsJson: Record<string, any> | null
  sortOrder: number
  isDefault: boolean
}

export interface PublicModelCatalogResult {
  providers: Array<{
    id: string
    code: string
    name: string
    iconUrl: string
    supportedTypes: string[]
    sortOrder: number
  }>
  models: {
    chat: PublicModelCatalogItem[]
    image: PublicModelCatalogItem[]
    video: PublicModelCatalogItem[]
  }
  defaults: {
    chat: string
    image: string
    video: string
  }
}

const MODEL_CATALOG_API_PATH = '/api/provider-config/catalog'

// 尺寸 / 画质 / 比例清单的唯一出处是 model-params.ts，这里只做转发，
// 保证「组件看到的选项」和「参数解析用的选项」永远是同一份。
export {
  SIZE_2K as SEEDREAM_SIZE_OPTIONS,
  SIZE_4K as SEEDREAM_4K_SIZE_OPTIONS,
  SEEDREAM_QUALITIES as SEEDREAM_QUALITY_OPTIONS,
  BANANA_SIZES as BANANA_SIZE_OPTIONS,
  GENERIC_RATIOS as VIDEO_RATIO_LIST,
}

export const VIDEO_DURATION_OPTIONS: DurationOption[] = DURATIONS_5_10.map(
  choice => ({ label: choice.label, key: Number(choice.key) }),
)

// 兼容旧代码的导出，避免类型引用报错。
export const IMAGE_MODELS: ImageModel[] = []
export const VIDEO_MODELS: VideoModel[] = []
export const CHAT_MODELS: ChatModel[] = []
export const DEFAULT_IMAGE_MODEL = ''
export const DEFAULT_VIDEO_MODEL = ''
export const DEFAULT_CHAT_MODEL = ''

const emptyCatalog: PublicModelCatalogResult = {
  providers: [],
  models: {
    chat: [],
    image: [],
    video: [],
  },
  defaults: {
    chat: '',
    image: '',
    video: '',
  },
}

const modelCatalogRef = ref<PublicModelCatalogResult>(emptyCatalog)
let modelCatalogPromise: Promise<PublicModelCatalogResult> | null = null

const toImageModel = (item: PublicModelCatalogItem): ImageModel => {
  const defaultParams = item.defaultParamsJson || {}

  // 单次出图最大张数：从 capabilityJson.maxImagesPerRequest 读取，未配置时缺省 1（最保守，
  // 防止跨上游误差直接打穿；管理员可在后台模型配置里覆写为对应上游的真实上限）。
  const capability = (item.capabilityJson || {}) as Record<string, unknown>
  const rawMaxImages = Number(capability.maxImagesPerRequest)
  const maxImagesPerRequest = Number.isFinite(rawMaxImages) && rawMaxImages >= 1
    ? Math.floor(rawMaxImages)
    : 1

  const model: ImageModel = {
    id: item.id,
    key: item.selectionKey,
    label: item.label,
    modelKey: item.modelKey,
    providerId: item.providerId,
    providerCode: item.providerCode,
    providerName: item.providerName,
    description: item.description,
    capabilityJson: item.capabilityJson,
    defaultParams,
    sortOrder: item.sortOrder,
    isDefault: item.isDefault,
    sizes: [],
    maxImagesPerRequest,
  }

  // sizes / qualities / getSizesByQuality 是历史字段，现在统一委托给 model-params，
  // 不再用「默认 size 字符串长什么样」去猜该模型属于哪一族的尺寸表。
  const schema = resolveImageParamSchema(model, '')
  model.sizes = schema.sizes.map(choice => choice.key)
  model.qualities = schema.qualities.length
    ? schema.qualities.map(choice => ({ label: choice.label, key: choice.key }))
    : undefined
  model.getSizesByQuality = schema.qualities.length
    ? (quality: string) => resolveImageParamSchema(model, quality)
      .sizes.map(choice => ({ label: choice.label, key: choice.key }))
    : undefined
  model.tips = schema.sizeHint || undefined

  return model
}

const toVideoModel = (item: PublicModelCatalogItem): VideoModel => {
  const model: VideoModel = {
    id: item.id,
    key: item.selectionKey,
    label: item.label,
    modelKey: item.modelKey,
    providerId: item.providerId,
    providerCode: item.providerCode,
    providerName: item.providerName,
    description: item.description,
    capabilityJson: item.capabilityJson,
    defaultParams: item.defaultParamsJson || {},
    sortOrder: item.sortOrder,
    isDefault: item.isDefault,
    ratios: [],
    durs: [],
  }

  // 同上：比例与时长也由 model-params 统一解析，目录层不再自带清单。
  const schema = resolveVideoParamSchema(model)
  model.ratios = schema.ratios.map(choice => choice.key)
  model.durs = schema.durations.map(choice => ({ label: choice.label, key: Number(choice.key) }))

  return model
}

const toChatModel = (item: PublicModelCatalogItem): ChatModel => ({
  id: item.id,
  key: item.selectionKey,
  label: item.label,
  modelKey: item.modelKey,
  providerId: item.providerId,
  providerCode: item.providerCode,
  providerName: item.providerName,
  description: item.description,
  capabilityJson: item.capabilityJson,
  defaultParams: item.defaultParamsJson || {},
  sortOrder: item.sortOrder,
  isDefault: item.isDefault,
})

const sortModels = <T extends BaseCatalogModel>(models: T[]) => [...models].sort((first, second) => {
  if (first.sortOrder !== second.sortOrder) {
    return first.sortOrder - second.sortOrder
  }
  return first.label.localeCompare(second.label)
})

const applyModelCatalog = (value?: PublicModelCatalogResult) => {
  modelCatalogRef.value = value || emptyCatalog
  return modelCatalogRef.value
}

export const loadPublicModelCatalog = async (force = false) => {
  if (!force && modelCatalogPromise) {
    return modelCatalogPromise
  }

  modelCatalogPromise = fetch(buildApiUrl(MODEL_CATALOG_API_PATH), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })
    .then(response => readApiData<PublicModelCatalogResult>(response))
    .then(data => applyModelCatalog(data))
    .catch(() => applyModelCatalog(emptyCatalog))
    .finally(() => {
      modelCatalogPromise = null
    })

  return modelCatalogPromise
}

export const getPublicModelCatalog = () => modelCatalogRef.value

export const getAllImageModels = (): ImageModel[] => sortModels(modelCatalogRef.value.models.image.map(toImageModel))
export const getAllVideoModels = (): VideoModel[] => sortModels(modelCatalogRef.value.models.video.map(toVideoModel))
export const getAllChatModels = (): ChatModel[] => sortModels(modelCatalogRef.value.models.chat.map(toChatModel))

export const getDefaultImageModelKey = () => modelCatalogRef.value.defaults.image || getAllImageModels()[0]?.key || ''
export const getDefaultVideoModelKey = () => modelCatalogRef.value.defaults.video || getAllVideoModels()[0]?.key || ''
export const getDefaultChatModelKey = () => modelCatalogRef.value.defaults.chat || getAllChatModels()[0]?.key || ''

export const findCatalogModel = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO') => {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) {
    return null
  }

  const groups = category
    ? [category === 'CHAT' ? modelCatalogRef.value.models.chat : category === 'IMAGE' ? modelCatalogRef.value.models.image : modelCatalogRef.value.models.video]
    : [modelCatalogRef.value.models.chat, modelCatalogRef.value.models.image, modelCatalogRef.value.models.video]

  for (const group of groups) {
    const matched = group.find(item => item.selectionKey === normalizedKey || item.modelKey === normalizedKey)
    if (matched) {
      return matched
    }
  }

  return null
}

export const resolveModelSelectionKey = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO') => {
  const matched = findCatalogModel(key, category)
  return matched?.selectionKey || ''
}

export const resolveRequestModelKey = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO') => {
  const matched = findCatalogModel(key, category)
  return matched?.modelKey || String(key || '').trim()
}

export const resolveRequestProviderId = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO') => {
  const matched = findCatalogModel(key, category)
  return matched?.providerId || ''
}

export const resolveModelLabel = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO') => {
  const matched = findCatalogModel(key, category)
  return matched?.label || String(key || '').trim()
}

export const getModelByName = (key: string) => {
  const matched = findCatalogModel(key)
  if (!matched) {
    return null
  }

  if (matched.category === 'IMAGE') {
    return toImageModel(matched)
  }

  if (matched.category === 'VIDEO') {
    return toVideoModel(matched)
  }

  return toChatModel(matched)
}
