/**
 * AI 同源网关前端入口
 * 统一管理网关路径与请求体构造。
 */

import { type AiEndpointType } from './provider-config'
import { resolveEndpointModelCategory } from './provider-config'
import { resolveModelSelection } from '@/config/models'

export const AI_GATEWAY_REQUEST_PATH = '/api/ai/request'
export const LEGACY_AI_GATEWAY_REQUEST_PATH = '/__workflow_gateway/request'

export interface GatewayRequestPayload {
  upstream: {
    baseUrl?: string
    apiKey?: string
    endpoint?: string
    providerId?: string
    endpointType?: AiEndpointType
    modelKey?: string
  }
  request: {
    method: string
    headers?: Record<string, string>
    body?: unknown
  }
}

export interface GatewayRequestOptions {
  url?: string
  method?: string
  data?: unknown
  headers?: Record<string, string>
  providerId?: string
  modelKey?: string
}

export const normalizeGatewayMethod = (method?: string) => (method || 'GET').toUpperCase()

export interface ResolvedGatewayUpstream {
  providerId: string
  modelKey: string
  modelValue: string
}

// 统一解析前端请求要命中的厂商与模型。
export const resolveGatewayUpstream = async (
  type: AiEndpointType,
  options: Pick<GatewayRequestOptions, 'providerId' | 'modelKey' | 'data'> & {
    modelValue?: string
  },
): Promise<ResolvedGatewayUpstream> => {
  const rawBody = options.data
  const modelValue = String(
    options.modelValue
    || (
      rawBody
      && typeof rawBody === 'object'
      && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>).model || ''
      : ''
    ),
  ).trim()
  const modelCategory = resolveEndpointModelCategory(type)
  const explicitProviderId = String(options.providerId || '').trim()

  // 调用方显式指定了厂商：不再按目录反查，模型key 原样透传（旧行为，避免误伤直连场景）。
  if (explicitProviderId) {
    return {
      providerId: explicitProviderId,
      modelKey: String(options.modelKey || '').trim() || modelValue,
      modelValue,
    }
  }

  // 其余情况交给目录解析：原选模型已下架时会先强拉一次目录，再回落到该分类的默认模型，
  // 并弹出「原选模型「X」已下架，已切换为「Y」」的可见提示（不静默换模型、也不硬失败）。
  const resolved = await resolveModelSelection({
    modelKey: options.modelKey,
    fallbackModelKey: modelValue,
    category: modelCategory,
  })

  if (!resolved) {
    throw new Error('未匹配到后台模型配置，请先在后台配置可用模型')
  }

  return {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    modelValue,
  }
}

export const createGatewayPayload = async (
  type: AiEndpointType,
  options: GatewayRequestOptions,
): Promise<GatewayRequestPayload> => {
  const method = normalizeGatewayMethod(options.method)
  const headers = { ...(options.headers || {}) }
  const rawBody = options.data
  const { providerId, modelKey, modelValue } = await resolveGatewayUpstream(type, options)

  const payload: GatewayRequestPayload = {
    upstream: {
      // 命中后台模型目录时，只把最小识别信息发给同源网关。
      // 真实厂商地址、密钥和具体接口路径统一在后端解析，避免暴露到浏览器请求体。
      providerId,
      endpointType: type,
      modelKey,
    },
    request: {
      method,
    },
  }

  if (Object.keys(headers).length) {
    payload.request.headers = headers
  }

  if (rawBody !== undefined && method !== 'GET') {
    if (providerId && rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
      payload.request.body = {
        ...(rawBody as Record<string, unknown>),
        model: modelKey || modelValue,
      }
    } else if (providerId) {
      payload.request.body = rawBody
    }
  }

  return payload
}
