/**
 * 回归验证：生成记录的「终态不被回退 + 输出只增不减」（2026-09-23 真机事故）
 *
 * 事故现场（首页出图）：
 *   23:42:08 服务端 `图片任务请求上游` → 23:42:31 `图片任务请求成功 imageCount:1`，图已落盘；
 *   同一记录随后又被写了一次 `done:false / 0 张输出`，最终变成 STOPPED、0 输出 —— **图被删了**，
 *   界面停在「同步中」，用户以为一直没出结果，最后点了停止。
 *
 * 成因是丢更新：客户端在处理 progress 事件时会节流回写整条记录（只带自己知道的 done/images），
 * 数据库慢的时候这次回写比服务端的完成写入更晚落库；而写记录是「全量删除重建 outputs」，
 * 过期快照里的 0 张图就把真图删了。
 *
 * 这个脚本只用**临时记录**（跑完删掉），不动任何真实数据。
 * 需要连库，所以不放进 `npm test`，手动跑：
 *   npx tsx --env-file=.env.development scripts/verify-terminal-sticky.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { prisma } from '../server/db/prisma.ts'
import { updateGenerationRecord } from '../server/generation-records/service.ts'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

/** 借一个现成的会话与用户，建一条只属于本次验证的记录 */
const anchor = await prisma.generationRecord.findFirst({
  where: { outputs: { some: {} } },
  orderBy: { createdAt: 'desc' },
  select: { userId: true, sessionId: true },
})
assert(anchor, '库里没有可用作用户/会话的记录，无法建临时记录')

const scratchIds = []
const makeRecord = async (input) => {
  const record = await prisma.generationRecord.create({
    data: {
      userId: anchor.userId,
      sessionId: anchor.sessionId,
      type: 'IMAGE',
      status: input.status,
      prompt: '终态兜底回归验证用的临时记录',
      content: input.content ?? null,
    },
  })
  scratchIds.push(record.id)
  if (input.withOutput) {
    await prisma.generationOutput.create({
      data: {
        generationRecordId: record.id,
        outputType: 'IMAGE',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    })
  }
  return record
}
const readBack = (id) => prisma.generationRecord.findUnique({ where: { id }, include: { outputs: true } })
const staleSnapshot = (record) => ({
  sessionId: record.sessionId,
  source: 'generate',
  type: 'image',
  prompt: record.prompt,
  content: '[[queued]]排队中',
  done: false,
  stopped: false,
  images: [],
})

try {
  console.log('== 终态兜底 ==')

  await check('过期的非终态快照不能把「已完成」改回去', async () => {
    const record = await makeRecord({ status: 'COMPLETED', withOutput: true })
    await updateGenerationRecord(record.id, staleSnapshot(record), record.userId)
    const after = await readBack(record.id)
    assert(after.status === 'COMPLETED', `status 被回退成 ${after.status}`)
  })

  await check('过期的非终态快照不能删掉已经出好的图', async () => {
    const record = await makeRecord({ status: 'COMPLETED', withOutput: true })
    await updateGenerationRecord(record.id, staleSnapshot(record), record.userId)
    const after = await readBack(record.id)
    assert(after.outputs.length === 1, `图被删了，剩 ${after.outputs.length} 张`)
  })

  await check('停止收尾（终态→终态、不带输出）也不能删掉已经出好的图', async () => {
    const record = await makeRecord({ status: 'COMPLETED', withOutput: true })
    await updateGenerationRecord(record.id, {
      sessionId: record.sessionId,
      source: 'generate',
      type: 'image',
      prompt: record.prompt,
      content: '[[stopped]]任务已停止：用户取消',
      done: true,
      stopped: true,
      images: [],
    }, record.userId)
    const after = await readBack(record.id)
    assert(after.outputs.length === 1, `停止收尾把图删了，剩 ${after.outputs.length} 张`)
  })

  await check('运行中的记录照常可写（兜底不能变成「谁都不能改」）', async () => {
    const record = await makeRecord({ status: 'PENDING' })
    await updateGenerationRecord(record.id, staleSnapshot(record), record.userId)
    const after = await readBack(record.id)
    assert(after.content === '[[queued]]排队中', `非终态的 content 应能写入，实际：${after.content}`)
  })

  await check('真结果当然能写进去（正常完成路径不能被兜底挡住）', async () => {
    const record = await makeRecord({ status: 'RUNNING' })
    await updateGenerationRecord(record.id, {
      sessionId: record.sessionId,
      source: 'generate',
      type: 'image',
      prompt: record.prompt,
      content: '[[completed]]图片生成完成',
      done: true,
      // 用 1×1 的 data URL：真实链路里上游返回的就是 data URL，
      // 而写记录时会把输出「落盘」，用一个不存在的域名会当场 fetch failed（第一版就踩了这个）
      images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
    }, record.userId)
    const after = await readBack(record.id)
    assert(after.status === 'COMPLETED', `应完成，实际 ${after.status}`)
    assert(after.outputs.length === 1, `结果没写进去，输出 ${after.outputs.length} 张`)
  })
  /**
   * 并发写：完成写入与「滞后快照」同时打进来。
   *
   * 这是 2026-09-24 00:18 真机事故的形状 —— 服务端记下 done:true/1 张图，
   * 同一秒另一个写者落成 done:false/0 张图，库里最终是 RUNNING、0 输出，
   * 而用户界面上已经有图（刷新即消失）。
   * 加了行锁之后，两个写者会被串行化，无论谁先谁后，**终态都必须是「已完成且有图」**。
   */
  await check('并发写入（完成 + 滞后快照）无论谁先落库，结果都是已完成且有图', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    for (let round = 1; round <= 5; round += 1) {
      const record = await makeRecord({ status: 'RUNNING' })
      const stale = staleSnapshot(record)
      const completion = {
        sessionId: record.sessionId,
        source: 'generate',
        type: 'image',
        prompt: record.prompt,
        content: '[[completed]]已完成：图片生成完成',
        done: true,
        images: [dataUrl],
      }
      // 滞后快照先发一拍，再让完成写入进场 —— 复现「旧快照最后落库」的时序
      const stalePromise = updateGenerationRecord(record.id, stale, record.userId)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const completionPromise = updateGenerationRecord(record.id, completion, record.userId)
      await Promise.allSettled([stalePromise, completionPromise])

      const after = await readBack(record.id)
      assert(after.status === 'COMPLETED', `第 ${round} 轮：status=${after.status}（应为 COMPLETED）`)
      assert(after.outputs.length === 1, `第 ${round} 轮：输出 ${after.outputs.length} 张（应为 1）`)
    }
  })
} finally {
  /**
   * 收尾要把**落盘产物**也删掉。
   *
   * 写记录时会把 data URL 落盘成真文件（这里用的是 1×1 占位图，70 字节），
   * 临时记录删了、文件还留在 uploads 里 —— 我第一版忘了清，用户的素材目录里就多了 7 个 70 字节的垃圾。
   */
  const scratchOutputs = scratchIds.length
    ? await prisma.generationOutput.findMany({
        where: { generationRecordId: { in: scratchIds } },
        select: { url: true },
      })
    : []
  let removedFiles = 0
  for (const output of scratchOutputs) {
    const url = String(output.url || '')
    if (!url.startsWith('/uploads/')) continue
    const filePath = path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', ''))
    try {
      await fs.promises.unlink(filePath)
      removedFiles += 1
    } catch {
      // 文件可能因为「已本地托管」被复用而没新建，删不到不算错
    }
  }

  if (scratchIds.length) {
    await prisma.generationRecord.deleteMany({ where: { id: { in: scratchIds } } })
    console.log(`\n（已清理 ${scratchIds.length} 条临时记录、${removedFiles} 个落盘文件）`)
  }
  await prisma.$disconnect()
}

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
