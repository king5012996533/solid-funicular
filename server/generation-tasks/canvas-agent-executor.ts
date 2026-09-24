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
} from "../../src/shared/canvas-agent-tools";
import { Agent, Type, type AgentTool } from "./pi-runtime";
import { createGatewayStreamFn } from "./pi-gateway-stream";
import { createSpendGuard } from "./canvas-agent-guard";
import {
  cancelPendingClientToolCalls,
  waitForClientToolResult,
} from "./canvas-agent-bridge";

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
const buildSystemPrompt = (input: { brief: string }) =>
  `你是「制片 Agent」，在用户的节点式画布上替他干完整的活：**从一份剧本出发，做出可用的分镜成果**。

# 完整链路（除非用户另有要求，按这个顺序推进）

## 第 1 步 · 读画布
先 get_canvas_state。看清已有什么（已有的素材、母版、分镜表），别重复造、别覆盖。
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

## 第 5 步 · 批量出母版图
用 run_nodes 一次把母版节点跑起来。出图需要时间（每张可能几分钟），
之后用 get_canvas_state 看母版节点的 imageUrl 是否已经有了；没出来就等一会儿再看，别急着重跑。

## 第 6 步 · 铺分镜节点
用 add_nodes 一次建好分镜节点（一次不超过 12 个），每个 image 节点的提示词 =
**母版的外观特征 + 这一镜的画面/景别/运镜**。再用 connect_nodes 的 links 参数，
一次把母版连到对应的分镜节点（表达继承关系）。

## 第 7 步 · 把母版图挂给分镜（continuity 的关键动作）
母版出图之后，用 attach_reference_images 把**母版节点实际生成出来的那张图**（get_canvas_state 里的
imageUrl）挂到它的分镜节点上。挂上之后执行分镜节点会走图生图，角色才真的长得一样。
只靠文字描述是做不到的 —— 这一步不做，出来的每一张都是不同的脸。

## 第 8 步 · 出分镜图
再要一次确认（如果这一批与第 4 步说的不一致，尤其规模变大了），然后用 run_nodes 批量执行分镜节点。

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
  唯一该主动结束这一轮的时刻只有两个：需要用户点确认（request_confirmation 已经自带等待），
  或者确实卡住做不下去。实测中模型曾在「挂完 3 个参考图」处收尾汇报，剩下 2 个参考图和 5 张图没做 ——
  那种「先报个进度」的中断对用户没有价值：他点一次委托，是想要成品，不是想看你分几次汇报。
- 批量工具的上限要记住：add_nodes ≤ 12 个/次、run_nodes ≤ 12 个/次、connect_nodes 的 links ≤ 40 条。
  要铺更多就分批，并且**每一批都在确认里说清**。
- 工具返回失败时读清原因：能改参数就改，改不了就如实告诉用户，**不要把失败讲成成功**。
- 同一个失败调用不要反复重试（例如没有确认就被拦下时，应该去调 request_confirmation，而不是再试一次）。
- 不确定风格/时长/画幅/镜数时，**用合理默认值先做**（写实电影感 / 16:9 / 按内容定镜数），
  在最后的汇报里说明你选了哪些默认值并请他改。**不要为了这些停下来提问** ——
  实测这条「先问一句」直接导致它建完母版就收尾等你回答，把一次委托拆成好几次。
  只有**缺少关键信息**（例如根本没给剧本内容）时才提问。
- 汇报里不要复述工具名和参数，说人话（「已建好 6 个分镜节点，并挂上了母角参考图」）。

${input.brief ? `# 当前画布摘要\n${input.brief}` : ""}`;

/**
 * 把对话历史并进本轮用户消息。
 *
 * 为什么不直接写进 `agent.state.messages`：Pi 的转录里**系统提示与工具声明是同一条 system 消息**，
 * 手工塞 messages 会把它顶掉（Agent 文档写明「除非消息里已经有一条 system」）——
 * 那一顶，工具就发不出去了，模型会开始说「我看不到画布」。这段历史只影响措辞连贯性，
 * 不值得为它冒「工具消失」的风险，所以退一步：作为背景贴在用户消息里，结构上绝对安全。
 */
export const buildPromptWithHistory = (
  prompt: string,
  requestBody: Record<string, unknown> | null | undefined,
) => {
  /**
   * 用户这一轮附的参考图。
   *
   * 必须显式告诉 Agent —— 它看不见浏览器里上传了什么。不说的话，用户附了图、Agent 却当没有，
   * 于是它要么凭空生成（图白附了），要么反问用户「你要我参考什么」。
   * 顺带把「用哪个工具」一起点名，省得它去猜。
   */
  const referenceImages = Array.isArray(requestBody?.referenceImages)
    ? (requestBody?.referenceImages as unknown[]).filter((item) => typeof item === "string" && item)
    : []
  const referenceNotice = referenceImages.length
    ? `\n\n【用户本轮附了 ${referenceImages.length} 张参考图】`
      + "需要用到它们时，用 attach_reference_images 把图挂到对应的图片节点上（默认就是取这几张），"
      + "再用 run_node 执行该节点 —— 挂上图之后那次生成会走图生图。不要假装用了图。"
    : ""
  const history = Array.isArray(requestBody?.history)
    ? (requestBody?.history as Array<{ role?: string; content?: string }>)
    : [];
  const lines = history
    .filter(
      (item) =>
        (item.role === "user" || item.role === "assistant") &&
        String(item.content || "").trim(),
    )
    .slice(-8)
    .map(
      (item) =>
        `${item.role === "user" ? "用户" : "你"}：${String(item.content || "")
          .trim()
          .slice(0, 500)}`,
    );

  /**
   * 执行要求贴在**用户消息**里，而不是只写在系统提示里。
   *
   * 实测教训：把「一轮里连续做完」放在几千字的系统提示中间时，模型经常读不到那么深 ——
   * 它会以「已完成前置拆解，下一步将生成母版图…」收尾汇报，把一次委托拆成好几次。
   * 用户点一次委托是想要成品，不是想看你分几次汇报。贴在用户消息末尾（模型注意力最强处）
   * 才真正管用；同时把「别来问风格」也写清 —— 那句「不确定就先问」曾经直接诱导它早早收尾。
   */
  const executionDemand =
    "\n\n【本轮执行要求】一次做到产出为止，不要中途收尾汇报、也不要反问风格/画幅这类可以用常识决定的事"
    + "（选了默认值就在最后汇报里说明）。只有两种情况可以结束这一轮：① 你调了 request_confirmation 等在等用户点确认；"
    + "② 确实做不下去（工具持续失败）。做完再一次性汇报。"

  if (!lines.length) {
    return `${prompt}${referenceNotice}${executionDemand}`;
  }
  return `（以下是本轮之前我们说过的话，供你保持连贯，不必复述）\n${lines.join("\n")}\n\n【用户现在的要求】\n${prompt}${referenceNotice}${executionDemand}`;
};

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
        definition.name === "request_confirmation"
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

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        brief: String((payload.requestBody || {}).canvasBrief || "").trim(),
      }),
      tools: buildAgentTools(),
    },
    streamFn,
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
     */
    await agent.prompt(buildPromptWithHistory(userPrompt, payload.requestBody));
    await agent.waitForIdle?.();
  } finally {
    clearTimeout(wallClockTimer);
    // 任务结束（正常/异常/停止）都要把还在等的客户端调用清掉，否则 Promise 会一直挂着
    cancelPendingClientToolCalls(
      task.recordId,
      "任务已结束，未完成的客户端工具调用被取消",
    );
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
