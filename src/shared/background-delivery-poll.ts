/**
 * 「不等了，让它后台跑完」的共用轮询节奏与终态判定（2026-09-26）。
 *
 * 为什么要有这个模块：
 *   付费生成任务一旦提交，上游就已经在生成 —— 钱付了、结果是有保证的。
 *   所以「不等了」绝不取消任务（取消 = 退用户 + 付上游 + 拿不到成果，净亏），
 *   只是解除**客户端**的等待：断本地 SSE 订阅、停计时、把状态记成「后台生成中」，
 *   然后按固定节奏去查任务记录，等结果自己回来再落界面上。
 *
 * 画布图片节点（ImageNode.vue）与生成页图片记录（generate.vue）用的是**同一套**节奏与判定，
 *   所以把节奏常量与判定函数抽到这里。这里只做纯计算 ——
 *   不碰定时器、不碰 DOM，定时器一律由调用方（组件）自己管，这样判定逻辑才能单测。
 *
 * 铁律（两边落地时都必须遵守）：
 *   1. 绝不调用 stopGenerationTask 之类的 stop 接口；
 *   2. 绝不 abort 服务端任务，只 abort 客户端的订阅 / 定时器；
 *   3. 任务在服务端照常跑完并写记录 + 资产，本模块只负责「客户端什么时候不再等」。
 */

/** 首次查询延迟：提交后别急着查，先给上游一点时间（单位毫秒） */
export const BACKGROUND_POLL_FIRST_DELAY_MS = 3_000

/** 首次之后的查询间隔（单位毫秒） */
export const BACKGROUND_POLL_INTERVAL_MS = 20_000

/**
 * 轮询总时长上限（单位毫秒，30 分钟）。
 *
 * 到期仍未完成就落「等太久，可以重试」的失败态并停止轮询 ——
 * **注意**：放弃的只是客户端的等待，服务端任务不受影响，仍会跑完并入库，
 * 用户刷新一下记录就能看到成果。
 */
export const BACKGROUND_POLL_MAX_DURATION_MS = 30 * 60 * 1000

/** 判定结果：终态三选一，或继续等 / 放弃 */
export type BackgroundDeliveryDecision =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'keep-waiting'
  | 'give-up'

/**
 * 判定只看这几个字段，调用方直接传 PersistedGenerationRecord 即可。
 * 之所以不用完整类型：只是为了让本模块保持纯粹、可独立单测，不引入 api 层依赖。
 */
export interface BackgroundDeliveryRecord {
  done?: boolean
  stopped?: boolean
  error?: unknown
  images?: unknown
}

/**
 * 给定任务记录与已轮询时长，判断该怎么收口。
 *
 * 判定顺序（错了会让用户拿到误导性的结果）：
 *   1. `done` 且有图 → completed：拿到成果就是完成，优先于一切（哪怕记录上带着别的标记）；
 *   2. `stopped` → stopped：服务端不会再产出，落停止态（对应 UI 的「已停止生成」）；
 *   3. `done` 但无图 → failed：完成了却没有产出，按现有口径落可重试失败态，不能一直等；
 *   4. `error` → failed：记录了错误（可能 done 尚未置位）；
 *   5. 已超预算 → give-up；否则 keep-waiting。
 *
 * `elapsedMs` 越界（NaN / 负数）时按「还没超预算」处理，避免误判成放弃。
 */
export const decideBackgroundDelivery = (
  record: BackgroundDeliveryRecord | null | undefined,
  elapsedMs: number,
): BackgroundDeliveryDecision => {
  if (record) {
    const images = Array.isArray(record.images) ? record.images.filter(Boolean) : []
    if (record.done && images.length) return 'completed'
    if (record.stopped) return 'stopped'
    if (record.done) return 'failed'
    if (record.error) return 'failed'
  }

  const elapsed = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0
  if (elapsed >= BACKGROUND_POLL_MAX_DURATION_MS) return 'give-up'
  return 'keep-waiting'
}
