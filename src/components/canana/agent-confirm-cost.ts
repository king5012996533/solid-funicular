/**
 * 确认卡的「预扣积分」显示（纯逻辑，2026-09-26）
 *
 * 产品决策：**画布 Agent 不参与任何积分计算**。积分是我们**提前前置**的（生成即预扣），
 * Agent 只需告诉用户「生成过程会预扣积分」，不够就由服务端拦下 —— 跟人手动在画布上点生成
 * 是同一个预扣费模型。
 *
 * 所以确认卡上的数字**只能来自服务端估算**（`/api/points/estimate`），模型自报的
 * `costPoints` 一律忽略：实测它心算**低估 3 倍**（卡片写 2 分、实际扣 12 分）。拿不到服务端数字
 * 就只显示预扣语义说明，绝不用模型给的数充数。
 *
 * 为什么抽成独立纯模块（不依赖 Vue）：确认卡渲染在 `RightPanel.vue` 里，node 单测挂不起来；
 * 把「取哪些节点 id」「降级文案」「是否显示数字」做成纯函数，测试可以直接断言。
 */

/** 降级文案：拿不到服务端估算时显示的预扣语义（必须写清「预扣 / 服务端拦下 / 失败退还」）。 */
export const AGENT_CONFIRM_PREDEDUCT_NOTICE =
  "本操作会「预扣」积分；余额不足会被服务端拦下，失败将自动退还。";

export interface AgentConfirmCostDisplay {
  /** 服务端估算的预扣积分；拿不到为 null —— 绝不回退模型自报的数字 */
  estimatedPoints: number | null;
  /** 预扣语义说明（始终显示） */
  notice: string;
  /** 当时可用余额（服务端给得到才显示，否则 null） */
  balanceText: string | null;
}

const readNonNegativeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;

/**
 * 由服务端事实拼出确认卡的显示内容。
 *
 * 入参刻意**不含**模型自报的 `costPoints` —— 这样「卡片可能显示模型编的数字」在类型上就不成立。
 */
export const resolveAgentConfirmCostDisplay = (input: {
  estimated?: unknown;
  available?: unknown;
}): AgentConfirmCostDisplay => {
  const estimatedPoints = readNonNegativeNumber(input.estimated);
  const available = readNonNegativeNumber(input.available);
  return {
    estimatedPoints,
    notice: AGENT_CONFIRM_PREDEDUCT_NOTICE,
    balanceText: available === null ? null : `当前可用积分 ${available}`,
  };
};

/**
 * 从确认入参里找出「这次动作涉及哪些节点」，供服务端估算用。
 *
 * 优先结构化 `nodeIds`（模型若已知目标节点就填它）；拿不到时退而扫描 `items` 文本里出现的
 * 已知节点 id。只认画布上真实存在的节点（`knownNodeIds`）—— 编造的 id 不参与估算，
 * 免得算出一个和实际动作无关的数字，反而比不显示更误导。
 */
export const collectConfirmationNodeIds = (input: {
  nodeIds?: unknown;
  items?: unknown;
  knownNodeIds?: unknown;
}): string[] => {
  const known = new Set(
    (Array.isArray(input.knownNodeIds) ? input.knownNodeIds : [])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim()),
  );
  const picked: string[] = [];
  const push = (id: string) => {
    if (known.size && !known.has(id)) return;
    if (!picked.includes(id)) picked.push(id);
  };

  if (Array.isArray(input.nodeIds)) {
    for (const raw of input.nodeIds) {
      if (typeof raw !== "string") continue;
      const id = raw.trim();
      if (id) push(id);
    }
  }
  if (!picked.length && known.size && Array.isArray(input.items)) {
    for (const raw of input.items) {
      if (typeof raw !== "string") continue;
      for (const id of known) {
        if (raw.includes(id)) push(id);
      }
    }
  }
  return picked;
};
