import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { createWorkflowDefinition } from '@/views/workflow/api/definitions'
import { resolveHomeCanvasName, writeHomeCanvasAgentPending } from '@/shared/home-canvas-entry'
import type { CreationType } from '@/components/generate/selectors'

/**
 * 首页生成器送出的参数（与 ContentGenerator 的 send 事件一致）。
 * 新建画布这条路只用到话本身；`/generate` 回退路径仍原样带上这些参数。
 */
export interface HomeGeneratorSendOptions {
  model?: string
  skill?: string
  ratio?: string
  resolution?: string
  modelKey?: string
  duration?: string
  feature?: string
  referenceImages?: string[]
}

/**
 * 首页的创作入口：把「用户说的那句话」变成一张新画布，并在画布上自动交给 Agent。
 *
 * 抽成 composable 是因为 /agentic-assets-canvas 与首页头部（HomeHeader）是同一套逻辑，
 * 两份各写一遍迟早会分叉。这里只做「建画布 + 写一次性标记 + 跳转 + 失败回退」，
 * 真正的发送在画布侧走既有链路（见 RightPanel 的 sendMessage）。
 */
export const useHomeCanvasEntry = () => {
  const router = useRouter()

  /** 回退到生成页：保留 /generate 深链与原有行为，别把用户卡在首页 */
  const pushToGenerate = (message: string, type: CreationType, options?: HomeGeneratorSendOptions) => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('canana:home-header:pending-send', JSON.stringify({
        modelKey: options?.modelKey || '',
        duration: options?.duration || '',
        feature: options?.feature || '',
        referenceImages: Array.isArray(options?.referenceImages) ? options.referenceImages : [],
      }))
    }

    void router.push({
      path: '/generate',
      query: {
        message,
        type,
        ...(options?.model && { model: options.model }),
        ...(options?.skill && { skill: options.skill }),
        ...(options?.ratio && { ratio: options.ratio }),
        ...(options?.resolution && { resolution: options.resolution }),
      },
    })
  }

  /**
   * 说一句 → 新建画布（名字取自那句话）→ 带标记跳进画布。
   * 建画布失败时回退到生成页并给出提示，不阻断用户的这次创作。
   */
  const sendToNewCanvas = async (
    message: string,
    type: CreationType,
    options?: HomeGeneratorSendOptions,
  ): Promise<boolean> => {
    const text = String(message || '').trim()
    if (!text) return false

    try {
      const created = await createWorkflowDefinition({
        name: resolveHomeCanvasName(text),
        scene: 'WORKFLOW_CANVAS',
      })
      const workflowId = String(created?.definition?.id || '').trim()
      if (!workflowId) throw new Error('创建画布失败')

      // 先写标记再跳转：画布挂载后据此把这句话自动交给 Agent（一次性消费）
      writeHomeCanvasAgentPending({ workflowId, message: text })
      await router.push({ path: '/workflow', query: { workflowId } })
      return true
    } catch (error) {
      console.error('[home-canvas] 新建画布失败，回退到生成页', error)
      ElMessage.warning('新建画布失败，已改为直接生成')
      pushToGenerate(text, type, options)
      return false
    }
  }

  return { sendToNewCanvas }
}
