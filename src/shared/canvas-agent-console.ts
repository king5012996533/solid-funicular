/**
 * 制片 Agent「导演控制台」的状态契约（前后端共用，2026-09-26）。
 *
 * 这是「AI Director Console」批次 1 的数据形状：控制台顶部要显示的东西 —— 当前阶段、
 * 生命周期、进度、执行日志 —— 全部由**服务端从真实事件推导**，客户端只负责渲染。
 * 放在共享文件（而不是只写在服务端）的理由与 canvas-agent-tools 一致：事件载荷要跨
 * 服务端（推导）与前端（渲染）两侧，任一侧改字段都必须让另一侧编译失败，避免静默漂移。
 *
 * 三条硬约束（这是本设计的灵魂，改动前先读）：
 *   ① **不造百分比**：`progress` 只在**真有分母**（批量回执给的 done/total）时出现；
 *      阶段进度用固定的 index/total，不掺任何模型自报数字。
 *   ② **状态由事件推导、不由模型自报**（见 server 侧的 canvas-agent-console-state.ts）。
 *   ③ **只给界面看、不进模型上下文**：状态只作为 `console_state` SSE 事件推送，
 *      **不写进转录**，因此 Pi 的 `convertToLlm` 无需过滤它（它根本不在 messages 里）。
 */

/** 生命周期：当前这一轮「正在做什么」——由工具名/事件推导，不由模型自报 */
export type CanvasAgentConsoleLifecycle =
  | 'thinking'
  | 'analyzing'
  | 'planning'
  | 'generating'
  | 'verifying'
  | 'delivering'

/** 阶段键：一部片子的 6 个阶段，只增不减（存在会话状态里） */
export type CanvasAgentConsolePhaseKey =
  | 'script'
  | 'cast'
  | 'storyboard'
  | 'production'
  | 'qa'
  | 'delivery'

export interface CanvasAgentConsolePhase {
  phase: CanvasAgentConsolePhaseKey
  label: string
  /** 1-based，展示用（「阶段 3/6」） */
  index: number
  total: number
}

export type CanvasAgentConsoleLogMark = 'done' | 'running' | 'pending' | 'failed'

export interface CanvasAgentConsoleLogEntry {
  mark: CanvasAgentConsoleLogMark
  text: string
}

/** 批量任务的真实分母（例如 run_nodes 回执的 submitted/total）——没有分母时整个字段不出现 */
export interface CanvasAgentConsoleProgress {
  done: number
  total: number
  unit: string
}

export interface CanvasAgentConsoleCurrent {
  title: string
  target?: string
}

export interface CanvasAgentConsoleState {
  agent: 'director'
  /** 项目名（画布名）；服务端取 requestBody.canvasName，前端拿不到时回落到面板标题 */
  project: string
  lifecycle: CanvasAgentConsoleLifecycle
  stage: CanvasAgentConsolePhase
  progress?: CanvasAgentConsoleProgress
  current?: CanvasAgentConsoleCurrent
  log: CanvasAgentConsoleLogEntry[]
}

/**
 * 会话记忆：跨轮持久化到 `GenerationRecord.metaJson.canvasAgentSession.console`。
 *
 * 只存「阶段高水位」——`generationSubmitted` 不必单独存，它可由阶段是否已到
 * production 推导（到了 production 就说明本会话提交过生成）。这样记忆最小、最难出错。
 */
export interface CanvasAgentConsoleSessionMemory {
  phase: CanvasAgentConsolePhaseKey
}

/** 6 个阶段的有序真源：顺序即展示顺序，也是「只增不减」的推进方向 */
export const CANVAS_AGENT_CONSOLE_PHASES: ReadonlyArray<{ key: CanvasAgentConsolePhaseKey; label: string }> = [
  { key: 'script', label: '剧本分析' },
  { key: 'cast', label: '角色设定' },
  { key: 'storyboard', label: '分镜规划' },
  { key: 'production', label: '生成执行' },
  { key: 'qa', label: '质检' },
  { key: 'delivery', label: '交付' },
]
