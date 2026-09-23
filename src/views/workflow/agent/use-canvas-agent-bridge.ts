/**
 * 画布 Agent 的客户端桥（2026-09-23，M2）
 *
 * 服务端的制片 Agent（Pi 循环）够不到画布 —— 画布状态在浏览器里。所以每一轮工具调用是这样走的：
 *
 *   服务端 execute() ──SSE tool_call──▶ 这里真的执行 ──POST tool-result──▶ 服务端继续推理
 *
 * 这个 composable 的职责边界很窄，但每一条都有原因：
 *   - **只负责执行 + 回执**：模型怎么想、提示词怎么写都在服务端，这里不做任何决策；
 *   - **失败也要回执**：工具抛错时把原因回给模型（它自己会决定换做法），而不是让服务端干等；
 *   - **回执必带 callId**：服务端按 callId 配对；漏了它，那一步会一直挂到超时；
 *   - **abort 时停止回执**：用户点了停止就别再往服务端推东西了。
 *
 * 这样「模型看不到结果就一遍遍重调同一个工具」这类循环，在服务端是明确的失败原因，而不是静默卡死。
 */
import { postGenerationTaskToolResult } from "@/api/generation-tasks";
import type { AgentToolCallPayload } from "@/shared/generation-task-stream";
import {
  executeCanvasAgentTool,
  type CanvasAgentContext,
  type CanvasAgentToolResult,
} from "./canvas-agent-tools";

export interface CanvasAgentToolStep {
  index: number;
  name: string;
  label: string;
  summary: string;
  ok: boolean;
}

export interface UseCanvasAgentBridgeOptions {
  /** 每次执行时现取画布上下文（画布随时在变，不能在某个时刻缓存住） */
  getContext: () => CanvasAgentContext | null;
  /** 工具执行完通知界面（用于在对话里列出「它做了什么」） */
  onStep?: (step: CanvasAgentToolStep) => void;
}

/** 工具名 → 中文展示名（来自服务端下发的 label；服务端没给就退回工具名） */
const resolveLabel = (call: AgentToolCallPayload) => call.label || call.name;

export const useCanvasAgentBridge = (options: UseCanvasAgentBridgeOptions) => {
  let stepCount = 0;
  /** 已经处理过的 callId：SSE 断线重连会重放事件，不去重就会把同一个工具执行两遍（加两个节点） */
  const handledCallIds = new Set<string>();

  const reset = () => {
    stepCount = 0;
    handledCallIds.clear();
  };

  /**
   * 服务端要求执行一个工具。返回值只用于日志/展示，回执已经在这里发出去了。
   */
  const runToolCall = async (
    taskId: string,
    call: AgentToolCallPayload,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!call?.callId || handledCallIds.has(call.callId)) {
      return;
    }
    handledCallIds.add(call.callId);

    const label = resolveLabel(call);
    let outcome: CanvasAgentToolResult;
    const context = options.getContext();

    try {
      if (!context) {
        outcome = {
          ok: false,
          result:
            "画布还没有准备好（页面正在初始化或已切走），这次工具调用没有执行。请稍后重试。",
          summary: "画布未就绪",
        };
      } else {
        outcome = await executeCanvasAgentTool(
          call.name,
          call.args || {},
          context,
        );
      }
    } catch (error) {
      // 工具自己抛错不能吞掉：要把它变成一条正常回执，让模型知道为什么没成
      const reason = error instanceof Error ? error.message : String(error);
      outcome = {
        ok: false,
        result: `工具执行时出现异常：${reason}`,
        summary: `${label} 执行异常：${reason}`,
      };
    }

    stepCount += 1;
    options.onStep?.({
      index: stepCount,
      name: call.name,
      label,
      summary: outcome.summary,
      ok: outcome.ok,
    });

    if (signal?.aborted) {
      // 用户已经叫停：这条回执发过去也没意义了（服务端那边同样在收口）
      return;
    }

    try {
      await postGenerationTaskToolResult(taskId, {
        callId: call.callId,
        name: call.name,
        ok: outcome.ok,
        result: outcome.result,
        summary: outcome.summary,
        details: { toolName: call.name, args: call.args || {} },
      });
    } catch (error) {
      // 回执发不出去（断网/服务端已收口）只记日志：服务端会超时收口，界面也会收到终态事件
      console.warn("[canvas-agent-bridge] 工具回执发送失败", call.name, error);
    }
  };

  /**
   * 从任务事件流里挑出属于桥的事件。
   *
   * 返回 true 表示「这个事件我处理了」，调用方可以跳过自己那条分支。
   */
  const handleStreamEvent = (
    taskId: string,
    event: { type?: string; agentToolCall?: AgentToolCallPayload },
    signal?: AbortSignal,
  ): boolean => {
    if (event?.type !== "tool_call" || !event.agentToolCall) {
      return false;
    }
    void runToolCall(taskId, event.agentToolCall, signal);
    return true;
  };

  return {
    handleStreamEvent,
    reset,
    get stepCount() {
      return stepCount;
    },
  };
};
