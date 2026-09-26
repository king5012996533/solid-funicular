import type {
  GenerationTaskStartPayload,
  GenerationTaskStreamEvent,
} from "./shared";
import type { GenerationRecordPayload } from "../generation-records/shared";
import type { RuntimeManagedTask } from "./task-runtime-governor";
import {
  CANVAS_AGENT_SKILL_KEY,
  CANVAS_AGENT_TOOL_DEFINITIONS,
  describeConfirmationDecision,
  findCanvasAgentTool,
  resolveCanvasAgentPlaybook,
  type AgentConfirmationDecision,
  type AgentConfirmationRequest,
  type CanvasPreflightQuotaCheck,
} from "../../src/shared/canvas-agent-tools";
import { describePreflightQuotaTelemetry } from "./canvas-agent-quota-telemetry";
import { Agent, Type, type AgentMessage, type AgentTool } from "./pi-runtime";
import { createGatewayStreamFn, requestGatewayChatText } from "./pi-gateway-stream";
import { createSpendGuard } from "./canvas-agent-guard";
import {
  cancelPendingClientToolCalls,
  waitForClientToolResult,
} from "./canvas-agent-bridge";
import {
  CANVAS_AGENT_SUMMARY_CARRIER,
  CANVAS_AGENT_SUMMARY_INPUT_CHAR_BUDGET,
  CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET,
  buildCanvasAgentRestoredContext,
  buildCanvasAgentSessionMeta,
  buildCanvasAgentSummarySource,
  buildCanvasAgentSummarySystemSection,
  compactCanvasAgentTranscript,
  resolveCanvasAgentCanvasId,
  resolveCanvasAgentSessionBootstrap,
  selectCanvasAgentFallbackHistory,
  trimTranscriptToBudgetPreservingSystem,
  type CanvasAgentPersistedSession,
} from "./canvas-agent-session";
import {
  CANVAS_AGENT_THINKING_BUDGETS,
  buildCanvasAgentProviderSessionId,
  escalateCanvasAgentThinkingLevel,
  resolveCanvasAgentReasoningFields,
  resolveCanvasAgentThinkingLevel,
} from "./canvas-agent-thinking";
import {
  buildCanvasAgentConsoleStreamEvent,
  deriveCanvasAgentConsole,
  parseDeclaredCanvasTarget,
  type CanvasAgentConsoleEvent,
} from "./canvas-agent-console-state";
import type { CanvasAgentConsoleSessionMemory } from "../../src/shared/canvas-agent-console";

/**
 * 画布 Agent 的服务端执行器（2026-09-23，M2）
 *
 * 与既有的 `agent-chat` / `agent-workspace` 执行器的根本区别：
 * **这个 Agent 真的会动手**。它跑在服务端（Pi 的 Agent 循环 + 我们的网关当模型层），
 * 而画布在浏览器里 —— 所以工具调用分两类：
 *
 *   · requiresClient = true（全部画布工具 + 向用户确认）→ 走桥：发 tool_call 事件给浏览器，
 *     浏览器真的执行，再把结果 POST 回来（canvas-agent-bridge.ts）；
 *   · 其它 → 将来在服务端直接做（生成任务分派、剧本落库等）。
 *
 * 半自动的两个闸门（用户拍板的产品规则）：
 *   ① **花钱前**：任何会消耗积分的动作，必须先拿到用户点过「同意」的确认；
 *   ② **交付前**：覆盖/定稿类动作同样要确认。
 * 第 ① 条在服务端**硬拦**（beforeToolCall），不靠模型自觉 —— 提示词会被忽略，代码不会。
 */

export type CanvasAgentExecutionTask = RuntimeManagedTask;

/** 与前端约定的技能键（真源在 src/shared/canvas-agent-tools.ts），
 * `type: 'agent'` + `skill: CANVAS_AGENT_SKILL_KEY` 才会走到这条策略 */
export { CANVAS_AGENT_SKILL_KEY };

/** 单个客户端工具调用的默认等待上限（毫秒） */
const CLIENT_TOOL_TIMEOUT_MS = 60_000;
/**
 * 「向用户确认」要按人的节奏等：用户可能在读分镜表、也可能离开一会儿。
 * 10 分钟是刻意给足的（SSE 连接寿命 30 分钟，够）；超时后 Agent 会如实说「没等到答复」。
 */
const CONFIRMATION_TIMEOUT_MS = 600_000;

/** 单次任务的工具调用总次数上限：防止模型绕圈把积分和时间烧光 */
const MAX_TOOL_CALLS = 40;

/** 单次任务的整体时限（毫秒）。到点强制收口，不让任务无限挂着占 SSE 连接 */
const TASK_WALL_CLOCK_MS = 25 * 60_000;

/**
 * 控制台「当前任务」里的目标节点 id。
 *
 * 只从工具参数里取**显式给的节点 id**（id / node_id / nodeId）——不猜、不从批量里挑第一个。
 * 取不到就不给 target，宁可少显示一个字段，也不显示一个可能错的节点。
 */
const resolveConsoleTarget = (args: Record<string, unknown>): string => {
  const raw = args.id ?? args.node_id ?? args.nodeId;
  return typeof raw === "string" ? raw.trim() : "";
};

interface PersistState {
  lastPersistAt: number;
  lastPersistContentLength: number;
}

export interface CanvasAgentTaskExecutorContext {
  syncSharedTaskRuntime: (
    task: CanvasAgentExecutionTask,
    status: "running" | "completed",
  ) => Promise<void>;
  ensureTaskNotAborted: (task: CanvasAgentExecutionTask) => Promise<void>;
  resolveGatewayProviderUpstream: (input: {
    providerId?: string;
    endpointType?: "chat" | "image" | "image-edit" | "video";
    modelKey?: string;
  }) => Promise<{
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    modelCapabilityJson?: unknown;
  }>;
  emitTaskProgressEvent: (
    recordId: string,
    input: { stage: string; stopped?: boolean; message?: string },
  ) => void;
  emitTaskContentDeltaEvent: (
    recordId: string,
    input: { stage: string; delta: string; content: string },
  ) => void;
  emitTaskThinkingDeltaEvent: (
    recordId: string,
    input: { stage: string; thinkingDelta: string; thinkingContent: string },
  ) => void;
  emitTaskStreamEvent: (
    recordId: string,
    event: GenerationTaskStreamEvent,
  ) => void;
  persistAgentTaskContentIfNeeded: (
    input: {
      task: CanvasAgentExecutionTask;
      payload: GenerationTaskStartPayload;
      content: string;
      thinkingContent?: string;
      force?: boolean;
    },
    state: PersistState,
  ) => Promise<void>;
  /**
   * 取「同一会话 + 同一画布」上上一轮制片 Agent 的转录（不含本轮记录）。
   * 取不到返回 null，调用方退回 fallback 拼装路径（首次 / 旧数据 / 恢复失败都一样）。
   */
  loadCanvasAgentSession: (input: {
    userId: string;
    sessionId: string;
    canvasId: string;
    excludeRecordId: string;
  }) => Promise<CanvasAgentPersistedSession | null>;
  /** 把本轮转录写进 metaJson（只动 meta_json，不碰记录其余列与输出） */
  saveCanvasAgentSession: (input: {
    recordId: string;
    userId: string;
    session: CanvasAgentPersistedSession;
  }) => Promise<void>;
  buildInitialRecordPayload: (
    payload: GenerationTaskStartPayload,
  ) => GenerationRecordPayload;
  updateGenerationRecord: (
    recordId: string,
    payload: GenerationRecordPayload,
    currentUserId: string,
  ) => Promise<unknown>;
  getGenerationRecordById: (
    recordId: string,
    currentUserId: string,
  ) => Promise<Record<string, unknown>>;
  logGenerationTask: (stage: string, detail: Record<string, unknown>) => void;
  logGenerationTaskError: (
    stage: string,
    error: unknown,
    detail: Record<string, unknown>,
  ) => void;
}

/**
 * 预校验的配额检查埋点。
 *
 * 为什么必须落在服务端：客户端（浏览器）拿不到余额/预估时会**静默跳过**配额校验，
 * 而这件事只发生在浏览器里 —— 不埋点的话，服务端只看到「预校验通过」，完全不知道
 * 配额这一条规则其实没跑（这正是「闸门是死的」当初没被发现的根因）。
 * 客户端把结论挂在工具结果的 `details.quotaCheck` 上回执过来，这里翻译成两条稳定日志：
 *   · checked  → `preflight_quota_checked`（带 available / totalEstimated）
 *   · skipped  → `preflight_quota_check_skipped`（带 reason，例如 balance_api_error）
 */
const logPreflightQuotaTelemetry = (
  context: CanvasAgentTaskExecutorContext,
  task: CanvasAgentExecutionTask,
  result: { details?: Record<string, unknown> },
) => {
  const quotaCheck = result.details?.quotaCheck as CanvasPreflightQuotaCheck | undefined;
  const telemetry = describePreflightQuotaTelemetry(quotaCheck);
  if (!telemetry) return;
  context.logGenerationTask(telemetry.stage, {
    recordId: task.recordId,
    userId: task.userId,
    ...telemetry.detail,
  });
};

/**
 * 制片 Agent 的工作手册。
 *
 * 这段提示词是「从零到一干完一条片子」的方法论落地：Agent 不必自己发明流程，
 * 而是按这里写死的链路走（剧本 → 分镜表 → 母版 → 分镜图 → 分镜视频），
 * 每一步的产物都落在画布节点上，用户随时能看见、能改、能叫停。
 */
/**
 * 制片 Agent 的工作手册（M3 起覆盖「从剧本到成片」的完整链路）。
 *
 * 与 M2 那一版的区别：那时工具只有零散的画布操作，提示词只能泛泛说「按这个顺序推进」；
 * 现在有了 add_nodes / run_nodes / connect_nodes(links) / attach_reference_images，
 * 于是可以把**每一步用哪个工具、批量多少、在哪一步停下来要确认**写成可执行的流程。
 * 这也是「Agent 能不能真替用户干活」的关键：流程写在提示词里，工具负责执行。
 */
/**
 * 画布现状的承载标签。**位置是刻意的**：它只出现在**用户消息**的附注里，不在 system 提示里。
 */
export const CANVAS_AGENT_STATE_NOTICE_LABEL = "【画布现状·仅供参考】";

/**
 * 画布现状的承载位置：**本轮用户消息的附注**（不再是 system 提示里的独立段）。
 *
 * 真机事故（2026-09-26，同一会话同一画布 cmuhdcz010000jk92aicdlxlo 的三轮实测）：
 *   1. 用户说「记住两条设定：统一 21:9、水墨国风」，模型回「记住了」；
 *   2. 关页重开后再问「我刚才让你记住的两条设定是什么」，模型回的是画布上的
 *      「金毛寻回犬在草地上快乐奔跑……用文本输入驱动文生图节点生成画面」；
 *   3. 再问「刚才让你记住的**画幅比例**是多少？只回答那个数字」，模型回「16:9」（应为 21:9）。
 * 旁证把责任钉死在「信谁」而不是「信息在不在」：
 *   · 服务端日志 canvas_agent:session_restored {messageCount:2, dialogMessageCount:2} —— 第 2 轮确实拿到了第 1 轮那两句对话，管线没坏；
 *   · 同一个模型写的压缩摘要抓对了「统一使用 21:9 画幅；水墨国风」——信息在、摘要也对。
 * 16:9 与「金毛寻回犬」都来自**画布**（示例模板文本节点的内容 + 图片节点上的 ratio）：
 * 模型把 system 提示里的「画布现状」当成了用户设定，把真正的对话历史当成了背景。
 *
 * 为什么选「用户消息附注」（方案 1）而不是「留在 system、单独分区靠后」（方案 2）：
 *   · system 提示里同时睡着几千字的工作手册，画布现状与它同处权威位，权重自然最高 —— 这正是事故形态；
 *   · 附注进用户消息后，对话历史保持连续的 user/assistant 序列，模型回答「会话事实」时不会把一段状态当指令；
 *   · 方案 2 只降低权重、仍是「状态」与「用户消息」两条通道，模型仍可能拿状态覆盖历史。
 * 画布现状**依然完整可见**：节点数、节点内容、比例、模型、连线、选中项都在附注里，Agent 不会瞎。
 */
export const buildCanvasAgentCanvasStateNotice = (brief: string): string => {
  const text = String(brief || "").trim();
  if (!text) return "";
  return `\n\n${CANVAS_AGENT_STATE_NOTICE_LABEL}\n`
    + "（这是当前画布的**状态快照**，**不是用户的要求或设定**；其中的文字/比例/风格可能来自模板示例或旧内容。"
    + "用户问起之前定过的设定时以对话历史为准；若与对话历史冲突，按对话历史回答并说明。）\n"
    + text;
};

/**
 * 「信谁」的规则：放在 system 提示**最前**（注意力最高位），写下冲突时的裁决。
 *
 * 事故与证据见 buildCanvasAgentCanvasStateNotice 上方注释。这里额外把「最新一轮」写进规则，
 * 是因为画布现状现在随每轮用户消息附注更新，旧轮次的附注会随转录保留 —— 读最新那条才对。
 */
export const buildCanvasAgentPrioritySection = (): string => `# 信息优先级（冲突时以此为准，先读这一段）
- 用户问起「刚才说过的 / 让你记住的 / 我们之前定的」这类**会话事实**时，**只以对话历史为准**（含系统提示里的「# 会话摘要」）。
- 用户消息末尾的 ${CANVAS_AGENT_STATE_NOTICE_LABEL} 只是**当前画面与节点参数的状态快照**，**不是**用户的要求或设定：
  其中的文字、比例、风格可能来自模板示例或旧内容，**不代表用户说过什么**。
- 两者冲突时**以对话历史为准**，并在回答里说明你按哪条走（例：「你定的是 21:9，画布上那个节点现在是 16:9，要我改过来吗？」）。
- 只有**没有会话历史可依据时**（全新会话或用户从未提过），才采用画布上的当前取值。
- 画布现状随每轮更新，要参考时读**最新一条**用户消息末尾的附注。

`;

/**
 * 输出契约（2026-09-26，产品要求「大段纯文本看起来很累」）。
 *
 * 两件事：① 回复一律用 Markdown 组织（固定 `# ~ ####` 标题 / `-` 列表 / `**粗体**`，
 * 前端面板已按 Markdown 渲染，见 RightPanel.vue 的 `.agent-md`，复用 report-markdown-utils
 * 的自写渲染器，先 escape 再渲染）；② 涉及任务提交/批量/状态汇报时按固定结构输出，
 * 免得用户要在一坨散文里找积分与进度。
 *
 * 为什么积分**一律不许模型算**：积分是我们**提前前置**的（生成即预扣），数字只认
 * /api/points/estimate、余额接口与定价表；Agent 不需要算、也不允许报。实测确认卡上的
 * 「预计消耗」是模型心算的，**低估 3 倍**（写 2 分、实际 12 分）。
 */
export const CANVAS_AGENT_OUTPUT_CONTRACT = `# 输出契约
用 Markdown 组织回答（小标题 + 列表 + 加粗关键数字），**不要写大段散文**；积分 / 张数 / 节点数 / 时长一律列表化、不要埋进长句，一次回答控制在 ~20 行结构化内容以内。
状态标记统一口径（别把「待办」误读成「失败」）：✅ 已完成 / 🔄 生成中 / ⏳ 待提交 / ❌ 失败 / ⚠️ 风险或待定。
**决策口径**：用 \`ask_user\` 提**导演决策点** —— 先一句情境（你已完成什么、卡在哪两个方向），再给**最多 2 个方案**，每个方案写**代号 + 名称 + 2~3 条特点**（如 \`A 电影写实 · 克制 / 留白 / 长镜头\`）。**禁止**「需要补充一点信息」这类客服腔；闲聊式追问不算决策点。
**仅当这一轮涉及「任务提交 / 批量动作 / 状态汇报」时**，按下面固定顺序输出（闲聊、澄清、问答不要套这个模板，否则「你好」会变成一张空表）：
首行一句总览（一句话说明发生了什么）
### 📌 当前任务
### 📋 任务进度（逐节点列状态 + 一句话说明）
### 💰 积分明细（**只列服务端给的数字**：单条成本 / 账户余额 / 每个节点积分；必须写明「未提交节点不扣费、不会自动重试」；手里没有服务端数字就写「预扣积分（以实际扣费为准）」并逐节点列状态）
### 🎯 用户可选方案（最多 2 个，允许 0/1 个；有推荐时标【推荐】）
### 💡补充备注（只放风险 / 批量预估 / 前置提醒）
结尾固定一句：等待你的下一步指令。
**不要计算或报出任何积分数字**（包括「预计消耗」「大约 N 分」）。需要花钱的动作，只说：**会预扣积分，余额不足服务端会拦下，失败自动退还**；确有服务端数字时才引用（/api/points/estimate、余额接口、定价表）。
语气：客观陈述，**不道歉、不抒情、不复述工具名参数**。`

export const buildSystemPrompt = (input: { brief: string; summary?: string }) => {
  /**
   * 摘要挂在 system 提示里（权威位，每轮 rebuild），不再留在转录中当一条 user 消息。
   *
   * 真机事故（2026-09-26，记录 cmuhd62cn000q4k923m7vvhle）：库里存的摘要明明写着「统一 16:9 画幅、
   * 写实电影感」，问「第 1 轮让你记住的两条设定」，模型却回「我看不到第 1 轮的对话记录，因此无法确认」。
   * 根因是它当时是 role=user 的旧消息 —— 模型把它读成「用户以前说过的话」，一问「过去」就去转录里
   * 找原始对话，找不到就说看不到。放进 system 提示（模型当背景知识读）再配下面 # 纪律 的点名，
   * 摘要才会被当作历史来源采用。段落构造在 buildCanvasAgentSummarySystemSection，承载位置见
   * CANVAS_AGENT_SUMMARY_CARRIER 与落库日志。
   */
  const summarySection = buildCanvasAgentSummarySystemSection(input.summary || "");
  // 画布现状**不在这里**（见 buildCanvasAgentCanvasStateNotice）：system 只留一句指针，内容由用户消息附注承载。
  const hasCanvasBrief = String(input.brief || "").trim().length > 0;

  return `${buildCanvasAgentPrioritySection()}你是「制片 Agent」，在用户的节点式画布上替他干活：**从剧本出发做出可用的分镜成果**。
${summarySection}
# 第 0 步 · 先回应用户，再决定动不动手（对话优先）

**一轮的第一件事是回应用户**：闲聊/问答/澄清/出主意 → **直接用一两句中文回复，默认不读画布、不调任何工具**。

**要动手时先给「执行建议」再动手**：一句话说清打算做什么、动哪些节点、大概产出什么；用户没有异议就接着做，做完再汇报。

**读画布是按需动作，不是开场动作**：仅当 ① 用户明确指向画布或节点，或 ② 你要做的动作**必须知道画布现状**（连谁、改哪个节点、挂哪张图）才读。顺序：**先单节点 \`get_canvas_node(id)\` → 不够才 \`get_canvas_overview\` → 确需整张才 \`get_canvas_state\`**；id 只来自工具返回，不要编造。

**判断这轮是哪类活**：**成片生产**（短片/漫剧/广告片：剧本→分镜→母版→分镜图/视频）→ 动手前**先调 \`load_playbook\`** 取链路再走；**小活**（单张图、改图、只要分镜表或文案、整理画布、换模型重跑）→ 只做那几步，不套整条流水线、不建母版、**不要调 \`load_playbook\`**。

**该问就问，只走 \`ask_user\`（导演决策点）**：缺了**猜不出来**的关键信息（做什么产品/主题、产出是成片还是单张、多少镜头、给谁用），或做了一版、发现**两个方向都说得通**时，就提导演决策点（先一句情境，最多 2 个方案：代号 + 名称 + 2~3 条特点），一次问全（最多 3 问）；它在同一轮里等你回答，不算收尾汇报。**不要在正文里写问题 —— 正文里提问等于这一轮结束**：用户得再发一条才能答，一次委托就被拆成两轮。

**不要问、按默认值做**：画幅/画质/镜头数/时长这类**有常识默认值的偏好**直接用默认值做，在汇报里写明选了哪些；**问「要什么」，不问「喜欢哪种」** —— 但做完第一版、发现两个成型方向时，按输出契约提导演决策点让用户拍板。

# 纪律
- **一轮里连续做完，不要中途停下来汇报**：成片生产的第 1~10 步是**同一轮里的顺序动作**，不是 10 轮对话；只有 ① 等用户点 request_confirmation、② 等用户答 ask_user、③ 确实做不下去才可以中断。「先报个进度」对用户没有价值 —— 他点一次委托是想要成品。
- **付费 / 交付动作必须先取得同意**：触发任何生成（run_node / run_nodes）或覆盖、定稿、批量删除前**先调 \`request_confirmation\`**（写清规模；会预扣积分，**不要自己算积分**）；用户同意才继续，拒绝就换方案。服务端会硬拦没有确认的付费动作。
- **生成类工具是「提交即回执」**（run_node / run_nodes）：提交成功立刻返回「已提交 · 生成中」，出图/出片要几分钟，**不在这一轮等**。**不要用读取工具反复轮询等结果**；看节点结果就读一次 get_canvas_node(id)：generating 先做别的，error 如实汇报原文。
- 批量工具的上限：add_nodes ≤ 12 个/次、run_nodes ≤ 12 个/次、connect_nodes 的 links ≤ 40 条；要铺更多就分批，且**每一批都在确认里说清**。
- **不要用 get_canvas_state 代替 get_canvas_overview/get_canvas_node**：定位用概览、看细节读单节点，整张只在确实需要时才读（又贵又塞上下文）。
- 工具返回失败时读清原因：能改参数就改，改不了就如实告诉用户，**不要把失败讲成成功**；同一个失败调用不要反复重试（没有确认被拦下就去调 \`request_confirmation\`）。
- **会话历史以系统提示里的「会话摘要（较早内容）」为准**：较早的对话已被压缩进那一段（可能不在转录里）。用户问起之前定过的设定/做过的事/待办时，**必须依据摘要回答，绝不要说「我看不到更早的对话记录」**—— 信息明明在，看到摘要就直接用它回答。

${CANVAS_AGENT_OUTPUT_CONTRACT}

${hasCanvasBrief ? `\n# 画布现状\n画布现状**不在本系统提示里**，而在**用户消息末尾**的 ${CANVAS_AGENT_STATE_NOTICE_LABEL} 附注里（随每轮更新，读最新一条）。需要时读它，但它只是**状态**、不是用户的设定。` : ""}`;
};

/**
 * 用户这一轮附的参考图。
 *
 * 必须显式告诉 Agent —— 它看不见浏览器里上传了什么。不说的话，用户附了图、Agent 却当没有，
 * 于是它要么凭空生成（图白附了），要么反问用户「你要我参考什么」。
 * 顺带把「用哪个工具」一起点名，省得它去猜。
 */
const buildReferenceNotice = (
  requestBody: Record<string, unknown> | null | undefined,
) => {
  const referenceImages = Array.isArray(requestBody?.referenceImages)
    ? (requestBody?.referenceImages as unknown[]).filter((item) => typeof item === "string" && item)
    : []
  return referenceImages.length
    ? `\n\n【用户本轮附了 ${referenceImages.length} 张参考图】`
      + "需要用到它们时，用 attach_reference_images 把图挂到对应的图片节点上（默认就是取这几张），"
      + "再用 run_node 执行该节点 —— 挂上图之后那次生成会走图生图。不要假装用了图。"
    : ""
}

/**
 * 本轮执行要求 + 画布现状附注（都贴在用户消息里）。
 * 恢复会话时直接用这个拼「用户消息 + 执行要求 + 画布现状」；没有转录可恢复时，`buildPromptWithHistory` 再在其前拼历史。
 *
 * 画布现状为什么放在这里（而不是 system 提示里）：见 buildCanvasAgentCanvasStateNotice 上方的事故记录 ——
 * 放在 system 权威位时模型拿它覆盖了用户设定。放到用户消息里、并显式标注「仅供参考、不是设定」，
 * 既保持对话历史是连续的 user/assistant 序列，又确保 Agent 仍看得到画布（节点、比例、连线都在）。
 */
export const buildPromptWithExecutionDemand = (
  prompt: string,
  requestBody: Record<string, unknown> | null | undefined,
) => {
  const referenceNotice = buildReferenceNotice(requestBody)
  const canvasStateNotice = buildCanvasAgentCanvasStateNotice(
    String((requestBody || {}).canvasBrief || ""),
  )

  /**
   * 执行要求贴在**用户消息**里，而不是只写在系统提示里。
   *
   * 实测教训：把「一轮里连续做完」放在几千字的系统提示中间时，模型经常读不到那么深 ——
   * 它会以「已完成前置拆解，下一步将生成母版图…」收尾汇报，把一次委托拆成好几次。
   * 用户点一次委托是想要成品，不是想看你分几次汇报。贴在用户消息末尾（模型注意力最强处）
   * 才真正管用。
   * 提问口径也要一并写清：早年那句笼统的「不确定就先问」直接诱导它建完母版就收尾等回答。
   * 现在是分档的 —— 目标/产物/规模这类猜不出来的用 ask_user 问（自带等待，不算收尾），
   * 风格/画幅/张数这类有常识默认值的偏好转默认值做并在汇报里说明。
   * 对话优先也贴在这里：实测里模型对「你好」这类消息的第一件事是 get_canvas_overview ——
   * 把「先回应用户、默认不读画布」放在用户消息里，比只写进 system 更靠前地被读到。
   */
  const executionDemand =
    "\n\n【本轮执行要求】**先回应用户**：闲聊、问答、澄清、出主意 → 直接回复，默认不读画布、不调任何工具。"
    + "要动手时先给一句「执行建议」（打算怎么做、动哪些节点、大概产出什么）再调工具；"
    + "先判断这是成片生产还是小活：小活直接做完，不要套母版/分镜那整条流水线。"
    + "目标、产物、规模这类**猜不出来**的信息缺了，就调 ask_user 问清楚再动手（它会在同一轮里等用户回答，不算收尾汇报）；"
    + "需要用户拍板的方案选择也用 ask_user 提「导演决策点」：先一句情境（你已完成什么、卡在哪），再给最多 2 个方案（代号 + 名称 + 2~3 条特点）；"
    + "**禁止**「需要补充一点信息」这类客服腔；"
    + "**提问必须调 ask_user 工具，不要写在正文里** —— 正文里提问等于这一轮结束，用户得再发一条消息才能答，"
    + "而工具问会在同一轮里等到答复继续做。"
    + "风格/画幅/张数这类有常识默认值的偏好不要问，用默认值做并在最后汇报里说明你选了哪些默认值。"
    + "除了 ask_user 与 request_confirmation 这两种自带等待的工具，以及确实做不下去（工具持续失败），不要中途停下来汇报；做完再一次性汇报。"
    + "**生成类是「提交即回执」**：run_node/run_nodes 提交成功就返回（回执写「已提交 · 生成中」），出图要几分钟，"
    + "**不要用读取工具反复轮询等结果** —— 提交完继续做下一步；要看结果就读一次单节点（get_canvas_node），"
    + "还是 generating 就先做别的。读画布按需：需要时先单节点 get_canvas_node，再概览 get_canvas_overview，别用 get_canvas_state 整张读。"

  return `${prompt}${referenceNotice}${canvasStateNotice}${executionDemand}`;
};

/**
 * 没有可恢复的转录时，把面板历史并进本轮用户消息（**兜底路径**）。
 *
 * 这条路径只在「首次 / 旧数据 / 恢复失败 / 拿不到画布 id」时走。它当年是主路径，
 * 现在退居兜底 —— 有转录可恢复时由 `executeCanvasAgentTaskFlow` 直接恢复 Pi 转录，
 * 连历史都不用再拼。历史条数不再固定砍 6/8 条、单条也不再砍 500 字，
 * 由 `selectCanvasAgentFallbackHistory` 按总字符预算取最近的若干条。
 */
export const buildPromptWithHistory = (
  prompt: string,
  requestBody: Record<string, unknown> | null | undefined,
) => {
  const tail = buildPromptWithExecutionDemand(prompt, requestBody);
  const lines = selectCanvasAgentFallbackHistory(requestBody?.history).map(
    (item) => `${item.role === "user" ? "用户" : "你"}：${item.content}`,
  );

  if (!lines.length) {
    return tail;
  }
  return `（以下是本轮之前我们说过的话，供你保持连贯，不必复述）\n${lines.join("\n")}\n\n【用户现在的要求】\n${tail}`;
};

/**
 * 会话摘要指令（主动压缩用，2026-09-26）。
 *
 * 三段式是刻意定的形状：用户偏好/已确定设定、已完成的事、待办/未决问题 ——
 * 这正是「多轮之后最不该丢」的东西。摘要会以 `[会话摘要]` 前缀的 user 消息长期携带，
 * 所以要求它**尽量短、只写对后续有用的**，不写工具名与参数细节。
 */
const CANVAS_AGENT_SUMMARY_INSTRUCTION = `你在为一个「制片 Agent」压缩它较早的一段历史会话，供后续轮次继续工作。

把下面这段对话压成一份结构化摘要，用中文，尽量短，只保留对后续有用的信息，严格按三段输出（某段没有内容就写「无」）：
1. 用户偏好 / 已确定的设定：画幅、比例、风格、角色外观与名字、品牌、命名、明确的「不要」；
2. 已完成的事：生成了什么、落在哪些画布节点（写节点 id 或名称）、关键参数与结论；
3. 待办 / 未决问题：还没做的、在等用户确认的、失败待重试的。

不要编造原文没有的信息，不要复述工具名和参数细节，直接给摘要正文，不要加标题以外的寒暄。`;

export const executeCanvasAgentTaskFlow = async (
  task: CanvasAgentExecutionTask,
  payload: GenerationTaskStartPayload,
  context: CanvasAgentTaskExecutorContext,
) => {
  await context.syncSharedTaskRuntime(task, "running");
  await context.ensureTaskNotAborted(task);

  const modelKey = String(payload.modelKey || "").trim();
  if (!modelKey) {
    throw new Error("缺少对话模型标识");
  }
  // 本轮用户输入要在创建 Agent **之前**就拿到：思考档位由它决定（见 canvas-agent-thinking）。
  // 只判「本轮新说的这句」，不带历史 —— 历史在转录里，档位要跟的是当下这一轮的活。
  const userPrompt = String(payload.prompt || "").trim();
  const providerId = String(
    (payload.requestBody || {}).providerId || "",
  ).trim();
  if (!providerId) {
    throw new Error("未匹配到后台模型配置，请先在后台配置可用模型");
  }

  const upstream = await context.resolveGatewayProviderUpstream({
    providerId,
    endpointType: "chat",
    modelKey,
  });
  const upstreamUrl = `${upstream.baseUrl.replace(/\/+$/, "")}/${upstream.endpoint.replace(/^\/+/, "")}`;

  // 思考预算分档（2026-09-26）：先按本轮用户输入判「这轮该想多少」。
  // 基准档取自意图；出现工具调用后允许在同一轮里升一档（见下面的 escalation）。
  const baseThinkingLevel = resolveCanvasAgentThinkingLevel(userPrompt);
  const escalatedThinkingLevel = escalateCanvasAgentThinkingLevel(baseThinkingLevel, true);
  // 档位 → 上游思考字段：只认模型能力声明里配过的档位，其它档位对本模型不生效（见 canvas-agent-thinking）。
  const reasoningFieldsByLevel = resolveCanvasAgentReasoningFields(
    upstream.modelCapabilityJson,
  );
  context.emitTaskProgressEvent(task.recordId, {
    stage: "resolved_provider",
    message: "已解析模型配置，制片 Agent 开始工作",
  });

  let fullText = "";
  let fullThinking = "";
  const persistState: PersistState = {
    lastPersistAt: Date.now(),
    lastPersistContentLength: 0,
  };
  const guard = createSpendGuard();
  let toolCallCount = 0;

  /**
   * 导演控制台（AI Director Console · 批次 1）。
   *
   * 这里只做一件事：把 Pi 的真实事件与工具回执攒成事件序列，交给纯函数推导快照，
   * 再**只通过 SSE** 推给面板（`console_state`）。要点：
   *   · 快照**不写进转录**、也不进模型上下文 —— 模型侧只看得到对话与工具结果，控制台是纯 UI；
   *   · 状态由事件推导，模型自报的数字一律不参与（`progress` 只认批量回执里的真实分母）；
   *   · 阶段高水位随会话（metaJson）持久化，跨轮「只增不减」。
   */
  const consoleEvents: CanvasAgentConsoleEvent[] = [];
  let consoleSeed: CanvasAgentConsoleSessionMemory | undefined;
  let consoleMemory: CanvasAgentConsoleSessionMemory | undefined;
  const consoleProjectName = String(
    (payload.requestBody as Record<string, unknown> | null | undefined)?.canvasName || "",
  ).trim();

  const emitConsoleState = () => {
    const { state, memory } = deriveCanvasAgentConsole(consoleEvents, {
      project: consoleProjectName,
      // 本轮实际使用的模型：工作流卡片「输入」的一项（运行时事实，不由模型自报）
      model: modelKey,
      seed: consoleSeed,
    });
    consoleMemory = memory;
    context.emitTaskStreamEvent(
      task.recordId,
      buildCanvasAgentConsoleStreamEvent(task.recordId, state),
    );
  };

  const pushConsoleEvent = (event: CanvasAgentConsoleEvent) => {
    consoleEvents.push(event);
    emitConsoleState();
  };

  const appendText = (chunk: string) => {
    if (!chunk) return;
    fullText += chunk;
    context.emitTaskContentDeltaEvent(task.recordId, {
      stage: "agent_running",
      delta: chunk,
      content: fullText,
    });
  };

  const streamFn = createGatewayStreamFn({
    upstreamUrl,
    apiKey: upstream.apiKey,
    modelKey,
    signal: task.abortController.signal,
    // 把意图档位对应的思考字段带进网关：不传的话 Pi 的 thinkingLevel 在自建网关上完全无效
    reasoningFieldsByLevel,
    onTextDelta: (delta) => {
      appendText(delta);
      void context
        .persistAgentTaskContentIfNeeded(
          { task, payload, content: fullText, thinkingContent: fullThinking },
          persistState,
        )
        .catch(() => {
          // 节流持久化失败不该打断 Agent：真正的写库在收尾时还会再做一次
        });
    },
    onThinkingDelta: (delta) => {
      fullThinking += delta;
      context.emitTaskThinkingDeltaEvent(task.recordId, {
        stage: "agent_thinking",
        thinkingDelta: delta,
        thinkingContent: fullThinking,
      });
    },
    onRequest: (detail) => {
      context.logGenerationTask("canvas_agent:gateway_request", {
        recordId: task.recordId,
        userId: task.userId,
        modelKey,
        messageCount: detail.messageCount,
        toolCount: detail.toolCount,
        roles: detail.roles,
        // 思考预算的验收证据：档位有没有下发、有没有落成上游字段、Pi 有没有带上缓存会话 id
        thinkingLevel: detail.thinkingLevel,
        injectedReasoningFields: detail.injectedReasoningFields,
        sessionId: detail.sessionId,
      });
    },
  });

  /** 把共享定义包成 Pi 的 AgentTool：参数直接用共享 JSON Schema（Type.Unsafe 不做运行时校验，避免两套 schema 打架） */
  const buildAgentTools = (): AgentTool[] =>
    CANVAS_AGENT_TOOL_DEFINITIONS.map((definition) => {
      const timeoutMs =
        // 这两个工具都在等人（用户读分镜表、离开一会儿都可能）—— 用默认的 60 秒会把
        // 「还在思考的用户」误判成超时，于是任务早早收口，用户点提交时已经没人收答复了。
        definition.name === "request_confirmation" || definition.name === "ask_user"
          ? CONFIRMATION_TIMEOUT_MS
          : CLIENT_TOOL_TIMEOUT_MS;

      return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: Type.Unsafe<Record<string, unknown>>(
          definition.parameters as never,
        ),
        execute: async (
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal,
        ) => {
          toolCallCount += 1;
          const args = (params || {}) as Record<string, unknown>;
          /**
           * 每次工具执行都留痕。
           *
           * 这是排查 Agent 行为的第一手证据：模型到底调了什么、调了几次、参数是什么。
           * 「界面只显示 3 步、服务端却执行了 6 次」这种不一致，只有对着这条日志才分得清
           * 是前端漏展示、还是模型真的重复调用。
           */
          context.logGenerationTask("canvas_agent:tool_call", {
            recordId: task.recordId,
            userId: task.userId,
            index: toolCallCount,
            toolName: definition.name,
            callId: toolCallId,
            args: JSON.stringify(args).slice(0, 300),
          });

          // 控制台：工具开始（真实事件，非模型自报）——目标节点 id 只来自参数，不做推断
          const consoleTarget = resolveConsoleTarget(args);
          /**
           * 画布动作计数：只有 request_confirmation 的逐条事项是**可信的目标声明**出处
           * （见 parseDeclaredCanvasTarget 注释），从这里解析出「24 个镜头」之类的目标总数。
           */
          const declaredTarget = definition.name === "request_confirmation"
            ? parseDeclaredCanvasTarget(
                Array.isArray(args.items) ? args.items.map((item) => String(item || "")) : [],
              )
            : undefined;
          /**
           * 工作流卡片的「输入」事实：load_playbook 取的是哪本手册。
           * 名称取自工具入参（空则用默认 storyboard-production，与 resolveCanvasAgentPlaybook 一致）——
           * 只给界面看，不进模型上下文。
           */
          const playbookName = definition.name === "load_playbook"
            ? String(args.name || "storyboard-production").trim()
            : "";
          pushConsoleEvent({
            type: "tool_start",
            toolName: definition.name,
            callId: toolCallId,
            ...(consoleTarget ? { target: consoleTarget } : {}),
            ...(declaredTarget ? { declaredTarget } : {}),
            ...(playbookName ? { playbookName } : {}),
          });

          if (!definition.requiresClient) {
            /**
             * 纯服务端工具：在服务端直接产出结果，不走浏览器桥。
             *
             * `load_playbook` 是第一个用上这条路径的工具（提示词瘦身）：手册正文就在服务端内存里，
             * 与画布状态无关 —— 走桥只会多一次浏览器往返，还可能因前端没实现这个 case 而失败。
             */
            let text = `工具「${definition.name}」尚未实现`;
            let serverToolOk = false;
            if (definition.name === "load_playbook") {
              const playbook = resolveCanvasAgentPlaybook(
                args.name ? String(args.name) : undefined,
              );
              text = playbook
                ?? `没有这个手册主题：${String(args.name || "")}（目前只有 storyboard-production）`;
              serverToolOk = Boolean(playbook);
            }
            pushConsoleEvent({
              type: "tool_end",
              toolName: definition.name,
              callId: toolCallId,
              ok: serverToolOk,
              summary: serverToolOk ? "已加载工作手册" : text,
            });
            return {
              content: [{ type: "text" as const, text }],
              details: {},
            };
          }

          context.emitTaskProgressEvent(task.recordId, {
            stage: "agent_tool_call",
            message: `Agent 正在执行：${definition.label}`,
          });

          context.emitTaskStreamEvent(task.recordId, {
            type: "tool_call",
            recordId: task.recordId,
            done: false,
            stage: "agent_tool_call",
            message: `等待浏览器执行 ${definition.name}`,
            agentToolCall: {
              callId: toolCallId,
              name: definition.name,
              args,
              label: definition.label,
              timeoutMs,
            },
          });

          const result = await waitForClientToolResult({
            recordId: task.recordId,
            callId: toolCallId,
            toolName: definition.name,
            timeoutMs,
            signal,
          });

          // 预校验的配额检查结论回执过来时落服务端日志：闸门到底有没有生效，服务端必须看得见
          if (definition.name === "preflight_check") {
            logPreflightQuotaTelemetry(context, task, result);
          }

          context.logGenerationTask("canvas_agent:tool_result", {
            recordId: task.recordId,
            userId: task.userId,
            toolName: definition.name,
            callId: toolCallId,
            ok: result.ok,
            summary: String(result.summary || "").slice(0, 120),
          });

          context.emitTaskStreamEvent(task.recordId, {
            type: "tool_result",
            recordId: task.recordId,
            done: false,
            stage: "agent_tool_result",
            message: result.summary || `已执行 ${definition.name}`,
            agentToolResult: result,
          });

          // 控制台：工具结束。摘要与回执都取自真实结果 —— 批量工具（add_nodes / run_nodes）
          // 的 done/total 也从这里拿到，绝不编造分母。
          pushConsoleEvent({
            type: "tool_end",
            toolName: definition.name,
            callId: toolCallId,
            ok: result.ok,
            summary: String(result.summary || ""),
            resultText: result.result,
            ...(declaredTarget ? { declaredTarget } : {}),
          });

          return {
            content: [{ type: "text" as const, text: result.result }],
            details: result.details || {},
          };
        },
      } satisfies AgentTool;
    });

  const wallClockTimer = setTimeout(() => {
    context.logGenerationTaskError(
      "canvas_agent:wall_clock_exceeded",
      new Error("制片 Agent 超过单次任务时限"),
      { recordId: task.recordId, userId: task.userId },
    );
    task.abortController.abort("user_stop");
  }, TASK_WALL_CLOCK_MS);

  /**
   * 会话恢复（跨轮记忆的入口）。
   *
   * 取「同一会话 + 同一画布」上上一轮的转录，塞进 `initialState.messages` —— 这样 Pi 一上来就带着
   * 上一轮的工具调用与结果，不必靠自己反复读画布去重建上下文（实测旧路径它一轮读了 39 次画布）。
   * 键必须是 **sessionId + 画布 id**：助手会话在浏览器里是全局的（不随画布切换），
   * 只用 sessionId 会让 A 画布的记忆串到 B 画布；拿不到画布 id（未保存的画布 / 没取到锁）时不恢复，
   * 退回 fallback 拼装路径 —— 宁可少带记忆，也不串台。
   */
  const sessionId = String(payload.sessionId || "").trim();
  const canvasId = resolveCanvasAgentCanvasId(payload.requestBody);
  let previousSession: CanvasAgentPersistedSession | null = null;
  if (canvasId && sessionId) {
    try {
      previousSession = await context.loadCanvasAgentSession({
        userId: task.userId,
        sessionId,
        canvasId,
        excludeRecordId: task.recordId,
      });
    } catch (error) {
      // 恢复失败不该让整轮 Agent 挂掉：拿不到就退回 fallback，本轮照常跑
      context.logGenerationTaskError("canvas_agent:session_restore_failed", error, {
        recordId: task.recordId,
        userId: task.userId,
        canvasId,
      });
    }
  }
  const sessionBootstrap = resolveCanvasAgentSessionBootstrap({
    requestBody: payload.requestBody,
    sessionId,
    previousSession,
  });

  // 控制台的阶段高水位从上一轮恢复：只有画布 id 与会话 id 都对上（previousSession 已按此校验）才拿。
  // 拿不到就从 script 起算 —— 宁可重来，也不把别的画布/会话的阶段串过来。
  if (canvasId && sessionId && previousSession) {
    consoleSeed = previousSession.console;
  }

  /**
   * 恢复出来的转录要**拆成两半**用：
   *   · 会话摘要 → 注入本轮 system 提示（权威位，见 buildSystemPrompt；不再作为 user 消息喂给模型）；
   *   · 其余对话 → 进入 `initialState.messages` 当会话转录。
   * 摘要仍以「消息」的形态存在库里（metaJson 里看得出、旧格式读得回），只是在**喂给模型前**被摘出来
   * 换了个更权威的承载位置。落库时还会把它再拼回压缩输入的最前面，保住「旧摘要 + 中间段 → 新摘要」的累积。
   */
  const restoredContext = sessionBootstrap.source === "session"
    ? buildCanvasAgentRestoredContext(sessionBootstrap.restoredMessages)
    : { summaryText: "", summaryMessage: null, messages: [] as unknown[] };
  if (sessionBootstrap.source === "session") {
    context.logGenerationTask("canvas_agent:session_restored", {
      recordId: task.recordId,
      userId: task.userId,
      canvasId: sessionBootstrap.canvasId,
      messageCount: sessionBootstrap.restoredMessages.length,
      // 摘要被摘去 system 提示、只留对话进转录：两个数都打出来，否则「摘要丢了」还是「换了位置」分不清
      dialogMessageCount: restoredContext.messages.length,
      summaryChars: restoredContext.summaryText.length,
      summaryCarrier: CANVAS_AGENT_SUMMARY_CARRIER,
    });
  }

  /**
   * 传给 Pi 的会话 id（**provider 缓存**用）。键法与会话恢复完全一致：会话 id + 画布 id。
   * 详见 buildCanvasAgentProviderSessionId —— 只传会话 id 会让不同画布命中同一份缓存路由。
   */
  const providerSessionId = buildCanvasAgentProviderSessionId(sessionId, canvasId);
  context.logGenerationTask("canvas_agent:thinking_level", {
    recordId: task.recordId,
    userId: task.userId,
    // 基准档与升档目标都记下来：「这一轮为什么这么快/这么慢」以此为准
    baseThinkingLevel,
    escalatedThinkingLevel,
    promptChars: userPrompt.length,
    // 档位落到哪些上游字段（空串 = 该模型没声明对应档位，思考预算对它不生效）
    reasoningFields: Object.keys(reasoningFieldsByLevel).join(","),
    thinkingBudgets: JSON.stringify(CANVAS_AGENT_THINKING_BUDGETS),
    providerSessionId,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        // 这里只用于决定「要不要给画布现状指针」；画布现状的**内容**改由用户消息的附注承载
        //（放 system 权威位会让模型拿它覆盖对话历史，见 buildCanvasAgentCanvasStateNotice）。
        brief: String((payload.requestBody || {}).canvasBrief || "").trim(),
        summary: restoredContext.summaryText,
      }),
      tools: buildAgentTools(),
      // 思考预算分档：闲聊最快、问答/小活默认、成片生产才认真想（见 canvas-agent-thinking）。
      // 不设的话 Pi 用 "off"，模型思考时长完全不受我们控制 —— 这正是「一句话也要 15~31 秒」的原因。
      thinkingLevel: baseThinkingLevel,
      // 恢复转录时**只给非 system 消息**：若保留旧 system 头，Pi 会把它当成会话自带系统提示，
      // 本轮新的 systemPrompt（含最新画布摘要）反而不生效（agent.js: messages[0] 已是 system 就不再插入）。
      ...(restoredContext.messages.length
        ? { messages: restoredContext.messages as AgentMessage[] }
        : {}),
    },
    streamFn,
    // Pi 的原生 `sessionId`：README 写明用于 provider 缓存。我们按「会话 id + 画布 id」传，
    // 但**是否真的生效取决于上游**——见本文件 createGatewayStreamFn 处的说明（当前仅记录、未转发）。
    ...(providerSessionId ? { sessionId: providerSessionId } : {}),
    // 按 token 计费的 provider 才用得上；当前网关未映射 token 预算字段，透传以保 Pi 语义完整。
    thinkingBudgets: CANVAS_AGENT_THINKING_BUDGETS,
    /**
     * 上下文兜底裁剪（Pi 的 `transformContext` 挂点）。
     *
     * 为什么这里**只裁不压**：这个挂点每次模型请求都会跑，若在这里做「摘要调用」，
     * 就变成每请求一次额外模型调用 —— 成本与延迟都不可接受。主动压缩放在落库时（每轮最多一次）。
     * 这里只防「单轮内转录涨过预算把上游撑爆」，是兜底而非主路径。
     * 必须保留头部 system 消息：它带着工作手册与工具声明，被裁掉模型就瞎了（见 trimTranscriptToBudgetPreservingSystem）。
     * 契约要求不抛错：出问题就原样返回。
     */
    transformContext: async (messages) => {
      try {
        return trimTranscriptToBudgetPreservingSystem(
          messages,
          CANVAS_AGENT_TRANSCRIPT_CHAR_BUDGET,
        ) as AgentMessage[];
      } catch {
        return messages;
      }
    },
    beforeToolCall: async (hookContext) => {
      const toolName = String(hookContext.toolCall.name || "");

      if (toolCallCount >= MAX_TOOL_CALLS) {
        return {
          block: true,
          terminate: true,
          reason: `本次任务已执行 ${MAX_TOOL_CALLS} 次工具调用，达到上限。请把当前进展汇报给用户，由他决定是否继续。`,
        };
      }

      context.logGenerationTask("canvas_agent:before_tool_call", {
        recordId: task.recordId,
        userId: task.userId,
        toolName,
        callId: String(hookContext.toolCall.id || ""),
        executedSoFar: toolCallCount,
      });

      const spendCheck = guard.check(toolName);
      if (spendCheck.blocked) {
        context.logGenerationTask("canvas_agent:spend_blocked", {
          recordId: task.recordId,
          userId: task.userId,
          toolName,
        });
        return { block: true, reason: spendCheck.reason };
      }

      return undefined;
    },
    afterToolCall: async (hookContext) => {
      // request_confirmation 的结果决定后续付费动作是否放行 —— 这是半自动闸门的落点
      if (String(hookContext.toolCall.name || "") !== "request_confirmation") {
        return undefined;
      }
      const rawText = Array.isArray(hookContext.result?.content)
        ? hookContext.result.content
            .map((part: { type?: string; text?: string }) =>
              part?.type === "text" ? String(part.text || "") : "",
            )
            .join("\n")
        : "";
      if (JSON.parse(rawText || "null")?.approved === true) {
        guard.markApproved(String(hookContext.toolCall.id || ""));
        context.logGenerationTask("canvas_agent:spend_approved", {
          recordId: task.recordId,
          userId: task.userId,
          callId: String(hookContext.toolCall.id || ""),
        });
      }
      return undefined;
    },
  });

  /**
   * Agent 生命周期留痕。
   *
   * 这几条日志是排查「Agent 跑完一遍又从头跑一遍」这类问题的唯一抓手：
   * 只看网关请求数（+2 条消息 / 轮）分不清「模型又调了工具」还是「Pi 自己多跑了一轮」，
   * 而 `message_end` 里带着这一轮**到底产出了什么**（文本？工具调用？几个？）。
   */
  // 同一轮内只升一次档（升一档、封顶 medium），已经升过就不再动 —— 反复改档会让思考开销来回抖。
  let thinkingEscalated = false;
  agent.subscribe((event) => {
    // 导演控制台：生命周期从 Pi 的真实事件推导（不由模型自报）
    if (event.type === "agent_start") {
      pushConsoleEvent({ type: "agent_start" });
      return;
    }
    if (event.type === "turn_start") {
      pushConsoleEvent({ type: "turn_start" });
      return;
    }
    if (event.type === "agent_end") {
      pushConsoleEvent({ type: "agent_end" });
      return;
    }
    if (event.type === "tool_execution_start") {
      context.emitTaskProgressEvent(task.recordId, {
        stage: "agent_tool_start",
        message: `执行工具 ${event.toolName}`,
      });
      return;
    }
    if (event.type === "message_end") {
      const message = event.message as {
        role?: string;
        content?: unknown;
        stopReason?: string;
      };
      if (message?.role === "assistant") {
        const parts = Array.isArray(message.content) ? message.content : [];
        context.logGenerationTask("canvas_agent:assistant_message", {
          recordId: task.recordId,
          userId: task.userId,
          stopReason: message.stopReason || "",
          // 失败原因必须记下来：否则上游 502 / 超时 全都只表现为「没有产出任何内容」，
          // 排查时完全看不出是通道挂了还是模型不肯说话
          errorMessage: String((message as { errorMessage?: string }).errorMessage || "").slice(0, 300),
          partTypes: parts
            .map((part) => (part as { type?: string }).type || "?")
            .join(","),
          toolNames: parts
            .filter((part) => (part as { type?: string }).type === "toolCall")
            .map((part) => String((part as { name?: string }).name || ""))
            .join(","),
          textLength: parts
            .filter((part) => (part as { type?: string }).type === "text")
            .map(
              (part) => String((part as { text?: string }).text || "").length,
            )
            .reduce((a, b) => a + b, 0),
        });

        /**
         * 运行中升档：本轮一旦出现工具调用，说明模型真的决定动手了 —— 这不再是闲聊。
         *
         * Pi 支持中途改 `agent.state.thinkingLevel`（agent.js 每次请求都从 state 现读），
         * 所以这里改完，**同一轮**下一次请求就生效。只升一档、只升一次：
         * 升多了思考开销会来回抖，与省时间的目标相悖（见 escalateCanvasAgentThinkingLevel）。
         */
        const hasToolCall = parts.some(
          (part) => (part as { type?: string }).type === "toolCall",
        );
        if (hasToolCall && !thinkingEscalated) {
          thinkingEscalated = true;
          if (escalatedThinkingLevel !== baseThinkingLevel) {
            agent.state.thinkingLevel = escalatedThinkingLevel;
            context.logGenerationTask("canvas_agent:thinking_escalated", {
              recordId: task.recordId,
              userId: task.userId,
              from: baseThinkingLevel,
              to: escalatedThinkingLevel,
            });
          }
        }

        // 控制台：只有文本、没有工具调用的 assistant 消息 = 收尾汇报（生命周期 delivering；
        // 生成过东西时阶段推进到交付）。带工具调用的那条不算汇报。
        const hasReportText = parts.some(
          (part) => (part as { type?: string }).type === "text"
            && String((part as { text?: string }).text || "").trim().length > 0,
        );
        if (hasReportText && !hasToolCall) {
          pushConsoleEvent({ type: "assistant_message" });
        }
      }
      return;
    }
    if (event.type === "turn_end") {
      context.logGenerationTask("canvas_agent:turn_end", {
        recordId: task.recordId,
        userId: task.userId,
        toolResultCount: Array.isArray(event.toolResults)
          ? event.toolResults.length
          : 0,
      });
    }
  });

  context.emitTaskProgressEvent(task.recordId, {
    stage: "agent_running",
    message: "制片 Agent 已开始工作",
  });

  try {
    if (!userPrompt) {
      throw new Error("缺少要交给 Agent 的任务描述");
    }

    /**
     * 只调一次 prompt。
     *
     * 这里曾经连着写了两行 `agent.prompt(...)`（改历史拼装那段时留下的残句），
     * 后果是**整条任务被完整跑两遍**：模型把「读画布 → 加节点 → 选中」做两次，
     * 一次请求加出来两个节点，答复里同一句话出现两遍。而且它不报任何错 ——
     * 只有把每一轮发给上游的消息角色打出来，才能看到结尾多出一条 user。
     *
     * 有转录可恢复时，历史已经在那条转录里，本轮只发「用户消息 + 执行要求」；
     * 走到 fallback（无转录）时才把面板历史拼回用户消息里。
     */
    const promptText = sessionBootstrap.source === "session"
      ? buildPromptWithExecutionDemand(userPrompt, payload.requestBody)
      : buildPromptWithHistory(userPrompt, payload.requestBody);
    await agent.prompt(promptText);
    await agent.waitForIdle?.();
  } finally {
    clearTimeout(wallClockTimer);
    // 任务结束（正常/异常/停止）都要把还在等的客户端调用清掉，否则 Promise 会一直挂着
    cancelPendingClientToolCalls(
      task.recordId,
      "任务已结束，未完成的客户端工具调用被取消",
    );
  }

  /**
   * 把本轮转录落库，供下一轮恢复。
   *
   * 放在这里（Agent 循环结束之后、终态写入之前）是有意的：
   *   · 无论本轮是成功还是「模型没产出」，转录都已经产生，尽早存下来，下一轮才有记忆；
   *   · 随后成功路径的 `updateGenerationRecord` 会 merge 已有 metaJson，这个键不会被覆盖；
   *   · 失败路径由策略层收口，同样只 merge metaJson，也不会把它清掉。
   * 只写 meta_json 一个字段（见 saveCanvasAgentSession），不碰内容/输出/状态。
   *
   * **主动压缩就落在这一步（落库之前）**，理由：
   *   · 存下来的转录本身就有界，下一轮恢复出来已经是紧凑的，不必在「用户等回答」的路径上多花一次模型调用；
   *   · 恢复路径保持纯读取（readCanvasAgentSession 是同步纯函数），压缩不掺进去，逻辑可单测；
   *   · 每完成一轮才可能超预算，这是压缩唯一的自然时机（每轮最多压一次，不会每请求一份摘要调用）。
   * 失败的兜底另有一处：Pi 的 `transformContext`（见 Agent 构造处），它**只裁剪、不再调模型**。
   */
  if (sessionBootstrap.canvasId && sessionId) {
    try {
      /**
       * 旧摘要在喂模型前已被摘走（改挂 system 提示，见 restoredContext），落库压缩时必须把它拼回最前面：
       * planCanvasAgentCompaction 的待压段从第 0 条起切，只有旧摘要在场，span 才会含它，
       * 才成立「旧摘要 + 中间段 → 新摘要」的累积；否则第二次压缩就只剩中间段、把之前的结论丢掉。
       */
      const messagesForCompaction: unknown[] = restoredContext.summaryMessage
        ? [restoredContext.summaryMessage, ...(agent.state?.messages || [])]
        : (agent.state?.messages || []);
      const compaction = await compactCanvasAgentTranscript({
        messages: messagesForCompaction,
        summarize: (span) =>
          requestGatewayChatText({
            upstreamUrl,
            apiKey: upstream.apiKey,
            modelKey,
            // 用户已停止时不再发这次额外请求：信号已 abort，fetch 会立刻失败并走回退
            signal: task.abortController.signal,
            messages: [
              { role: "system", content: CANVAS_AGENT_SUMMARY_INSTRUCTION },
              {
                role: "user",
                content:
                  "以下是需要压缩的历史会话：\n\n"
                  + buildCanvasAgentSummarySource(span, {
                    maxChars: CANVAS_AGENT_SUMMARY_INPUT_CHAR_BUDGET,
                  }),
              },
            ],
          }),
      });

      // 这条日志是「主动压缩到底有没有发生」的验收证据：压缩前后消息/字符数、摘要长度、是否走了回退，
      // 以及摘要的承载位置（system 提示）与本次是否在累积。真机验收靠它判断摘要有没有被采用。
      context.logGenerationTask("canvas_agent:session_compacted", {
        recordId: task.recordId,
        userId: task.userId,
        canvasId: sessionBootstrap.canvasId,
        compacted: compaction.compacted,
        fellBack: compaction.fellBack,
        beforeMessageCount: compaction.beforeMessageCount,
        afterMessageCount: compaction.afterMessageCount,
        beforeChars: compaction.beforeChars,
        afterChars: compaction.afterChars,
        summaryChars: compaction.summaryChars,
        summarizedMessageCount: compaction.summarizedMessageCount,
        carriesPreviousSummary: compaction.carriesPreviousSummary,
        /** 摘要改挂的位置：真机验收要能从这里看出「这批消息里的摘要进了 system 提示」 */
        summaryCarrier: CANVAS_AGENT_SUMMARY_CARRIER,
        /** 本轮 system 提示里实际注入的摘要字符数（0 = 这一轮没摘要有可注入） */
        summaryAppliedToSystemPrompt: restoredContext.summaryText.length,
        failureReason: compaction.failureReason.slice(0, 300),
      });

      const session = buildCanvasAgentSessionMeta({
        canvasId: sessionBootstrap.canvasId,
        messages: compaction.messages,
        // 控制台阶段高水位随会话落库：下一轮从这里续（只增不减）
        console: consoleMemory,
      });
      if (session) {
        await context.saveCanvasAgentSession({
          recordId: task.recordId,
          userId: task.userId,
          session,
        });
        context.logGenerationTask("canvas_agent:session_saved", {
          recordId: task.recordId,
          userId: task.userId,
          canvasId: session.canvasId,
          messageCount: session.messages.length,
        });
      }
    } catch (error) {
      // 存转录失败不该改写本轮结果：下一轮退回 fallback，本轮该报什么照报什么
      context.logGenerationTaskError("canvas_agent:session_save_failed", error, {
        recordId: task.recordId,
        userId: task.userId,
        canvasId: sessionBootstrap.canvasId,
      });
    }
  }

  const finalText = fullText.trim();
  if (!finalText) {
    /**
     * 没产出内容时，优先把**上游/模型的真实原因**抛出去。
     *
     * 之前无论什么原因都是同一句「没有产出任何内容」—— 用户看不懂，我也查不出。
     * Pi 会把失败原因放在那条失败 assistant 消息的 errorMessage 上（例如「上游对话接口返回 HTTP 502」），
     * 那才是要给人看的东西；实在没有才退回这句兜底。
     */
    const failureReason = agent.state?.messages
      ?.filter((message) => (message as { role?: string }).role === "assistant")
      .map((message) => String((message as { errorMessage?: string }).errorMessage || "").trim())
      .filter(Boolean)
      .pop();
    throw new Error(failureReason || "制片 Agent 没有产出任何内容（模型既没回答也没调用工具）");
  }

  context.emitTaskProgressEvent(task.recordId, {
    stage: "syncing_record",
    message: "Agent 已给出结论，正在同步记录",
  });

  await context.updateGenerationRecord(
    task.recordId,
    {
      ...context.buildInitialRecordPayload(payload),
      content: fullText,
      thinkingContent: fullThinking,
      done: true,
      stopped: false,
    },
    task.userId,
  );
  const completedRecord = await context.getGenerationRecordById(
    task.recordId,
    task.userId,
  );
  await context.syncSharedTaskRuntime(task, "completed");
  context.emitTaskStreamEvent(task.recordId, {
    type: "completed",
    recordId: task.recordId,
    done: true,
    stopped: false,
    record: completedRecord,
    stage: "completed",
    message: "制片 Agent 已完成本轮工作",
  });

  context.logGenerationTask("canvas_agent:completed", {
    recordId: task.recordId,
    userId: task.userId,
    toolCallCount,
    contentLength: fullText.length,
  });
};

/** 客户端回传确认结果时，服务端用它把「用户答复」翻成模型能读的文本 */
export const buildConfirmationToolResult = (
  request: AgentConfirmationRequest,
  decision: AgentConfirmationDecision,
) => describeConfirmationDecision(request, decision);

/** 供 request-handler 校验回执里的工具名是否合法（防止前端回传一个不存在的工具名） */
export const isKnownCanvasAgentTool = (name: string) =>
  Boolean(findCanvasAgentTool(name));
