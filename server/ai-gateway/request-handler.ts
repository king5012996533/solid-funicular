import {
  joinUpstreamUrl,
  normalizeGatewayPayload,
  readJsonBody,
  sendJson,
} from './shared'
import { forwardGatewayPayload, forwardMultipartRequest } from './forward'
import { resolveGatewayProviderUpstream } from '../provider-config/service'
import { requireCurrentSessionUser } from '../auth/session'
import { consumeGenerationPoints, refundGenerationPoints, resolveModelPricingCost } from '../marketing-center/service'
import { buildNormalizedGenerationParams } from '../../src/shared/model-pricing-rules'
import { normalizeChargeableEndpointType, type AiEndpointType } from '../../src/shared/provider-endpoint-strategy'

const shouldExposeGatewayDebug = () => String(process.env.AI_GATEWAY_DEBUG_HEADERS || '').trim() === 'true'

const isChargeableGenerationRequest = (input: {
  providerId: string
  endpointType?: AiEndpointType
  method: string
}) => {
  const chargeableEndpointType = normalizeChargeableEndpointType(input.endpointType)
  return Boolean(input.providerId)
    && input.method === 'POST'
    && (chargeableEndpointType === 'image' || chargeableEndpointType === 'video')
}

const buildGatewayAssociationNo = () => {
  return `GWY${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

/**
 * 把网关请求体里的规格归一化成定价入参。
 *
 * 网关是低层转发：图片/视频的 size/count/seconds 散在 body 里，抽成一个函数免得两处各解释一遍。
 * multipart 路径此刻拿不到 body（还没解析就直接透传）→ 传 null，按 1 张/1 次计。
 */
const buildGatewayPricingParams = (endpointType: 'image' | 'video', body: unknown) => {
  const source = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  return buildNormalizedGenerationParams({
    kind: endpointType,
    size: source.size,
    count: source.count ?? source.n,
    seconds: source.seconds ?? source.duration,
  })
}

export const handleAiGatewayRequest = async (req: any, res: any) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' })
    return
  }

  let debugUpstreamUrl = ''
  let debugUpstreamMethod = 'POST'

  try {
    const headerBaseUrl = String(req.headers['x-upstream-base-url'] || '').trim()
    const headerEndpoint = String(req.headers['x-upstream-endpoint'] || '').trim()
    const headerApiKey = String(req.headers['x-upstream-api-key'] || '').trim()
    const headerProviderId = String(req.headers['x-upstream-provider-id'] || '').trim()
    const headerEndpointType = String(req.headers['x-upstream-endpoint-type'] || '').trim() as AiEndpointType
    const headerModelKey = String(req.headers['x-upstream-model-key'] || '').trim()
    const headerMethod = String(req.headers['x-upstream-method'] || 'POST').trim().toUpperCase()
    const billedHeaderEndpointType = normalizeChargeableEndpointType(headerEndpointType)

    const shouldChargeHeaderRequest = isChargeableGenerationRequest({
      providerId: headerProviderId,
      endpointType: headerEndpointType,
      method: headerMethod,
    })

    if (headerProviderId && headerEndpointType) {
      const currentUser = shouldChargeHeaderRequest ? await requireCurrentSessionUser(req, res) : null
      if (shouldChargeHeaderRequest && !currentUser?.id) {
        return
      }

      const upstream = await resolveGatewayProviderUpstream({
        providerId: headerProviderId,
        endpointType: headerEndpointType,
        modelKey: headerModelKey || undefined,
      })
      debugUpstreamUrl = joinUpstreamUrl(upstream.baseUrl, upstream.endpoint)
      debugUpstreamMethod = headerMethod

      const billingDetail = shouldChargeHeaderRequest
        ? await resolveModelPricingCost({
          providerId: headerProviderId,
          modelKey: headerModelKey,
          endpointType: billedHeaderEndpointType as 'image' | 'video',
          // multipart 体积流未解析，拿不到 size/count —— 按默认 1 张/1 次计
          params: buildGatewayPricingParams(billedHeaderEndpointType as 'image' | 'video', null),
        })
        : { pointCost: 0, usingDraft: false, detail: '', modelName: '' }

      const associationNo = buildGatewayAssociationNo()
      const consumedPointLog = shouldChargeHeaderRequest && billingDetail.pointCost > 0
        ? await consumeGenerationPoints({
          userId: currentUser!.id,
          pointCost: billingDetail.pointCost,
          sourceId: associationNo,
          associationNo,
          endpointType: billedHeaderEndpointType as 'image' | 'video',
          providerId: headerProviderId,
          modelKey: headerModelKey,
          modelName: billingDetail.modelName,
          metaJson: {
            gatewayPath: 'multipart-header',
          },
        })
        : null

      let refunded = false
      const refundConsumedPointsIfNeeded = async (reason: string) => {
        if (!consumedPointLog || refunded) return
        refunded = true
        try {
          await refundGenerationPoints({
            userId: currentUser!.id,
            pointCost: billingDetail.pointCost,
            sourceId: associationNo,
            associationNo,
            endpointType: billedHeaderEndpointType as 'image' | 'video',
            providerId: headerProviderId,
            modelKey: headerModelKey,
            modelName: billingDetail.modelName,
            metaJson: { refundReason: reason },
          })
        } catch (error) {
          console.error('[ai-gateway][refund-error]', JSON.stringify({
            reason,
            endpointType: headerEndpointType,
            providerId: headerProviderId,
            modelKey: headerModelKey,
            message: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      await forwardMultipartRequest({
        req,
        res,
        baseUrl: upstream.baseUrl,
        endpoint: upstream.endpoint,
        apiKey: upstream.apiKey || undefined,
        method: headerMethod,
        beforeProxy: async ({ upstreamResponse, res: currentRes }) => {
          if (!upstreamResponse.ok) {
            await refundConsumedPointsIfNeeded(`upstream_status_${upstreamResponse.status}`)
            return
          }
          if (consumedPointLog) {
            currentRes.setHeader('x-marketing-points-updated', '1')
            currentRes.setHeader('x-marketing-points-balance', String(consumedPointLog.balanceAfter || consumedPointLog.availableAmount || 0))
          }
        },
        onError: async () => {
          await refundConsumedPointsIfNeeded('gateway_fetch_failed')
        },
      })
      return
    }

    if (headerBaseUrl && headerEndpoint) {
      debugUpstreamUrl = `${headerBaseUrl.replace(/\/+$/, '')}/${headerEndpoint.replace(/^\/+/, '')}`
      debugUpstreamMethod = headerMethod
      await forwardMultipartRequest({
        req,
        res,
        baseUrl: headerBaseUrl,
        endpoint: headerEndpoint,
        apiKey: headerApiKey || undefined,
        method: headerMethod,
      })
      return
    }

    const payload = await readJsonBody(req)
    const normalized = normalizeGatewayPayload(payload)
    const upstream = normalized.providerId && normalized.endpointType
      ? await resolveGatewayProviderUpstream({
        providerId: normalized.providerId,
        endpointType: normalized.endpointType,
        modelKey: normalized.modelKey || undefined,
      })
      : null

    debugUpstreamUrl = upstream
      ? joinUpstreamUrl(upstream.baseUrl, upstream.endpoint)
      : normalized.upstreamUrl
    debugUpstreamMethod = normalized.method

    const shouldChargeJsonRequest = isChargeableGenerationRequest({
      providerId: normalized.providerId,
      endpointType: normalized.endpointType,
      method: normalized.method,
    })
    const billedJsonEndpointType = normalizeChargeableEndpointType(normalized.endpointType)

    const currentUser = shouldChargeJsonRequest ? await requireCurrentSessionUser(req, res) : null
    if (shouldChargeJsonRequest && !currentUser?.id) {
      return
    }

    const billingDetail = shouldChargeJsonRequest
      ? await resolveModelPricingCost({
        providerId: normalized.providerId,
        modelKey: normalized.modelKey,
        endpointType: billedJsonEndpointType as 'image' | 'video',
        params: buildGatewayPricingParams(billedJsonEndpointType as 'image' | 'video', normalized.body),
      })
      : { pointCost: 0, usingDraft: false, detail: '', modelName: '' }

    const associationNo = buildGatewayAssociationNo()
    const consumedPointLog = shouldChargeJsonRequest && billingDetail.pointCost > 0
      ? await consumeGenerationPoints({
        userId: currentUser!.id,
        pointCost: billingDetail.pointCost,
        sourceId: associationNo,
        associationNo,
        endpointType: billedJsonEndpointType as 'image' | 'video',
        providerId: normalized.providerId,
        modelKey: normalized.modelKey,
        modelName: billingDetail.modelName,
        metaJson: {
          gatewayPath: 'json-payload',
        },
      })
      : null

    let refunded = false
    const refundConsumedPointsIfNeeded = async (reason: string) => {
      if (!consumedPointLog || refunded) return
      refunded = true
      try {
        await refundGenerationPoints({
          userId: currentUser!.id,
          pointCost: billingDetail.pointCost,
          sourceId: associationNo,
          associationNo,
          endpointType: billedJsonEndpointType as 'image' | 'video',
          providerId: normalized.providerId,
          modelKey: normalized.modelKey,
          modelName: billingDetail.modelName,
          metaJson: { refundReason: reason },
        })
      } catch (error) {
        console.error('[ai-gateway][refund-error]', JSON.stringify({
          reason,
          endpointType: normalized.endpointType,
          providerId: normalized.providerId,
          modelKey: normalized.modelKey,
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    await forwardGatewayPayload({
      res,
      upstreamUrl: upstream
        ? joinUpstreamUrl(upstream.baseUrl, upstream.endpoint)
        : normalized.upstreamUrl,
      apiKey: upstream
        ? (upstream.apiKey || undefined)
        : (normalized.apiKey || undefined),
      method: normalized.method,
      headers: normalized.headers,
      body: normalized.body,
      beforeProxy: async ({ upstreamResponse, res: currentRes }) => {
        if (!upstreamResponse.ok) {
          await refundConsumedPointsIfNeeded(`upstream_status_${upstreamResponse.status}`)
          return
        }
        if (consumedPointLog) {
          currentRes.setHeader('x-marketing-points-updated', '1')
          currentRes.setHeader('x-marketing-points-balance', String(consumedPointLog.balanceAfter || consumedPointLog.availableAmount || 0))
        }
      },
      onError: async () => {
        await refundConsumedPointsIfNeeded('gateway_fetch_failed')
      },
    })
  } catch (error: any) {
    if (error?.code === 'INSUFFICIENT_POINTS') {
      sendJson(res, 402, {
        message: error?.message || '积分不足',
        error: {
          type: 'insufficient_points',
          message: error?.message || '积分不足',
          currentBalance: Number(error?.currentBalance || 0),
          requiredPoints: Number(error?.requiredPoints || 0),
        },
      })
      return
    }

    sendJson(res, 500, {
      message: error?.message || 'AI 网关转发失败',
      error: {
        type: 'gateway_error',
        message: error?.message || 'AI 网关转发失败',
      },
      ...(shouldExposeGatewayDebug()
        ? {
            debug: {
              upstreamUrl: debugUpstreamUrl || undefined,
              upstreamMethod: debugUpstreamMethod || undefined,
            },
          }
        : {}),
    })
  }
}
