/**
 * 流水线锁的**纯决策逻辑**（不碰数据库、不碰任何 IO）。
 *
 * 为什么单独一个文件：pipeline-lock.ts 要 import Prisma 才能建快照，而单测环境没有
 * DATABASE_URL —— 把它引进单测会在创建 PrismaClient 时就炸。决策规则本身与存储无关，
 * 拆出来才能被真正单测覆盖，同时三个写入口也都调这一处，不会各写一份 if。
 */

export interface PipelineLockInfo {
  workflowId: string
  userId: string
  token: string
  snapshotVersionId: string
  acquiredAt: number
  expiresAt: number
  /**
   * 取这把锁的那个任务（画布 Agent 的 recordId），由 bindPipelineLockToTask 在建单后写入。
   * 任务到达终态时服务端据此释放锁；释放前必须校验「当前这把锁是不是本任务那把」——
   * 只要 recordId 对不上就不动它，避免误放别的任务后来新取的锁。
   */
  recordId?: string
  /** 最近一次续约时间（仅诊断用：能看出运行中的任务有没有在续租） */
  renewedAt?: number
}

/** 锁是否已过 TTL（进程没崩但任务僵死时，靠它自动放行，避免永久锁住画布） */
export const isPipelineLockExpired = (lock: PipelineLockInfo, now: number = Date.now()) => lock.expiresAt <= now

/**
 * 一次画布写入该不该被拦。
 *
 * 规则只有两条：**没有锁就放行；有锁且 token 不对就拦下**。
 * 特别注意「带对了 token」要放行 —— 流水线自己那轮改动画布也是走这些写入口的，
 * 拦掉它等于把自己的写入挡住（这是设计里最容易写反的一处）。
 */
export const evaluateCanvasWriteLock = (
  lock: PipelineLockInfo | null | undefined,
  pipelineToken: string | undefined,
  now: number = Date.now(),
): { blocked: boolean; holder?: PipelineLockInfo } => {
  if (!lock) return { blocked: false }
  if (isPipelineLockExpired(lock, now)) return { blocked: false }
  if (lock.token === String(pipelineToken || '')) return { blocked: false }
  return { blocked: true, holder: lock }
}

/**
 * 任务到达终态时，这把锁该不该由这条任务释放。
 *
 * 只看 recordId 是否精确相等：任务 A 收口时若 B 已经取了新锁（recordId 是 B），这里返回 false，
 * 不去动 B 的锁。这是「不误放别人后来新取的锁」这条要求的落点。
 */
export const shouldReleaseLockForTask = (
  lock: PipelineLockInfo | null | undefined,
  recordId: string,
): boolean => Boolean(lock && recordId && lock.recordId === recordId)

/**
 * 该用户有没有资格强制释放这把锁。
 *
 * 只允许放「自己持有的」锁：锁是防别的流水线并发改画布，不该防用户自己。
 * 由于 acquirePipelineLock 已经校验了画布归属，lock.userId 匹配即代表这是他自己画布上的锁。
 */
export const canForceReleaseLockForUser = (
  lock: PipelineLockInfo | null | undefined,
  userId: string,
): boolean => Boolean(lock && userId && lock.userId === userId)

/**
 * 释放锁的结果。为什么不是布尔：调用方要区分「本来就没锁」与「锁是别人的」——
 * 前者该按成功处理，后者才是冲突。混成一个 false，客户端就会把「锁已经被任务终态
 * 那一路放掉了」这种完全正常的情况报成红字错误。
 */
export type PipelineLockReleaseOutcome = 'released' | 'already-released' | 'not-owner'

/**
 * 释放锁的判定。**幂等**：锁已经不在 = 已经释放成功。
 *
 * 依据：调用方（`POST …/pipeline-lock/release`）要的结果是「这通调用之后这把锁不再由我持有」。
 * 服务端在任务终态时已经按 recordId 放过一次（见 releasePipelineLockForTask），
 * 客户端随后补的这一发必然「锁不存在」—— 那是成功，不是失败。
 * 实测症状：画布上弹「释放失败：锁不存在，或 token 不是持锁者的」，明明什么都没出错。
 *
 * 只有「锁还在、token 却对不上」才是 not-owner：那是别人的锁，不能谎报已释放。
 * 空 token 一律不算持锁者（防止老客户端漏传字段时误放）。
 */
export const resolvePipelineLockReleaseOutcome = (
  lock: PipelineLockInfo | null | undefined,
  token: string,
): PipelineLockReleaseOutcome => {
  if (!lock) {
    return 'already-released'
  }
  const given = String(token || '')
  if (!given || String(lock.token || '') !== given) {
    return 'not-owner'
  }
  return 'released'
}
