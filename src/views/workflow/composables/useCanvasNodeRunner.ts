import { ref } from "vue";

/**
 * 画布节点的「执行器」注册表（2026-09-23）
 *
 * 为什么需要：节点的生成动作（buildRequest → 建任务 → 订阅事件 → 落库）实现在**节点组件内部**
 * （ImageNode 的 runGeneration 等），画布这一层没有可调用的入口。于是画布助手这类
 * 「替我跑一下这个节点」的能力就无处下手 —— 只能让用户自己点。
 *
 * 做法：节点挂载时把「用自身当前参数跑一次」的闭包注册进来，卸载时注销。
 *   - 不引入新的状态源：注册表本身不存业务数据，只是把组件内的能力暴露出来；
 *   - 失效安全：节点不在画面上（未挂载）时 hasNodeRunner 为 false，调用方给出明确提示，
 *     而不是静默什么都不发生。
 */
const runners = new Map<string, () => Promise<void> | void>();
/** 供 UI 判断「这个节点现在能不能被执行」，变化时响应式更新 */
export const runnerNodeIds = ref<string[]>([]);

/** 正在执行中的节点：同一次生成被重复触发时直接拒绝，避免重复建单、重复扣费 */
const runningNodeIds = new Set<string>();
/**
 * 本轮（一次 Agent 任务）已经成功触发过执行的节点。
 *
 * 为什么需要「本轮」这个粒度：实测同一个 30 秒广告会话里，三张母版各被提交了两次 ——
 * 模型先用 run_nodes 批量跑，随后从 get_canvas_state 看不到「已经跑过 / 已经有图」的证据，
 * 以为没跑，又对同一节点补了 run_node；两条路径各提交一次，同一句提示词就建了两张单。
 * 这里把「同一节点本轮只允许成功触发一次」钉死在唯一入口（runNodeById）上：
 * 这样批量与单个两条路径互相去重，任一先到即占位。失败的下一次仍允许重试。
 */
const triggeredNodeIds = new Set<string>();

/** 一轮 Agent 开始前清空去重状态（面板在每轮开跑前调用）。 */
export const beginAgentRunRound = () => {
  runningNodeIds.clear();
  triggeredNodeIds.clear();
};

export const registerNodeRunner = (
  nodeId: string,
  run: () => Promise<void> | void,
) => {
  if (!nodeId) return;
  runners.set(nodeId, run);
  runnerNodeIds.value = [...runners.keys()];
};

export const unregisterNodeRunner = (nodeId: string) => {
  if (!runners.delete(nodeId)) return;
  runnerNodeIds.value = [...runners.keys()];
};

export const hasNodeRunner = (nodeId: string) => runners.has(nodeId);

/** 「提交一次生成」的结果三态（工具层据此把回执说清楚，见 canvas-agent-tools 的 toSubmitReceipt） */
export interface NodeRunOutcome {
  ok: boolean;
  /**
   * submitted = 已提交、正在生成；duplicate = 本轮已提交过（不是失败，也没重复扣费）；
   * failed = 没提交成功（未挂载 / 提交阶段抛错）。
   */
  status: "submitted" | "duplicate" | "failed";
  reason?: string;
}

/**
 * 跑一次该节点。返回它自己的**提交结果**（成功/失败原因），不吞异常 ——
 * 调用方（例如画布助手）要把真实原因转述给用户，而不是假装成功。
 *
 * `await runner()` 现在只等到「提交完成」（节点组件在 taskId 落盘后即返回，不再等出图），
 * 所以这个入口**不会**卡几分钟。出图结果由节点自己的事件流落回画布。
 */
export const runNodeById = async (
  nodeId: string,
): Promise<NodeRunOutcome> => {
  // 去重闸门：同一节点「正在跑」或「本轮已经成功跑过」都只允许触发一次。
  // 放在这里而不是工具层：批量 run_nodes 与单个 run_node 都汇到这一个入口，
  // 谁先到谁占位，另一条路径拿到明确的失败原因（而不是静默再扣一次费）。
  if (runningNodeIds.has(nodeId)) {
    return { ok: false, status: "duplicate", reason: "该节点正在生成中，已忽略这次重复执行" };
  }
  if (triggeredNodeIds.has(nodeId)) {
    return {
      ok: false,
      status: "duplicate",
      reason: "本轮已经触发过该节点（重复提交会重复扣费），已忽略；要重新生成请新开一轮",
    };
  }
  const runner = runners.get(nodeId);
  if (!runner) return { ok: false, status: "failed", reason: "该节点未挂载或暂不支持直接执行" };
  runningNodeIds.add(nodeId);
  try {
    await runner();
    triggeredNodeIds.add(nodeId);
    return { ok: true, status: "submitted" };
  } catch (error) {
    // 失败不占位：本轮内仍允许对同一节点重试。
    return {
      ok: false,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    runningNodeIds.delete(nodeId);
  }
};
