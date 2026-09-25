import { prisma } from '../db/prisma'
import {
  canForceReleaseLockForUser,
  evaluateCanvasWriteLock,
  isPipelineLockExpired,
  shouldReleaseLockForTask,
  type PipelineLockInfo,
} from './pipeline-lock-rules'

// 决策逻辑在 pipeline-lock-rules.ts（不依赖 IO，可单测）；这里保留同名导出，调用方无需改动
export { canForceReleaseLockForUser, evaluateCanvasWriteLock, isPipelineLockExpired, shouldReleaseLockForTask }
export type { PipelineLockInfo }
import { toNullableJsonInput } from '../shared/json-input'
import { writeScopedLog } from '../shared/logging'

/**
 * 画布流水线锁（M3「最后一公里」风险①：画布状态序列化 + 快照锁）
 *
 * 要解决的问题：Agent 一轮连续跑十几步、改几十个节点。这期间如果画布被别处改动
 * （用户手拖、另一个标签页自动保存、云端同步），Agent 手里的节点 id / 参考图引用就可能失效 ——
 * 表现是「母版图找不到、后续分镜人物崩坏」，而且极难排查。
 *
 * 做法：跑之前**打一份快照**并占住锁；跑完释放；中途失败可以拿快照回滚/续跑。
 *
 * 两个刻意的选择：
 * 1. **快照是「侧写」而不是「另存为当前版本」**。项目里已有的 createWorkflowDefinitionVersion
 *    会把 currentVersionId 指到新版本上 —— 那等于把用户的当前画布换成快照，方向反了。
 *    这里直接建一条 DRAFT 版本、只推进 latestVersionNo，**不动 currentVersionId**：
 *    用户看到的画布不变，版本列表里多出一条「Agent 本轮快照」，将来回滚就是把它设为 current。
 * 2. **锁只在内存里，带 TTL**。它是「本轮进程内的一次执行」的互斥，不是分布式锁；
 *    进程重启后锁自然消失（快照还在，回滚能力不受影响）。TTL 兜住「进程没崩但任务僵死」。
 */

/**
 * 锁的最长持有时间。
 *
 * 它只是「持有者失活」的兜底，**不是主要释放机制** —— 主要释放有两条：
 *   ① 任务到达终态（成功/失败/停止/熔断）时，服务端据此释放（见 releasePipelineLockForTask）；
 *   ② 客户端 endPipelineRun 的正常路径（及时释放）。
 * 运行中的任务会定期续约，所以 5 分钟足够；比原来 30 分钟短得多，
 * 即便所有释放路径都失效，用户最多等几分钟，而不是半小时。
 */
const LOCK_TTL_MS = 5 * 60_000

/** 运行中任务的续约间隔：明显小于 TTL，留出网络抖动的余量 */
export const PIPELINE_LOCK_RENEW_INTERVAL_MS = 60_000

const locks = new Map<string, PipelineLockInfo>()

export type AcquirePipelineLockResult =
  | { ok: true; lock: PipelineLockInfo }
  | { ok: false; reason: 'locked'; holder: PipelineLockInfo }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_version' }

const pruneExpired = () => {
  const now = Date.now()
  for (const [workflowId, lock] of locks) {
    if (lock.expiresAt <= now) {
      locks.delete(workflowId)
    }
  }
}

/** 当前有没有人持锁（判过期），供写入口做校验 */
export const getActivePipelineLock = (workflowId: string): PipelineLockInfo | null => {
  pruneExpired()
  return locks.get(workflowId) ?? null
}

/**
 * 取锁并留快照。
 *
 * 同一画布同时只允许一个流水线 —— 后到的直接拿到 `locked` 和持锁者是谁，
 * 由调用方决定是等、还是提示用户；**不抢占**（抢占会让前一轮的中间成果变成孤儿）。
 */
export const acquirePipelineLock = async (input: {
  workflowId: string
  userId: string
  label?: string
}): Promise<AcquirePipelineLockResult> => {
  const { workflowId, userId, label } = input
  pruneExpired()

  const existing = locks.get(workflowId)
  if (existing) {
    return { ok: false, reason: 'locked', holder: existing }
  }

  const workflow = await prisma.workflowDefinition.findUnique({
    where: { id: workflowId },
    select: {
      id: true,
      userId: true,
      latestVersionNo: true,
      currentVersionId: true,
      currentVersion: {
        select: {
          definitionJson: true,
          nodesJson: true,
          edgesJson: true,
          viewportJson: true,
          inputSchemaJson: true,
          outputSchemaJson: true,
          runtimeConfigJson: true,
        },
      },
    },
  })

  if (!workflow) {
    return { ok: false, reason: 'not_found' }
  }
  if (workflow.userId !== userId) {
    return { ok: false, reason: 'forbidden' }
  }
  if (!workflow.currentVersion) {
    return { ok: false, reason: 'no_version' }
  }

  const source = workflow.currentVersion
  const snapshot = await prisma.$transaction(async (tx) => {
    const version = await tx.workflowDefinitionVersion.create({
      data: {
        workflowId,
        createdBy: userId,
        versionNo: workflow.latestVersionNo + 1,
        versionName: label?.slice(0, 100) || 'Agent 本轮快照',
        changeSummary: '制片 Agent 开始执行本轮改动前自动留存（用于失败回滚/续跑）',
        status: 'DRAFT',
        definitionJson: toNullableJsonInput(source.definitionJson),
        nodesJson: toNullableJsonInput(source.nodesJson),
        edgesJson: toNullableJsonInput(source.edgesJson),
        viewportJson: toNullableJsonInput(source.viewportJson),
        inputSchemaJson: toNullableJsonInput(source.inputSchemaJson),
        outputSchemaJson: toNullableJsonInput(source.outputSchemaJson),
        runtimeConfigJson: toNullableJsonInput(source.runtimeConfigJson),
      },
      select: { id: true },
    })

    // 只推进版本号，**不动 currentVersionId**：用户看到的画布保持原样
    await tx.workflowDefinition.update({
      where: { id: workflowId },
      data: { latestVersionNo: workflow.latestVersionNo + 1 },
    })

    return version
  })

  const now = Date.now()
  const lock: PipelineLockInfo = {
    workflowId,
    userId,
    token: `pl_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    snapshotVersionId: snapshot.id,
    acquiredAt: now,
    expiresAt: now + LOCK_TTL_MS,
  }
  locks.set(workflowId, lock)
  return { ok: true, lock }
}

/** 释放锁：只有持锁者本人（token 对得上）能放，避免误放别人的锁 */
export const releasePipelineLock = (workflowId: string, token: string): boolean => {
  const current = getActivePipelineLock(workflowId)
  if (!current) {
    return false
  }
  if (current.token !== token) {
    return false
  }
  locks.delete(workflowId)
  return true
}

/**
 * 把这把锁绑定到发起它的画布 Agent 任务（recordId）。
 *
 * 为什么需要绑定：取锁发生在建单**之前**（前端先占住画布，再起 Agent），
 * 所以取锁时还不知道 recordId；任务建出来后由服务端把它补上，任务终态时才能按 recordId 释放。
 * 只在 token 与 userId 都对得上时才写，避免被冒领。
 */
export const bindPipelineLockToTask = (input: {
  workflowId: string
  token: string
  recordId: string
  userId: string
}): boolean => {
  const { workflowId, token, recordId, userId } = input
  if (!recordId) {
    return false
  }
  const current = getActivePipelineLock(workflowId)
  if (!current || current.token !== token || current.userId !== userId) {
    return false
  }
  if (current.recordId === recordId) {
    return true
  }
  current.recordId = recordId
  locks.set(workflowId, current)
  writeScopedLog('info', '工作流', '画布锁已绑定到任务', { workflowId, recordId, userId })
  return true
}

/**
 * 任务到达终态（completed / failed / stopped / 超时熔断）时释放它持有的画布锁，幂等。
 *
 * **锁不该比任务活得久**：任务生命周期在服务端是权威的，客户端 endPipelineRun 只是正常路径的
 * 及时释放，任何一条客户端路径没走到都不该留下孤儿锁。
 *
 * 只放 `recordId` 正好是这条任务的那把：任务 A 收口时若 B 已经取了新锁，这里不会碰 B 的锁。
 */
export const releasePipelineLockForTask = (recordId: string): boolean => {
  if (!recordId) {
    return false
  }
  pruneExpired()
  for (const [workflowId, lock] of locks) {
    if (!shouldReleaseLockForTask(lock, recordId)) {
      continue
    }
    locks.delete(workflowId)
    writeScopedLog('info', '工作流', '任务终态释放画布锁', {
      workflowId,
      recordId,
      userId: lock.userId,
      heldMs: Date.now() - lock.acquiredAt,
    })
    return true
  }
  return false
}

/**
 * 运行中的任务续约自己那把画布锁（心跳）。
 *
 * TTL 是「持有者失活」的兜底，运行中的任务不该让它自然过期 —— 否则长任务中途锁失效，
 * 外部改动会插进来，锁就白加了。只有 recordId 匹配时才续，避免给别人的锁续命。
 */
export const renewPipelineLockForTask = (recordId: string): boolean => {
  if (!recordId) {
    return false
  }
  const now = Date.now()
  for (const [workflowId, lock] of locks) {
    if (lock.recordId !== recordId) {
      continue
    }
    // 已经过期的锁不「复活」：交给取锁逻辑重新走一遍，别让续约把失效锁又拎回来
    if (lock.expiresAt <= now) {
      locks.delete(workflowId)
      return false
    }
    lock.expiresAt = now + LOCK_TTL_MS
    lock.renewedAt = now
    locks.set(workflowId, lock)
    return true
  }
  return false
}

/**
 * 强制释放「自己的」画布锁（同一用户的会话，无需 token）。
 *
 * 理由：锁是防「**别的**流水线并发改画布」，不该防用户自己。任务早跑完但锁没被正常放掉时，
 * 用户会被自己的锁挡在门外干等 TTL —— 这不是加锁的本意。只放 userId 匹配的那把，
 * 所以不会影响别人正常的并发保护。
 */
export const forceReleasePipelineLockForUser = (
  workflowId: string,
  userId: string,
): { released: boolean; reason?: 'no_lock' | 'forbidden'; holder?: PipelineLockInfo } => {
  const current = getActivePipelineLock(workflowId)
  if (!current) {
    return { released: false, reason: 'no_lock' }
  }
  if (!canForceReleaseLockForUser(current, userId)) {
    writeScopedLog('warn', '工作流', '强制释放被拒：锁不属于该用户', {
      workflowId,
      userId,
      holderUserId: current.userId,
      recordId: current.recordId,
    })
    return { released: false, reason: 'forbidden', holder: current }
  }
  locks.delete(workflowId)
  writeScopedLog('warn', '工作流', '同用户强制释放画布锁', {
    workflowId,
    userId,
    recordId: current.recordId,
    heldMs: Date.now() - current.acquiredAt,
  })
  return { released: true, holder: current }
}

/** 诊断用：当前持锁的画布（排查「画布被锁住」这类问题时很有用） */
export const listActivePipelineLocks = (): PipelineLockInfo[] => {
  pruneExpired()
  return [...locks.values()]
}
