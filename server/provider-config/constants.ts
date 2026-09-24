export const PROVIDER_CONFIG_BASE_PATH = '/api/provider-config'
export const PROVIDER_CONFIG_CATALOG_PATH = `${PROVIDER_CONFIG_BASE_PATH}/catalog`
export const PROVIDER_CONFIG_PROVIDERS_PATH = `${PROVIDER_CONFIG_BASE_PATH}/providers`

// 模型定价总览（model_pricing 的读写入口，见 model-pricing-service.ts）。
// 单个模型的定价读写挂在 /providers/:providerId/models/:modelId/pricing。
export const PROVIDER_CONFIG_MODEL_PRICING_PATH = `${PROVIDER_CONFIG_BASE_PATH}/model-pricing`

export const PROVIDER_CONFIG_MATCH_PATHS = [
  PROVIDER_CONFIG_CATALOG_PATH,
  PROVIDER_CONFIG_PROVIDERS_PATH,
  PROVIDER_CONFIG_MODEL_PRICING_PATH,
] as const
