/**
 * 面板发送路由（2026-09-26）：一轮进行中的用户输入该走哪条路。
 *
 * 这是「插话不建新单」这条硬约束的**唯一判定点**，抽成纯函数是为了能单测钉死：
 *   · 运行中 → interject（`steer` / `follow-up`），投递给**正在跑的那个任务**（`/steer` 端点）；
 *   · 空闲   → new-turn，才走 `createGenerationTask` 建新任务。
 *
 * 两者互斥：只要 `running=true` 就落不到 new-turn，于是插话路径**不可能**碰到建单路径 ——
 * 当初把插话判为「高风险」正是因为无脑放开发送会起第二个任务、和第一个抢同一把画布锁。
 */

/** 插话方式：`steer` = 插入当前轮；`follow-up` = 排到这一轮之后 */
export type AgentInterjectionMode = 'steer' | 'follow-up'

export type AgentSendRoute =
  | { kind: 'new-turn' }
  | { kind: 'interject'; mode: AgentInterjectionMode }

/** 只认 `follow-up`，其余（含缺失）一律按 `steer`：默认最贴近用户直觉的「插入当前轮」 */
export const normalizeAgentInterjectionMode = (mode: unknown): AgentInterjectionMode =>
  String(mode || '').trim() === 'follow-up' ? 'follow-up' : 'steer'

export const resolveAgentSendRoute = (input: {
  running: boolean
  mode?: unknown
}): AgentSendRoute =>
  input.running
    ? { kind: 'interject', mode: normalizeAgentInterjectionMode(input.mode) }
    : { kind: 'new-turn' }

/** 插话成功后的提示文案（按方式区分，用户要知道自己那句话是插进去了还是排在后面） */
export const describeAgentInterjectionNotice = (mode: AgentInterjectionMode): string =>
  mode === 'follow-up'
    ? '已排队：这一轮结束后交给 Agent'
    : '已插入当前轮：Agent 会在下一次工具间隙读到'
