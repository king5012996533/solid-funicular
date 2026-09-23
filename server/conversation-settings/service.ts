import type {
  SystemConversationSettingsPayload,
  SystemGenerationProgressSettingsPayload,
} from '../system-config/shared'
import {
  createDefaultConversationSettings,
  getDefaultGenerationProgressSettings,
  getAdminSystemConfig,
  saveAdminSystemConfig,
} from '../system-config/service'
import type { SystemConfigPayload } from '../system-config/shared'

export interface AdminConversationSettingsBundle {
  conversationSettings: Awaited<ReturnType<typeof createDefaultConversationSettings>>
  generationProgressSettings: ReturnType<typeof getDefaultGenerationProgressSettings>
}

// 读取后台会话配置。
export const getAdminConversationSettings = async () => {
  const config = await getAdminSystemConfig()
  return {
    conversationSettings: config.conversationSettings || createDefaultConversationSettings(),
    generationProgressSettings: config.generationProgressSettings || getDefaultGenerationProgressSettings(),
  }
}

// 保存后台会话配置。
export const saveAdminConversationSettings = async (payload: {
  conversationSettings?: SystemConversationSettingsPayload
  generationProgressSettings?: SystemGenerationProgressSettingsPayload
}) => {
  const currentConfig = await getAdminSystemConfig()
  // 会话设置与生成进度设置的具体形状比 SystemConfigPayload 的声明更细（调用点自己拼的部分字段），
  // 边界上收口；saveAdminSystemConfig 内部 normalizeSystemConfig 会逐字段归一化
  const savedConfig = await saveAdminSystemConfig({
    ...currentConfig,
    conversationSettings: payload.conversationSettings || currentConfig.conversationSettings,
    generationProgressSettings: payload.generationProgressSettings || currentConfig.generationProgressSettings,
  } as SystemConfigPayload)

  return {
    conversationSettings: savedConfig.conversationSettings || createDefaultConversationSettings(),
    generationProgressSettings: savedConfig.generationProgressSettings || getDefaultGenerationProgressSettings(),
  }
}
