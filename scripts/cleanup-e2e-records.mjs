/**
 * 清掉历次「本地库端到端验证」留下的打桩记录（含资产与落盘文件）。
 * 按提示词精确匹配，不碰用户的真实作品。
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../server/db/prisma.ts'

const KEYWORD = process.argv[2] || '本地库端到端验证'
const records = await prisma.generationRecord.findMany({
  where: { prompt: { contains: KEYWORD } },
  select: { id: true, prompt: true, outputs: { select: { url: true } } },
})
console.log(`匹配到 ${records.length} 条（关键词：${KEYWORD}）`)

let files = 0
for (const record of records) {
  for (const output of record.outputs) {
    const url = String(output.url || '')
    if (!url.startsWith('/uploads/')) continue
    const file = path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', ''))
    try { await fs.promises.unlink(file); files += 1 } catch { /* 已不在 */ }
  }
  // 资产行要显式删：AssetItem 对记录是 onDelete: SetNull，只删记录会留下指向已删文件的孤儿资产
  await prisma.assetItem.deleteMany({ where: { generationRecordId: record.id } })
  await prisma.generationRecord.delete({ where: { id: record.id } })
  console.log(`  删除 ${record.id}  ${String(record.prompt).slice(0, 26)}`)
}
console.log(`完成：${records.length} 条记录、${files} 个落盘文件`)

const left = await prisma.assetItem.count({ where: { isDeleted: false } })
const broken = await prisma.assetItem.findMany({ where: { isDeleted: false }, select: { fileUrl: true } })
const missing = broken.filter((asset) => {
  const url = String(asset.fileUrl || '')
  return url.startsWith('/uploads/') && !fs.existsSync(path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', '')))
})
console.log(`资产库复查：可见 ${left} 条，其中破图 ${missing.length} 条`)

await prisma.$disconnect()
