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

/**
 * 本回合的「画布动作」累计（批次 3）。
 *
 * 控制台里单独一行展示（例如「🖼 已创建 8/24 个镜头」）：
 *   · `created` —— 本回合 `add_node` / `add_nodes` **成功创建**的节点数，跨批次累加；
 *   · `target`  —— **只有 Agent 明确声明过目标总数时才出现**（声明写在 request_confirmation 的
 *     逐条事项里）；声明不到就**没有这个字段**，界面只显示「已创建 N 个」，绝不编分母 ——
 *     这条与 `progress` 同一条规矩（本项目在「没分母却给百分比」上踩过两次）。
 *   · `unit`    —— 展示单位，随声明的量词变（声明「24 个镜头」→「个镜头」；没声明→「个节点」）。
 *
 * 与其它控制台字段一样：**只走 SSE 给界面看，不写进转录、不进模型上下文**。
 */
export interface CanvasAgentConsoleCanvasActions {
  created: number
  target?: number
  unit: string
}

/** 工作流卡片的输入项键：只列本回合**真实发生过**的那几类输入（模型 / 读画布 / 挂参考图 / 取手册） */
export type CanvasAgentConsoleWorkflowInputKey =
  | 'model'
  | 'canvas_nodes'
  | 'reference_images'
  | 'playbook'

/**
 * 工作流卡片的一条输入。
 *
 * `value` **只来自本回合的真实事件与工具回执**（模型键来自运行时、节点数/参考图数来自工具回执、
 * 手册名来自 load_playbook 的入参）；拿不到就不构造这一项，界面显示「—」。绝不写死示例值。
 */
export interface CanvasAgentConsoleWorkflowInput {
  key: CanvasAgentConsoleWorkflowInputKey
  label: string
  value: string
}

/**
 * 工作流卡片的产出（批次 4）。
 *
 * `done` 是本回合**真实产出**的数量（工具回执累计：已创建节点数，或已提交生成数）；
 * `target` **只有 Agent 明确声明过目标总数时才出现**（沿用 parseDeclaredCanvasTarget），
 * 没声明就只显示已产出数 —— 绝不编分母（本项目在「没分母却给百分比」上踩过两次）。
 */
export interface CanvasAgentConsoleWorkflowOutput {
  done: number
  target?: number
  unit: string
}

/**
 * 工作流卡片（批次 4）：「当前在跑的那件事」。
 *
 * 标题与状态由 `stage` / `lifecycle` 推导（前端渲染时加 🎬）；这里只给**输入与产出**的数据，
 * 全部来自真实事件，缺就整项缺席（界面显示「—」）。
 */
export interface CanvasAgentConsoleWorkflow {
  inputs: CanvasAgentConsoleWorkflowInput[]
  output?: CanvasAgentConsoleWorkflowOutput
}

export interface CanvasAgentConsoleState {
  agent: 'director'
  /** 项目名（画布名）；服务端取 requestBody.canvasName，前端拿不到时回落到面板标题 */
  project: string
  lifecycle: CanvasAgentConsoleLifecycle
  stage: CanvasAgentConsolePhase
  progress?: CanvasAgentConsoleProgress
  current?: CanvasAgentConsoleCurrent
  /** 本回合的画布动作累计（创建了多少、目标多少）——只在真的动过画布时出现 */
  canvasActions?: CanvasAgentConsoleCanvasActions
  /** 工作流卡片的输入与产出（批次 4）——只在真有真实输入/产出时出现 */
  workflow?: CanvasAgentConsoleWorkflow
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
