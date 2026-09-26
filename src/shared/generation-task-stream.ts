// 任务事件流共享协议（前后端共用）
//
// 设计要点：
// - 用泛型 TRecord 适配前后端对 record 字段的不同类型期望（前端是 PersistedGenerationRecord，
//   服务端是 Record<string, unknown>），但其余字段强类型对齐
// - 定义标准化的失败码 GenerationTaskFailureCode，用于 failed 事件，
//   前端可据此区分错误类型并给出准确的用户反馈
import type { AgentWorkspaceEvent } from "./agent-workspace";
import type { CanvasAgentConsoleState } from "./canvas-agent-console";
import type {
  ResearchBeginPayload,
  ResearchOutlineReadyPayload,
  ResearchStageChangedPayload,
} from "./research/research-stream";
import type {
  ResearchEvidence,
  ResearchFact,
  ResearchReasoningSummary,
  ResearchSectionDelta,
  ResearchTokenUsage,
  ResearchToolCallPayload,
  ResearchToolResultPayload,
  ResearchVerificationResult,
} from "./research/research-types";

export type GenerationTaskStreamEventType =
  | "connected"
  | "snapshot"
  | "begin"
  | "progress"
  | "stage_changed"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result"
  | "evidence_added"
  | "fact_update"
  | "verification"
  | "outline_ready"
  | "content_delta"
  | "thinking_delta"
  | "section_delta"
  | "token_usage"
  | "agent_event"
  // 制片 Agent 的「导演控制台」结构化状态（只给界面看，不进转录/不进模型上下文）
  | "console_state"
  | "completed"
  | "failed"
  | "stopped";

/**
 * 画布 Agent 的「桥」协议（2026-09-23）
 *
 * 背景：Agent 的大脑在服务端（Pi），但**画布是浏览器里的状态**，服务端碰不到。
 * 于是需要一个来回：
 *   服务端决定调工具 → 发 tool_call 事件（带调用 id）→ 浏览器真的执行
 *     → POST 回执 → 服务端把结果喂回模型继续下一步。
 *
 * 复用已有的 `tool_call` / `tool_result` 事件名（研究任务也在用），
 * 靠载荷字段区分来源：带 agentToolCall / agentToolResult 的就是画布 Agent 的。
 */
export interface AgentToolCallPayload {
  /** 调用 id：服务端生成，浏览器必须原样带回，用于配对 */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** 展示用中文名 */
  label: string;
  /** 模型这一轮为什么调它（可选，用于 UI 展开） */
  reason?: string;
  /** 服务端最多等多久（毫秒）；超时后服务端会当作「用户离页」收口 */
  timeoutMs?: number;
}

export interface AgentToolResultPayload {
  callId: string;
  name?: string;
  ok: boolean;
  /** 给模型看的文本结果 */
  result: string;
  /** 给用户看的一句话摘要 */
  summary?: string;
  /** 结构化细节（例如确认卡片的原始参数） */
  details?: Record<string, unknown>;
}

// 任务失败的标准化原因，前端可据此决定提示文案与是否提示重试
export type GenerationTaskFailureCode =
  | "upstream_error" // 上游 AI 厂商返回错误
  | "upstream_timeout" // 上游响应超时
  | "upstream_disconnected" // 上游连接中断
  | "rate_limit_exceeded" // 触发限流
  | "concurrency_exceeded" // 并发数超限
  | "authentication_failed" // 鉴权失败
  | "insufficient_quota" // 余额或配额不足
  | "invalid_input" // 输入参数非法
  | "task_aborted" // 任务被主动中止
  | "internal_error"; // 内部错误（兜底）

// 通用事件载荷，TRecord 用于桥接前后端 record 字段的差异
export interface GenerationTaskStreamEventBase<TRecord = unknown> {
  type: GenerationTaskStreamEventType;
  recordId: string;
  done: boolean;
  stopped?: boolean;
  record?: TRecord | null;
  stage?: string;
  message?: string;
  delta?: string;
  content?: string;
  /** thinking_delta 事件用：本次新增的思考片段。 */
  thinkingDelta?: string;
  /** thinking_delta / completed 事件用：累计完整思考内容。 */
  thinkingContent?: string;
  agentEvent?: AgentWorkspaceEvent;
  researchBegin?: ResearchBeginPayload;
  researchStage?: ResearchStageChangedPayload;
  reasoningSummary?: ResearchReasoningSummary;
  toolCall?: ResearchToolCallPayload;
  toolResult?: ResearchToolResultPayload;
  evidence?: ResearchEvidence;
  fact?: ResearchFact;
  verification?: ResearchVerificationResult;
  outline?: ResearchOutlineReadyPayload;
  sectionDelta?: ResearchSectionDelta;
  tokenUsage?: ResearchTokenUsage;
  /** 画布 Agent 桥：服务端要求浏览器执行的工具调用 */
  agentToolCall?: AgentToolCallPayload;
  /** 画布 Agent 桥：浏览器回传的执行回执（服务端会转成事件再广播一次，便于多端同步展示） */
  agentToolResult?: AgentToolResultPayload;
  /**
   * 导演控制台状态（console_state）：由服务端从真实事件推导。
   * **只给界面渲染**，客户端不得把它并入消息正文或任何回喂模型的上下文。
   */
  consoleState?: CanvasAgentConsoleState;
  // 单调递增的事件 id，用于客户端断线重连时通过 lastEventId 定位重放起点
  id?: number;
  // 仅 failed 事件使用：标准化错误码 + 详细原因
  errorCode?: GenerationTaskFailureCode;
  errorReason?: string;
}

// 默认导出：record 用 unknown，由前后端各自收紧
export type GenerationTaskStreamEvent = GenerationTaskStreamEventBase;
