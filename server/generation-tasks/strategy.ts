import type { GenerationTaskStartPayload } from './shared'

export type GenerationTaskStrategyKey = 'image' | 'video' | 'agent-chat' | 'agent-workspace' | 'research-report'

export interface GenerationTaskStrategy {
  key: GenerationTaskStrategyKey
  matches: (payload: GenerationTaskStartPayload) => boolean
}

const strategies: GenerationTaskStrategy[] = [
  {
    key: 'image',
    matches: payload => String(payload.type || '').trim() === 'image',
  },
  {
    key: 'agent-workspace',
    matches: payload => String(payload.type || '').trim() === 'agent'
      && Boolean(String(payload.skill || '').trim())
      && String(payload.skill || '').trim() !== 'general',
  },
  {
    key: 'agent-chat',
    matches: payload => String(payload.type || '').trim() === 'agent',
  },
  {
    // 视频：异步任务制（建单 → 轮询 → 取件）。SceneFlow 那边支持的通道在这里由
    // video-upstream.ts 的适配层承载（openai 兼容 / 火山 Ark / 通用 task 网关）。
    key: 'video',
    matches: payload => String(payload.type || '').trim() === 'video',
  },
  {
    key: 'research-report',
    matches: payload => String(payload.type || '').trim() === 'research',
  },
]

export const resolveGenerationTaskStrategy = (payload: GenerationTaskStartPayload): GenerationTaskStrategy => {
  const strategy = strategies.find(item => item.matches(payload))
  if (!strategy) {
    throw new Error('未找到可用的生成任务策略')
  }
  return strategy
}
