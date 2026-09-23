/**
 * 列最近的图片记录（含无输出的），用来把「落盘了但记录里没有」的图对回到具体记录上。
 * 跑法：npx tsx --env-file=.env.development scripts/inspect-recent-records.mjs
 */
import { prisma } from '../server/db/prisma.ts'

const rows = await prisma.generationRecord.findMany({
  where: { type: 'IMAGE', createdAt: { gte: new Date('2026-09-23T15:35:00Z') } },
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    status: true,
    modelKey: true,
    createdAt: true,
    finishedAt: true,
    prompt: true,
    _count: { select: { outputs: true } },
  },
})

console.log(`${rows.length} 条记录（北京时间 = createdAt + 8h）\n`)
for (const row of rows) {
  const beijing = new Date(row.createdAt.getTime() + 8 * 3600 * 1000).toLocaleString('zh-CN', { hour12: false })
  const prompt = String(row.prompt || '').replace(/\s+/g, ' ').slice(0, 30)
  console.log(`${beijing}  ${row.status.padEnd(9)} 输出=${row._count.outputs}  ${String(row.modelKey || '').slice(-24).padEnd(24)}  ${row.id}`)
  console.log(`            提示词：${prompt}`)
}

await prisma.$disconnect()
