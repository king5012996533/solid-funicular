/**
 * 画布助手的工具层（2026-09-23）
 *
 * 设计要点
 *   1. **纯函数式注入**：所有画布操作通过 CanvasAgentContext 传进来，工具层自己不 import
 *      画布 store —— 这样能在 Node 里用假 ctx 直接单测（见 scripts/tests/test-canvas-agent-tools.mjs），
 *      也让「模型能对画布做什么」这件事有一份可读、可测的清单。
 *   2. **工具失败要能被模型看见**：每个执行器返回 { ok, ... } 或抛错，循环里都转成 tool 结果，
 *      让模型自己决定重试/换个做法，而不是整轮对话直接崩掉。
 *   3. 只暴露「画布能承受的操作」：新增/改参数/连线/删除/选中/执行/套模板。没有删库、没有改配置。
 */

import {
  PREFLIGHT_REPORT_TTL_MS,
  runCanvasPipelineValidation,
  verifyPreflightReport,
  type CanvasValidationContext,
  type PreflightReport,
} from "@/shared/canvas-pipeline-validation";
import {
  CANVAS_AGENT_TOOL_DEFINITIONS,
  buildAgentAskUserReceipt,
  describeConfirmationDecision,
  normalizeAgentAskUserOptions,
  type AgentAskUserAnswer,
  type AgentConfirmationDecision,
  type AgentConfirmationRequest,
  type CanvasPreflightQuotaCheck,
  type NormalizedAgentAskUserOption,
} from "@/shared/canvas-agent-tools";
import {
  requestPointsBalance,
  requestPointsEstimate,
  type PointsEstimateItem,
} from "@/api/points";
import { resolveModelSelectionKey } from "@/config/models";
import { rememberPreflightEstimate } from "@/components/canana/agent-confirm-cost";

/**
 * 最近一次预校验报告。
 *
 * 放在模块级：一份报告对应「这块画布的这一批」，同一时刻只需要记住最新那份
 * （再早的已经被同批次的校验覆盖，留着只会误导）。TTL 由 verifyPreflightReport 判。
 */
let lastPreflightReport: PreflightReport | null = null

/** 一次批量建节点的上限：够铺一条完整分镜，又不至于一次把画布塞爆 */
const MAX_BATCH_NODES = 12;
/** 自动排布时的列数（超过就换行） */
const MAX_BATCH_COLUMNS = 4;
/** 一次批量执行的上限：分镜图一般 6~12 张 */
const MAX_BATCH_RUNS = 12;
/** 一次批量连线的上限 */
const MAX_BATCH_LINKS = 40;
/** 一次问用户的问题数上限：问题越多越像审问，用户越容易直接跳过 */
const MAX_ASK_QUESTIONS = 3;
/**
 * 预校验里余额/预估两个接口各自的超时预算。
 *
 * 刻意压到 1.5 秒：预校验是**批量生成前的同步一步**，在用户点「执行」的路径上；
 * 一个慢接口（网络抖动、服务端排队）不能把整次预校验拖住。超时即按失败处理 →
 * 配额这一条静默跳过，其余校验照常跑（拿不到余额不该阻断别的问题的发现）。
 */
const PREFLIGHT_QUOTA_TIMEOUT_MS = 1500;

export interface CanvasAgentNodeSnapshot {
  id: string;
  type: string;
  label: string;
  /** 图片/视频节点的提示词或文本节点的内容（截断后给模型，避免把整张图 base64 塞进上下文） */
  text: string;
  /**
   * 分开给出的提示词与文本内容。
   *
   * 为什么不能只给合并后的 `text`：预校验的校验器按节点类型分派字段（图片/视频看 prompt、
   * 文本看 content）。实测踩过一次：快照只给 `text` → 校验器读 `prompt` 为空 →
   * 把有提示词的节点报成「没有提示词」。**误报会把合法批次也拦下来**，门卫就不可信了。
   */
  prompt?: string;
  content?: string;
  model?: string;
  size?: string;
  quality?: string;
  /** 旧的中文状态串（`生成中` / 错误文本）—— `get_canvas_state` 的形状不动，继续用它 */
  status?: string;
  /**
   * 生成状态的三态原始事实（2026-09-26，第一刀）。
   *
   * 为什么不再从 `status` 这个中文串反推：`loading` / `error` / `url` 三者组合才是机器可读的真相，
   * 概览与单节点要把它们归一成 `idle | generating | error` 给模型（模型据此判断「要不要再等」）。
   * 用中文串判断「是否还在跑」是不可靠的 —— 跑完没报错的节点 status 跟从没跑过的节点一模一样。
   */
  loading?: boolean;
  error?: string;
  /** 已提交的生成任务 id（刷新后对账用；模型看结果时也用得上） */
  taskRecordId?: string;
  /** 节点在画布上的坐标（只有单节点读会给出，概览刻意不含） */
  position?: { x: number; y: number };
  /** 是否处于选中态 */
  selected?: boolean;
  /**
   * 这个节点已经生成出来的图（本地托管地址）。
   *
   * 连续性全靠它：母版出图之后，分镜节点要把**那张图**挂成参考图才谈得上「同一个角色」。
   * 不把地址给模型，它就只能靠文字描述去猜，出来的角色必然每张都不一样。
   */
  imageUrl?: string;
  /** 文本节点的内容长度（模型据此判断分镜表是否已经铺过） */
  textLength?: number;
  /** 挂着的参考图（预校验要 HEAD 探可达性，运行期还要复核一次） */
  referenceImages?: string[];
}

/**
 * `ask_user` 的参数与回执。
 *
 * 为什么和 request_confirmation 放在同一层却单独定义：它问的是**猜不出来的关键信息**
 * （要做什么 / 成片还是单张 / 多大规模），或需要用户拍板的方向（导演决策点），
 * 需要在同一轮里拿到答复才能继续 —— 所以数据形状必须两侧一致
 * （面板渲染卡片、工具层读答复），任一侧改字段都要编译失败。
 *
 * 2026-09-26 批次 2：options 从纯字符串升级为「代号 + 名称 + 特点」，归一化后传给面板；
 * 面板点选项回 optionKey，自由输入回 text，载荷由 `buildAgentAskUserReceipt` 统一拼。
 */
export interface AgentAskUserRequest {
  /** 为什么需要问（一句话情境，帮用户快速判断该答什么） */
  context?: string;
  /** 要问的问题（最多 3 个） */
  questions: Array<{ question: string; options?: NormalizedAgentAskUserOption[] }>;
}

export interface AgentAskUserResult {
  /** 用户对每一问的作答（点选项给 optionKey，自由输入给 text） */
  answers: AgentAskUserAnswer[];
  /** 用户点了「跳过」没作答时为 true */
  skipped?: boolean;
}

export interface CanvasAgentContext {
  /** 当前画布上的节点快照 */
  snapshotNodes: () => CanvasAgentNodeSnapshot[];
  /** 当前连线 */
  snapshotEdges: () => Array<{ source: string; target: string }>;
  /** 当前选中的节点 id */
  selectedIds: () => string[];
  /** 新节点默认落点（通常是视口中心），模型不指定坐标时使用 */
  defaultPosition: () => { x: number; y: number };
  addNode: (
    type: string,
    position: { x: number; y: number },
    data?: Record<string, unknown>,
  ) => string | null;
  updateNode: (id: string, patch: Record<string, unknown>) => boolean;
  removeNode: (id: string) => boolean;
  addEdge: (source: string, target: string) => boolean;
  selectNodes: (ids: string[], focus?: boolean) => void;
  /**
   * 开始/结束一轮流水线（可选）。
   *
   * 由助手面板在跑 Agent 前后调用：画布页据此取得「流水线锁」并留存快照，
   * 持锁期间只有本轮自己的保存能写进画布 —— 避免 Agent 手里的节点/参考图引用被外部改动顶掉。
   */
  beginPipelineRun?: (label?: string) => Promise<{
    ok: boolean;
    reason?: string;
    message?: string;
    snapshotVersionId?: string;
    /** 取到的锁属于哪块画布、token 是什么 —— 建 Agent 任务时一并回传，服务端据此把锁绑到任务上 */
    workflowId?: string;
    pipelineToken?: string;
  }>;
  endPipelineRun?: () => Promise<void>;
  /**
   * 强制释放本画布上的锁（可选，同一用户自救）。
   *
   * 面板在「画布被占用」时给用户一个可操作入口，而不是让他干等 TTL：
   * 任务早跑完但锁没被正常放掉时，用户自己被自己的锁挡住了。
   */
  forceReleasePipelineRun?: () => Promise<{ ok: boolean; message?: string }>;
  /**
   * 只读查询本画布当前有没有生效中的流水线锁（可选）。
   *
   * 给「首页说完话 → 新建画布 → 自动交给 Agent」在发送前做占用保护：
   * 有锁就不发、只把话填进输入框。**不取锁、不留快照**，绝不能拿它绕过锁。
   */
  checkPipelineLock?: () => Promise<boolean>;
  /**
   * 提交某个节点的生成任务（node 组件注册进来的「用当前参数跑一次」）。
   *
   * **返回的是「提交结果」，不是「出图结果」**：节点组件在任务建好、taskId 落进节点 data 之后
   * 就返回（出图由节点自己的事件流落回画布）。所以这里 `ok:true` 只代表**已提交**，
   * 不代表出图成功 —— 失败要如实回执，不能把「没提交成功」说成成功。
   */
  runNode: (id: string) => Promise<CanvasNodeSubmitOutcome>;
  /**
   * 依次提交多个节点的生成任务（可选；没注入就退化成逐个 runNode）。
   * 分镜图是「一批一起出」的活，合成一次调用能让执行记录更干净。
   */
  runNodes?: (ids: string[]) => Promise<Array<{ id: string } & CanvasNodeSubmitOutcome>>;
  /** 套用一个工作流模板，返回创建出的节点/连线数量 */
  applyTemplate: (
    templateId: string,
    position: { x: number; y: number },
  ) => { nodes: number; edges: number } | null;
  /** 模板 id → 名称，供模型选择 */
  listTemplates: () => Array<{ id: string; name: string; description: string }>;
  /** 节点类型说明（让模型知道有哪些 type 可用） */
  nodeTypeHints: () => Array<{ type: string; name: string }>;
  /**
   * 用户本轮上传的参考图（地址）。Agent 的 attach_reference_images 默认取这里。
   * 由面板注入 —— 只有它知道用户这一轮附了什么。
   */
  referenceImages?: () => string[];
  /**
   * 把参考图写到某个图片节点上。由画布页实现（只有它拿得到节点）。
   *
   * images 里既可以是图片地址，也可以是**节点 id**（画布页会把 id 解析成该节点已生成的那张图）；
   * 返回 ok:false 时 reason 说明哪一项没用上。
   */
  attachReferenceImages?: (
    id: string,
    images: string[],
  ) => { ok: boolean; reason?: string };
  /**
   * 向用户要一个确认（半自动闸门）。
   *
   * 服务端 Agent 在花钱/交付前会调 request_confirmation，这里负责把卡片弹给用户并等答复。
   * 不注入它的话，该工具会明确失败 —— 而不是静默「当作同意」，那样闸门就形同虚设了。
   */
  requestConfirmation?: (
    request: AgentConfirmationRequest,
  ) => Promise<AgentConfirmationDecision>;
  /**
   * 向用户提问（关键信息不足时）。
   *
   * 与 requestConfirmation 一样是**阻塞式**的：卡片弹出来、等用户答完、答案回灌同一轮，
   * 所以「问」不再等于结束这一轮。不注入它的话，该工具必须明确失败 ——
   * 绝不能静默「当作已答」，否则模型会拿着编出来的答案往下做。
   */
  askUser?: (request: AgentAskUserRequest) => Promise<AgentAskUserResult>;
}

export interface CanvasAgentToolSchema {
  type: "function";
  function: {
    name: string;
    /** 界面展示用中文名 */
    label: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 生成状态（机器可读三态）。
 *
 * 概览与单节点读都给这个枚举，模型据此判断「是否已离开 busy」：
 *   · idle       —— 没在跑（`url` 有值就是已出结果）
 *   · generating —— 已提交、正在生成
 *   · error      —— 失败（`error` 是原文，如实回给模型）
 */
export type CanvasNodeGenerationStatus = "idle" | "generating" | "error";

/** 由原始事实归一：`loading` 优先（提交后到终态之间），其次看 `error`，都没有就是 idle */
export const resolveNodeGenerationStatus = (node: {
  loading?: boolean;
  error?: string;
}): CanvasNodeGenerationStatus => {
  if (node.loading) return "generating";
  if (String(node.error || "").trim()) return "error";
  return "idle";
};

/**
 * 一次「提交生成」的结果。
 *
 * 与旧的 `{ ok, reason }` 的差别只在多一个 `status`：工具层要据此把回执说清楚 ——
 * 「已提交，正在生成」/「本轮已提交过（跳过）」/「没提交成功」，三者用户看到的含义完全不同。
 * `runNodeById` 的失败已经不占位（可重试），所以 `duplicate` 与 `failed` 必须分开。
 */
export interface CanvasNodeSubmitOutcome {
  ok: boolean;
  status: "submitted" | "duplicate" | "failed";
  reason?: string;
}

export interface CanvasAgentToolResult {
  ok: boolean;
  /** 回给模型的文本（成功摘要或失败原因） */
  result: string;
  /** 给 UI 展示的一行记录 */
  summary: string;
  /**
   * 结构化细节（回执给服务端做埋点/留痕用）。
   *
   * 为什么需要它：有些结论（例如 preflight_check 的「配额到底查了没有」）只出现在浏览器里，
   * 但排查「闸门是不是被静默跳过」必须在**服务端**看得见。走 details 回执比让服务端正则去
   * 解析给模型看的 result 文本要可靠。
   */
  details?: Record<string, unknown>;
}

const text = (value: unknown, max = 400) => {
  const raw = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
};

/**
 * 把一个「提交结果」翻译成给模型的回执项。
 *
 * 三态必须分开，因为用户看到的含义完全不同：
 *   · submitted → 已提交、正在生成（`generating`）；
 *   · duplicate → 本轮已提交过，这次跳过（**不是失败，也不是又提交了一次**）；
 *   · failed    → 没提交成功，带真实原因。
 * 早先这里只有 `{ok, reason}`，工具层把「提交失败」和「已触发」混在一个布尔里，
 * 于是「提交了但马上失败」被报成了成功 —— 这一条专门修过，别再合回去。
 */
const toSubmitReceipt = (
  id: string,
  outcome: { ok: boolean; status?: string; reason?: string },
) => {
  if (outcome.ok) return { id, submitted: true, status: "generating" as const };
  const duplicate = outcome.status === "duplicate";
  return {
    id,
    submitted: false,
    status: duplicate ? ("skipped" as const) : ("failed" as const),
    reason: outcome.reason || "未知原因",
  };
};

/** 提交回执的统一外壳：顶层给计数（模型一眼看出成没成、成几个），逐节点给明细 */
const buildSubmitPayload = (
  receipts: Array<ReturnType<typeof toSubmitReceipt>>,
  message?: string,
) => JSON.stringify({
  submitted: receipts.filter((item) => item.submitted).length,
  total: receipts.length,
  ...(message ? { message } : {}),
  nodes: receipts,
});

/**
 * 给一次网络请求套上超时：到点就 abort。
 *
 * 用 AbortController 而不是 Promise.race —— race 只是「结果不要了」，底层请求还在跑；
 * abort 才真正把连接释放掉。预校验会被反复调用，不释放会在批量场景里堆积。
 */
const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 把节点的模型字段补成预校验接口要的**三段式选择键**。
 *
 * `/api/points/estimate` 的契约是 `providerId::CATEGORY::modelKey`（服务端靠它解析出
 * providerId 再去定价表查价）。但画布节点里存的可能是**裸 modelKey**（早期 / 导入的画布就是
 * `gpt-image-2`）—— 2026-09-26 真机 bug：原样转发裸键 + 服务端静默按 0 计，于是一张实际 6 分的
 * gpt-image-2 预估成 0，确认卡拿不到「本批将预扣 N 分」。
 *
 * 这里用目录把裸键补成选择键；目录里确实没有（下架 / 未配置）就原样发出，
 * 由服务端明确回「估不出」（不再由客户端猜或补数字）。
 */
const toEstimateModelKey = (node: CanvasAgentNodeSnapshot) => {
  const raw = String(node.model || "").trim();
  if (!raw) return "";
  const category = node.type === "video" ? "VIDEO" : "IMAGE";
  return resolveModelSelectionKey(raw, category) || raw;
};

/**
 * 探「这一批余额够不够」所需的外部事实。
 *
 * 折算方式（为什么这么算）：`/api/points/estimate` 给的是**整批合计** `totalEstimated`，
 * 而校验器的整批判据是 `estimatedCostPerUnit × 可执行节点数 ≥ 可用余额`。把
 * `estimatedCostPerUnit` 取成 `totalEstimated / 可执行节点数`，两者相乘还原出来的整批总额
 * 就与接口给的 `totalEstimated` 一致 —— 于是「配额不足」这条结论与整批预估说的是同一件事，
 * 不会出现「预估接口说够、校验器说不够」的自相矛盾。
 *
 * 降级（必须严格遵守）：任一接口失败（401 / 5xx / 超时 / 字段缺失）就**不注入**对应字段，
 * 配额校验器看到 undefined 会静默跳过（它本就不该在「不知道余额」时假装知道），其余校验规则
 * 照常执行。结论通过 quotaCheck 回传，供服务端埋点 —— 别让「闸门被跳过」这件事悄悄发生。
 */
const collectPreflightQuota = async (
  visualNodes: CanvasAgentNodeSnapshot[],
): Promise<{
  availablePoints?: number;
  estimatedCostPerUnit?: number;
  estimatedCostTotal?: number;
  quotaCheck: CanvasPreflightQuotaCheck;
}> => {
  // 没有可执行节点就没有可预估的消耗：连接口都不必打，配额天然满足。
  if (!visualNodes.length) {
    return { quotaCheck: { status: "skipped", reason: "no_estimatable_nodes", nodeCount: 0 } };
  }

  const items: PointsEstimateItem[] = visualNodes.map((node) => ({
    model: toEstimateModelKey(node),
    count: 1,
    // 画幅能拿到就带上：定价若按画幅分档，漏传会低估；拿不到时服务端按默认算
    ...(node.size ? { size: node.size } : {}),
  }));

  // 两个接口并行、各自独立超时：串行会把预校验的等待时间叠起来。
  const [estimate, balance] = await Promise.all([
    withTimeout((signal) => requestPointsEstimate(items, signal), PREFLIGHT_QUOTA_TIMEOUT_MS)
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const })),
    withTimeout((signal) => requestPointsBalance(signal), PREFLIGHT_QUOTA_TIMEOUT_MS)
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const })),
  ]);

  // 字段缺失也算失败：success 不为 true 或数字字段不是 number，一律按「拿不到」处理
  const totalEstimated = estimate.ok
    && estimate.value?.success === true
    && typeof estimate.value.totalEstimated === "number"
    ? estimate.value.totalEstimated
    : undefined;
  const available = balance.ok
    && balance.value?.success === true
    && typeof balance.value.available === "number"
    ? balance.value.available
    : undefined;

  const bothReady = typeof available === "number" && typeof totalEstimated === "number";
  return {
    ...(typeof available === "number" ? { availablePoints: available } : {}),
    ...(typeof totalEstimated === "number"
      ? { estimatedCostPerUnit: totalEstimated / visualNodes.length }
      : {}),
    /**
     * `estimatedCostTotal` 只要预估拿到了就给（不再要求余额也在）。
     *
     * 它有两个用途：报告事实（下面按 availablePoints + estimatedCostTotal 双双存在才记，语义不变）
     * 和确认卡缓存 —— 余额接口偶发失败时，确认卡仍应显示「本批将预扣 N 分」，只是不显示余额。
     * 配额校验本身（下面 quotaCheck 的 bothReady 分支）依旧要求两者都在，语义一个字没改。
     */
    ...(typeof totalEstimated === "number" ? { estimatedCostTotal: totalEstimated } : {}),
    quotaCheck: bothReady
      ? {
          status: "checked",
          available,
          totalEstimated,
          nodeCount: visualNodes.length,
        }
      : {
          status: "skipped",
          reason: [
            typeof available !== "number" ? "balance_api_error" : "",
            typeof totalEstimated !== "number" ? "estimate_api_error" : "",
          ].filter(Boolean).join(","),
          nodeCount: visualNodes.length,
        },
  };
};

/** 工具清单：这是「Agent 能对画布做什么」的唯一来源，模型看到的描述也来自这里 */
/**
 * 工具清单：**从共享真源派生**，不再手写一份。
 *
 * 2026-09-23 改：这份清单原来和服务端（`src/shared/canvas-agent-tools.ts`）各写一份，
 * 两边描述/参数已经开始漂移（例如 run_node 的说明一边写「视频没接通」一边写「视频已接通」）。
 * 漂移的后果是最难查的那种：模型学到的是一套、执行的是另一套，表现为「它老调错工具」。
 * 现在两边都从共享定义派生，改一处两边同时生效，漂移在结构上不可能发生。
 */
export const CANVAS_AGENT_TOOL_SCHEMAS: CanvasAgentToolSchema[] =
  CANVAS_AGENT_TOOL_DEFINITIONS.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));

/**
 * 执行一个工具调用。未知工具、参数缺失、节点不存在都返回 ok:false + 明确原因，
 * 由循环把它作为 tool 结果回给模型。
 */
export const executeCanvasAgentTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: CanvasAgentContext,
): Promise<CanvasAgentToolResult> => {
  const fail = (result: string, summary = result): CanvasAgentToolResult => ({
    ok: false,
    result,
    summary,
  });

  switch (name) {
    case "request_confirmation": {
      const request: AgentConfirmationRequest = {
        title: String(args.title || "请确认"),
        summary: String(args.summary || ""),
        items: Array.isArray(args.items)
          ? args.items.map((item) => String(item))
          : undefined,
        // 目标节点 id 交给界面去调服务端估算；拿不到就不估算（只显示预扣说明）
        nodeIds: Array.isArray(args.nodeIds)
          ? args.nodeIds.map((item) => String(item)).filter(Boolean)
          : undefined,
        costPoints: Number.isFinite(Number(args.costPoints))
          ? Number(args.costPoints)
          : undefined,
        riskLevel: (["low", "medium", "high"] as readonly unknown[]).includes(
          args.riskLevel,
        )
          ? (args.riskLevel as AgentConfirmationRequest["riskLevel"])
          : "medium",
      };
      /**
       * 产品决策：**Agent 不参与积分计算**。模型即使按旧提示词自报了 costPoints 也不用它
       * （确认卡的数字只认服务端估算）。这里只在开发日志留一条痕，便于观察模型是否还在自算；
       * 不落到用户界面，也不阻断这一轮。
       */
      if (args.costPoints !== undefined && args.costPoints !== null && String(args.costPoints).trim() !== "") {
        console.debug(
          "[画布 Agent] 忽略模型自报积分：",
          args.costPoints,
          "（确认卡数字只认服务端估算 /api/points/estimate）",
        );
      }
      if (!request.summary.trim()) {
        return fail("确认事项必须写清 summary（将要做什么）");
      }
      if (!ctx.requestConfirmation) {
        return fail(
          "当前环境不支持向用户确认（没有注入确认入口），因此不能执行任何花钱或交付类动作。请把计划讲给用户，让他自己决定。",
        );
      }
      const decision = await ctx.requestConfirmation(request);
      return {
        ok: decision.approved,
        // 回执必须是 JSON：服务端要按 approved 字段放行后续付费动作
        result: JSON.stringify({
          approved: Boolean(decision.approved),
          note: decision.note || "",
          summary: describeConfirmationDecision(request, decision),
        }),
        summary: decision.approved
          ? `用户同意：${request.title}`
          : `用户拒绝：${request.title}${decision.note ? `（${decision.note}）` : ""}`,
      };
    }
    case "ask_user": {
      /**
       * 提问是**阻塞式**的（卡片弹出来 → 等用户答 → 答案回灌同一轮），所以它不会像
       * 纯文本提问那样把一次委托拆成好几轮。但答复必须真的来自用户：没有注入提问入口时
       * 一律明确失败，绝不能「当作已答」把编出来的答案喂给模型。
       *
       * 批次 2：选项先归一成「代号 + 名称 + 特点」再交给面板；兼容旧对话里的纯字符串写法。
       */
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      const questions = rawQuestions
        .map((item) => {
          const raw = (item || {}) as Record<string, unknown>;
          const question = String(raw.question || "").trim();
          const options = normalizeAgentAskUserOptions(raw.options);
          return { question, ...(options.length ? { options } : {}) };
        })
        .filter((item) => item.question)
        .slice(0, MAX_ASK_QUESTIONS);
      if (!questions.length) {
        return fail("ask_user 必须带至少一个 question");
      }
      const truncated = rawQuestions.filter((item) => String((item as Record<string, unknown>)?.question || "").trim()).length > MAX_ASK_QUESTIONS;
      if (!ctx.askUser) {
        return fail(
          "当前环境不支持向用户提问（没有注入提问入口）。请把问题写在回复里，让用户回答后你再继续。",
        );
      }
      const outcome = await ctx.askUser({
        context: args.context ? String(args.context).trim() : undefined,
        questions,
      });
      const answers = Array.isArray(outcome?.answers) ? outcome.answers : [];
      if (outcome?.skipped === true || !answers.length) {
        return {
          ok: false,
          // result 也必须是 JSON：服务端/模型要能稳定判断「到底有没有答复」
          result: JSON.stringify({ answered: false, answers: [] }),
          summary: "用户没有回答（可以按默认值继续，或询问是否需要停止）",
        };
      }
      // 回执必须带**代号 + 名称 + 特点**：模型要知道用户选了什么、为什么，不能只回一个字母
      const receipt = buildAgentAskUserReceipt(questions, answers);
      const head = `已向用户提问 ${questions.length} 个问题并拿到答复：${questions[0].question} → ${receipt.answers[0]?.answer || ""}`;
      const note = truncated ? `（问题多于 ${MAX_ASK_QUESTIONS} 个，只问了前 ${MAX_ASK_QUESTIONS} 个）` : "";
      const summary = `${head.length > 120 ? `${head.slice(0, 120)}…` : head}${note}`;
      return {
        ok: true,
        result: JSON.stringify(receipt),
        summary,
      };
    }
    case "get_canvas_state": {
      const nodes = ctx.snapshotNodes();
      const edges = ctx.snapshotEdges();
      const selected = ctx.selectedIds();
      const payload = {
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          text: text(node.text, 120),
          model: node.model || undefined,
          size: node.size || undefined,
          quality: node.quality || undefined,
          status: node.status || undefined,
          /**
           * 已经有出图结果 / 已经挂了参考图 —— 这两项是模型判断「这个节点还需不需要跑」的唯一依据。
           *
           * 之前快照只给 status，而「跑完但没报错」的节点 status 跟「从没跑过」完全一样（都是空），
           * 模型据此误判为没跑，对同一批母版补跑了一次 run_node（实测：三张母版各建了两张单）。
           * 把「有没有图」显式给出来，它才有证据不去重复执行。
           */
          hasImage: Boolean(node.imageUrl),
          referenceImageCount: Array.isArray(node.referenceImages) ? node.referenceImages.length : 0,
        })),
        edges,
        selectedNodeIds: selected,
        availableNodeTypes: ctx.nodeTypeHints(),
      };
      return {
        ok: true,
        result: JSON.stringify(payload),
        summary: `读取画布：${nodes.length} 个节点、${edges.length} 条连线${selected.length ? `、已选 ${selected.length} 个` : ""}`,
      };
    }
    case "get_canvas_overview": {
      const nodes = ctx.snapshotNodes();
      const edges = ctx.snapshotEdges();
      /**
       * 刻意只给「定位与决策」需要的字段。
       *
       * 不给 prompt / position / 连线明细 —— 这是这个工具存在的**唯一理由**：让默认读取路径
       * 从「整张画布」降到「一行一个节点」。多加一个字段，就等于把模型往旧习惯上拽一点。
       */
      const countsByKind: Record<string, number> = {};
      const countsByGenerationStatus: Record<CanvasNodeGenerationStatus, number> = {
        idle: 0,
        generating: 0,
        error: 0,
      };
      const summaries = nodes.map((node) => {
        const generationStatus = resolveNodeGenerationStatus(node);
        countsByKind[node.type] = (countsByKind[node.type] || 0) + 1;
        countsByGenerationStatus[generationStatus] += 1;
        return {
          id: node.id,
          kind: node.type,
          label: node.label,
          generationStatus,
          hasOutput: Boolean(node.imageUrl),
        };
      });
      const payload = {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        countsByKind,
        countsByGenerationStatus,
        selectedNodeIds: ctx.selectedIds(),
        nodes: summaries,
      };
      const busy = countsByGenerationStatus.generating;
      const broken = countsByGenerationStatus.error;
      return {
        ok: true,
        result: JSON.stringify(payload),
        summary: `画布概览：${nodes.length} 个节点、${edges.length} 条连线${busy ? `、生成中 ${busy}` : ""}${broken ? `、失败 ${broken}` : ""}`,
      };
    }
    case "get_canvas_node": {
      const id = String(args.id ?? args.node_id ?? args.nodeId ?? "").trim();
      if (!id) return fail("缺少节点 id");
      const nodes = ctx.snapshotNodes();
      const node = nodes.find((item) => item.id === id);
      if (!node) return fail(`找不到节点 ${id}（先用 get_canvas_overview 拿 id）`);
      const edges = ctx.snapshotEdges();
      // 连线只给摘要（对面节点的 id/类型/标题）：模型要的是「谁连着我」，不是边本身的字段
      const brief = (otherId: string) => {
        const other = nodes.find((item) => item.id === otherId);
        return { id: otherId, kind: other?.type || "", label: other?.label || "" };
      };
      const payload = {
        id: node.id,
        kind: node.type,
        label: node.label,
        position: node.position || { x: 0, y: 0 },
        selected: Boolean(node.selected),
        data: {
          prompt: node.prompt ?? "",
          content: node.content ?? "",
          model: node.model || undefined,
          size: node.size || undefined,
          quality: node.quality || undefined,
          referenceImages: Array.isArray(node.referenceImages) ? node.referenceImages : [],
          url: node.imageUrl || "",
          taskRecordId: node.taskRecordId || "",
          generationStatus: resolveNodeGenerationStatus(node),
          error: node.error || "",
        },
        incomingConnections: edges.filter((edge) => edge.target === id).map((edge) => brief(edge.source)),
        outgoingConnections: edges.filter((edge) => edge.source === id).map((edge) => brief(edge.target)),
      };
      return {
        ok: true,
        result: JSON.stringify(payload),
        summary: `读取节点 ${id}：${node.label || node.type}（${payload.data.generationStatus}）`,
      };
    }
    case "add_node": {
      const type = String(args.type || "").trim();
      const allowed = ctx.nodeTypeHints().map((item) => item.type);
      if (!allowed.includes(type))
        return fail(
          `不支持的节点类型「${type}」，可用：${allowed.join(" / ")}`,
        );
      const base = ctx.defaultPosition();
      const position = {
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : base.x,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : base.y,
      };
      const data: Record<string, unknown> = {};
      if (typeof args.content === "string") data.content = args.content;
      if (typeof args.prompt === "string") data.prompt = args.prompt;
      if (typeof args.model === "string" && args.model.trim())
        data.model = args.model.trim();
      if (typeof args.size === "string" && args.size.trim())
        data.size = args.size.trim();
      if (typeof args.quality === "string" && args.quality.trim())
        data.quality = args.quality.trim();
      const id = ctx.addNode(type, position, data);
      if (!id) return fail("节点没能创建（画布拒绝了这个类型或数据）");
      return {
        ok: true,
        result: JSON.stringify({ id }),
        summary: `新增 ${type} 节点 ${id}${data.prompt ? `（提示词：${text(data.prompt, 30)}）` : ""}`,
      };
    }
    case "update_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      const patch: Record<string, unknown> = {};
      for (const key of [
        "content",
        "prompt",
        "label",
        "model",
        "size",
        "quality",
      ]) {
        const value = args[key];
        if (typeof value === "string") patch[key] = value;
      }
      if (!Object.keys(patch).length) return fail("没有给出任何要修改的字段");
      const ok = ctx.updateNode(id, patch);
      if (!ok) return fail(`找不到节点 ${id}（先用 get_canvas_overview 拿 id）`);
      return {
        ok: true,
        result: JSON.stringify({ id, updated: Object.keys(patch) }),
        summary: `更新节点 ${id}：${Object.keys(patch).join("、")}`,
      };
    }
    case "add_nodes": {
      const raw = Array.isArray(args.nodes) ? args.nodes : [];
      if (!raw.length) return fail("nodes 不能为空");
      if (raw.length > MAX_BATCH_NODES) {
        return fail(`一次最多建 ${MAX_BATCH_NODES} 个节点（收到 ${raw.length} 个）。分批来，先建分镜表与母版，再建分镜。`);
      }
      const base = ctx.defaultPosition();
      const items = raw.map((item, index) => {
        const node = (item || {}) as Record<string, unknown>;
        const data: Record<string, unknown> = {};
        for (const key of ["label", "content", "prompt", "model", "size", "quality"]) {
          if (node[key] !== undefined && node[key] !== null && node[key] !== "") data[key] = node[key];
        }
        // 没给坐标就自动排布：横向一行，每隔一个节点宽度错开，避免全叠在中心点
        const fallbackX = base.x + (index % MAX_BATCH_COLUMNS) * 320;
        const fallbackY = base.y + Math.floor(index / MAX_BATCH_COLUMNS) * 260;
        return {
          type: String(node.type || "text"),
          position: {
            x: Number.isFinite(Number(node.x)) ? Number(node.x) : fallbackX,
            y: Number.isFinite(Number(node.y)) ? Number(node.y) : fallbackY,
          },
          data,
          label: String(node.label || ""),
        };
      });

      const created: string[] = [];
      for (const item of items) {
        const id = ctx.addNode(item.type, item.position, item.data);
        created.push(String(id || ""));
      }

      const failures = created.filter((id) => !id).length;
      if (failures === created.length) {
        return fail("一个节点都没建出来（可能是画布未就绪）");
      }
      return {
        ok: true,
        result: JSON.stringify({
          nodes: items.map((item, index) => ({ id: created[index] || null, type: item.type, label: item.label })),
        }),
        summary: `新建 ${created.filter(Boolean).length} 个节点${failures ? `（${failures} 个失败）` : ""}`,
      };
    }
    case "preflight_check": {
      const asked = (Array.isArray(args.ids) ? args.ids : []).map((id) => String(id || "").trim()).filter(Boolean);
      const allNodes = ctx.snapshotNodes();
      const edges = ctx.snapshotEdges();
      const targets = asked.length
        ? allNodes.filter((node) => asked.includes(node.id))
        : allNodes.filter((node) => node.type === "image" || node.type === "video");
      if (!targets.length) return fail("没有可校验的节点（画布上没有图片/视频节点）");

      // 参考图可达性：这一步必须在客户端做（只有浏览器这边能直接探本地托管的图）
      const refUrls = [...new Set(targets.flatMap((node) => node.referenceImages || []))];
      const reachability: Record<string, boolean> = {};
      await Promise.all(refUrls.map(async (url) => {
        /**
         * 探测单个地址：先 HEAD，**失败再用 GET 复核**。
         *
         * 为什么必须复核：有些服务端/CDN 对 HEAD 只回 404，而那并不代表图取不到
         * （我们自己的 `/uploads` 就曾如此，见 `server/index.ts` 的 handleUploadsRequest）。
         * 仅凭 HEAD 判定会误报「参考图不可达」→ Agent 认定**已生成好的母版链接过期**、
         * 要求重跑 6 张（实测白花 60 积分）。GET 只等响应头、拿到就立刻 cancel，
         * 不把整张图下下来。
         */
        const probe = async (method: "HEAD" | "GET") => {
          const res = await fetch(url, { method });
          if (method === "GET") {
            try {
              await res.body?.cancel();
            } catch {
              // 取消失败不影响结论
            }
          }
          return res.ok;
        };
        try {
          reachability[url] = (await probe("HEAD")) || (await probe("GET"));
        } catch {
          try {
            reachability[url] = await probe("GET");
          } catch {
            reachability[url] = false;
          }
        }
      }));

      /**
       * 配额：这一批要花多少、现在有多少。
       *
       * 这两个数字（`/api/points/estimate`、`/api/points/balance`）此前**没有任何调用方**，
       * 于是配额校验器直接短路 —— 后果是「余额不足」要跑到真扣费才炸（那时图已经在生成了）。
       * 这里把它接上：能拿到就注入，预校验就能提前拦下；拿不到就降级（见 collectPreflightQuota），
       * 不阻断其余规则的发现。
       */
      const estimatable = targets.filter((node) => node.type === "image" || node.type === "video");
      const quota = await collectPreflightQuota(estimatable);
      /**
       * 把这一批的服务端数字缓存下来，供**确认卡**直接取用（键 = 目标节点集合）。
       *
       * 这是「让确认卡稳定显示服务端估算」的正路：确认卡不再自己重算/重打一次接口
       * （那条弱路径常因拿不到整批而降级）。缓存只在真有服务端总额时写入；
       * 余额缺失照写（卡片届时只显示估算，不显示余额）。缓存与报告一样按 TTL 判新旧。
       */
      rememberPreflightEstimate({
        nodeIds: estimatable.map((node) => node.id),
        estimatedCostTotal: quota.estimatedCostTotal,
        availablePoints: quota.availablePoints,
      });
      const context: CanvasValidationContext = { referenceReachability: reachability };
      if (typeof quota.availablePoints === "number") context.availablePoints = quota.availablePoints;
      if (typeof quota.estimatedCostPerUnit === "number") context.estimatedCostPerUnit = quota.estimatedCostPerUnit;

      const report = runCanvasPipelineValidation({
        targets,
        allNodes,
        edges,
        context,
      });

      lastPreflightReport = {
        reportId: `pf_${Date.now().toString(36)}`,
        workflowId: "",
        nodeIds: targets.map((node) => node.id),
        createdAt: Date.now(),
        expiresAt: Date.now() + PREFLIGHT_REPORT_TTL_MS,
        facts: {
          reachableReferences: refUrls.filter((url) => reachability[url]),
          // 只有真查过配额才记这两个事实：没查过却记上，运行期复核会误以为「当时够钱」
          ...(typeof quota.availablePoints === "number" && typeof quota.estimatedCostTotal === "number"
            ? { availablePoints: quota.availablePoints, estimatedCost: quota.estimatedCostTotal }
            : {}),
        },
      };

      // 报告要能驱动修复：每个问题都带上「哪个节点 + 怎么改」，而不只是「被拦下了」
      const lines = report.findings.map((item) => {
        const where = item.nodeId ? `节点 ${item.nodeId}` : "整批";
        return `- [${item.level === "error" ? "必须修" : "建议"}] ${where}：${item.message}${item.hint ? ` → ${item.hint}` : ""}`;
      });
      return {
        ok: report.runnable,
        result: JSON.stringify({ runnable: report.runnable, blockedNodeIds: report.blockedNodeIds, findings: report.findings, validators: report.validators }),
        // 配额检查结论走 details 回执给服务端埋点（浏览器 console 服务端看不到）
        details: { quotaCheck: quota.quotaCheck },
        summary: report.runnable
          ? `预校验通过（${report.checkedNodes} 个节点）`
          : `预校验未通过：${report.blockedNodeIds.length} 个节点有必须修的问题\n${lines.join("\n")}`,
      };
    }
    case "run_nodes": {
      // 去重：同一个 id 在参数里出现多次只执行一次（模型偶尔会把同一个节点写两遍）
      const ids = [...new Set((Array.isArray(args.ids) ? args.ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!ids.length) return fail("ids 不能为空");
      if (ids.length > MAX_BATCH_RUNS) {
        return fail(`一次最多执行 ${MAX_BATCH_RUNS} 个节点（收到 ${ids.length} 个），分批来。`);
      }
      const known = new Set(ctx.snapshotNodes().map((node) => node.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) return fail(`这些节点不存在：${missing.join("、")}（先用 get_canvas_overview 拿 id）`);

      /**
       * **运行期 gate**：没有有效预校验报告就不许批量生成。
       *
       * 为什么不只写在提示词里：那是软约束，模型偶尔跳过你也不会知道 ——
       * 而代价是带着空提示词/失效参考图真的花钱跑一批。
       * 这里现探一次关键事实（参考图还在不在），过期/覆盖面不符/事实变了都拦下，
       * 并把「该怎么修」回给模型（报告本身就是它的修复依据）。
       */
      const currentRefUrls = [...new Set(
        ctx.snapshotNodes().filter((node) => ids.includes(node.id)).flatMap((node) => node.referenceImages || []),
      )];
      const unreachable: string[] = [];
      await Promise.all(currentRefUrls.map(async (url) => {
        try {
          const res = await fetch(url, { method: "HEAD" });
          if (!res.ok) unreachable.push(url);
        } catch {
          unreachable.push(url);
        }
      }));
      const verdict = verifyPreflightReport({
        report: lastPreflightReport,
        workflowId: "",
        nodeIds: ids,
        current: { unreachableReferences: unreachable },
      });
      if (!verdict.ok) {
        return fail(`批量执行被拦下：${verdict.reason}。${verdict.hint}`);
      }

      const outcomes = ctx.runNodes
        ? await ctx.runNodes(ids)
        : await Promise.all(ids.map(async (id) => ({ id, ...(await ctx.runNode(id)) })));

      const receipts = outcomes.map((item) => toSubmitReceipt(item.id, item));
      const submitted = receipts.filter((item) => item.submitted).length;
      const skipped = receipts.filter((item) => item.status === "skipped");
      const failed = receipts.filter((item) => item.status === "failed");
      const notes = [
        skipped.length ? `跳过 ${skipped.length} 个（本轮已提交过，未重复扣费）` : "",
        failed.length ? `失败 ${failed.length} 个（${failed.map((item) => `${item.id}: ${item.reason || "未知原因"}`).join("；")}）` : "",
      ].filter(Boolean).join("；");
      const summary = submitted
        ? `已提交 · 生成中：${submitted} 个节点${notes ? `（${notes}）` : ""}`
        : `没有任何节点被提交${notes ? `：${notes}` : ""}`;
      return {
        ok: submitted > 0,
        result: buildSubmitPayload(receipts, notes || undefined),
        summary,
      };
    }
    case "connect_nodes": {
      // 批量优先：母版连多个分镜是常见动作，一次连完能省掉一堆往返
      const links = Array.isArray(args.links) ? args.links : [];
      if (links.length) {
        const known = new Set(ctx.snapshotNodes().map((node) => node.id));
        const done: Array<{ source: string; target: string }> = [];
        const skipped: string[] = [];
        for (const item of links.slice(0, MAX_BATCH_LINKS)) {
          const source = String((item as Record<string, unknown>)?.source || "").trim();
          const target = String((item as Record<string, unknown>)?.target || "").trim();
          if (!source || !target || source === target || !known.has(source) || !known.has(target)) {
            skipped.push(`${source || "?"}→${target || "?"}`);
            continue;
          }
          if (ctx.addEdge(source, target)) done.push({ source, target });
          else skipped.push(`${source}→${target}（已存在或失败）`);
        }
        if (!done.length) return fail(`一条都没连上：${skipped.join("、")}`);
        return {
          ok: true,
          result: JSON.stringify({ links: done, skipped }),
          summary: `连了 ${done.length} 条线${skipped.length ? `（${skipped.length} 条跳过）` : ""}`,
        };
      }

      const source = String(args.source || "").trim();
      const target = String(args.target || "").trim();
      if (!source || !target) return fail("缺少 source / target");
      if (source === target) return fail("不能把节点连到自己");
      const ids = new Set(ctx.snapshotNodes().map((node) => node.id));
      if (!ids.has(source) || !ids.has(target))
        return fail("节点不存在（先用 get_canvas_overview 拿 id）");
      if (!ctx.addEdge(source, target))
        return fail("连线失败（可能已存在同样的连线）");
      return {
        ok: true,
        result: JSON.stringify({ source, target }),
        summary: `连线 ${source} → ${target}`,
      };
    }
    case "remove_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      if (!ctx.removeNode(id)) return fail(`找不到节点 ${id}`);
      return {
        ok: true,
        result: JSON.stringify({ id }),
        summary: `删除节点 ${id}（含其连线）`,
      };
    }
    case "select_nodes": {
      const ids = Array.isArray(args.ids)
        ? args.ids.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (!ids.length) return fail("ids 不能为空");
      const focus = args.focus !== false;
      ctx.selectNodes(ids, focus);
      return {
        ok: true,
        result: JSON.stringify({ selected: ids }),
        summary: `选中 ${ids.length} 个节点${focus ? "并把视图移过去" : ""}`,
      };
    }
    case "attach_reference_images": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      if (!ctx.snapshotNodes().some((node) => node.id === id)) {
        return fail(`找不到节点 ${id}（先用 get_canvas_overview 拿 id）`);
      }
      const explicit = Array.isArray(args.images)
        ? args.images.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const images = explicit.length ? explicit : ctx.referenceImages?.() || [];
      if (!images.length) {
        return fail(
          "没有任何参考图可用：用户这一轮没有上传参考图，也没有在 images 里给地址。直接用提示词生成，或先请用户上传。",
        );
      }
      if (!ctx.attachReferenceImages) {
        return fail("当前环境不支持把参考图挂到节点上");
      }
      const attached = ctx.attachReferenceImages(id, images);
      if (!attached.ok) {
        return fail(`挂参考图失败：${attached.reason || "找不到节点 " + id}`);
      }
      return {
        ok: true,
        result: JSON.stringify({ id, referenceImageCount: images.length, note: attached.reason || undefined }),
        summary: attached.reason
          ? `给节点 ${id} 挂了参考图：${attached.reason}`
          : `给节点 ${id} 挂了 ${images.length} 张参考图（执行该节点会走图生图）`,
      };
    }
    case "run_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      const outcome = await ctx.runNode(id);
      const receipts = [toSubmitReceipt(id, outcome)];
      if (!outcome.ok) {
        // 失败与「本轮已提交过」都要有可读的 result（模型据此决定重试还是继续），
        // 结构化回执一并带上，别只有一句人话。
        const message = outcome.status === "duplicate"
          ? `节点 ${id} 本轮已提交过，这次跳过：${outcome.reason || ""}`
          : `提交节点 ${id} 失败：${outcome.reason || "未知原因"}`;
        return {
          ok: false,
          result: buildSubmitPayload(receipts, message),
          summary: message,
        };
      }
      return {
        ok: true,
        result: buildSubmitPayload(receipts),
        // 面板的步骤记录照这句显示 —— 必须是「已提交 · 生成中」，不能写成「已完成」
        summary: `已提交 · 生成中（节点 ${id}）`,
      };
    }
    case "list_workflow_templates": {
      const templates = ctx.listTemplates();
      return {
        ok: true,
        result: JSON.stringify(templates),
        summary: `列出 ${templates.length} 个可用模板`,
      };
    }
    case "apply_workflow_template": {
      const templateId = String(args.templateId || "").trim();
      if (!templateId) return fail("缺少 templateId");
      const base = ctx.defaultPosition();
      const position = {
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : base.x,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : base.y,
      };
      const created = ctx.applyTemplate(templateId, position);
      if (!created)
        return fail(
          `没有这个模板：${templateId}（先用 list_workflow_templates 拿 id）`,
        );
      return {
        ok: true,
        result: JSON.stringify(created),
        summary: `套用模板 ${templateId}：新增 ${created.nodes} 个节点、${created.edges} 条连线`,
      };
    }
    default:
      return fail(`没有这个工具：${name}`);
  }
};
