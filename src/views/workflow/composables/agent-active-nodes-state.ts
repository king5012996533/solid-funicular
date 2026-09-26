/**
 * Agent 画布动作高亮的纯逻辑（批次 3「画布动作可视化」）。
 *
 * 为什么单开一份、**绝不写进 node.data**：
 *   node.data 是画布持久化的一部分（自动保存 → nodesJson → 快照/版本）。
 *   把「Agent 正在创建/正在生成」塞进去，会弄脏画布、触发无谓的自动保存、还会被版本快照记住，
 *   刷新后还可能残留一圈「永远发光」的描边。所以高亮只是一份**瞬时 UI 状态**：
 *   `{ 刚创建: id→到期时刻, 生成中: id→错开序号 }`，与画布数据毫无交集。
 *
 * 这一层刻意是纯函数（不 import vue）：状态迁移（标记/清除/TTL/错开序号）可被 Node 里的单测直接断言。
 * 真正响应式的单例在 `useAgentActiveNodes.ts`，它只负责把这里的纯函数接到 ref 上。
 */

/** 「刚创建」高亮的存活时长：够看清它在批量铺开，又不至于长期挂着 */
export const AGENT_CREATED_TTL_MS = 4000;
/** 同一次批量里每个节点错开点亮的间隔：40~80ms 之间，看得出「它在批量铺」但不拖沓 */
export const AGENT_STAGGER_STEP_MS = 60;

export interface AgentActiveNodeMark {
  id: string;
  /** 同批内的错开序号：0,1,2…（只用于 CSS animation-delay，不入画布数据） */
  order: number;
}

interface CreatedEntry {
  order: number;
  /** 到期时刻（毫秒）；到点后由调用方 prune 掉 */
  expiresAt: number;
}

interface GeneratingEntry {
  order: number;
}

/**
 * 高亮状态。
 *
 * 两个集合**互相独立**：`created` 受 TTL 约束、`generating` 不受 —— 生成结束与否由节点终态/回合结束决定，
 * 不能用固定 TTL 猜（一次生成可能几十秒）。这条边界是「不会留下永远发光的节点」的关键。
 */
export interface AgentActiveNodesState {
  readonly created: ReadonlyMap<string, CreatedEntry>;
  readonly generating: ReadonlyMap<string, GeneratingEntry>;
}

export const createAgentActiveNodesState = (): AgentActiveNodesState => ({
  created: new Map(),
  generating: new Map(),
});

/** 去掉空串与重复，保持首次出现顺序（同一 id 在一批里出现两次只点亮一次） */
export const normalizeAgentNodeIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/** 同批 ids → 错开序号（从 startOrder 起单调 +1，数量与去重后的 ids 一致） */
export const assignStaggerOrders = (
  ids: readonly string[],
  startOrder = 0,
): AgentActiveNodeMark[] =>
  normalizeAgentNodeIds(ids).map((id, index) => ({ id, order: startOrder + index }));

/** 标记「刚创建」：每批从序号 0 起（延迟小、看得出依次点亮），并刷新到期时刻 */
export const markAgentCreatedNodes = (
  state: AgentActiveNodesState,
  ids: readonly string[],
  options: { now: number; ttlMs?: number },
): AgentActiveNodesState => {
  const marks = assignStaggerOrders(ids);
  if (!marks.length) return state;
  const ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs as number) > 0
    ? (options.ttlMs as number)
    : AGENT_CREATED_TTL_MS;
  const created = new Map(state.created);
  for (const mark of marks) {
    created.set(mark.id, { order: mark.order, expiresAt: options.now + ttlMs });
  }
  return { created, generating: state.generating };
};

/** 标记「生成中」：无 TTL（等节点终态事件或回合结束来清） */
export const markAgentGeneratingNodes = (
  state: AgentActiveNodesState,
  ids: readonly string[],
): AgentActiveNodesState => {
  const marks = assignStaggerOrders(ids);
  if (!marks.length) return state;
  const generating = new Map(state.generating);
  for (const mark of marks) {
    generating.set(mark.id, { order: mark.order });
  }
  return { created: state.created, generating };
};

/**
 * 清掉到期的「刚创建」。
 *
 * **只动 created，绝不动 generating**：生成中若被 TTL 误清，就会出现「Agent 明明还在出图、画布却没有任何提示」；
 * 反之错把生成中当刚创建清掉，也会让长任务在 4 秒后集体熄灭。两者是两个时钟，不能混。
 */
export const pruneExpiredCreatedNodes = (
  state: AgentActiveNodesState,
  now: number,
): AgentActiveNodesState => {
  let changed = false;
  const created = new Map(state.created);
  for (const [id, entry] of state.created) {
    if (entry.expiresAt <= now) {
      created.delete(id);
      changed = true;
    }
  }
  return changed ? { created, generating: state.generating } : state;
};

/** 清「刚创建」：给 ids 就只清这些，不给就全清 */
export const clearAgentCreatedNodes = (
  state: AgentActiveNodesState,
  ids?: readonly string[],
): AgentActiveNodesState => {
  if (!ids) {
    return state.created.size ? { created: new Map(), generating: state.generating } : state;
  }
  const targets = normalizeAgentNodeIds(ids);
  if (!targets.length) return state;
  const created = new Map(state.created);
  let changed = false;
  for (const id of targets) {
    if (created.delete(id)) changed = true;
  }
  return changed ? { created, generating: state.generating } : state;
};

/** 清「生成中」：给 ids 就只清这些（该节点生成结束），不给就全清（回合结束） */
export const clearAgentGeneratingNodes = (
  state: AgentActiveNodesState,
  ids?: readonly string[],
): AgentActiveNodesState => {
  if (!ids) {
    return state.generating.size ? { created: state.created, generating: new Map() } : state;
  }
  const targets = normalizeAgentNodeIds(ids);
  if (!targets.length) return state;
  const generating = new Map(state.generating);
  let changed = false;
  for (const id of targets) {
    if (generating.delete(id)) changed = true;
  }
  return changed ? { created: state.created, generating } : state;
};

/** 两个集合一起清掉这些 id（节点被删除/卸载时的兜底） */
export const clearAgentNodesForIds = (
  state: AgentActiveNodesState,
  ids: readonly string[],
): AgentActiveNodesState => {
  const targets = normalizeAgentNodeIds(ids);
  if (!targets.length) return state;
  const created = new Map(state.created);
  const generating = new Map(state.generating);
  let changed = false;
  for (const id of targets) {
    if (created.delete(id)) changed = true;
    if (generating.delete(id)) changed = true;
  }
  return changed ? { created, generating } : state;
};

/** 是否处于「刚创建」高亮（到期即视为已不在） */
export const isAgentCreated = (
  state: AgentActiveNodesState,
  id: string,
  now: number,
): boolean => {
  const entry = state.created.get(String(id || "").trim());
  return Boolean(entry && entry.expiresAt > now);
};

/** 是否处于「生成中」高亮（不受 TTL 影响） */
export const isAgentGenerating = (
  state: AgentActiveNodesState,
  id: string,
): boolean => state.generating.has(String(id || "").trim());

/** 该节点的错开延迟（毫秒）：优先看「刚创建」，否则看「生成中」，都没有就是 0 */
export const agentStaggerDelayMs = (
  state: AgentActiveNodesState,
  id: string,
): number => {
  const key = String(id || "").trim();
  const entry = state.created.get(key) || state.generating.get(key);
  return entry ? entry.order * AGENT_STAGGER_STEP_MS : 0;
};

export interface ResolvedAgentNodeMarks {
  /** 刚创建（要错开点亮） */
  created: string[];
  /** 生成中（等终态/回合结束清） */
  generating: string[];
  /** 该动作让这些节点的高亮作废（例如删除节点） */
  cleared: string[];
}

const parseToolResultJson = (resultText: string | undefined): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(String(resultText || ""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** 从回执里取「真正创建出来」的节点 id（add_nodes 的 nodes[].id；失败项为 null 会跳过） */
const collectNodeIds = (payload: Record<string, unknown> | null): string[] => {
  const nodes = Array.isArray(payload?.nodes) ? (payload?.nodes as Array<Record<string, unknown>>) : [];
  return normalizeAgentNodeIds(nodes.map((item) => String(item?.id || "")));
};

/**
 * 把一次工具回执翻译成高亮动作。
 *
 * **只认成功的部分**：add_nodes 回执里 id 为 null 的失败项不点亮；
 * run_nodes 只点亮 `submitted:true` 的节点 —— 跳过（本轮已提交过）与被拦下的不该显示成「生成中」。
 */
export const resolveAgentNodeMarks = (
  toolName: string,
  resultText: string | undefined,
): ResolvedAgentNodeMarks => {
  const empty: ResolvedAgentNodeMarks = { created: [], generating: [], cleared: [] };
  const tool = String(toolName || "");
  const payload = parseToolResultJson(resultText);

  if (tool === "add_node") {
    const id = String(payload?.id || "").trim();
    return id ? { created: [id], generating: [], cleared: [] } : empty;
  }
  if (tool === "add_nodes") {
    return { created: collectNodeIds(payload), generating: [], cleared: [] };
  }
  if (tool === "run_node" || tool === "run_nodes") {
    const nodes = Array.isArray(payload?.nodes) ? (payload?.nodes as Array<Record<string, unknown>>) : [];
    const submitted = normalizeAgentNodeIds(
      nodes.filter((item) => item?.submitted === true).map((item) => String(item?.id || "")),
    );
    return { created: [], generating: submitted, cleared: [] };
  }
  if (tool === "remove_node") {
    const id = String(payload?.id || "").trim();
    return id ? { created: [], generating: [], cleared: [id] } : empty;
  }
  return empty;
};
