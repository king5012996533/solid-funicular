import { prisma } from '../db/prisma'
import { toNullableJsonInput } from '../shared/json-input'

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

/** 锁的最长持有时间：流水线一轮可能十几分钟，给足 30 分钟后自动失效，避免僵死锁住画布 */
const LOCK_TTL_MS = 30 * 60_000

export interface PipelineLockInfo {
  workflowId: string
  userId: string
  token: string
  snapshotVersionId: string
  acquiredAt: number
  expiresAt: number
}

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

/** 诊断用：当前持锁的画布（排查「画布被锁住」这类问题时很有用） */
export const listActivePipelineLocks = (): PipelineLockInfo[] => {
  pruneExpired()
  return [...locks.values()]
}
