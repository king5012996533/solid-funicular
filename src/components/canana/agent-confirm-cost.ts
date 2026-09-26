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
 *
 * ── 2026-09-26 追加：复用预校验的服务端数字（缓存） ──
 * 确认卡原先自己再打一次 `/api/points/estimate`（从入参解析节点 → 请求），这条弱路径经常拿不到
 * 整批（返回 204 / 节点解析不全）→ 一律降级成通用文案，用户看不到「这一批到底要花多少」。
 * 而 `preflight_check` 在同一批上**已经**算出过服务端总额与余额。于是把那份结果缓存到
 * 本模块（模块级单例，工具的写入方与面板的读取方引的是同一份），确认时按**目标节点集合**
 * 精确取用。缓存里只有服务端值 —— 模型自报的数字依旧没有任何入口。
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
  const rawEstimated = readNonNegativeNumber(input.estimated);
  /**
   * **0 与负数一律按「拿不到」处理**：0 不是「不花钱」，而是「没估出来价」
   * （实测 `/api/points/estimate` 返回 204 时就是 0）。显示「预扣 0 分」是**报错的数字**，
   * 比降级成通用文案糟糕得多 —— 产品口径是「宁可不说数字，也不说错的」。
   */
  const estimatedPoints = rawEstimated !== null && rawEstimated > 0 ? rawEstimated : null;
  const available = readNonNegativeNumber(input.available);
  return {
    estimatedPoints,
    notice: AGENT_CONFIRM_PREDEDUCT_NOTICE,
    balanceText: available === null ? null : `当前余额 ${available}`,
  };
};

/**
 * 预校验估算缓存的有效期。
 *
 * 5 分钟：够覆盖「刚预校验完 → 用户读完确认卡 → 点同意」的正常节奏，又不至于让一个明显过时的
 * 数字（期间用户可能在别处花了/充了积分）继续冒充「当前」。
 */
export const PREFLIGHT_ESTIMATE_TTL_MS = 5 * 60_000;

interface PreflightEstimateEntry {
  /** 服务端给出的整批预估总额（原始值，展示时只做取整） */
  estimatedCostTotal: number;
  /** 当时的可用余额；服务端没给到就是 null（显示时只省略余额那一行，估算照常显示） */
  availablePoints: number | null;
  /** 过期时刻（毫秒） */
  expiresAt: number;
}

/** 模块级缓存：键 = 目标节点集合的规范化串，值 = 那一批的服务端事实 */
const preflightEstimates = new Map<string, PreflightEstimateEntry>();

/**
 * 把一组节点 id 规范化成缓存键：**去重 + 排序**。
 *
 * 顺序无关是必须的 —— 同一批节点，预校验按画布顺序给、确认按模型叙述顺序给，是常事；
 * 若按原序拼键，同一批会被当成两批，白白降级。用 `\n` 当分隔符（节点 id 里不会出现它），
 * 避免 `["a","b"]` 与 `["ab"]` 这类拼接歧义。
 */
export const normalizePreflightNodeKey = (nodeIds: unknown): string => {
  const unique = new Set(
    (Array.isArray(nodeIds) ? nodeIds : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  return [...unique].sort().join("\n");
};

const pruneExpiredPreflightEstimates = (now: number): void => {
  for (const [key, entry] of preflightEstimates) {
    if (now >= entry.expiresAt) preflightEstimates.delete(key);
  }
};

/** 清空缓存（单测隔离用；正式流程没有调用方） */
export const clearPreflightEstimates = (): void => {
  preflightEstimates.clear();
};

/**
 * 记下 `preflight_check` 刚算出的服务端事实。
 *
 * 只在「有服务端总额」时写入：拿不到总额（预估接口失败）就没什么可缓存的，返回 false 让调用方
 * 知道这次没记。余额缺失仍会写入 —— 卡片届时只显示估算那一行（比整条降级更有用，且不失真）。
 */
export const rememberPreflightEstimate = (input: {
  nodeIds?: unknown;
  estimatedCostTotal?: unknown;
  availablePoints?: unknown;
  /** 注入时钟（默认 Date.now()），单测据此造过期场景 */
  now?: number;
  /** 覆盖 TTL（默认 PREFLIGHT_ESTIMATE_TTL_MS） */
  ttlMs?: number;
}): boolean => {
  const key = normalizePreflightNodeKey(input.nodeIds);
  const estimatedCostTotal = readNonNegativeNumber(input.estimatedCostTotal);
  /**
   * 只在**拿到正数总额**时才缓存。
   *
   * 为什么不能收 0：实测（`points-check` 真机验收）出现
   * `/api/points/estimate` 返回 204、估算拿不到价，`totalEstimated` 就是 **0** ——
   * 若把 0 当有效数字缓存，确认卡会「自信地」显示「本批将预扣 **0 分**」（一张图实际 6 分）。
   * 这比降级更糟：降级只是不说数字，报 0 是**报错的数字**。宁可不缓存，让它降级。
   */
  if (estimatedCostTotal === null || estimatedCostTotal <= 0) return false;
  if (!key) return false;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? input.ttlMs
      : PREFLIGHT_ESTIMATE_TTL_MS;
  pruneExpiredPreflightEstimates(now);
  preflightEstimates.set(key, {
    estimatedCostTotal,
    availablePoints: readNonNegativeNumber(input.availablePoints),
    expiresAt: now + ttlMs,
  });
  return true;
};

/**
 * 按「本次要确认的目标节点集合」取回那一批的服务端事实。
 *
 * **精确匹配才算命中**：集合必须完全一致（多一个/少一个都不行），空集合永不命中。
 * 这样才不会把 A 批的总额安到 B 批头上 —— 拿不准就返回 null，由调用方降级。
 */
export const readPreflightEstimate = (input: {
  nodeIds?: unknown;
  now?: number;
}): { estimatedCostTotal: number; availablePoints: number | null } | null => {
  const key = normalizePreflightNodeKey(input.nodeIds);
  if (!key) return null;
  const entry = preflightEstimates.get(key);
  if (!entry) return null;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  if (now >= entry.expiresAt) {
    preflightEstimates.delete(key);
    return null;
  }
  return { estimatedCostTotal: entry.estimatedCostTotal, availablePoints: entry.availablePoints };
};

/**
 * 确认卡的显示入口：命中缓存就用服务端数字，否则降级。
 *
 * 入参只有「目标节点 id」与时钟 —— 模型自报的 `costPoints` 结构上依旧进不来。
 */
export const resolveAgentConfirmCostDisplayFromCache = (input: {
  nodeIds?: unknown;
  now?: number;
}): AgentConfirmCostDisplay => {
  const facts = readPreflightEstimate(input);
  return resolveAgentConfirmCostDisplay({
    estimated: facts?.estimatedCostTotal,
    available: facts?.availablePoints ?? undefined,
  });
};

/**
 * 从确认入参里找出「这次动作涉及哪些节点」，供缓存查找用。
 *
 * 优先结构化 `nodeIds`（模型若已知目标节点就填它）；拿不到时退而扫描 `items` 文本里出现的
 * 已知节点 id。只认画布上真实存在的节点（`knownNodeIds`）—— 编造的 id 不参与匹配，
 * 免得查出一个和实际动作无关的数字，反而比不显示更误导。
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
