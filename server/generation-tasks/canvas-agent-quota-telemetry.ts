import type { CanvasPreflightQuotaCheck } from '../../src/shared/canvas-agent-tools'

/**
 * 预校验配额埋点的「日志映射」（纯函数，便于单测钉死）。
 *
 * 为什么单独拆出来：埋点这件事的失败模式很隐蔽 —— 客户端拿不到余额时会**静默跳过**配额校验，
 * 而这件事只发生在浏览器里。如果服务端没有留痕，日志里只会看到「预校验通过」，
 * 完全不知道配额这一条规则其实没跑（这正是「闸门是死的」当初没被发现的根因）。
 * 把「quotaCheck → 用哪条 stage、带哪些字段」抽成纯函数，是为了让它能被单测钉死，
 * 不依赖跑完整的 Agent 链路（那条链路需要可用的对话模型）。
 *
 * 两条稳定的 stage（刻意保留原文 token，方便在服务端日志里直接 grep）：
 *   · canvas_agent:preflight_quota_checked        —— 配额真的参与了校验
 *   · canvas_agent:preflight_quota_check_skipped   —— 拿不到余额/预估，配额被跳过
 */
export const PREFLIGHT_QUOTA_CHECKED_STAGE = 'canvas_agent:preflight_quota_checked'
export const PREFLIGHT_QUOTA_SKIPPED_STAGE = 'canvas_agent:preflight_quota_check_skipped'

export interface PreflightQuotaTelemetry {
  stage: string
  detail: Record<string, unknown>
}

export const describePreflightQuotaTelemetry = (
  quotaCheck: CanvasPreflightQuotaCheck | undefined | null,
): PreflightQuotaTelemetry | null => {
  if (!quotaCheck || typeof quotaCheck.status !== 'string') return null

  if (quotaCheck.status === 'checked') {
    return {
      stage: PREFLIGHT_QUOTA_CHECKED_STAGE,
      detail: {
        available: quotaCheck.available ?? null,
        totalEstimated: quotaCheck.totalEstimated ?? null,
        nodeCount: quotaCheck.nodeCount ?? null,
      },
    }
  }

  return {
    stage: PREFLIGHT_QUOTA_SKIPPED_STAGE,
    detail: {
      reason: quotaCheck.reason || 'unknown',
      nodeCount: quotaCheck.nodeCount ?? null,
    },
  }
}
