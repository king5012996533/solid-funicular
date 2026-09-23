import { CANVAS_AGENT_SKILL_KEY } from '../../src/shared/canvas-agent-tools'
import type { GenerationTaskStartPayload } from './shared'

export type GenerationTaskStrategyKey =
  | 'image'
  | 'video'
  | 'agent-chat'
  | 'canvas-agent'
  | 'agent-workspace'
  | 'research-report'

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
    /**
     * 制片 Agent（画布上的「从零到一」）：与 agent-chat 同样是 type=agent，
     * 靠 skill 键区分 —— 这样不必新增任务类型，也不必改动前端的 type 联合。
     */
    key: 'canvas-agent',
    matches: payload => String(payload.type || '').trim() === 'agent'
      && String(payload.skill || '').trim() === CANVAS_AGENT_SKILL_KEY,
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
