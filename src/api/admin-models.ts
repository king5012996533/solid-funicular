import { buildApiUrl } from './http'
import { readApiData } from './response'
import type { AdminProviderItem } from './admin-providers'

export type AdminModelCategory = 'CHAT' | 'IMAGE' | 'VIDEO'

export interface AdminProviderModelItem {
  id: string
  providerId: string
  category: AdminModelCategory
  label: string
  modelKey: string
  description: string
  sortOrder: number
  isEnabled: boolean
  capabilityJson: Record<string, any> | null
  defaultParamsJson: Record<string, any> | null
  createdAt: string
  updatedAt: string
}

export interface AdminProviderModelListResult {
  provider: AdminProviderItem
  models: AdminProviderModelItem[]
}

export interface AdminProviderModelPayload {
  category: AdminModelCategory
  label: string
  modelKey: string
  description: string
  sortOrder: number
  isEnabled: boolean
  capabilityJson: Record<string, any> | null
  defaultParamsJson: Record<string, any> | null
}

export interface DiscoveredProviderModelItem {
  modelKey: string
  label: string
  description: string
  category: AdminModelCategory
  sortOrder: number
  raw: Record<string, any>
}

export interface DiscoverProviderModelsResult {
  provider: AdminProviderItem
  requestUrl: string
  models: DiscoveredProviderModelItem[]
}

export interface BatchUpsertProviderModelsPayload {
  items: AdminProviderModelPayload[]
}

const buildProviderModelsApiPath = (providerId: string) =>
  `/api/provider-config/providers/${encodeURIComponent(providerId)}/models`

// 查询指定厂商下的模型列表。
export const listAdminProviderModels = async (providerId: string) => {
  const response = await fetch(buildApiUrl(buildProviderModelsApiPath(providerId)), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })

  return readApiData<AdminProviderModelListResult>(response)
}

// 调用厂商上游 /v1/models 拉取模型目录。
export const discoverAdminProviderModels = async (providerId: string) => {
  const response = await fetch(buildApiUrl(`${buildProviderModelsApiPath(providerId)}/discover`), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })

  return readApiData<DiscoverProviderModelsResult>(response, {
    showSuccessMessage: true,
    successMessage: '已获取上游模型列表',
  })
}

// 批量导入所选模型配置。
export const batchUpsertAdminProviderModels = async (providerId: string, payload: BatchUpsertProviderModelsPayload) => {
  const response = await fetch(buildApiUrl(`${buildProviderModelsApiPath(providerId)}/batch-upsert`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return readApiData<AdminProviderModelListResult>(response, {
    showSuccessMessage: true,
    successMessage: '模型已批量导入',
  })
}

// 创建模型配置。
export const createAdminProviderModel = async (providerId: string, payload: AdminProviderModelPayload) => {
  const response = await fetch(buildApiUrl(buildProviderModelsApiPath(providerId)), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return readApiData<AdminProviderModelItem>(response, {
    showSuccessMessage: true,
    successMessage: '模型已创建',
  })
}

// 更新模型配置。
export const updateAdminProviderModel = async (providerId: string, id: string, payload: AdminProviderModelPayload) => {
  const response = await fetch(buildApiUrl(`${buildProviderModelsApiPath(providerId)}/${encodeURIComponent(id)}`), {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return readApiData<AdminProviderModelItem>(response, {
    showSuccessMessage: true,
    successMessage: '模型已更新',
  })
}

// 删除模型配置。
export const deleteAdminProviderModel = async (providerId: string, id: string) => {
  const response = await fetch(buildApiUrl(`${buildProviderModelsApiPath(providerId)}/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    credentials: 'include',
  })

  return readApiData<{ id: string }>(response, {
    showSuccessMessage: true,
    successMessage: '模型已删除',
  })
}

/**
 * 模型定价（model_pricing）管理端接口。
 *
 * 图片/视频的真实扣费与预估只认这张表；模型配置里的「计费规则」对它们无效，
 * 所以改价 / 补录新模型定价必须走这里。
 */
export interface AdminModelPricingPreview {
  pointCost: number
  usingDraft: boolean
  /** 是否拒绝计费（未配价/未标定/匹配失败）—— 为 true 时该模型生成会被拒绝，pointCost 为 0 */
  refused: boolean
  detail: string
  params: Record<string, any>
}

export interface AdminModelPricingItem {
  modelId: string
  providerId: string
  category: AdminModelCategory
  modelName: string
  modelKey: string
  hasPricing: boolean
  /** 定价是否不可用（无定价 / 定价不合法）—— 为 true 时该模型会拒绝生成，后台要标出来提醒补录 */
  usingDraft: boolean
  draftReason: string
  updatedAt: string | null
  spec: Record<string, any> | null
  preview: AdminModelPricingPreview
}

export interface AdminModelPricingOverviewResult {
  items: AdminModelPricingItem[]
  summary: { modelCount: number; pricedCount: number; draftCount: number }
}

export interface AdminModelPricingSaveResult {
  saved: boolean
  item: AdminModelPricingItem
  spec?: Record<string, any>
}

const buildModelPricingApiPath = (providerId: string, modelId: string) =>
  `${buildProviderModelsApiPath(providerId)}/${encodeURIComponent(modelId)}/pricing`

// 定价总览：列出（可指定厂商）全部模型及其定价状态、不可用标记与试算价。
export const listAdminModelPricing = async (query: { providerId?: string; category?: AdminModelCategory } = {}) => {
  const params = new URLSearchParams()
  if (query.providerId) params.set('providerId', query.providerId)
  if (query.category) params.set('category', query.category)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(buildApiUrl(`/api/provider-config/model-pricing${suffix}`), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })

  return readApiData<AdminModelPricingOverviewResult>(response)
}

// 读取单个模型的定价。
export const getAdminModelPricing = async (providerId: string, modelId: string) => {
  const response = await fetch(buildApiUrl(buildModelPricingApiPath(providerId, modelId)), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })

  return readApiData<AdminModelPricingItem>(response)
}

// 保存单个模型的定价；服务端会用 validateModelPricing 校验，非法配置返回 400。
export const saveAdminModelPricing = async (
  providerId: string,
  modelId: string,
  payload: { spec: Record<string, any>; dryRun?: boolean },
) => {
  const response = await fetch(buildApiUrl(buildModelPricingApiPath(providerId, modelId)), {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return readApiData<AdminModelPricingSaveResult>(response, {
    showSuccessMessage: true,
    successMessage: '模型定价已保存',
  })
}

// 删除单个模型的定价（删掉后该模型生成会被拒绝，直到重新配置）。
export const deleteAdminModelPricing = async (providerId: string, modelId: string) => {
  const response = await fetch(buildApiUrl(buildModelPricingApiPath(providerId, modelId)), {
    method: 'DELETE',
    credentials: 'include',
  })

  return readApiData<{ modelId: string; deleted: boolean }>(response, {
    showSuccessMessage: true,
    successMessage: '模型定价已删除',
  })
}
