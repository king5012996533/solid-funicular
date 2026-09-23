/** 打印一条记录 content 里的阶段行原文（界面就是按这些行渲染的），用来定位文案重复。 */
import { prisma } from '../server/db/prisma.ts'

const ids = process.argv.slice(2)
const rows = await prisma.generationRecord.findMany({
  where: ids.length ? { id: { in: ids } } : { type: 'IMAGE' },
  orderBy: { createdAt: 'desc' },
  take: ids.length ? undefined : 3,
  select: { id: true, status: true, content: true, createdAt: true, _count: { select: { outputs: true } } },
})

for (const row of rows) {
  console.log(`--- ${row.id} status=${row.status} 输出=${row._count.outputs} ---`)
  const lines = String(row.content || '').split('\n')
  lines.forEach((line, index) => console.log(`  [${index}] ${JSON.stringify(line)}`))
  console.log('')
}
await prisma.$disconnect()
