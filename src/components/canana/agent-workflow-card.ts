/**
 * 工作流卡片的显示组装（纯逻辑，2026-09-26，导演控制台批次 4）
 *
 * 卡片展示「当前在跑的那件事」：标题（🎬 + 阶段名）、输入、输出、状态。
 *
 * 三条硬约束（与整个控制台一致，改前先读）：
 *   ① **不编数据**：输入/输出全部来自服务端 `console_state` 里由真实事件与工具回执推导的
 *      `workflow` 字段（见 server/generation-tasks/canvas-agent-console-state.ts）；
 *   ② **缺就显示「—」**：没有真实输入、没有真实产出时如实显示「—」，绝不写死示例、不猜；
 *   ③ **输出不给假分母**：`target` 只在 Agent 明确声明过目标总数时才由服务端带上，
 *      这里只负责格式化 —— 没有 target 就只显示「已产出 N」，绝不自己补一个总数。
 *
 * 为什么抽成独立纯模块（不依赖 Vue）：卡片渲染在 `RightPanel.vue` 里，node 单测挂不起来；
 * 把「拼显示文案」做成纯函数，测试可直接断言（与 agent-confirm-cost.ts 同一种做法）。
 */

import type {
  CanvasAgentConsoleLifecycle,
  CanvasAgentConsoleState,
  CanvasAgentConsoleWorkflowInput,
  CanvasAgentConsoleWorkflowOutput,
} from '../../shared/canvas-agent-console'

/** 生命周期中文词（服务端给英文枚举，这里只做展示翻译） */
export const CANVAS_AGENT_LIFECYCLE_LABELS: Record<CanvasAgentConsoleLifecycle, string> = {
  thinking: '思考中',
  analyzing: '分析中',
  planning: '规划中',
  generating: '执行中',
  verifying: '校验中',
  delivering: '交付中',
}

/** 输入为空时的占位：如实显示「—」，不猜、不写死示例 */
export const AGENT_WORKFLOW_EMPTY_PLACEHOLDER = '—'

export interface AgentWorkflowCardView {
  /** 标题：🎬 + 当前阶段名（用服务端的 stage.label） */
  title: string
  /** 项目名（画布名）；拿不到为空串，界面不渲染 */
  project: string
  /** 输入行：本回合真实发生过的输入（以 · 分隔）；一项都没有时为「—」 */
  inputText: string
  /** 输出行：已产出数量（有声明目标才带 /总数）；没有产出时为「—」 */
  outputText: string
  /** 状态行：生命周期中文词 + 阶段进度（如「执行中 · 阶段 3/6 · 分镜规划」） */
  statusText: string
}

/**
 * 输入项 → 一行展示文本。
 *
 * 只显示服务端真实给到的项（值非空才显示）；一项都没有就返回「—」。
 */
export const formatWorkflowInputText = (
  inputs: ReadonlyArray<CanvasAgentConsoleWorkflowInput> | undefined,
): string => {
  const rows = (Array.isArray(inputs) ? inputs : [])
    .map((item) => {
      const value = String(item?.value ?? '').trim()
      if (!value) return ''
      const label = String(item?.label ?? '').trim()
      return label ? `${label} ${value}` : value
    })
    .filter(Boolean)
  return rows.length ? rows.join(' · ') : AGENT_WORKFLOW_EMPTY_PLACEHOLDER
}

/**
 * 产出 → 展示文本。
 *
 * 有声明目标 → 「已产出 8/24 个镜头」；没有声明 → 「已产出 8 个节点」（**只显示已产出数**）。
 * 没有产出 → 「—」。分母不在这里补：服务端没给 target，这里就绝不出现「/」。
 */
export const formatWorkflowOutputText = (
  output: CanvasAgentConsoleWorkflowOutput | undefined,
): string => {
  if (!output || !Number.isFinite(output.done)) return AGENT_WORKFLOW_EMPTY_PLACEHOLDER
  const done = Math.max(0, Math.trunc(output.done))
  const declaredTarget = typeof output.target === 'number' && Number.isFinite(output.target)
    ? Math.trunc(output.target)
    : null
  const amount = declaredTarget === null ? `${done}` : `${done}/${declaredTarget}`
  const unit = String(output.unit || '').trim()
  return `已产出 ${amount}${unit ? ` ${unit}` : ''}`
}

/**
 * 由控制台状态组装卡片视图。
 *
 * 没有状态（空态 / 无事件）返回 null —— 界面据此整块不显示卡片。
 */
export const buildAgentWorkflowCard = (
  state: CanvasAgentConsoleState | null | undefined,
): AgentWorkflowCardView | null => {
  if (!state || typeof state !== 'object') return null
  const stageLabel = String(state.stage?.label || '').trim()
  const phaseProgress = state.stage
    ? `阶段 ${state.stage.index}/${state.stage.total} · ${String(state.stage.label || '').trim()}`
    : ''
  const lifeLabel = CANVAS_AGENT_LIFECYCLE_LABELS[state.lifecycle] || ''
  const statusText = [lifeLabel, phaseProgress].filter(Boolean).join(' · ')
  return {
    title: `🎬 ${stageLabel || '制片 Agent'}`,
    project: String(state.project || '').trim(),
    inputText: formatWorkflowInputText(state.workflow?.inputs),
    outputText: formatWorkflowOutputText(state.workflow?.output),
    statusText,
  }
}
