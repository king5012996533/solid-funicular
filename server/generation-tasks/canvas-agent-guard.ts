/**
 * 「花钱闸门」——半自动 Agent 的核心约束（2026-09-23，M2）
 *
 * 产品规则是用户定的：**Agent 可以自己干活，但不能自己刷卡**。
 * 任何会消耗积分的动作，必须先拿到用户点过「同意」的确认。
 *
 * 这条规则为什么不写在提示词里就够了：提示词是**建议**，模型会漏、会被用户的一句话带偏
 * （实测里用户说「直接开始生成，不用问我」，模型仍然先问了 —— 这是好结果，但不能指望它每次都这样）。
 * 所以真正兜底的必须是代码：`beforeToolCall` 里硬拦，拦下来的原因作为工具错误回给模型，
 * 它会自己去调 request_confirmation。
 *
 * 单独成文件的原因：这是**钱的开关**。放在执行器里和 400 行 Agent 逻辑混在一起，
 * 改的人看不到全貌、测的人也不好下手。这里只有一件事，且被单测钉死。
 */

/**
 * 会消耗积分的工具白名单式清单。
 *
 * 加新工具时**必须**同步考虑：它会不会让用户花钱？会就加进来。
 * 反过来说，没在这个清单里的工具不会拦 —— 所以清单是「允许花钱的入口」，
 * 而不是「禁止清单」。（新增付费工具却忘了加这里，就是一次静默的刷卡。）
 *
 * `run_nodes` 必须与 `run_node` 一起在清单里（2026-09-26 补）。
 *
 * 为什么：提示词一直让模型「批量出分镜图用 run_nodes」，而清单里只有 run_node ——
 * 于是**批量生成整条路绕过了服务端硬拦**：模型不用确认就能一次刷掉一整套分镜的钱。
 * 这是花钱的洞，不是文案问题。
 *
 * 语义差异（一次确认覆盖一批，不是每节点各确认一次）：闸门只回答「这次调用能不能跑」，
 * 一次 `run_nodes` 是**一次调用、一次确认**。批量要花多少由模型在 request_confirmation 的
 * `costPoints` / `summary` 里自己算清楚（那是给用户看的账），闸门不替它做乘法 ——
 * 单槽解锁（`approvedCallId`）的语义因此对两者完全一致，不需要额外的「批量子项」状态。
 */
export const PAID_CANVAS_AGENT_TOOLS = new Set<string>(["run_node", "run_nodes"]);

export interface SpendGuardDecision {
  blocked: boolean;
  /** 被拦时给模型的说明（会作为工具错误内容回给模型） */
  reason?: string;
}

export interface SpendGuard {
  /** request_confirmation 拿到「同意」后调用，解锁后续付费动作 */
  markApproved: (callId: string) => void;
  /** 本次任务里解锁过的确认调用 id（空串表示还没解锁） */
  readonly approvedCallId: string;
  /** beforeToolCall 每次调用前问一句：这个工具现在能不能跑 */
  check: (toolName: string) => SpendGuardDecision;
}

export const createSpendGuard = (): SpendGuard => {
  let approvedConfirmationId = "";

  return {
    markApproved(callId: string) {
      approvedConfirmationId = callId;
    },
    get approvedCallId() {
      return approvedConfirmationId;
    },
    check(toolName: string): SpendGuardDecision {
      if (!PAID_CANVAS_AGENT_TOOLS.has(toolName)) {
        return { blocked: false };
      }
      if (approvedConfirmationId) {
        return { blocked: false };
      }
      return {
        blocked: true,
        reason:
          `「${toolName}」会消耗用户积分，但本次任务还没有取得用户确认。` +
          "请先调用 request_confirmation，把「将要做什么、做几步、预计消耗多少积分」讲清楚，" +
          "等用户点同意之后再执行。不要绕过确认，也不要反复重试这个调用。",
      };
    },
  };
};
