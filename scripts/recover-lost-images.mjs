/**
 * 抢救昨夜被覆盖掉的三张图（2026-09-23 丢更新事故）
 *
 * 背景：三条记录都在上游成功、图片已落盘之后，被一份过期快照覆盖成 0 输出（详见
 * scripts/verify-terminal-sticky.mjs 里的事故说明）。**记录里的输出行没了，但文件还在磁盘上** ——
 * 落盘发生在写记录之前，所以 uploads/generated/image/20260923/ 下留着这三个文件。
 *
 * 抢救办法不是手工插数据库行，而是**走产品自己的写入路径** `updateGenerationRecord`
 * （终态→终态是允许的），这样 outputs 与「素材库」的资产项都会按正常逻辑补齐，不会只修一半。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/recover-lost-images.mjs [--apply]
 *   不带 --apply 只做体检（打印将要发生什么），带 --apply 才真的写。
 */
import { prisma } from '../server/db/prisma.ts'
import { updateGenerationRecord } from '../server/generation-records/service.ts'

/** 记录 id → 磁盘上的文件。配对依据：日志里每条记录的「输出资源落盘成功」时间与文件名一一对应 */
const RECOVERIES = [
  {
    recordId: 'cmue9pvy9005akc92q6x0h4z5',
    file: '1790178128622-2412f4a9-98e8-4280-983a-be711502612e.png',
    bytes: 1991949,
    evidence: '落盘 23:42:14；23:42:31 服务端报「图片任务请求成功 imageCount:1」',
  },
  {
    recordId: 'cmue9uotq005ekc928tvsdmua',
    file: '1790178347094-6933d0c1-3bd9-4fe5-9fdc-315cf4fe62fd.png',
    bytes: 1827384,
    evidence: '落盘 23:45:47；23:46:04 服务端报「图片任务请求成功 imageCount:1」',
  },
  {
    recordId: 'cmue9u9hi005bkc92avl0o10p',
    file: '1790178406561-53818d42-9278-451c-81b9-0a06c13ebdb4.png',
    bytes: 1977506,
    evidence: '落盘 23:46:46（该记录 23:46:46 发起上游请求后成功）',
  },
]

const apply = process.argv.includes('--apply')
console.log(apply ? '模式：写入（--apply）\n' : '模式：体检（只打印，不写库；加 --apply 才真的改）\n')

for (const item of RECOVERIES) {
  const record = await prisma.generationRecord.findUnique({
    where: { id: item.recordId },
    include: { outputs: true, assets: true },
  })
  if (!record) {
    console.log(`✗ ${item.recordId} 不存在，跳过`)
    continue
  }
  const url = `/uploads/generated/image/20260923/${item.file}`
  console.log(`--- ${item.recordId} ---`)
  console.log(`  现在：status=${record.status} 输出=${record.outputs.length} 资产=${record.assets.length}`)
  console.log(`  依据：${item.evidence}`)
  console.log(`  将恢复为：status=COMPLETED，输出 1 张 → ${url}（磁盘上 ${item.bytes} 字节）`)

  if (!apply) continue

  await updateGenerationRecord(item.recordId, {
    sessionId: record.sessionId,
    source: 'generate',
    type: 'image',
    prompt: record.prompt,
    model: record.modelLabel || undefined,
    modelKey: record.modelKey || undefined,
    ratio: record.ratio || undefined,
    resolution: record.resolution || undefined,
    // 保留原有的阶段对话，别把「排队中→同步中」这段历史抹掉
    content: record.content || undefined,
    done: true,
    stopped: false,
    images: [url],
  }, record.userId)

  const after = await prisma.generationRecord.findUnique({
    where: { id: item.recordId },
    include: { outputs: true, assets: true },
  })
  console.log(`  ✅ 恢复后：status=${after.status} 输出=${after.outputs.length} 资产=${after.assets.length}`)
  for (const output of after.outputs) console.log(`     输出：${output.outputType} ${output.url}`)
  console.log('')
}

await prisma.$disconnect()
