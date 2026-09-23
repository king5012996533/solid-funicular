/** 删掉端到端验证留下的那条打桩记录（含落盘文件），别污染用户的历史列表。 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../server/db/prisma.ts'

const ids = process.argv.slice(2)
for (const id of ids) {
  const record = await prisma.generationRecord.findUnique({ where: { id }, include: { outputs: true } })
  if (!record) { console.log(`${id}: 不存在`); continue }
  for (const output of record.outputs) {
    const url = String(output.url || '')
    if (!url.startsWith('/uploads/')) continue
    const file = path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', ''))
    try { await fs.promises.unlink(file); console.log(`  删除文件 ${url}`) } catch { /* 已不在 */ }
  }
  await prisma.generationRecord.delete({ where: { id } })
  console.log(`${id}: 已删除记录`)
}
await prisma.$disconnect()
