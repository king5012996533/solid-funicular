import { sendJson, readJsonBody } from '../ai-gateway/shared'
import { isPrismaConfigured } from '../db/prisma'
import { requireAdminSessionUser } from '../auth/session'
import { REDIS_CONFIG, consumeFixedWindowRateLimit, getRedisRuntimeSettings } from '../redis'
import { recordAdminAuditLog } from '../shared/admin-audit'
import { invalidateAdminCaches } from '../shared/admin-cache'
import {
  createAdminProvider,
  deleteAdminProvider,
  getAdminProviderDetail,
  getPublicModelCatalog,
  listAdminProviders,
  updateAdminProvider,
} from './service'
import {
  batchUpsertProviderModels,
  createProviderModel,
  deleteProviderModel,
  discoverProviderModels,
  listProviderModels,
  testProviderConnectivity,
  updateProviderModel,
} from './model-service'
import {
  deleteModelPricing,
  getModelPricing,
  listModelPricingOverview,
  saveModelPricing,
} from './model-pricing-service'
import { ProviderConfigRequestError, sendProviderRuntimeError } from './shared'
import {
  PROVIDER_CONFIG_CATALOG_PATH,
  PROVIDER_CONFIG_MODEL_PRICING_PATH,
  PROVIDER_CONFIG_PROVIDERS_PATH,
} from './constants'

const matchProviderDetailPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
  }
}

const matchProviderModelsPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/models$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
  }
}

const matchProviderModelDetailPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/models\/([^/]+)$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
    modelId: decodeURIComponent(matched[2]),
  }
}

const matchProviderModelDiscoverPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/models\/discover$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
  }
}

const matchProviderModelBatchUpsertPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/models\/batch-upsert$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
  }
}

// 单个模型的定价读写：/providers/:providerId/models/:modelId/pricing
const matchProviderModelPricingPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/models\/([^/]+)\/pricing$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
    modelId: decodeURIComponent(matched[2]),
  }
}

const matchProviderTestPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/provider-config\/providers\/([^/]+)\/test$/)
  if (!matched) {
    return null
  }

  return {
    providerId: decodeURIComponent(matched[1]),
  }
}

// 处理厂商配置与模型配置请求。
export const handleProviderConfigRequest = async (req: any, res: any) => {
  try {
    if (!isPrismaConfigured()) {
      sendProviderRuntimeError(res, 500, '缺少 DATABASE_URL，暂时无法使用后端配置存储。')
      return
    }

    const requestPath = String(req.url || '').split('?')[0]
    const providerDetailMatch = matchProviderDetailPath(requestPath)
    const providerModelsMatch = matchProviderModelsPath(requestPath)
    const providerModelDetailMatch = matchProviderModelDetailPath(requestPath)
    const providerModelDiscoverMatch = matchProviderModelDiscoverPath(requestPath)
    const providerModelBatchUpsertMatch = matchProviderModelBatchUpsertPath(requestPath)
    const providerModelPricingMatch = matchProviderModelPricingPath(requestPath)
    const providerTestMatch = matchProviderTestPath(requestPath)

    if (req.method === 'GET' && requestPath === PROVIDER_CONFIG_CATALOG_PATH) {
      const data = await getPublicModelCatalog()
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'GET' && requestPath === PROVIDER_CONFIG_PROVIDERS_PATH) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const data = await listAdminProviders()
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'GET' && providerDetailMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const data = await getAdminProviderDetail(providerDetailMatch.providerId)
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'POST' && requestPath === PROVIDER_CONFIG_PROVIDERS_PATH) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const payload = await readJsonBody(req)
      const data = await createAdminProvider(payload as any)
      await invalidateAdminCaches({ dashboard: true, modelCatalog: true })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_create',
        targetType: 'ai_provider',
        targetId: data.id,
        beforeJson: null,
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '厂商已创建' })
      return
    }

    if (req.method === 'PUT' && providerDetailMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const payload = await readJsonBody(req)
      const before = await getAdminProviderDetail(providerDetailMatch.providerId)
      const data = await updateAdminProvider(providerDetailMatch.providerId, payload as any)
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerDetailMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_update',
        targetType: 'ai_provider',
        targetId: providerDetailMatch.providerId,
        beforeJson: before,
        afterJson: {
          request: payload,
          saved: data,
        },
      })
      sendJson(res, 200, { data, message: '厂商已更新' })
      return
    }

    if (req.method === 'DELETE' && providerDetailMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const before = await getAdminProviderDetail(providerDetailMatch.providerId)
      const data = await deleteAdminProvider(providerDetailMatch.providerId)
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerDetailMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_delete',
        targetType: 'ai_provider',
        targetId: providerDetailMatch.providerId,
        beforeJson: before,
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '厂商已删除' })
      return
    }

    if (req.method === 'GET' && providerModelsMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const data = await listProviderModels(providerModelsMatch.providerId)
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'GET' && providerModelDiscoverMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }
      const runtimeSettings = await getRedisRuntimeSettings()

      const rateLimitResult = await consumeFixedWindowRateLimit({
        scope: 'provider-model-discover',
        identifier: `${String(currentUser.id || '').trim()}:${providerModelDiscoverMatch.providerId}`,
        limit: runtimeSettings.providerModelDiscoverRateLimit || Math.max(REDIS_CONFIG.taskSubmitRateLimit, 3),
        windowSeconds: Math.max(REDIS_CONFIG.rateLimitWindowSeconds, 60),
      })

      if (!rateLimitResult.allowed) {
        throw new ProviderConfigRequestError(
          429,
          `模型发现过于频繁，请在 ${rateLimitResult.retryAfterSeconds || REDIS_CONFIG.rateLimitWindowSeconds} 秒后重试`,
        )
      }

      const data = await discoverProviderModels(providerModelDiscoverMatch.providerId)
      sendJson(res, 200, { data, message: '模型列表已获取' })
      return
    }

    if (req.method === 'POST' && providerTestMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const data = await testProviderConnectivity(providerTestMatch.providerId)
      sendJson(res, 200, {
        data,
        message: data.ok ? '厂商连通性测试通过' : '厂商连通性测试存在失败项',
      })
      return
    }

    if (req.method === 'POST' && providerModelsMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const payload = await readJsonBody(req)
      const data = await createProviderModel(providerModelsMatch.providerId, payload as any)
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerModelsMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_model_create',
        targetType: 'ai_model',
        targetId: data.id,
        beforeJson: {
          providerId: providerModelsMatch.providerId,
          request: payload,
        },
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '模型已创建' })
      return
    }

    if (req.method === 'POST' && providerModelBatchUpsertMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const payload = await readJsonBody(req)
      const data = await batchUpsertProviderModels(providerModelBatchUpsertMatch.providerId, payload as any)
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerModelBatchUpsertMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_model_batch_upsert',
        targetType: 'ai_model',
        targetId: providerModelBatchUpsertMatch.providerId,
        beforeJson: {
          providerId: providerModelBatchUpsertMatch.providerId,
          request: payload,
        },
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '模型已批量导入' })
      return
    }

    if (req.method === 'PUT' && providerModelDetailMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const payload = await readJsonBody(req)
      const data = await updateProviderModel(
        providerModelDetailMatch.providerId,
        providerModelDetailMatch.modelId,
        payload as any,
      )
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerModelDetailMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_model_update',
        targetType: 'ai_model',
        targetId: providerModelDetailMatch.modelId,
        beforeJson: {
          providerId: providerModelDetailMatch.providerId,
          request: payload,
        },
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '模型已更新' })
      return
    }

    if (req.method === 'DELETE' && providerModelDetailMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }

      const data = await deleteProviderModel(providerModelDetailMatch.providerId, providerModelDetailMatch.modelId)
      await invalidateAdminCaches({
        dashboard: true,
        modelCatalog: true,
        providerDiscover: providerModelDetailMatch.providerId,
      })
      await recordAdminAuditLog({
        req,
        operatorUserId: currentUser.id,
        action: 'admin_provider_model_delete',
        targetType: 'ai_model',
        targetId: providerModelDetailMatch.modelId,
        beforeJson: {
          providerId: providerModelDetailMatch.providerId,
        },
        afterJson: data,
      })
      sendJson(res, 200, { data, message: '模型已删除' })
      return
    }

    /**
     * 模型定价（`model_pricing`）的管理端读写入口。
     *
     * 图片 / 视频的真实扣费与预估只认这张表（`resolveModelPricingCost`），
     * 模型配置里的 billingRule 对它们无效 —— 运营必须能在这里改价、加新模型定价，
     * 并看到「哪些模型其实还在走草案兜底价」。
     */
    if (req.method === 'GET' && requestPath === PROVIDER_CONFIG_MODEL_PRICING_PATH) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }
      const requestUrl = new URL(String(req.url || ''), 'http://127.0.0.1')
      const categoryRaw = String(requestUrl.searchParams.get('category') || '')
        .trim()
        .toUpperCase()
      const category =
        categoryRaw === 'CHAT' || categoryRaw === 'IMAGE' || categoryRaw === 'VIDEO' || categoryRaw === 'AUDIO'
          ? (categoryRaw as 'CHAT' | 'IMAGE' | 'VIDEO' | 'AUDIO')
          : undefined
      const data = await listModelPricingOverview({
        providerId: String(requestUrl.searchParams.get('providerId') || ''),
        category,
      })
      sendJson(res, 200, { data })
      return
    }

    if (providerModelPricingMatch) {
      const currentUser = await requireAdminSessionUser(req, res)
      if (!currentUser) {
        return
      }
      const { providerId, modelId } = providerModelPricingMatch

      if (req.method === 'GET') {
        sendJson(res, 200, {
          data: await getModelPricing(providerId, modelId),
        })
        return
      }

      if (req.method === 'PUT') {
        const payload = await readJsonBody(req)
        const before = await getModelPricing(providerId, modelId).catch(() => null)
        let data: Awaited<ReturnType<typeof saveModelPricing>>
        try {
          data = await saveModelPricing(providerId, modelId, payload as any)
        } catch (error: any) {
          // 定价校验失败 / 模型不存在都按 400 回，把原因原样给运营（不要 500 掩盖）
          throw new ProviderConfigRequestError(400, error?.message || '保存模型定价失败')
        }
        await invalidateAdminCaches({ modelCatalog: true })
        await recordAdminAuditLog({
          req,
          operatorUserId: currentUser.id,
          action: 'admin_provider_model_pricing_update',
          targetType: 'model_pricing',
          targetId: modelId,
          beforeJson: before,
          afterJson: {
            request: payload,
            saved: data,
          },
        })
        sendJson(res, 200, { data, message: '模型定价已保存' })
        return
      }

      if (req.method === 'DELETE') {
        const before = await getModelPricing(providerId, modelId).catch(() => null)
        const data = await deleteModelPricing(providerId, modelId)
        await invalidateAdminCaches({ modelCatalog: true })
        await recordAdminAuditLog({
          req,
          operatorUserId: currentUser.id,
          action: 'admin_provider_model_pricing_delete',
          targetType: 'model_pricing',
          targetId: modelId,
          beforeJson: before,
          afterJson: data,
        })
        sendJson(res, 200, {
          data,
          message: '模型定价已删除，将回落到草案兜底价',
        })
        return
      }
    }

    sendProviderRuntimeError(res, 405, 'Method Not Allowed')
  } catch (error: any) {
    const statusCode = error instanceof ProviderConfigRequestError ? error.statusCode : 500
    sendProviderRuntimeError(res, statusCode, error?.message || '读取配置失败')
  }
}
