/**
 * 画布 Agent 的「交付前自检」（2026-09-26）。
 *
 * 病灶：一轮跑完，模型说「已建好 8 个分镜」但画布上只有 5 个；它也不一定自己发现。
 * 我们的半自动闸门只有「花钱前」的 `request_confirmation`，**交付前没有任何检查**。
 *
 * 解法是 Pi 的原生 `finishTurn` 挂点：它在「assistant 与全部工具结果定稿之后、`turn_end` 之前」
 * 运行，可以返回 `{ action: "end" | "continue" }`（README 144-154 行；agent-loop.js:179-201）。
 * 这里提供的是**纯判定逻辑**：给定这一轮的交付事实，决定「收口」还是「再补一轮」，
 * 以及补那一轮要说的那句自检指令。真正把决定交给 Pi、把指令塞进队列的是执行器。
 *
 * 三条硬约束（改之前先读）：
 *   ① **必须能结束**：自检续跑次数有上限（`CANVAS_AGENT_MAX_SELF_CHECKS`），
 *      到顶必须收口 —— 无条件的 `continue` 会变成无限循环烧钱（README 154 行原文警告）。
 *   ② **不产生额外付费动作**：自检指令只让模型「补齐或如实汇报」，钱仍然走 `request_confirmation`
 *      （提示词里明写；服务端 `beforeToolCall` 硬拦不变）。
 *   ③ **如实**：判定「不成立」时，指令必须点名「声明了多少、实际多少、差多少 / 哪些动作失败」，
 *      并要求补齐或逐项说明原因，**不许粉饰**（本项目反复强调的口径）。
 *
 * 交付事实全部来自**真实回执**推导（复用导演控制台的事件折叠），不采信模型自报的数字。
 */

import {
  deriveCanvasAgentConsoleState,
  type CanvasAgentConsoleEvent,
} from "./canvas-agent-console-state";

/**
 * 参与自检的「生产动作」。
 *
 * 只有这些工具**失败**才算「交付不成立」—— 读画布、预校验、问用户失败都不算：
 * 它们失败通常可重试且本来就会把原文回给模型，拿它们触发自检只会白烧一轮钱。
 * 与花钱闸门同口径：`generate` 是收敛后的唯一生成入口，`run_node(s)` 是旧路径（仍保留）。
 */
export const CANVAS_AGENT_DELIVERY_TOOLS: ReadonlySet<string> = new Set<string>([
  "generate",
  "run_node",
  "run_nodes",
  "add_node",
  "add_nodes",
]);

/** 一轮任务里最多自检续跑多少次。到顶即收口，绝不无限循环。 */
export const CANVAS_AGENT_MAX_SELF_CHECKS = 2;

/** 本轮交付事实（全部由真实事件推导） */
export interface CanvasAgentDeliveryFacts {
  /** Agent 明确声明过的目标总数（没有声明就不给，界面与自检都不编分母） */
  declaredTotal?: number;
  declaredUnit?: string;
  /** 实际交付数：优先「成功创建/提交的节点数」，退到「已提交生成数」 */
  deliveredCount: number;
  /** 生产动作失败的次数（只数 CANVAS_AGENT_DELIVERY_TOOLS） */
  failedDeliveryCount: number;
  /** 失败过的生产工具名（去重，给自检指令点名用） */
  failedDeliveryTools: string[];
}

/**
 * 从本轮的导演控制台事件序列里汇总交付事实。
 *
 * 复用的是控制台那份**同一个** `deriveCanvasAgentConsoleState`：创建数 / 分母的解析口径只有一处，
 * 避免自检自己再写一份 JSON 解析（两套口径迟早漂移，这个仓库在这类「两边各写一份」上吃过亏）。
 */
export const summarizeCanvasAgentDelivery = (
  events: ReadonlyArray<CanvasAgentConsoleEvent>,
): CanvasAgentDeliveryFacts => {
  let declaredTarget: { total: number; unit: string } | undefined;
  const failedTools: string[] = [];

  for (const event of events) {
    if (event.declaredTarget && (!declaredTarget || event.declaredTarget.total > declaredTarget.total)) {
      declaredTarget = event.declaredTarget;
    }
    if (
      event.type === "tool_end"
      && event.ok === false
      && CANVAS_AGENT_DELIVERY_TOOLS.has(String(event.toolName || ""))
    ) {
      failedTools.push(String(event.toolName || ""));
    }
  }

  const state = deriveCanvasAgentConsoleState(events);
  const created = state.canvasActions?.created ?? 0;
  const deliveredCount = created > 0 ? created : (state.workflow?.output?.done ?? 0);

  return {
    ...(declaredTarget ? { declaredTotal: declaredTarget.total, declaredUnit: declaredTarget.unit } : {}),
    deliveredCount,
    failedDeliveryCount: failedTools.length,
    failedDeliveryTools: [...new Set(failedTools)],
  };
};

export type CanvasAgentSelfCheckAction = "end" | "continue";

/** end 的原因：正常收口 / 上游错误 / 还没到交付时刻 / 交付成立 / 有缺口但到上限 */
export type CanvasAgentSelfCheckReason =
  | "normal"
  | "error"
  | "in_progress"
  | "fulfilled"
  | "gap";

export interface CanvasAgentSelfCheckGap {
  declaredTotal: number;
  deliveredCount: number;
  unit: string;
  shortfall: number;
  failedDeliveryCount: number;
}

export interface CanvasAgentSelfCheckInput {
  /** 本轮最终 assistant 消息的 stopReason（error/aborted 时决策会被 Pi 忽略，直接收口） */
  stopReason?: string;
  /** 本轮 assistant 是否发起过工具调用（有 → 还在干活，不是交付时刻） */
  hasToolCalls: boolean;
  /** 本轮的工具结果数量（>0 → 还在干活） */
  toolResultCount: number;
  /** 本轮 assistant 是否产出了可见文本（没有文本就谈不上「交付」） */
  hasReportText: boolean;
  facts: CanvasAgentDeliveryFacts;
  /** 本次运行已经自检续跑过几次 */
  selfCheckCount: number;
  maxSelfChecks: number;
}

export interface CanvasAgentSelfCheckDecision {
  action: CanvasAgentSelfCheckAction;
  reason: CanvasAgentSelfCheckReason;
  /** 到上限仍未补齐（reason='gap' 且 capped）—— 执行器要如实记一笔日志 */
  capped?: boolean;
  gap?: CanvasAgentSelfCheckGap;
  /** action='continue' 时给下一轮的自检指令 */
  instruction?: string;
}

/**
 * 判定「这一轮的交付是否成立」。
 *
 * 只有**收尾回合**（纯文本、无工具调用、无工具结果）才做自检 —— 那是模型即将交付的时刻。
 * 还在调工具的回合一律不干预（返回 end，执行器映射为「不强制续跑」，Pi 的正常调度继续）。
 * 这样自检不会在链路中途插话、把正常的多轮工具流程带乱。
 */
export const decideCanvasAgentSelfCheck = (
  input: CanvasAgentSelfCheckInput,
): CanvasAgentSelfCheckDecision => {
  const stopReason = String(input.stopReason || "");
  if (stopReason === "error" || stopReason === "aborted") {
    return { action: "end", reason: "error" };
  }
  if (input.hasToolCalls || input.toolResultCount > 0 || !input.hasReportText) {
    return { action: "end", reason: "in_progress" };
  }

  const declared = input.facts.declaredTotal;
  const delivered = input.facts.deliveredCount;
  const shortfall = typeof declared === "number" ? Math.max(0, declared - delivered) : 0;
  const hasDeclaredShortfall = shortfall > 0;
  const hasFailedDelivery = input.facts.failedDeliveryCount > 0;

  if (!hasDeclaredShortfall && !hasFailedDelivery) {
    return { action: "end", reason: "fulfilled" };
  }

  const unit = String(input.facts.declaredUnit || "项").trim() || "项";
  const gap: CanvasAgentSelfCheckGap = {
    declaredTotal: typeof declared === "number" ? declared : 0,
    deliveredCount: delivered,
    unit,
    shortfall,
    failedDeliveryCount: input.facts.failedDeliveryCount,
  };

  if (input.selfCheckCount >= input.maxSelfChecks) {
    // 到上限：必须收口。缺口照实带在决策里，执行器记日志 —— 不在这里偷偷粉饰。
    return { action: "end", reason: "gap", capped: true, gap };
  }

  return {
    action: "continue",
    reason: "gap",
    gap,
    instruction: buildCanvasAgentSelfCheckInstruction(gap, input.facts),
  };
};

/**
 * 自检指令：一句能直接丢给模型的用户消息。
 *
 * 措辞的三处刻意设计：
 *   · 数字全部写死（声明 N / 实际 M / 差 N-M），免得模型自己再算一遍或含糊过去；
 *   · 「补齐，补不了就逐项说明原因，不要粉饰」——这是本项目的硬口径，写在指令里；
 *   · 明写「花钱动作仍先 request_confirmation」——自检**不产生额外付费动作**。
 */
export const buildCanvasAgentSelfCheckInstruction = (
  gap: CanvasAgentSelfCheckGap,
  facts: CanvasAgentDeliveryFacts,
): string => {
  const lines: string[] = ["【交付前自检】"];

  if (gap.declaredTotal > 0 && gap.shortfall > 0) {
    lines.push(
      `你在本轮声明要做 ${gap.declaredTotal} ${gap.unit}，实际只交付了 ${gap.deliveredCount} ${gap.unit}，`
      + `还差 ${gap.shortfall} ${gap.unit}。`,
    );
    lines.push(
      "请把差额补齐；确实补不了的，就逐项说明是哪一项没做到、为什么，"
      + "不要把没做的说成已做，也不要含糊过去（如实汇报比好看更重要）。",
    );
  }

  if (gap.failedDeliveryCount > 0) {
    const tools = facts.failedDeliveryTools.length
      ? facts.failedDeliveryTools.join("、")
      : "生产动作";
    lines.push(
      `本轮还有 ${gap.failedDeliveryCount} 次生产动作失败（${tools}）。`
      + "请重试补齐；重试仍失败就如实说明失败原因与影响。",
    );
  }

  lines.push("补齐如需花钱的动作，仍须先调用 request_confirmation 取得用户同意，不要绕过确认。");
  lines.push("如果上面每一项都已补齐或已如实说明，直接给出最终汇报即可，不要重复执行已完成的动作。");
  return lines.join("\n");
};
