import {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "./pi-runtime";

/**
 * 把「我们的网关（厂商配置 + 解密后的密钥 + 重试）」包成 Pi 需要的 `StreamFn`。
 *
 * 为什么不让 Pi 用自己的 provider 体系：那等于让 Agent 自带一套厂商/密钥/计费，
 * 和后台配置、积分扣费、限流完全脱钩。这里做成「Pi 只负责决策，模型调用一律走我们」。
 *
 * 这一层的职责只有三件事：
 *   1. 把 Pi 的转录翻成 OpenAI 形状（**必须翻**：Pi 内部工具结果叫 `role: toolResult`，
 *      上游只认 `role: tool` + `tool_call_id`；不翻模型就看不到工具结果，会把同一个工具反复重调）；
 *   2. 把「模型可以调用什么」从转录里取出来发给上游（`getCurrentTools`，不是 `context.tools` ——
 *      后者是运行时能执行的集合，第一次写错会导致工具一个都没发出去）；
 *   3. 把上游的流式增量翻译成 Pi 的事件流（start → text_* / toolcall_* → done）。
 */

type PiModel = Model<Api>;

interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Pi 的内容块 → 纯文本（ThinkingContent 不进正文，避免把思考当成答案回灌给模型） */
const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = part as { type?: string; text?: string };
      return block?.type === "text" ? String(block.text || "") : "";
    })
    .filter(Boolean)
    .join("\n");
};

/**
 * Pi 的内部消息 → OpenAI 形状。导出出来是为了能单测（这段转换是整条链路里最容易静默出错的地方）。
 */
export const toOpenAiMessages = (
  messages: TranscriptContext["messages"],
): OpenAiChatMessage[] => {
  const out: OpenAiChatMessage[] = [];
  for (const raw of messages) {
    const message = raw as unknown as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      toolName?: string;
    };
    if (message.role === "system") {
      out.push({ role: "system", content: textOfContent(message.content) });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: textOfContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = textOfContent(content);
      const toolCalls = content
        .map(
          (part) =>
            part as {
              type?: string;
              id?: string;
              name?: string;
              arguments?: unknown;
            },
        )
        .filter((part) => part?.type === "toolCall")
        .map((part) => ({
          id: String(part.id || ""),
          type: "function" as const,
          function: {
            name: String(part.name || ""),
            arguments: JSON.stringify(part.arguments ?? {}),
          },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: String(message.toolCallId || ""),
        content: textOfContent(message.content) || "(空结果)",
      });
      continue;
    }
  }
  return out;
};

export interface GatewayStreamFnOptions {
  /** 上游对话接口地址（已含 endpoint） */
  upstreamUrl: string;
  apiKey: string;
  modelKey: string;
  /** 用户停止任务时中断上游请求 */
  signal: AbortSignal;
  /** 正文增量（用于把「正在打字」实时透给前端） */
  onTextDelta?: (delta: string) => void;
  /** 思考增量（推理模型会走 reasoning_content，不订阅就完全看不到它在想什么） */
  onThinkingDelta?: (delta: string) => void;
  /**
   * 每次请求前记一条日志，排查「模型看不到工具」这类问题时是唯一线索。
   * `roles` 是这条链路上最有用的字段：一眼能看出「Pi 是不是多塞了一条消息」——
   * 只看条数增减分不清是「模型又调了工具（+2）」还是「Pi 自己多插了一条（+1）」。
   */
  onRequest?: (detail: {
    messageCount: number;
    toolCount: number;
    toolNames: string[];
    roles: string;
  }) => void;
  /** 单次请求的整体超时（含流式读取的空闲判定） */
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

interface AccumulatedToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

/**
 * 创建 Pi 用的 StreamFn。
 *
 * 注意这是**每次任务一份**的闭包（携带上游地址/密钥/abort signal），不要在任务之间复用。
 */
export const createGatewayStreamFn = (options: GatewayStreamFnOptions) => {
  const fetchImpl = options.fetchImpl || fetch;
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;

  return (
    model: PiModel,
    context: TranscriptContext,
    // Pi 会把温度等选项放在这里；我们的上游参数由网关侧的厂商配置决定，这里只接收不使用
    _streamOptions?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const buildMessage = (
        parts: AssistantMessage["content"],
        stopReason: AssistantMessage["stopReason"],
        errorMessage?: string,
      ): AssistantMessage => ({
        role: "assistant",
        content: parts,
        api: "openai-completions",
        provider: "canana-gateway",
        model: options.modelKey || String((model as { id?: string })?.id || ""),
        // 用量与成本由网关侧自己记账（积分扣费在生成任务里做），这里如实填 0 而不是编数字
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
        ...(errorMessage ? { errorMessage } : {}),
      });

      let partial = buildMessage([], "pending");

      try {
        const transcript = collapseSystemMessages(context);
        const systemPrompt = getCurrentSystemPrompt(transcript.messages);
        const declaredTools = getCurrentTools(transcript.messages);
        const body: Record<string, unknown> = {
          model: options.modelKey,
          stream: true,
          messages: [
            ...(systemPrompt
              ? [{ role: "system", content: systemPrompt }]
              : []),
            ...toOpenAiMessages(
              transcript.messages.filter(
                (message) => message.role !== "system",
              ),
            ),
          ],
          ...(declaredTools.length
            ? {
                tools: declaredTools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
                tool_choice: "auto",
              }
            : {}),
        };

        const openAiMessages = body.messages as OpenAiChatMessage[];
        options.onRequest?.({
          messageCount: openAiMessages.length,
          toolCount: declaredTools.length,
          toolNames: declaredTools.map((tool) => tool.name),
          roles: openAiMessages
            .map((message) =>
              message.role === "assistant"
                ? message.tool_calls?.length
                  ? `asst+${message.tool_calls.length}tool`
                  : "asst"
                : message.role,
            )
            .join(","),
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetchImpl(options.upstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(
            `上游对话接口返回 HTTP ${response.status}${errorText ? `：${errorText.slice(0, 300)}` : ""}`,
          );
        }

        const contentType = String(
          response.headers.get("content-type") || "",
        ).toLowerCase();
        let textContent = "";
        let thinkingContent = "";
        const toolCalls: AccumulatedToolCall[] = [];
        let stopReason: AssistantMessage["stopReason"] = "stop";

        /**
         * 上游可能不守 SSE（少数中转直接把整个 JSON 吐回来，`stream: true` 被忽略）。
         * 这里两种都接：非 event-stream 就整段解析。
         */
        if (!response.body || !contentType.includes("event-stream")) {
          const rawText = await response.text();
          const parsed = (() => {
            try {
              return JSON.parse(rawText);
            } catch {
              return null;
            }
          })();
          const choice = parsed?.choices?.[0];
          const message = choice?.message || {};
          textContent = String(message.content || "");
          if (message.reasoning_content)
            thinkingContent = String(message.reasoning_content);
          for (const call of Array.isArray(message.tool_calls)
            ? message.tool_calls
            : []) {
            toolCalls.push({
              id: String(call.id || ""),
              name: String(call.function?.name || ""),
              argumentsText: String(call.function?.arguments || "{}"),
            });
          }
          if (!textContent && !toolCalls.length) {
            throw new Error(`上游没有返回可用内容：${rawText.slice(0, 200)}`);
          }
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let lastChunkAt = Date.now();
          let finished = false;

          while (!finished && !options.signal.aborted) {
            // 空闲守卫：上游发完 [DONE] 常常不关连接，只等 reader 会永远挂着（这条链路踩过）
            const idleWaitMs = Math.max(
              1_000,
              idleTimeoutMs - (Date.now() - lastChunkAt),
            );
            const readResult = await Promise.race([
              reader
                .read()
                .then((result) => ({ kind: "data" as const, result })),
              new Promise<{ kind: "idle" }>((resolve) =>
                setTimeout(() => resolve({ kind: "idle" }), idleWaitMs),
              ),
            ]);

            if (readResult.kind === "idle") {
              if (Date.now() - lastChunkAt >= idleTimeoutMs) {
                throw new Error(
                  `上游 ${Math.round(idleTimeoutMs / 1000)} 秒没有继续输出，已中止本次 Agent 对话`,
                );
              }
              continue;
            }
            if (readResult.result.done) break;
            lastChunkAt = Date.now();

            buffer += decoder.decode(readResult.result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const chunk = trimmed.slice(5).trim();
              if (chunk === "[DONE]") {
                finished = true;
                break;
              }

              let parsed: any = null;
              try {
                parsed = JSON.parse(chunk);
              } catch {
                continue;
              }

              const upstreamError = parsed?.error?.message || parsed?.message;
              if (upstreamError && !parsed?.choices) {
                throw new Error(
                  `上游返回错误：${String(upstreamError).slice(0, 300)}`,
                );
              }

              const choice = parsed?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};

              const thinkingDelta =
                typeof delta.reasoning_content === "string"
                  ? delta.reasoning_content
                  : "";
              if (thinkingDelta) {
                thinkingContent += thinkingDelta;
                options.onThinkingDelta?.(thinkingDelta);
              }

              const piece =
                typeof delta.content === "string" ? delta.content : "";
              if (piece) {
                textContent += piece;
                options.onTextDelta?.(piece);
              }

              /**
               * 工具调用在流里是**碎片**：第一片带 id 与函数名，后面的片只有参数片段，
               * 靠 `index` 归并。不按 index 归并就会把一次调用拆成好几个空名调用。
               */
              for (const toolCallDelta of Array.isArray(delta.tool_calls)
                ? delta.tool_calls
                : []) {
                const index = Number.isFinite(toolCallDelta?.index)
                  ? Number(toolCallDelta.index)
                  : toolCalls.length;
                if (!toolCalls[index]) {
                  toolCalls[index] = { id: "", name: "", argumentsText: "" };
                }
                const target = toolCalls[index];
                if (toolCallDelta.id) target.id = String(toolCallDelta.id);
                if (toolCallDelta.function?.name)
                  target.name += String(toolCallDelta.function.name);
                if (toolCallDelta.function?.arguments) {
                  target.argumentsText += String(
                    toolCallDelta.function.arguments,
                  );
                }
              }

              if (choice.finish_reason) {
                stopReason =
                  choice.finish_reason === "tool_calls" ||
                  choice.finish_reason === "tool_use"
                    ? "toolUse"
                    : choice.finish_reason === "length"
                      ? "length"
                      : "stop";
              }
            }
          }
        }

        const content: AssistantMessage["content"] = [];
        if (textContent) content.push({ type: "text", text: textContent });
        if (thinkingContent)
          content.push({ type: "thinking", thinking: thinkingContent });
        for (const call of toolCalls) {
          if (!call?.name) continue;
          let args: unknown = {};
          try {
            args = call.argumentsText ? JSON.parse(call.argumentsText) : {};
          } catch {
            args = {};
          }
          content.push({
            type: "toolCall",
            id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: call.name,
            arguments: args as Record<string, never>,
          });
        }

        // 有工具调用时以 toolUse 收口：Pi 据此决定「继续执行工具」而不是「结束这一轮」
        if (content.some((part) => part.type === "toolCall")) {
          stopReason = "toolUse";
        } else if (stopReason === "toolUse") {
          stopReason = "stop";
        }

        if (!content.length) {
          throw new Error("上游返回了空内容（既没有文本也没有工具调用）");
        }

        partial = buildMessage(content, stopReason);
        stream.push({ type: "start", partial });

        content.forEach((part, index) => {
          if (part.type === "text") {
            stream.push({ type: "text_start", contentIndex: index, partial });
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: part.text,
              partial,
            });
            stream.push({
              type: "text_end",
              contentIndex: index,
              content: part.text,
              partial,
            });
          }
          if (part.type === "toolCall") {
            stream.push({
              type: "toolcall_start",
              contentIndex: index,
              partial,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: part,
              partial,
            });
          }
        });

        stream.push({ type: "done", reason: stopReason, message: partial });
        stream.end(partial);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const aborted = options.signal.aborted;
        partial = buildMessage([], aborted ? "aborted" : "error", reason);
        stream.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: partial,
        });
        stream.end(partial);
      }
    })();

    return stream;
  };
};
