/**
 * 画布 Agent 的「一轮内插话」入口（2026-09-26）。
 *
 * 要解决的问题：面板在 Agent 跑的时候把输入框禁掉了，而一轮可能很长（实测一次 128 秒）。
 * 用户想补一句「别用这个模型」「第三张换个角度」时，只能干等 —— 或者（旧路径）回车
 * 再发一次，那会走 `createGenerationTask` 起**第二个任务**，两个 Agent 抢同一把画布锁。
 *
 * 解法是 Pi 的原生队列，不自研并发：
 *   · `agent.steer(message)`   —— 把用户输入插进**当前轮**（工具跑完的间隙注入，下一轮模型就能看到）；
 *   · `agent.followUp(message)` —— 作为**后续**排队，等这一轮该干的都干完了再处理。
 * 见 `@earendil-works/pi-agent-core` README「Steering and Follow-up」（steer 示例 402 行、
 * followUp 示例 408 行、队列模式 398 行；`finishTurn` 语义 144-154 行）。
 *
 * 这里**只做投递**：把消息塞进正在跑的那个 Agent 的队列。它**绝不**创建新任务
 * （不 import 也不调用任何 start/create 任务的东西）—— 这是本批次立项时被判「高风险」的那条，
 * 现在靠 Pi 原生能力绕开了：插话是同一个任务的输入，不是第二个任务。
 *
 * 与 `canvas-agent-bridge.ts` 同一套进程内假设：执行器与它注册的 Agent 同进程，
 * 浏览器把插话 POST 到本实例的 HTTP 入口；多实例部署下若打到别的实例，投递会明确失败
 * （`accepted:false`），不会静默变成「换个实例再起一轮」。
 */

/** Pi 队列接受的最小消息形状：一条普通用户消息（与 README 示例一致，见 402/408 行） */
export interface CanvasAgentSteeringMessage {
  role: "user";
  content: string;
  timestamp: number;
}

/** 执行器注册进来的投递面：只暴露 Pi 队列需要的两个方法，不把整个 Agent 泄漏出去 */
export interface CanvasAgentSteeringTarget {
  steer: (message: CanvasAgentSteeringMessage) => void;
  followUp: (message: CanvasAgentSteeringMessage) => void;
}

/** 插话方式：`steer` = 插入当前轮；`follow-up` = 排在后面（这一轮结束后处理） */
export type CanvasAgentInterjectionMode = "steer" | "follow-up";

export interface CanvasAgentSteerInput {
  content: string;
  mode?: string;
}

export interface CanvasAgentSteerResult {
  accepted: boolean;
  mode: CanvasAgentInterjectionMode;
  /** accepted=false 时可读原因（任务已结束 / 内容为空 / 本实例没有这个任务） */
  reason?: string;
}

const steeringTargets = new Map<string, CanvasAgentSteeringTarget>();

/** 执行器在 `new Agent(...)` 之后调用：这一轮可被插话的时间窗从这里开始 */
export const registerCanvasAgentSteering = (
  recordId: string,
  target: CanvasAgentSteeringTarget,
): void => {
  const key = String(recordId || "").trim();
  if (!key) return;
  steeringTargets.set(key, target);
};

/** 任务到达任何终态时调用：窗口关闭，之后再插话一律明确失败 */
export const unregisterCanvasAgentSteering = (recordId: string): void => {
  steeringTargets.delete(String(recordId || "").trim());
};

/** 诊断用：这个任务当前能不能被插话 */
export const isCanvasAgentSteeringActive = (recordId: string): boolean =>
  steeringTargets.has(String(recordId || "").trim());

/** 诊断/测试用：当前登记在案的任务数 */
export const getCanvasAgentSteeringTargetCount = (): number =>
  steeringTargets.size;

/** 只认 `follow-up`，其余（含缺失）一律按 `steer` —— 默认行为必须是最贴近用户直觉的「插入当前轮」 */
export const normalizeCanvasAgentInterjectionMode = (
  mode: unknown,
): CanvasAgentInterjectionMode =>
  String(mode || "").trim() === "follow-up" ? "follow-up" : "steer";

/**
 * 造一条插话消息。
 *
 * `role: "user"` 是刻意的：Pi 会把队列消息当普通用户输入注入转录
 * （agent-loop.js:116-120：`message_start/end` 后 push 进 context 与 newMessages），
 * 于是它**既被模型看到，也被既有会话落库/压缩带走** —— 用户插了什么，转录里就有。
 */
export const buildCanvasAgentInterjectionMessage = (
  content: string,
  now: number = Date.now(),
): CanvasAgentSteeringMessage => ({
  role: "user",
  content: String(content || "").trim(),
  timestamp: now,
});

/**
 * 把一次插话投递给正在跑的 Agent。
 *
 * 返回值 `accepted` 是调用方（HTTP 路由）要如实回给前端的：投递不成功就**不能**让用户
 * 以为自己的话已经进了这一轮 —— 那会产出「用户以为说了、Agent 没听到」这种最糟的结果。
 */
export const steerCanvasAgent = (
  recordId: string,
  input: CanvasAgentSteerInput,
): CanvasAgentSteerResult => {
  const mode = normalizeCanvasAgentInterjectionMode(input?.mode);
  const content = String(input?.content ?? "").trim();
  if (!content) {
    return { accepted: false, mode, reason: "插话内容为空，没有可投递的内容" };
  }

  const target = steeringTargets.get(String(recordId || "").trim());
  if (!target) {
    return {
      accepted: false,
      mode,
      reason: "这一轮 Agent 已结束（或不在当前实例上运行），插话没有送达；请重新发起。",
    };
  }

  const message = buildCanvasAgentInterjectionMessage(content);
  if (mode === "follow-up") {
    target.followUp(message);
  } else {
    target.steer(message);
  }
  return { accepted: true, mode };
};
