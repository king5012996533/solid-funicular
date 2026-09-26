/**
 * 制片 Agent「导演控制台」的状态推导（纯逻辑，2026-09-26）。
 *
 * 设计要点（详见共享契约 src/shared/canvas-agent-console.ts 与产品要求）：
 *   · **输入是事件序列，不是模型的自我描述**：执行器把 Pi 的真实事件（agent_start / turn_start /
 *     tool_execution_* / agent_end）与工具回执喂成 `CanvasAgentConsoleEvent[]`，这里把它们折叠成快照；
 *   · **纯函数、可单测**：给定事件序列 → 断言快照，不连库、不发请求；
 *   · **不造百分比**：`progress` 只在批量回执给出真实分母（add_nodes / run_nodes）时出现；
 *   · **阶段只增不减**：阶段高水位由事件推进，一旦到达就不会因「又读了一次画布」而回退；
 *   · **不进模型上下文**：输出只用于 SSE（见 buildCanvasAgentConsoleStreamEvent），不写进转录。
 */

import {
  CANVAS_AGENT_CONSOLE_PHASES,
  type CanvasAgentConsoleCanvasActions,
  type CanvasAgentConsoleCurrent,
  type CanvasAgentConsoleLifecycle,
  type CanvasAgentConsoleLogEntry,
  type CanvasAgentConsoleLogMark,
  type CanvasAgentConsolePhaseKey,
  type CanvasAgentConsoleProgress,
  type CanvasAgentConsoleSessionMemory,
  type CanvasAgentConsoleState,
  type CanvasAgentConsoleWorkflow,
  type CanvasAgentConsoleWorkflowInput,
  type CanvasAgentConsoleWorkflowOutput,
} from '../../src/shared/canvas-agent-console'
import type { GenerationTaskStreamEvent } from './shared'

/** 折叠输入的事件类型：取自 Pi 的真实事件 + 执行器自产的「工具开始/结束」 */
export type CanvasAgentConsoleEventType =
  | 'agent_start'
  | 'turn_start'
  /** 收尾汇报：一段只有文本、没有工具调用的 assistant 消息 */
  | 'assistant_message'
  | 'tool_start'
  | 'tool_end'
  | 'agent_end'

export interface CanvasAgentConsoleEvent {
  type: CanvasAgentConsoleEventType
  /** tool_start / tool_end 才有 */
  toolName?: string
  /** tool_end：回执是否成功（false → 日志记为 failed） */
  ok?: boolean
  /** tool_end：回执的一句话摘要（取自真实回执，日志正文用它，不由模型自报） */
  summary?: string
  /** tool_end：回执文本（run_nodes / add_nodes 的 JSON，用来算真分母） */
  resultText?: string
  /** tool_start：目标节点 id（展示用，可选） */
  target?: string
  /**
   * Agent **明确声明过的目标总数**（批次 3 的「画布动作」计数用）。
   *
   * 只有 `request_confirmation` 的逐条事项里写出的目标数会走到这里（见 parseDeclaredCanvasTarget）——
   * 声明不到就不给，界面只显示「已创建 N 个」；**绝不解析裸数字当分母**。
   */
  declaredTarget?: { total: number; unit: string }
  /** 工具调用 id：让同一调用的 start/end 精确配对（并发调用也不会串） */
  callId?: string
  /**
   * tool_start：这次 load_playbook 取的**哪本手册**（值来自工具入参、默认 storyboard-production）。
   * 只给工作流卡片的「输入」用 —— 与其它控制台字段一样，只走 SSE、不进模型上下文。
   */
  playbookName?: string
}

/**
 * 工具 → 阶段 的映射。
 *
 * 只映射「能明确判断片子推进到哪一阶段」的工具；qa / delivery 不在这里 —— 它们由事件上下文推导
 * （读回结果 = 质检、收尾汇报 = 交付），这样就不会因为「批量生成前的 preflight_check」把阶段
 * 提前拱到质检再回不去。
 */
const PHASE_BY_TOOL: Record<string, CanvasAgentConsolePhaseKey> = {
  get_canvas_state: 'script',
  get_canvas_overview: 'script',
  get_canvas_node: 'script',
  ask_user: 'script',
  list_workflow_templates: 'script',
  update_node: 'script',
  remove_node: 'script',
  select_nodes: 'script',
  attach_reference_images: 'cast',
  load_playbook: 'storyboard',
  add_node: 'storyboard',
  add_nodes: 'storyboard',
  connect_nodes: 'storyboard',
  apply_workflow_template: 'storyboard',
  run_node: 'production',
  run_nodes: 'production',
  preflight_check: 'production',
  request_confirmation: 'production',
}

/** 工具 → 生命周期。读画布=分析、读手册/规划类=规划、生成类=生成、自检类=校验、其余=思考 */
const LIFECYCLE_BY_TOOL: Record<string, CanvasAgentConsoleLifecycle> = {
  get_canvas_state: 'analyzing',
  get_canvas_overview: 'analyzing',
  get_canvas_node: 'analyzing',
  load_playbook: 'planning',
  ask_user: 'planning',
  list_workflow_templates: 'planning',
  apply_workflow_template: 'planning',
  add_node: 'planning',
  add_nodes: 'planning',
  update_node: 'planning',
  connect_nodes: 'planning',
  remove_node: 'planning',
  select_nodes: 'planning',
  attach_reference_images: 'planning',
  request_confirmation: 'planning',
  preflight_check: 'verifying',
  run_node: 'generating',
  run_nodes: 'generating',
}

/** 工具 → 中文短语（日志与「当前任务」都用它，不暴露英文工具名） */
const PHRASE_BY_TOOL: Record<string, string> = {
  request_confirmation: '等待用户确认',
  ask_user: '向用户提问',
  get_canvas_state: '读取整张画布',
  get_canvas_overview: '读取画布概览',
  get_canvas_node: '读取节点',
  add_node: '创建节点',
  add_nodes: '批量创建节点',
  update_node: '修改节点',
  connect_nodes: '连接节点',
  remove_node: '删除节点',
  select_nodes: '选中节点',
  preflight_check: '批量预校验',
  run_node: '提交节点生成',
  run_nodes: '批量提交生成',
  attach_reference_images: '挂参考图',
  list_workflow_templates: '列出模板',
  apply_workflow_template: '套用模板',
  load_playbook: '加载工作手册',
}

const RUN_TOOLS = new Set(['run_node', 'run_nodes'])
const READ_TOOLS = new Set(['get_canvas_state', 'get_canvas_overview', 'get_canvas_node'])

/**
 * 量词 → 展示单位。
 *
 * 「24 个镜头」在界面上要读成「已创建 8/24 **个镜头**」，而不是干巴巴的「个节点」——
 * 单位跟着 Agent 声明的对象走，用户一眼知道在数什么。
 */
const UNIT_BY_CLASSIFIER: Record<string, string> = {
  镜头: '个镜头',
  场景: '个场景',
  分镜: '个分镜',
  画面: '个画面',
  素材: '个素材',
  节点: '个节点',
  图片: '张图',
  图: '张图',
  视频: '条视频',
}

/** 数字 + 量词 + 分类词（「24 个镜头」「12 张分镜图」）；也覆盖「共 24 个镜头」这种带总数副词的写法 */
const DECLARED_TARGET_PATTERN = /(\d{1,4})\s*(?:个|张|条|幅|段|组)?\s*(镜头|场景|分镜|画面|素材|节点|图片|图|视频)/g
/**
 * 过去式标记：数字前的这一小段里有「已/已经/建好/完成」等，说明是在报告**已经做了多少**，
 * 不是在说目标 —— 不能当分母。刻意只认明确过去式（不认裸「生成/创建」，那是常见的计划措辞）。
 */
const PAST_TENSE_BEFORE = /(?:已|已经|刚刚|刚才|完成|建好|建了|创建了|生成了|做了)/

/**
 * 从 Agent 的**声明文本**里解析目标总数（批次 3）。
 *
 * 只喂 `request_confirmation` 的 items —— 那是 Agent 在花钱前写下的计划逐条，
 * 是**唯一可信的「声明」出处**。刻意不去解析回复正文里的裸数字：
 * 「已创建 8 个场景节点」和「目标 24 个镜头」在纯文本里长得一样，正则分不清，
 * 一旦把前者当分母，界面就会显示「8/8」这种假完成度 —— 这正是本项目踩过的坑。
 * 宁可少显示分母，也不编。
 *
 * 同一批声明里取最大数（目标只会越说越大）；解析不出返回 undefined。
 */
export const parseDeclaredCanvasTarget = (
  texts: ReadonlyArray<string>,
): { total: number; unit: string } | undefined => {
  let best: { total: number; unit: string } | undefined
  for (const raw of texts) {
    const text = String(raw || '')
    if (!text) continue
    DECLARED_TARGET_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = DECLARED_TARGET_PATTERN.exec(text)) !== null) {
      const total = Number(match[1])
      if (!Number.isFinite(total) || total <= 0) continue
      const before = text.slice(Math.max(0, match.index - 8), match.index)
      if (PAST_TENSE_BEFORE.test(before)) continue
      const unit = UNIT_BY_CLASSIFIER[match[2]] || '个节点'
      if (!best || total > best.total) best = { total, unit }
    }
  }
  return best
}

/**
 * 从工具回执里取**真正创建成功**的节点数（add_node / add_nodes）。
 *
 * 只数回执里带 id 的项：add_nodes 部分失败时失败项 id 为 null，不能算进去。
 * 其它工具一律 0（本计数专指「声明式创建节点」这两件动作）。
 */
const resolveCreatedNodeCount = (
  toolName: string | undefined,
  resultText: string | undefined,
): number => {
  const tool = String(toolName || '')
  if (tool !== 'add_node' && tool !== 'add_nodes') return 0
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(String(resultText || '')) as Record<string, unknown>
  } catch {
    return 0
  }
  if (!payload || typeof payload !== 'object') return 0
  if (tool === 'add_node') return String(payload.id || '').trim() ? 1 : 0
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
  return nodes.filter((node) => Boolean((node as { id?: unknown } | null)?.id)).length
}

/**
 * 从「读画布」回执里取**真实读到的节点数**（工作流卡片的输入事实）。
 *
 * get_canvas_state 回执 `{ nodes: [...] }` 数数组长度；get_canvas_overview 回执 `{ nodeCount }`。
 * 其它工具 / 解析不出来 → undefined（这一项输入就不出现，界面显示「—」，绝不猜）。
 */
const resolveReadNodeCount = (
  toolName: string | undefined,
  resultText: string | undefined,
): number | undefined => {
  const tool = String(toolName || '')
  if (tool !== 'get_canvas_state' && tool !== 'get_canvas_overview') return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(String(resultText || '')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  if (tool === 'get_canvas_overview') {
    const count = Number(payload.nodeCount)
    return Number.isFinite(count) && count >= 0 ? count : undefined
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : null
  return nodes ? nodes.length : undefined
}

/** 从 attach_reference_images 回执取**真实挂上的参考图张数**（`{ referenceImageCount }`） */
const resolveAttachedReferenceCount = (
  toolName: string | undefined,
  resultText: string | undefined,
): number | undefined => {
  if (String(toolName || '') !== 'attach_reference_images') return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(String(resultText || '')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const count = Number(payload?.referenceImageCount)
  return Number.isFinite(count) && count > 0 ? count : undefined
}

/** 本回合可观察到的「真实输入事实」——缺的项保持 undefined，界面显示「—」 */
interface ConsoleInputFacts {
  model?: string
  canvasNodes?: number
  referenceImages?: number
  playbook?: string
}

/**
 * 输入事实 → 工作流卡片的输入列表。
 *
 * 顺序固定（模型 → 画布 → 参考图 → 手册），但**只列真实存在的那几项**：没读到画布就没有
 * 「画布」这一项，界面显示「—」。值一律照实（模型键、N 个节点、N 张、手册名），不美化、不编。
 */
const buildWorkflowInputs = (facts: ConsoleInputFacts): CanvasAgentConsoleWorkflowInput[] => {
  const inputs: CanvasAgentConsoleWorkflowInput[] = []
  const model = String(facts.model || '').trim()
  if (model) inputs.push({ key: 'model', label: '模型', value: model })
  if (typeof facts.canvasNodes === 'number') {
    inputs.push({ key: 'canvas_nodes', label: '画布', value: `${facts.canvasNodes} 个节点` })
  }
  if (typeof facts.referenceImages === 'number') {
    inputs.push({ key: 'reference_images', label: '参考图', value: `${facts.referenceImages} 张` })
  }
  const playbook = String(facts.playbook || '').trim()
  if (playbook) inputs.push({ key: 'playbook', label: '手册', value: playbook })
  return inputs
}

/** 日志最多保留的条数：控制台是「最近发生了什么」，不是全量审计（全量在服务端日志里） */
const CONSOLE_LOG_CAP = 20

const phaseIndexOf = (key: CanvasAgentConsolePhaseKey): number =>
  CANVAS_AGENT_CONSOLE_PHASES.findIndex((item) => item.key === key)

const PRODUCTION_INDEX = phaseIndexOf('production')

const clampPhaseIndex = (index: number): number =>
  Math.min(Math.max(index, 0), CANVAS_AGENT_CONSOLE_PHASES.length - 1)

interface InternalLogEntry extends CanvasAgentConsoleLogEntry {
  callId?: string
}

interface FoldedConsole {
  lifecycle: CanvasAgentConsoleLifecycle
  phaseIndex: number
  generationSubmitted: boolean
  log: InternalLogEntry[]
  progress?: CanvasAgentConsoleProgress
  current?: CanvasAgentConsoleCurrent
  /** 本回合累计成功创建的节点数（add_node / add_nodes 跨批次累加） */
  canvasCreated: number
  /** Agent 声明过的目标总数（取最大）——没有声明就没有它，界面不给分母 */
  canvasTarget?: { total: number; unit: string }
  /** 本回合真实发生过的输入事实（工作流卡片用）——缺的项保持 undefined */
  inputs: ConsoleInputFacts
}

/** 目标总数只增不减：同一回合里声明多次取最大（越说越大才是目标） */
const mergeDeclaredTarget = (
  current: { total: number; unit: string } | undefined,
  next: { total: number; unit: string } | undefined,
): { total: number; unit: string } | undefined => {
  if (!next) return current
  if (!current || next.total > current.total) return next
  return current
}

/** 把一条 running 的日志更新成终态：按 callId 精确配对；没有 callId 时退化为「最后一条 running」 */
const settleRunningLog = (
  log: InternalLogEntry[],
  callId: string | undefined,
  entry: { mark: CanvasAgentConsoleLogMark; text: string },
): InternalLogEntry[] => {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index]
    if (item.mark !== 'running') continue
    if (callId && item.callId !== callId) continue
    const next = log.slice()
    next[index] = { mark: entry.mark, text: entry.text, callId: item.callId }
    return next
  }
  return [...log, { mark: entry.mark, text: entry.text, callId }]
}

/**
 * 从批量回执里取真实分母。
 *
 * 只认这两种工具的回执（形状见 src/views/workflow/agent/canvas-agent-tools.ts）：
 *   · add_nodes → `{ nodes: [{ id, ... }] }`：done = 真的建出来的节点数，total = 请求的节点数；
 *   · run_nodes → `{ submitted, total, nodes }`：done = 真正提交的节点数，total = 这一批的节点数。
 * 解析不出来（非 JSON / 字段缺失 / 分母为 0）一律返回 undefined —— **没有分母就不显示进度**。
 */
const resolveBatchProgress = (
  toolName: string | undefined,
  resultText: string | undefined,
): CanvasAgentConsoleProgress | undefined => {
  const tool = String(toolName || '')
  if (tool !== 'add_nodes' && tool !== 'run_nodes') return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(String(resultText || '')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined

  if (tool === 'add_nodes') {
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : null
    if (!nodes || nodes.length === 0) return undefined
    const done = nodes.filter((node) => Boolean((node as { id?: unknown } | null)?.id)).length
    return { done, total: nodes.length, unit: '个节点' }
  }

  const total = Number(payload.total)
  if (!Number.isFinite(total) || total <= 0) return undefined
  const submitted = Number(payload.submitted)
  return { done: Number.isFinite(submitted) ? submitted : 0, total, unit: '个节点' }
}

/** 事件序列 → 折叠态（阶段高水位、生命周期、日志、进度、当前任务） */
const foldConsoleEvents = (
  events: ReadonlyArray<CanvasAgentConsoleEvent>,
  seed?: CanvasAgentConsoleSessionMemory,
  model?: string,
): FoldedConsole => {
  const seedIndex = seed ? clampPhaseIndex(phaseIndexOf(seed.phase)) : 0
  const folded: FoldedConsole = {
    lifecycle: 'thinking',
    phaseIndex: seedIndex,
    generationSubmitted: seedIndex >= PRODUCTION_INDEX,
    log: [],
    canvasCreated: 0,
    // 模型是本轮的运行时事实（不是模型自报）：启动时就已知，作为「输入」的一项
    inputs: model ? { model } : {},
  }

  const advanceTo = (key?: CanvasAgentConsolePhaseKey) => {
    if (!key) return
    const index = phaseIndexOf(key)
    if (index > folded.phaseIndex) folded.phaseIndex = index
  }

  for (const event of events) {
    switch (event.type) {
      case 'agent_start':
        folded.lifecycle = 'thinking'
        break
      case 'turn_start':
        // 新一轮模型思考开始：清掉上一动作的「当前任务」，避免「思考中 · 正在创建节点」这种自相矛盾
        folded.lifecycle = 'thinking'
        folded.current = undefined
        break
      case 'assistant_message':
        // 只有生成过东西之后的纯文本收尾才算「交付」；闲聊/问答不把阶段拱到交付
        if (folded.generationSubmitted) {
          folded.lifecycle = 'delivering'
          advanceTo('delivery')
        } else {
          folded.lifecycle = 'thinking'
        }
        break
      case 'agent_end':
        folded.lifecycle = 'delivering'
        if (folded.generationSubmitted) advanceTo('delivery')
        break
      case 'tool_start': {
        const tool = String(event.toolName || '')
        const phrase = PHRASE_BY_TOOL[tool] || tool || '执行操作'
        folded.lifecycle = LIFECYCLE_BY_TOOL[tool] || 'thinking'
        folded.current = {
          title: `正在${phrase}`,
          ...(event.target ? { target: event.target } : {}),
        }
        folded.log = [...folded.log, { mark: 'running', text: `${phrase}…`, callId: event.callId }]
        if (RUN_TOOLS.has(tool)) folded.generationSubmitted = true
        if (READ_TOOLS.has(tool) && folded.generationSubmitted) advanceTo('qa')
        // 声明可能在卡片弹出的那一刻（tool_start）就到；end 也会带一次，两处都并一次，取最大
        folded.canvasTarget = mergeDeclaredTarget(folded.canvasTarget, event.declaredTarget)
        // 手册名来自 load_playbook 的入参（tool_start 时就已知）：作为「输入」的一项
        if (tool === 'load_playbook') {
          const name = String(event.playbookName || '').trim()
          if (name) folded.inputs = { ...folded.inputs, playbook: name }
        }
        advanceTo(PHASE_BY_TOOL[tool])
        break
      }
      case 'tool_end': {
        const tool = String(event.toolName || '')
        const phrase = PHRASE_BY_TOOL[tool] || tool || '执行操作'
        const failed = event.ok === false
        const summary = String(event.summary || '').trim()
        folded.log = settleRunningLog(folded.log, event.callId, {
          mark: failed ? 'failed' : 'done',
          text: failed ? `失败：${summary || `${phrase}未完成`}` : summary || `已完成${phrase}`,
        })
        if (!failed) {
          const batchProgress = resolveBatchProgress(tool, event.resultText)
          if (batchProgress) folded.progress = batchProgress
          // 画布动作：只累计成功创建出来的节点数（失败项回执里没有 id，自然不算）
          folded.canvasCreated += resolveCreatedNodeCount(tool, event.resultText)
          // 输入事实：读到的节点数 / 挂上的参考图张数（都取自真实回执；解析不出就不给这一项）
          const readNodeCount = resolveReadNodeCount(tool, event.resultText)
          if (typeof readNodeCount === 'number') {
            folded.inputs = { ...folded.inputs, canvasNodes: readNodeCount }
          }
          const attachedRefs = resolveAttachedReferenceCount(tool, event.resultText)
          if (typeof attachedRefs === 'number') {
            folded.inputs = { ...folded.inputs, referenceImages: attachedRefs }
          }
        }
        folded.canvasTarget = mergeDeclaredTarget(folded.canvasTarget, event.declaredTarget)
        if (READ_TOOLS.has(tool) && folded.generationSubmitted) advanceTo('qa')
        advanceTo(PHASE_BY_TOOL[tool])
        break
      }
    }
  }

  if (folded.log.length > CONSOLE_LOG_CAP) {
    folded.log = folded.log.slice(-CONSOLE_LOG_CAP)
  }
  return folded
}

export interface CanvasAgentConsoleDerivation {
  state: CanvasAgentConsoleState
  /** 本次折叠后的会话记忆（阶段高水位），由执行器写回 metaJson 供下一轮继续推进 */
  memory: CanvasAgentConsoleSessionMemory
}

/**
 * 折叠事件序列，产出控制台快照与会话记忆。
 *
 * `seed` 是上一轮落库的阶段高水位（同一画布 + 同一会话），保证「阶段只增不减」跨轮成立。
 */
export const deriveCanvasAgentConsole = (
  events: ReadonlyArray<CanvasAgentConsoleEvent>,
  input?: { project?: string; model?: string; seed?: CanvasAgentConsoleSessionMemory },
): CanvasAgentConsoleDerivation => {
  const folded = foldConsoleEvents(events, input?.seed, input?.model)
  const phaseIndex = clampPhaseIndex(folded.phaseIndex)
  const phase = CANVAS_AGENT_CONSOLE_PHASES[phaseIndex]
  /**
   * 画布动作：只在**真的创建过节点**时出现。
   * `target` 只有 Agent 声明过才带（没有声明就只显示「已创建 N 个」）——绝不编分母。
   */
  const canvasActions: CanvasAgentConsoleCanvasActions | undefined = folded.canvasCreated > 0
    ? {
        created: folded.canvasCreated,
        ...(folded.canvasTarget ? { target: folded.canvasTarget.total } : {}),
        unit: folded.canvasTarget?.unit || '个节点',
      }
    : undefined
  /**
   * 工作流卡片的产出：已产出数量只认工具回执累计 —— 优先「已创建节点数」（声明式创建），
   * 没有创建节点但提交过生成时退到「已提交数」。`target` 只在 Agent 声明过目标总数时才带。
   */
  const workflowOutput: CanvasAgentConsoleWorkflowOutput | undefined = folded.canvasCreated > 0
    ? {
        done: folded.canvasCreated,
        ...(folded.canvasTarget ? { target: folded.canvasTarget.total } : {}),
        unit: folded.canvasTarget?.unit || '个节点',
      }
    : (folded.progress
        ? { done: folded.progress.done, unit: folded.progress.unit }
        : undefined)
  const workflowInputs = buildWorkflowInputs(folded.inputs)
  const workflow: CanvasAgentConsoleWorkflow | undefined = workflowInputs.length || workflowOutput
    ? {
        inputs: workflowInputs,
        ...(workflowOutput ? { output: workflowOutput } : {}),
      }
    : undefined
  const state: CanvasAgentConsoleState = {
    agent: 'director',
    project: String(input?.project || ''),
    lifecycle: folded.lifecycle,
    stage: {
      phase: phase.key,
      label: phase.label,
      index: phaseIndex + 1,
      total: CANVAS_AGENT_CONSOLE_PHASES.length,
    },
    ...(folded.progress ? { progress: folded.progress } : {}),
    ...(folded.current ? { current: folded.current } : {}),
    ...(canvasActions ? { canvasActions } : {}),
    ...(workflow ? { workflow } : {}),
    log: folded.log.map((item) => ({ mark: item.mark, text: item.text })),
  }
  return { state, memory: { phase: phase.key } }
}

/** 只要快照（单测/前端契约用它；需要写回记忆用 deriveCanvasAgentConsole） */
export const deriveCanvasAgentConsoleState = (
  events: ReadonlyArray<CanvasAgentConsoleEvent>,
  input?: { project?: string; model?: string; seed?: CanvasAgentConsoleSessionMemory },
): CanvasAgentConsoleState => deriveCanvasAgentConsole(events, input).state

/**
 * 造一个 `console_state` 流事件。
 *
 * **它只走 SSE**：载荷挂在 `consoleState` 字段上，不带 `content` / `delta` / `message`，
 * 所以前端的内容流与转录都不可能把它当成模型输出 —— 这正是「状态只给界面看、不进模型上下文」的落点。
 */
export const buildCanvasAgentConsoleStreamEvent = (
  recordId: string,
  state: CanvasAgentConsoleState,
): GenerationTaskStreamEvent => ({
  type: 'console_state',
  recordId,
  done: false,
  stopped: false,
  stage: 'agent_console',
  consoleState: state,
})
