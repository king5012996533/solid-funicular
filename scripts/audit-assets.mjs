/**
 * 盘一下资产库：哪些是指向「磁盘上不存在」的破图，哪些是小到不可能正常的占位图。
 * 只读，不改任何东西。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/audit-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../server/db/prisma.ts'

const assets = await prisma.assetItem.findMany({
  orderBy: { createdAt: 'asc' },
  select: { id: true, userId: true, fileUrl: true, coverUrl: true, thumbnailUrl: true, assetType: true, title: true, fileSizeBytes: true, createdAt: true },
})
console.log(`资产库共 ${assets.length} 条\n`)

const buckets = { missing: [], tiny: [], ok: [] }
for (const asset of assets) {
  const url = String(asset.fileUrl || '')
  if (!url.startsWith('/uploads/')) { buckets.tiny.push({ ...asset, size: -1, note: '非本地文件（外链）' }); continue }
  const file = path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', ''))
  let size = null
  try { size = fs.statSync(file).size } catch { size = null }
  if (size === null) buckets.missing.push({ ...asset, size: 0, note: '磁盘上没有这个文件' })
  else if (size < 200) buckets.tiny.push({ ...asset, size, note: '小得不像真图（占位图）' })
  else buckets.ok.push({ ...asset, size, note: '' })
}

const line = (item) => `  ${item.createdAt.toISOString().slice(0, 19)}  ${String(item.size).padStart(9)} B  ${item.id}  ${item.assetType}  ${String(item.title || '').slice(0, 18)}  ${item.fileUrl}`

console.log(`== 破图：记录里有、磁盘上没文件（${buckets.missing.length} 条）==`)
for (const item of buckets.missing) console.log(line(item))
console.log(`\n== 占位/异常小图（${buckets.tiny.length} 条）==`)
for (const item of buckets.tiny) console.log(line(item))
console.log(`\n== 正常（${buckets.ok.length} 条）==`)
for (const item of buckets.ok.slice(0, 10)) console.log(line(item))
if (buckets.ok.length > 10) console.log(`  ...还有 ${buckets.ok.length - 10} 条`)

await prisma.$disconnect()
