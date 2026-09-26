import { buildApiUrl } from "./http";
import { readApiData } from "./response";
import type { PersistedGenerationRecord } from "./generation-records";
import { consumeSseStream, type SseMessage } from "@/utils/sse";
import type { GenerationTaskStreamEventBase } from "@/shared/generation-task-stream";
import type { ResearchTaskConfig } from "@/shared/research/research-types";
import { resolveModelSelection } from "@/config/models";

// 重新导出失败码，便于业务代码 import { GenerationTaskFailureCode } from '@/api/generation-tasks'
export type { GenerationTaskFailureCode } from "@/shared/generation-task-stream";

export interface GenerationTaskStartPayload {
  sessionId?: string;
  source?: string;
  // 服务端已补齐 video 执行策略（异步任务制），这里同步放开
  type: "image" | "video" | "agent" | "research";
  requestMode?: "image-generation" | "image-edit";
  prompt: string;
  model?: string;
  modelKey?: string;
  ratio?: string;
  resolution?: string;
  duration?: string;
  feature?: string;
  skill?: string;
  referenceImages?: string[];
  /** 局部重绘蒙版（/uploads 路径，PNG 带透明通道）；透明处 = 允许重绘的区域 */
  mask?: string;
  researchConfig?: Partial<ResearchTaskConfig> | null;
  requestBody?: Record<string, unknown>;
}

interface RequestOptions {
  signal?: AbortSignal;
}

export interface ResolvedGenerationTaskModelInput {
  modelKey?: string;
  fallbackModelKey?: string;
  // 服务端补齐 video 策略后，视频节点也要用这条解析（原来只有 CHAT/IMAGE）
  category: "CHAT" | "IMAGE" | "VIDEO";
  missingProviderMessage?: string;
  missingModelMessage?: string;
}

export interface ResolvedGenerationTaskModelResult {
  providerId: string;
  modelKey: string;
}

// 前端的 record 收紧为持久化记录类型
export type GenerationTaskStreamEvent =
  GenerationTaskStreamEventBase<PersistedGenerationRecord>;

const GENERATION_TASKS_API_PATH = "/api/generation-tasks";

/**
 * 统一解析生成任务提交前要使用的厂商与模型。
 *
 * 解析交给 config/models 的 resolveModelSelection：原选模型已下架时，
 * 那里会先强拉一次目录、再回落到该分类的默认模型，并给出一条可见提示
 * （「原选模型「X」已下架，已切换为「Y」」）—— 既不让用户卡死在
 * 「未匹配到后台模型配置」上，也不会静默把他的选择换掉。
 *
 * 只有该分类在后台一个可用模型都没有时，这里才按原样报错。
 */
export const resolveGenerationTaskModel = async (
  input: ResolvedGenerationTaskModelInput,
): Promise<ResolvedGenerationTaskModelResult> => {
  const resolved = await resolveModelSelection({
    modelKey: input.modelKey,
    fallbackModelKey: input.fallbackModelKey,
    category: input.category,
  });

  if (!resolved) {
    throw new Error(
      input.missingProviderMessage ||
        "未匹配到后台模型配置，请先在后台配置可用模型",
    );
  }

  if (!resolved.modelKey) {
    throw new Error(input.missingModelMessage || "缺少模型标识");
  }

  return {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
  };
};

// 创建服务端生成任务，由后端继续运行并持续写回生成记录。
export const createGenerationTask = async (
  payload: GenerationTaskStartPayload,
  options: RequestOptions = {},
) => {
  const response = await fetch(buildApiUrl(GENERATION_TASKS_API_PATH), {
    method: "POST",
    credentials: "include",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readApiData<PersistedGenerationRecord>(response, {
    showErrorMessage: true,
  });
};

// 获取单个服务端任务对应的最新生成记录。
export const getGenerationTask = async (
  taskId: string,
  options: RequestOptions = {},
) => {
  const response = await fetch(
    buildApiUrl(`${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}`),
    {
      method: "GET",
      credentials: "include",
      signal: options.signal,
    },
  );

  return readApiData<PersistedGenerationRecord>(response);
};

// 停止服务端仍在运行的生成任务。
export const stopGenerationTask = async (
  taskId: string,
  options: RequestOptions = {},
) => {
  const response = await fetch(
    buildApiUrl(
      `${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}/stop`,
    ),
    {
      method: "POST",
      credentials: "include",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  return readApiData<PersistedGenerationRecord>(response, {
    showErrorMessage: true,
  });
};

/**
 * 画布 Agent 的「工具回执」：服务端发来 tool_call，浏览器真的执行完之后从这里回传结果。
 *
 * 为什么不复用 createGenerationTask 那条路：这是同一个任务内的**子调用**，不是新任务。
 * 用独立端点可以让服务端按 taskId 做归属校验（别人的任务查不到就直接 404）。
 *
 * 返回值里的 `accepted: false` 表示服务端已经不在等这个回执了（多半是超时收口），
 * 不是错误 —— 调用方记一条日志即可。
 */
export const postGenerationTaskToolResult = async (
  taskId: string,
  payload: {
    callId: string;
    name?: string;
    ok: boolean;
    result: string;
    summary?: string;
    details?: Record<string, unknown>;
  },
  options: RequestOptions = {},
) => {
  const response = await fetch(
    buildApiUrl(
      `${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}/tool-result`,
    ),
    {
      method: "POST",
      credentials: "include",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  return readApiData<{ accepted: boolean }>(response);
};

/** 插话方式：`steer` = 插入当前轮；`follow-up` = 排到这一轮之后 */
export type GenerationTaskInterjectionMode = "steer" | "follow-up";

export interface SteerGenerationTaskResult {
  accepted: boolean;
  mode: GenerationTaskInterjectionMode;
  /** accepted=false 时的可读原因（这一轮已结束、内容为空等） */
  reason?: string;
}

/**
 * 一轮内插话：把用户新输入投递给**正在跑的那个 Agent 的队列**。
 *
 * 关键与工具回执一致：这是**同一个任务内的输入**，不是新任务 —— 用独立端点（`/steer`）而不是
 * `createGenerationTask`，避免用户插一句话就并发起第二个任务去抢同一把画布锁。
 * `accepted:false` 表示投递没成功（多半这一轮刚结束），调用方要如实提示，不能假装已送达。
 */
export const steerGenerationTask = async (
  taskId: string,
  payload: { content: string; mode?: GenerationTaskInterjectionMode },
  options: RequestOptions = {},
): Promise<SteerGenerationTaskResult> => {
  const response = await fetch(
    buildApiUrl(
      `${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}/steer`,
    ),
    {
      method: "POST",
      credentials: "include",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  return readApiData<SteerGenerationTaskResult>(response);
};

// 订阅任务的实时状态事件流，页面切换回来后可直接重连。// 已内置自动重连（指数退避）+ watchdog（30s 无消息视为断流）。
const ALLOWED_STREAM_EVENT_TYPES = new Set([
  "message",
  "text",
  "end",
  "connected",
  "snapshot",
  "progress",
  "content_delta",
  "thinking_delta",
  "agent_event",
  "begin",
  "stage_changed",
  "reasoning_summary",
  "tool_call",
  "tool_result",
  "evidence_added",
  "fact_update",
  "verification",
  "outline_ready",
  "section_delta",
  "token_usage",
  // 制片 Agent 的导演控制台状态（只给界面渲染，不属于消息正文）
  "console_state",
  "completed",
  "failed",
  "stopped",
]);
const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "stopped", "end"]);
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const WATCHDOG_TIMEOUT_MS = 30000;
const WATCHDOG_CHECK_INTERVAL_MS = 5000;

/**
 * 429（当前用户实时订阅已达上限）的专用错误。
 *
 * 与「任务不存在 / 鉴权失败」这类永久性 4xx 区别对待：它多半是别的页面还挂着连接，
 * 退避后重连通常就能接上，所以走可重试分支；重试仍失败才提示用户。
 */
class SubscriptionCapacityError extends Error {}

const readErrorMessageFromBody = async (response: Response): Promise<string> => {
  try {
    const text = (await response.text()).trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      return typeof parsed?.message === "string" ? parsed.message.trim() : "";
    } catch {
      return text;
    }
  } catch {
    return "";
  }
};

export const subscribeGenerationTaskEvents = async (
  taskId: string,
  options: RequestOptions & {
    onEvent: (event: GenerationTaskStreamEvent) => void;
  },
) => {
  const externalSignal = options.signal;
  let attempt = 0;
  let terminated = false;
  // 跟踪最后一个收到事件的 id，重连时传给服务端用于重放遗漏事件
  let lastEventId = 0;
  // 最近一次「订阅额度已满」的错误：重试都失败时用它拼一条可读提示
  let lastCapacityError: SubscriptionCapacityError | null = null;

  while (!terminated) {
    if (externalSignal?.aborted) return;

    const innerController = new AbortController();
    const onExternalAbort = () => innerController.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);

    // watchdog：超过 30s 没收到任何事件（含心跳）就视为断流，主动 abort 触发重连
    let lastActivityAt = Date.now();
    const watchdogTimer = setInterval(() => {
      if (Date.now() - lastActivityAt > WATCHDOG_TIMEOUT_MS) {
        innerController.abort();
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);

    let connected = false;
    try {
      const url =
        lastEventId > 0
          ? `${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}/events?lastEventId=${lastEventId}`
          : `${GENERATION_TASKS_API_PATH}/${encodeURIComponent(taskId)}/events`;
      const response = await fetch(buildApiUrl(url), {
        method: "GET",
        credentials: "include",
        signal: innerController.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          // 用户级实时订阅已满：当作可重试（多数是别的页面/Tab 还挂着连接，稍等就腾出来了），
          // 文案取服务端给的那句中文，别再抛「订阅任务状态失败 (429)」这种读不懂的。
          const detail = await readErrorMessageFromBody(response);
          throw new SubscriptionCapacityError(
            detail || "当前实时订阅数量已达上限，请关闭部分页面后重试",
          );
        }
        // HTTP 4xx/5xx 不重试（鉴权失败 / 任务不存在等永久错误）
        throw new Error(`订阅任务状态失败 (${response.status})`);
      }

      connected = true;
      attempt = 0; // 一旦成功连接就重置退避计数

      await consumeSseStream(response, (message: SseMessage) => {
        lastActivityAt = Date.now();
        // 心跳事件仅用于刷新 watchdog，不向上派发
        if (message.event === "ping") return;

        try {
          const parsed = JSON.parse(
            message.data,
          ) as GenerationTaskStreamEvent & { type?: string };
          const normalizedEventType =
            message.event === "message"
              ? String(parsed?.type || "").trim()
              : message.event;
          if (!ALLOWED_STREAM_EVENT_TYPES.has(normalizedEventType)) return;
          // 跟踪 lastEventId（优先 SSE 协议层 id，其次 payload.id）
          const incomingId = message.id
            ? Number.parseInt(message.id, 10)
            : typeof parsed.id === "number"
              ? parsed.id
              : 0;
          if (Number.isFinite(incomingId) && incomingId > lastEventId) {
            lastEventId = incomingId;
          }
          options.onEvent(parsed as GenerationTaskStreamEvent);
          if (TERMINAL_EVENT_TYPES.has(normalizedEventType)) {
            terminated = true;
            /**
             * 终态事件到手就主动断开这条连接。
             *
             * 服务端发完 completed/failed/stopped **不会自己 end()** —— 它只负责发事件，
             * 连接靠 15s 心跳一直保活到寿命上限（SSE_MAX_CONNECTION_MS，默认 30 分钟）。
             * 而每条订阅都占着用户的实时订阅额度（SSE_PER_USER_LIMIT，默认 20），
             * 攒满之后所有订阅一律 429，就是用户看到的「订阅任务状态失败 (429)」。
             *
             * 之所以收口在这里、而不是让每个调用方自己记得 abort：调用点有六个
             * （画布图片节点四处、视频节点、助手面板、生成页、工作流对话），
             * 漏掉任何一个，那条路径就每条任务白占一个额度半小时。放在这里，
             * 所有调用方一次性对齐 —— 谁都不必记得这件事。
             *
             * 注意断的是本轮的内层 controller，不是调用方传进来的 signal：
             * 助手面板把外部 signal 同时给了画布桥，断它会把在途工具执行一起取消。
             */
            innerController.abort();
          }
        } catch {
          // 忽略解析失败的事件消息。
        }
      });
    } catch (error) {
      // 用户主动取消：直接退出，不重连
      if (externalSignal?.aborted) return;
      // 已经收到终止事件后再抛错也直接退出
      if (terminated) return;
      if (error instanceof SubscriptionCapacityError) {
        // 订阅额度暂时满了：记住它，走下面的退避重连，别立刻失败
        lastCapacityError = error;
      } else {
        // 永久性 HTTP 错误（4xx/5xx response.ok=false）不重试
        const message = error instanceof Error ? error.message : "";
        if (/订阅任务状态失败 \(4\d{2}\)/.test(message)) throw error;
      }
    } finally {
      clearInterval(watchdogTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    if (terminated || externalSignal?.aborted) return;

    // 退避后重连
    if (attempt >= RETRY_DELAYS_MS.length) {
      // 额度类错误重试到底仍然失败：给出人能看懂、能照做的提示，而不是原始状态码
      if (lastCapacityError) {
        throw new Error(`${lastCapacityError.message}（已自动重试 ${attempt} 次仍未成功）`);
      }
      throw new Error("订阅任务状态失败：超过最大重试次数");
    }
    const delay = RETRY_DELAYS_MS[attempt];
    attempt++;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      externalSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        { once: true },
      );
    });
    if (!connected && attempt === 1) {
      // 首次连接就失败，可能是网络层问题，继续重试
    }
  }
};
