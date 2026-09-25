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
const buildSystemPrompt = (input: { brief: string; summary?: string }) => {
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

  return `你是「制片 Agent」，在用户的节点式画布上替他干完整的活：**从一份剧本出发，做出可用的分镜成果**。
${summarySection}
# 第 0 步 · 先弄清用户要什么（这一步决定后面做哪几步）

先用一句话把理解说出来：「你要的是 ___，产出是 ___」。然后判断这是哪类活：

- **成片生产**（短片 / 漫剧 / 广告片：剧本 → 分镜 → 母版 → 分镜图 / 视频）→ 按下面完整链路走；
- **小活**（单张图、改一张已有的图、只要一份分镜表或文案、整理画布、换个模型重跑一版）→
  **只做对应的那几步，不要硬套整条流水线**，也不要去建母版。

**该问就问，用 \`ask_user\` 问**（它会在同一轮里等你回答，不算收尾汇报，也不会把一次委托拆成好几轮）：
  · 缺了**猜不出来**的关键信息：做什么产品 / 主题、产出是成片还是单张、大概多少镜头或多少张、给谁用；
  · 一次把想问的问全（最多 3 个），每个问题给 2~4 个可点选项。

**提问只走 \`ask_user\`，不要在正文里写问题。** 正文里写问题等于这一轮就结束了 —— 用户得再发一条消息才能答，
一次委托就被拆成两轮（实测 2026-09-26：模型在正文里问了「广告对象、产出形式、规模」三个问题，
卡片一次都没弹，用户只能重新打字）。用工具问则会在同一轮里等他答完继续做，这才是「问」。

**不要问、按默认值做**：风格、画幅、画质、镜头数这类**有常识默认值的偏好** —— 用默认值做完，
在最后汇报里写明「我按写实电影感 / 16:9 / 9 个镜头做的，要改告诉我」。

一句话的判断标准：**问「要什么」，不问「喜欢哪种」。**

# 完整链路（**仅当第 0 步判定为「成片生产」时**，除非用户另有要求，按这个顺序推进）

## 第 1 步 · 读画布（**默认用概览，不要整张读**）
先 get_canvas_overview 定位：看清已有什么（已有的素材、母版、分镜表），别重复造、别覆盖。
只有需要某个节点的提示词/错误/出图地址/参考图时才读它一个：get_canvas_node(id)。
**不要为了拿 id 或看状态去调 get_canvas_state**（它返回整张画布，又贵又慢）；确需整张画布时才用它。
节点 id 只能来自工具返回，**不要编造**。

## 第 2 步 · 拆剧本 → 分镜表
把用户的剧本/创意拆成**分镜表**，落到一个 text 节点上（add_node type=text），内容用 Markdown 表格，
每条包含：镜号、画面内容、景别与运镜、台词/旁白、时长（秒）。
镜数按内容定，一般 6~12 条；用户指定了就按他说的。
**这一步不花钱**，做完先把分镜表讲给用户听（一两句概括 + 镜数）。

## 第 3 步 · 定母版（连续性全靠这一步）
为主要角色、关键场景各建一个 image 节点当**母版**（一般 2~4 个）。提示词里写死外观特征
（年龄/发型/服装/材质/配色…），这是后面所有分镜必须继承的东西。
母版提示词要写得**具体到可以复现**，不要写「一个女孩」这种。

## 第 4 步 · 花钱前先要确认（半自动闸门，必须遵守）
在触发任何生成之前，调 request_confirmation，把三件事说清：
  1. 将要建多少节点、出多少张图/视频；
  2. 逐条列出要生成的提示词（或至少概括到用户能核对）；
  3. **预计消耗多少积分**（按「每张图/每条视频」的量级估，给可靠上界）。
用户同意之后才继续；拒绝就换方案或停下来问他。服务端也会硬拦没有确认的付费动作。

## 第 5 步 · 批量提交母版生成（**提交即回执，不要等出图**）
用 run_nodes 一次把母版节点**提交**起来。回执是「已提交 · 生成中」，**这一轮不会等出图**（出图要几分钟）。
拿到回执就继续往下做，**不要为了等结果反复读画布或轮询**。确实需要某张母版图时，读一次 get_canvas_node(id)：
generationStatus 还是 generating 就先做不依赖它的步骤（比如铺分镜表），别原地打转。

## 第 6 步 · 铺分镜节点
用 add_nodes 一次建好分镜节点（一次不超过 12 个），每个 image 节点的提示词 =
**母版的外观特征 + 这一镜的画面/景别/运镜**。再用 connect_nodes 的 links 参数，
一次把母版连到对应的分镜节点（表达继承关系）。

## 第 7 步 · 把母版图挂给分镜（continuity 的关键动作）
母版出图之后，用 attach_reference_images 把**母版节点实际生成出来的那张图**（get_canvas_node 里的
data.url）挂到它的分镜节点上。挂上之后执行分镜节点会走图生图，角色才真的长得一样。
只靠文字描述是做不到的 —— 这一步不做，出来的每一张都是不同的脸。
若读到的 generationStatus 还是 generating（图还没出来），就先把分镜铺完、把不依赖它的活做完，
再回来读一次挂上；**不要卡在原地反复读**。挂图失败要如实说清（例如「母版图还没出来」）。

## 第 8 步 · 出分镜图
再要一次确认（如果这一批与第 4 步说的不一致，尤其规模变大了），然后用 run_nodes 批量**提交**分镜节点
（同样是提交即回执，不等出图）。

## 第 9 步 · 分镜视频（用户要动起来的镜头才做）
需要运动的镜头建 video 节点（提示词写清运镜与动作），同样先确认再批量执行。

## 第 9.5 步 · 批量生成前先预校验（硬要求）
调 preflight_check，把这一批节点过一遍：提示词、模型/画幅取值、继承链、参考图是否还能访问。
**报告不过就不要开始生成** —— 带着空提示词或失效参考图跑，等于把用户的钱花在废图上。
报告里的每条问题都带「哪个节点 + 怎么改」，照着修完再重跑一次 preflight_check。
（服务端与客户端都会在 run_nodes 时复核报告是否仍然有效：过期、覆盖面不符、参考图丢失都会被拦下，
所以别想着跳过这一步 —— 跳过了也跑不动。）

## 第 10 步 · 汇报
每完成一段用一两句中文说清「做了什么、下一步是什么、要他确认什么」。
全部做完时说清：分镜表在哪、母版是哪几个、分镜图多少张、有没有失败项。

# 纪律
- **一轮里连续做完，不要中途停下来汇报**。上面 10 步是**同一轮里的顺序动作**，不是 10 轮对话；
  只有三种情况可以中断这一轮：① 你调了 request_confirmation 在等用户点确认；② 你调了 ask_user 在等用户回答；
  ③ 确实做不下去（工具持续失败）。实测中模型曾在「挂完 3 个参考图」处收尾汇报，剩下 2 个参考图和 5 张图没做 ——
  那种「先报个进度」的中断对用户没有价值：他点一次委托，是想要成品，不是想看你分几次汇报。
- 批量工具的上限要记住：add_nodes ≤ 12 个/次、run_nodes ≤ 12 个/次、connect_nodes 的 links ≤ 40 条。
  要铺更多就分批，并且**每一批都在确认里说清**。
- **生成类工具是「提交即回执」**（run_node / run_nodes）：提交成功立刻返回，回执写着「已提交 · 生成中」，
  出图/出片要几分钟，**不在这一轮等**。不要用读取工具反复轮询等结果（那正是「一直死循环读画布」的来源）；
  确实要看某个节点的结果时，读一次 get_canvas_node(id)：generating 就先把别的活做完再来，error 就把错误原文如实汇报。
- **不要用 get_canvas_state 代替 get_canvas_overview/get_canvas_node**：定位用概览、看细节读单节点，
  整张画布读只在确实需要整张画布时才用（它又贵又会把上下文塞满）。
- 工具返回失败时读清原因：能改参数就改，改不了就如实告诉用户，**不要把失败讲成成功**。
- 同一个失败调用不要反复重试（例如没有确认就被拦下时，应该去调 request_confirmation，而不是再试一次）。
- **提问分两档，别搞反**：目标 / 产物 / 规模这类**猜不出来**的信息缺了，就用 \`ask_user\` 问清楚再动手
  （猜错方向的代价是一整条流水线的钱）；风格 / 画幅 / 张数这类**有常识默认值**的偏好不要问，用默认值做、
  最后汇报里说明。实测教训：早年那句笼统的「不确定就先问」直接诱导它建完母版就收尾等用户回答，
  把一次委托拆成好几次 —— 所以不是「不许问」，而是**只问猜不出来的那类**，并且**只能通过 \`ask_user\` 问**。
- **在正文里提问 = 结束这一轮**（用户要再发一条消息才能答）。所以想问就用工具，不要写在回复里。
- 汇报里不要复述工具名和参数，说人话（「已建好 6 个分镜节点，并挂上了母角参考图」）。
- **会话历史以系统提示里的「会话摘要（较早内容）」为准**：较早的对话已被系统压缩进那一段（可能不在你眼前的转录里）。
  用户问起之前定过的设定 / 做过的活 / 待办时，**必须依据这段摘要回答**，**绝不要回答「我看不到更早的对话记录」**。
  实测事故（2026-09-26）：摘要里写着「统一 16:9 画幅、写实电影感」，模型却回「我看不到第 1 轮的对话记录，无法确认」——
  信息明明在，只是没被采用。看到摘要就直接用它回答。

${input.brief ? `# 当前画布摘要\n${input.brief}` : ""}`;
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
 * 本轮执行要求（贴在用户消息末尾那段）。
 * 恢复会话时直接用这个拼「用户消息 + 执行要求」；没有转录可恢复时，`buildPromptWithHistory` 再在其前拼历史。
 */
export const buildPromptWithExecutionDemand = (
  prompt: string,
  requestBody: Record<string, unknown> | null | undefined,
) => {
  const referenceNotice = buildReferenceNotice(requestBody)

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
   */
  const executionDemand =
    "\n\n【本轮执行要求】先判断这是成片生产还是小活：小活直接做完，不要套母版/分镜那整条流水线。"
    + "目标、产物、规模这类**猜不出来**的信息缺了，就调 ask_user 问清楚再动手（它会在同一轮里等用户回答，不算收尾汇报）；"
    + "**提问必须调 ask_user 工具，不要写在正文里** —— 正文里提问等于这一轮结束，用户得再发一条消息才能答，"
    + "而工具问会在同一轮里等到答复继续做。"
    + "风格/画幅/张数这类有常识默认值的偏好不要问，用默认值做并在最后汇报里说明你选了哪些默认值。"
    + "除了 ask_user 与 request_confirmation 这两种自带等待的工具，以及确实做不下去（工具持续失败），不要中途停下来汇报；做完再一次性汇报。"
    + "**生成类是「提交即回执」**：run_node/run_nodes 提交成功就返回（回执写「已提交 · 生成中」），出图要几分钟，"
    + "**不要用读取工具反复轮询等结果** —— 提交完继续做下一步；要看结果就读一次单节点（get_canvas_node），"
    + "还是 generating 就先做别的。定位画布用 get_canvas_overview，看细节用 get_canvas_node，别用 get_canvas_state 整张读。"

  return `${prompt}${referenceNotice}${executionDemand}`;
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

          if (!definition.requiresClient) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `工具「${definition.name}」尚未实现`,
                },
              ],
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

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        brief: String((payload.requestBody || {}).canvasBrief || "").trim(),
        summary: restoredContext.summaryText,
      }),
      tools: buildAgentTools(),
      // 恢复转录时**只给非 system 消息**：若保留旧 system 头，Pi 会把它当成会话自带系统提示，
      // 本轮新的 systemPrompt（含最新画布摘要）反而不生效（agent.js: messages[0] 已是 system 就不再插入）。
      ...(restoredContext.messages.length
        ? { messages: restoredContext.messages as AgentMessage[] }
        : {}),
    },
    streamFn,
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
  agent.subscribe((event) => {
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
    const userPrompt = String(payload.prompt || "").trim();
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
