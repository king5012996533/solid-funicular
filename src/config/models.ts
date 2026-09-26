/**
 * 模型配置与前端模型注册表
 * 统一从后台公开模型目录读取，不再使用前端静态模型清单。
 */

import { ref } from 'vue'
import { ElMessage } from 'element-plus'
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

export interface AudioModel extends BaseCatalogModel {
  /** 可选时长档位（秒）；模型未声明时为空数组，由工具栏回落默认档 */
  seconds: number[]
  /** 可选输出格式（mp3 / wav 等）；模型未声明时为空数组，对应控件不渲染 */
  formats: string[]
}

export interface ChatModel extends BaseCatalogModel {}

export interface PublicModelCatalogItem {
  id: string
  selectionKey: string
  providerId: string
  providerCode: string
  providerName: string
  category: 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO'
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
    audio: PublicModelCatalogItem[]
  }
  defaults: {
    chat: string
    image: string
    video: string
    audio: string
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
    audio: [],
  },
  defaults: {
    chat: '',
    image: '',
    video: '',
    audio: '',
  },
}

const modelCatalogRef = ref<PublicModelCatalogResult>(emptyCatalog)
let modelCatalogPromise: Promise<PublicModelCatalogResult> | null = null

/**
 * 目录快照的新鲜度。
 *
 * 为什么需要它：目录只有内存快照，而**解析模型（resolveModelSelection / 各工具栏）都是纯读**，
 * 自己不会重拉。以前唯一的刷新时机是「某个组件挂载时调一次 loadPublicModelCatalog」——
 * 于是页面加载那一瞬间拿到的快照（可能是空的、也可能少了刚被下架的模型）会被整个会话一直用下去。
 * 用户看到的「未匹配到后台模型配置，请先在后台配置可用模型」有很多就是这样来的：
 * 后台目录早好了，前端手里还是那份旧快照。
 *
 * TTL 内复用快照（避免每个组件挂载都打一次网络），过期后下一次调用真拉；
 * 解析失败时另有 resolveModelSelection() 强拉一次兜底，所以 TTL 不会把用户卡在旧目录上。
 */
const MODEL_CATALOG_TTL_MS = 30 * 1000
let modelCatalogLoadedAt = 0

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

/** 读取模型声明的数字档位（音频时长）：非法值丢弃、去重后升序，读不出来就是空数组 */
const readNumberOptionList = (value: unknown): number[] => {
  if (!Array.isArray(value)) return []
  const numbers: number[] = []
  for (const item of value) {
    const parsed = Number(item)
    if (Number.isFinite(parsed) && parsed > 0) {
      numbers.push(parsed)
    }
  }
  return Array.from(new Set(numbers)).sort((first, second) => first - second)
}

/** 读取模型声明的字符串档位（音频格式）：去空、去重，字段缺失时当空数组 */
const readStringOptionList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const options: string[] = []
  for (const item of value) {
    const normalized = String(item ?? '').trim()
    if (normalized && !options.includes(normalized)) {
      options.push(normalized)
    }
  }
  return options
}

const toAudioModel = (item: PublicModelCatalogItem): AudioModel => {
  // 音频模型用 capabilityJson.seconds / formats 声明可选档位；
  // 目录没给（或写坏）时一律当空数组，工具栏据此隐藏对应控件，不抛错。
  const capability = (item.capabilityJson || {}) as Record<string, unknown>
  return {
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
    seconds: readNumberOptionList(capability.seconds),
    formats: readStringOptionList(capability.formats),
  }
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
  // 并发去重：同一批组件挂载只打一次网络。
  if (modelCatalogPromise) {
    return modelCatalogPromise
  }

  // TTL 内直接复用内存快照；force 用于「解析失败，怀疑快照过期」时的强拉。
  if (!force && modelCatalogLoadedAt && Date.now() - modelCatalogLoadedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogRef.value
  }

  modelCatalogPromise = fetch(buildApiUrl(MODEL_CATALOG_API_PATH), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })
    .then(response => readApiData<PublicModelCatalogResult>(response))
    .then(data => {
      modelCatalogLoadedAt = Date.now()
      return applyModelCatalog(data)
    })
    .catch(() => {
      // 请求失败（网络断了 / 服务端重启中）**不要**用空目录覆盖手里那份可用快照：
      // 空目录会让生成、对话全部报「未匹配到后台模型配置」，而旧快照里往往就有用户要用的模型。
      // 失败时不更新 modelCatalogLoadedAt，下一次调用会立刻重试（不会被 TTL 挡住）。
      return modelCatalogRef.value
    })
    .finally(() => {
      modelCatalogPromise = null
    })

  return modelCatalogPromise
}

/** 是否至少成功拉到过一次目录（用于区分「还没拉到」和「后台真没配」） */
export const isPublicModelCatalogLoaded = () => modelCatalogLoadedAt > 0

export const getPublicModelCatalog = () => modelCatalogRef.value

export const getAllImageModels = (): ImageModel[] => sortModels(modelCatalogRef.value.models.image.map(toImageModel))
export const getAllVideoModels = (): VideoModel[] => sortModels(modelCatalogRef.value.models.video.map(toVideoModel))
export const getAllChatModels = (): ChatModel[] => sortModels(modelCatalogRef.value.models.chat.map(toChatModel))
/** 音频模型：目录缺 audio 字段（旧服务端）时当空数组，不抛错 */
export const getAllAudioModels = (): AudioModel[] =>
  sortModels((modelCatalogRef.value.models.audio || []).map(toAudioModel))

/** 模型分类，与目录接口的 category 字段一致 */
export type PublicModelCategory = 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO'

// 目录里 defaults 用的键名是小写分类
const CATALOG_DEFAULT_KEY: Record<PublicModelCategory, 'chat' | 'image' | 'video' | 'audio'> = {
  CHAT: 'chat',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
}

/** 取某一分类的目录模型（原始条目，未转成组件用的 ImageModel/VideoModel） */
export const getCatalogModelsByCategory = (category: PublicModelCategory): PublicModelCatalogItem[] => {
  if (category === 'CHAT') {
    return modelCatalogRef.value.models.chat || []
  }
  if (category === 'IMAGE') {
    return modelCatalogRef.value.models.image || []
  }
  if (category === 'AUDIO') {
    return modelCatalogRef.value.models.audio || []
  }
  return modelCatalogRef.value.models.video || []
}

/**
 * 某一分类的默认模型（selectionKey）。
 *
 * 后台下发的 defaults 里那个 key 必须**真的在当前分类的模型列表里**才认 ——
 * 默认模型自己也被下架时，界面上的「默认」会变成一个解析不出 providerId 的死 key。
 */
export const getDefaultModelSelectionKey = (category: PublicModelCategory) => {
  const group = getCatalogModelsByCategory(category)
  const preferred = String(modelCatalogRef.value.defaults[CATALOG_DEFAULT_KEY[category]] || '').trim()
  if (preferred && group.some(item => item.selectionKey === preferred)) {
    return preferred
  }
  return group[0]?.selectionKey || ''
}

export const getDefaultImageModelKey = () => getDefaultModelSelectionKey('IMAGE')
export const getDefaultVideoModelKey = () => getDefaultModelSelectionKey('VIDEO')
export const getDefaultAudioModelKey = () => getDefaultModelSelectionKey('AUDIO')
export const getDefaultChatModelKey = () => getDefaultModelSelectionKey('CHAT')

export const findCatalogModel = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO') => {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) {
    return null
  }

  const groups = category
    ? [getCatalogModelsByCategory(category)]
    : [
        modelCatalogRef.value.models.chat || [],
        modelCatalogRef.value.models.image || [],
        modelCatalogRef.value.models.video || [],
        modelCatalogRef.value.models.audio || [],
      ]

  for (const group of groups) {
    const matched = group.find(item => item.selectionKey === normalizedKey || item.modelKey === normalizedKey)
    if (matched) {
      return matched
    }
  }

  return null
}

export const resolveModelSelectionKey = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO') => {
  const matched = findCatalogModel(key, category)
  return matched?.selectionKey || ''
}

// 原来还有 resolveRequestModelKey / resolveRequestProviderId 两个「纯读快照、查不到就返回空」的
// 导出，调用方拿到空 providerId 只能抛「未匹配到后台模型配置」。现在所有提交路径统一走
// resolveModelSelection（快照过期会强拉、下架会回落并提示），这两个函数已无调用方，随之删除 ——
// 留着只会再被拿来拼出「查不到就报错」的老路。

export const resolveModelLabel = (key: string, category?: 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO') => {
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

  if (matched.category === 'AUDIO') {
    return toAudioModel(matched)
  }

  return toChatModel(matched)
}

export interface ModelSelectionReconcileResult {
  /** 收敛后可直接提交的 selectionKey；目录里还没有这一类模型时原样返回存值 */
  key: string
  requestedKey: string
  /** true = 原选模型已不在目录里（下架 / 禁用），调用方**必须**给用户可见提示 */
  fellBack: boolean
  /** 目录里已经有这一类模型（能对存值下判断了） */
  catalogReady: boolean
}

/**
 * 把「用户存下来的模型」收敛成目录里真实可用的模型。
 *
 * 两条必须守住的线：
 *   1. **不能静默换**：原选模型还在目录里就原样返回，一个字节都不动。
 *      （历史上「首屏目录还没到，拿空列表校验存值」导致用户选的模型被悄悄换成默认，
 *       界面上看起来还「就是那样」，没有任何提示 —— 所以这里空列表一律不下判断。）
 *   2. **不能硬失败**：原选模型已经下架 / 被禁用时回落到该分类的默认模型，
 *      并把 fellBack 交给调用方去提示用户（见 notifyModelSelectionFallback）。
 */
export const reconcileModelSelection = (
  key: string,
  category: PublicModelCategory,
): ModelSelectionReconcileResult => {
  const requestedKey = String(key || '').trim()
  const group = getCatalogModelsByCategory(category)

  if (!group.length) {
    return { key: requestedKey, requestedKey, fellBack: false, catalogReady: false }
  }

  if (requestedKey && group.some(item => item.selectionKey === requestedKey || item.modelKey === requestedKey)) {
    return { key: requestedKey, requestedKey, fellBack: false, catalogReady: true }
  }

  return {
    key: getDefaultModelSelectionKey(category),
    requestedKey,
    fellBack: Boolean(requestedKey),
    catalogReady: true,
  }
}

// 一次回落只提示一次（键是「原选 → 落点」）：提交重试、多个组件同时收敛都会重复走到同一个回落，
// 不去重就会连弹好几条一样的提示。
const notifiedModelFallbacks = new Set<string>()

/** selectionKey 形如 `p-xxx::CHAT::deepseek-v4-pro`，提示里只给人看模型名 */
const toModelDisplayName = (key: string) => String(key || '').split('::').pop() || String(key || '')

/**
 * 「原选模型已下架，已切换为 X」——回落必须可见。
 *
 * 早期这里是静默回落，结果是用户选的模型被悄悄换掉、界面上没有任何解释；
 * 反过来若只报错不回落，用户又会卡在「未匹配到后台模型配置」上动不了。
 * 二者取中：自动回落到目录里的默认模型，同时明确告诉他换了什么。
 */
export const notifyModelSelectionFallback = (requestedKey: string, fallbackLabel: string) => {
  const requested = String(requestedKey || '').trim()
  const fallback = String(fallbackLabel || '').trim()
  if (!requested || !fallback) {
    return
  }

  // 没有 DOM 的场合（纯 Node 单测）没有可弹出的位置，直接跳过；
  // 浏览器里这条提示是「不静默换模型」的兑现方式，正常路径一定会走到。
  if (typeof document === 'undefined') {
    return
  }

  const noticeKey = `${requested}->${fallback}`
  if (notifiedModelFallbacks.has(noticeKey)) {
    return
  }
  notifiedModelFallbacks.add(noticeKey)

  ElMessage.warning(`原选模型「${toModelDisplayName(requested)}」已下架，已切换为「${fallback}」`)
}

export interface ResolvedModelSelection {
  providerId: string
  modelKey: string
  /** 目录里的 selectionKey（前端持久化用的那个 key） */
  selectionKey: string
  requestedKey: string
  /** true = 没用上原选的模型（原选已下架，或本来就没选） */
  usedFallback: boolean
}

/**
 * 提交前解析「这次到底用哪个厂商 + 哪个模型」。
 *
 * 与纯读快照的 resolveRequestProviderId 的区别，正是这条路径不会再让用户卡死：
 *   1. 先按当前快照匹配，匹配上就原样用（**绝不动用户仍可用的选择**）；
 *   2. 匹配不上时强拉一次目录再匹配 —— 快照可能只是过期了（后台刚恢复 / 刚重新启用）；
 *   3. 还是没有就回落到该分类的默认模型，并给出一条可见提示；
 *   4. 该分类一个可用模型都没有（后台真没配）才返回 null，由调用方按原样报错。
 */
export const resolveModelSelection = async (input: {
  modelKey?: string
  fallbackModelKey?: string
  category: PublicModelCategory
}): Promise<ResolvedModelSelection | null> => {
  await loadPublicModelCatalog()

  const requestedKey = String(input.modelKey || input.fallbackModelKey || '').trim()
  let matched = findCatalogModel(requestedKey, input.category)

  // 只有「确实选了个模型但目录里没有」才值得强拉一次：
  // 本来就没传 key 的情况强拉只是白打网络（那属于调用方没给值，不是目录过期）。
  if (!matched && requestedKey) {
    await loadPublicModelCatalog(true)
    matched = findCatalogModel(requestedKey, input.category)
  }

  if (matched) {
    return {
      providerId: matched.providerId,
      modelKey: matched.modelKey,
      selectionKey: matched.selectionKey,
      requestedKey,
      usedFallback: false,
    }
  }

  const fallback = findCatalogModel(getDefaultModelSelectionKey(input.category), input.category)
  if (!fallback) {
    return null
  }

  notifyModelSelectionFallback(requestedKey, fallback.label)

  return {
    providerId: fallback.providerId,
    modelKey: fallback.modelKey,
    selectionKey: fallback.selectionKey,
    requestedKey,
    usedFallback: true,
  }
}
