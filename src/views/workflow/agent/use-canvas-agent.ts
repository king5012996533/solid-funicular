import { ref } from "vue";

import {
  AI_GATEWAY_REQUEST_PATH,
  createGatewayPayload,
} from "@/api/ai-gateway";
import { buildApiUrl } from "@/api/http";
import {
  getAllChatModels,
  getDefaultChatModelKey,
  loadPublicModelCatalog,
} from "@/config/models";
import {
  CANVAS_AGENT_TOOL_SCHEMAS,
  executeCanvasAgentTool,
  type CanvasAgentContext,
} from "./canvas-agent-tools";

/**
 * 画布助手的 Agent 循环（2026-09-23）
 *
 * 之前这里是个 mock：发消息 → 300ms 后回一句「助手能力接入中」。现在换成真的：
 *
 *   用户输入 → 带上「画布快照 + 工具清单」请模型决策
 *            → 模型要么直接回答，要么要求调用工具（function calling）
 *            → 我们**在画布上真的执行**（增删节点、连线、选中、触发节点执行）
 *            → 把执行结果回给模型 → 循环，直到它给出最终答复或到达步数上限
 *
 * 几个刻意的取舍：
 *   - **工具执行完全在客户端**：画布是本地状态（zustand 同级的 ref），走服务端反而要来回同步；
 *     模型的调用则走既有 AI 网关（同源、后端持有厂商密钥、对话不计费）。
 *   - **工具失败不炸整轮**：失败原因作为 tool 结果回给模型，让它自己决定重试或换做法 ——
 *     这才是「像个智能体」该有的样子，而不是一遇错就断线。
 *   - **步数上限**：MAX_STEPS 防模型反复绕圈；到顶就如实告知「已执行 N 步仍未给出结论」。
 *   - **可中断**：AbortController 一路透传到网关请求；用户点「停止」立即生效。
 */

/** 工具执行记录，给 UI 展示「它到底做了什么」 */
export interface CanvasAgentStep {
  index: number;
  name: string;
  summary: string;
  ok: boolean;
}

interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

const MAX_STEPS = 6;

const SYSTEM_PROMPT = `你是「画布助手」——一个能真正动手改画布的智能体，运行在一个节点式创作画布上。

你的职责：理解用户意图，必要时**调用工具**直接改动画布，让用户看到结果，而不是只给建议。

工作方式：
1. 动手之前先调用 get_canvas_state 看清画布现状（有哪些节点、怎么连的、用户选中了什么）。
2. 需要新建/修改/连线/删除/执行时，直接调用对应工具。一次可以连续调用多个工具完成任务。
3. 需要整套流程时，先 list_workflow_templates，再 apply_workflow_template。
4. 工具返回失败时读清原因再决定：改参数重试、换一种做法、或如实告诉用户为什么做不到。
5. 完成后用简短中文说明你做了什么（例如「已新增图片节点 n1 并选中」），不要复述工具清单。

约束：
- 不要编造画布上不存在的东西；节点 id 只能来自 get_canvas_state 或工具返回。
- 视频节点的执行服务端尚未接通，run_node 会失败 —— 如实说明，不要谎报成功。
- 用户只是问问题时不要乱改画布；改动要服务于用户明确的目标。
- 不要一次创建超过 8 个节点；需要更多先跟用户确认。`;

export interface UseCanvasAgentOptions {
  ctx: CanvasAgentContext;
  /** 画布摘要（选中节点、上游上下文等），由页面提供；每次请求前现取，保证是最新的 */
  buildBrief: () => string;
  /** 会话已有的历史消息，转成模型可读的对话 */
  readHistory: () => Array<{ role: "user" | "assistant"; content: string }>;
  /** 指定模型（默认取目录里的默认对话模型） */
  modelKey?: () => string;
}

export const useCanvasAgent = (options: UseCanvasAgentOptions) => {
  const running = ref(false);
  const steps = ref<CanvasAgentStep[]>([]);
  const error = ref("");
  let controller: AbortController | null = null;

  /**
   * 解析这次要用哪个对话模型。
   *
   * 两个坑（都是实测踩到的）：
   *   1. `getDefaultChatModelKey()` 返回的是目录里的 **selectionKey**（providerId::CATEGORY::modelKey），
   *      而网关那侧要的是**裸 modelKey** —— 直接把 selectionKey 传过去会得到「模型不存在或未启用」。
   *   2. 目录在客户端是模块级缓存：管理员在后台改配置（例如停用某个厂商）后，页面不刷新就一直用旧的，
   *      于是请求打到一个已经停用的厂商上。这里**强制刷新**一次，免得每次都要用户手动刷新页面。
   */
  const resolveModelKey = async () => {
    const explicit = options.modelKey?.() || "";
    if (explicit) return explicit;
    await loadPublicModelCatalog(true);
    const selectionKey = getDefaultChatModelKey();
    const chatModels = getAllChatModels();
    const picked = chatModels.find((item) => item.key === selectionKey)
      || chatModels.find((item) => selectionKey.endsWith(item.modelKey))
      || chatModels[0];
    return picked?.modelKey || "";
  };

  /** 一次模型调用：带上工具清单，返回 message（可能是 tool_calls，也可能是最终文本） */
  const callModel = async (messages: ChatTurn[], signal: AbortSignal) => {
    // 目录刷新在 resolveModelKey 里做（force 一次），这里不再重复加载
    const modelKey = await resolveModelKey();
    if (!modelKey)
      throw new Error(
        "后台还没有配置可用的对话模型（去「模型配置」里加一个 CHAT 模型）",
      );

    const payload = await createGatewayPayload("chat", {
      // 必须显式 POST：createGatewayPayload 默认按 GET 组装，会把 body（messages/tools）整段丢掉
      method: "POST",
      modelKey,
      data: {
        model: modelKey,
        messages,
        tools: CANVAS_AGENT_TOOL_SCHEMAS,
        tool_choice: "auto",
        temperature: 0.3,
      },
    });
    const response = await fetch(buildApiUrl(AI_GATEWAY_REQUEST_PATH), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let message = `模型调用失败（HTTP ${response.status}）`;
      try {
        const parsed = JSON.parse(bodyText);
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        /* 保持默认信息 */
      }
      throw new Error(message);
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error("模型返回的不是合法 JSON");
    }
    const message = parsed?.choices?.[0]?.message;
    if (!message) throw new Error("模型没有返回 message");
    return message as {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  };

  /**
   * 跑一轮对话。返回最终答复文本（供调用方写入消息流）。
   * 抛错时 error 里会有可读原因，调用方决定怎么显示。
   */
  const run = async (userText: string): Promise<string> => {
    if (running.value) return "";
    running.value = true;
    steps.value = [];
    error.value = "";
    controller = new AbortController();
    const signal = controller.signal;

    const brief = options.buildBrief();
    const messages: ChatTurn[] = [
      {
        role: "system",
        content: brief
          ? `${SYSTEM_PROMPT}\n\n当前画布摘要：\n${brief}`
          : SYSTEM_PROMPT,
      },
      ...options
        .readHistory()
        .map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: userText },
    ];

    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const message = await callModel(messages, signal);
        const toolCalls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];

        if (!toolCalls.length) {
          return (
            String(message.content || "").trim() || "（模型没有给出文字答复）"
          );
        }

        // 把助手这一轮的「要求调用工具」记进对话，后续 tool 结果才有归属
        messages.push({
          role: "assistant",
          content: String(message.content || ""),
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function?.arguments
              ? JSON.parse(call.function.arguments)
              : {};
          } catch {
            args = {};
          }
          const outcome = await executeCanvasAgentTool(
            String(call.function?.name || ""),
            args,
            options.ctx,
          );
          steps.value = [
            ...steps.value,
            {
              index: steps.value.length + 1,
              name: String(call.function?.name || ""),
              summary: outcome.summary,
              ok: outcome.ok,
            },
          ];
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: outcome.result,
          });
        }
      }
      return `已连续执行 ${MAX_STEPS} 步仍未得出结论，先停在这里。你可以看看画布上的变化，或把需求说得更具体些。`;
    } catch (err) {
      if (signal.aborted) {
        error.value = "已停止";
        return steps.value.length ? "已停止（画布上的改动会保留）" : "";
      }
      const reason = err instanceof Error ? err.message : String(err);
      error.value = reason;
      throw new Error(reason, { cause: err });
    } finally {
      running.value = false;
      controller = null;
    }
  };

  const stop = () => {
    controller?.abort();
  };

  return { running, steps, error, run, stop };
};
