/**
 * 清掉资产库里指向「磁盘上已经没有的文件」的条目（界面上就是一张张爆裂的破图）。
 *
 * 成因：AssetItem 与生成记录是 onDelete: SetNull —— 记录被删时资产行会留下，
 * 而它引用的文件已经没了，于是资产库里就多出一条破图。我的验证脚本删临时记录时也留下了 21 条这种。
 *
 * 处理方式是**软删**（isDeleted = true）而不是物理删除：资产库的查询本来就过滤 isDeleted=false，
 * 效果一样，但万一误判还能恢复。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/cleanup-broken-assets.mjs [--apply]
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../server/db/prisma.ts'

const apply = process.argv.includes('--apply')
const assets = await prisma.assetItem.findMany({
  where: { isDeleted: false },
  select: { id: true, userId: true, fileUrl: true, title: true, fileSizeBytes: true, publishStatus: true, visibility: true, createdAt: true },
})

const broken = []
for (const asset of assets) {
  const url = String(asset.fileUrl || '')
  if (!url.startsWith('/uploads/')) continue
  const file = path.resolve(process.cwd(), 'uploads', url.replace('/uploads/', ''))
  if (!fs.existsSync(file)) broken.push(asset)
}

console.log(`${apply ? '模式：写入（--apply）' : '模式：体检（加 --apply 才真的改）'}`)
console.log(`资产库 ${assets.length} 条，其中指向缺失文件（破图）的 ${broken.length} 条\n`)
for (const asset of broken) {
  console.log(`  ${asset.createdAt.toISOString().slice(0, 19)}  ${asset.id}  ${asset.publishStatus}/${asset.visibility}  ${String(asset.title || '').slice(0, 20)}  ${asset.fileUrl}`)
}

const published = broken.filter((asset) => asset.publishStatus !== 'DRAFT' || asset.visibility !== 'PRIVATE')
if (published.length) {
  console.log(`\n⚠️ 其中 ${published.length} 条不是草稿/私有，出于安全我不动它们：`)
  for (const asset of published) console.log(`  ${asset.id}  ${asset.publishStatus}/${asset.visibility}`)
}

if (!apply) {
  console.log('\n（没有改动。确认无误后加 --apply 执行软删）')
} else {
  const targets = broken.filter((asset) => asset.publishStatus === 'DRAFT' && asset.visibility === 'PRIVATE')
  const result = await prisma.assetItem.updateMany({
    where: { id: { in: targets.map((asset) => asset.id) } },
    data: { isDeleted: true },
  })
  console.log(`\n已软删 ${result.count} 条破图（isDeleted=true，可恢复）`)
}

await prisma.$disconnect()
