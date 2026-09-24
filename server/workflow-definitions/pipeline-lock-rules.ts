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
