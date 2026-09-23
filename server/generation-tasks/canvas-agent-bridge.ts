import type { AgentToolResultPayload } from "../../src/shared/generation-task-stream";

/**
 * 画布 Agent 的「客户端工具桥」（2026-09-23，M2）
 *
 * 为什么需要它：Agent 的大脑在服务端（Pi + 我们的网关），但**画布状态只存在于浏览器**。
 * 所以「读画布 / 加节点 / 问用户确认」这类工具没法在服务端直接执行，只能：
 *
 *   服务端 execute() ──发 tool_call 事件──▶ 浏览器真的执行 ──POST 回执──▶ 服务端继续
 *
 * 这个模块就是中间那张「等待中的回执表」：按 `recordId::callId` 挂起一个 Promise，
 * 浏览器 POST 回来时把它兑现；超时或任务结束就统一失败掉，绝不让 Agent 永远挂着。
 *
 * 两个刻意的设计：
 *   - **按 recordId 前缀索引**：同一进程可能同时跑多个用户的任务，callId 只保证任务内唯一，
 *     不做前缀隔离会串台（A 用户的回执打到 B 用户的任务上）。
 *   - **超时即失败，不是静默重试**：浏览器可能已经关掉/断网。宁可让模型知道「这一步没人执行」，
 *     也不要让它以为改成功了 —— 那会产出「报告说做了、画布上没有」这种最糟的结果。
 */

/**
 * 注意：这里的定时器**故意不 unref**。unref 会让「只剩这个等待」时进程直接退出
 * （单测里就当场表现为 unsettled top-level await），而正在等浏览器回执恰恰是
 * 一个合法的工作状态。清理靠 executor 的 finally → cancelPendingClientToolCalls，
 * 不靠「进程顺手退出」。
 */
interface PendingClientToolCall {
  recordId: string;
  callId: string;
  toolName: string;
  resolve: (payload: AgentToolResultPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingCalls = new Map<string, PendingClientToolCall>();

const buildKey = (recordId: string, callId: string) => `${recordId}::${callId}`;

export class ClientToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `等待浏览器执行「${toolName}」超过 ${Math.round(timeoutMs / 1000)} 秒未返回结果` +
        "（页面可能已关闭或断线）。这一步没有生效，请不要假设它已完成。",
    );
    this.name = "ClientToolTimeoutError";
  }
}

/**
 * 挂起等待浏览器回执。
 *
 * `onTimeout` 用来区分「超时」与「任务被用户停止」两种失败 —— 前者提示用户回页面，
 * 后者应该走停止收口（不要退款、不要报错）。
 */
export const waitForClientToolResult = (input: {
  recordId: string;
  callId: string;
  toolName: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AgentToolResultPayload> => {
  const { recordId, callId, toolName, timeoutMs, signal } = input;
  const key = buildKey(recordId, callId);

  return new Promise<AgentToolResultPayload>((resolve, reject) => {
    const settle = (fn: () => void) => {
      const entry = pendingCalls.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingCalls.delete(key);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new ClientToolTimeoutError(toolName, timeoutMs)));
    }, timeoutMs);
    const onAbort = () => {
      settle(() => reject(new Error("任务已停止，客户端工具调用被取消")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pendingCalls.set(key, {
      recordId,
      callId,
      toolName,
      timer,
      resolve: (payload) => settle(() => resolve(payload)),
      reject: (error) => settle(() => reject(error)),
    });
  });
};

/**
 * 浏览器回执入口。
 *
 * 返回 false 表示这次回执没有对应的等待者 —— 常见于「服务端已经超时收口，回执才到」。
 * 这不是错误，但值得记日志：如果频繁出现，说明前端执行太慢或超时设得太短。
 */
export const resolveClientToolResult = (
  recordId: string,
  payload: AgentToolResultPayload,
) => {
  const key = buildKey(recordId, payload.callId);
  const entry = pendingCalls.get(key);
  if (!entry) return false;
  entry.resolve(payload);
  return true;
};

/** 任务结束（完成/失败/停止）时清空该任务剩下的等待者，避免悬挂的 Promise 泄漏 */
export const cancelPendingClientToolCalls = (
  recordId: string,
  reason: string,
) => {
  /**
   * 只调 entry.reject，**不在这里自己清 map**。
   *
   * 兑现逻辑（settle）要先在 map 里找到这一项才肯 settled —— 提前删掉会让它以为
   * 「已经兑现过了」，直接返回，于是 Promise 永远不 settle。
   * 这个坑是被单测逼出来的：进程挂在 `unsettled top-level await` 上，界面上的表现
   * 则是「任务停了但 Agent 那一步永远不结束」。
   */
  for (const entry of [...pendingCalls.values()]) {
    if (entry.recordId !== recordId) continue;
    entry.reject(new Error(reason));
  }
};

/** 诊断用：当前有多少个挂起的客户端工具调用（排查「任务停不下来」时很有用） */
export const getPendingClientToolCallCount = (recordId?: string) => {
  if (!recordId) return pendingCalls.size;
  let count = 0;
  for (const entry of pendingCalls.values()) {
    if (entry.recordId === recordId) count += 1;
  }
  return count;
};
