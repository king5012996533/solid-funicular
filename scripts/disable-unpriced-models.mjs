/**
 * 禁用所有「未配价」的模型。
 *
 * 背景：图片 / 视频的扣费与预估只认 `model_pricing` 表。没有定价记录的模型，之前会走
 * 代码里的草案兜底价（`perImage: 6`）—— 视频类按 6 分扣就是**明显倒贴**。
 * 现已把「未配价」改成拒绝生成（见 src/shared/model-pricing-rules.ts）；同时把这类模型
 * 直接下架（`isEnabled=false`），让它们不出现在画布 / 首页的模型选择与目录接口里。
 *
 * 口径：**只要该模型没有 `model_pricing` 记录，就置为禁用**；有定价记录的保持原样。
 * 幂等：已经是禁用状态的未配价模型会被跳过（不重复写库），可安全重复执行。
 *
 * 跑法（WSL 无 node，走 cmd.exe）：
 *   cd /mnt/c/Users/Administrator/solid-funicular
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs"
 *   # 只看将要做什么、不写库：
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs --dry-run"
 */
import { prisma } from '../server/db/prisma.ts'

const dryRun = process.argv.includes('--dry-run')

const models = await prisma.aiModel.findMany({
  select: {
    id: true,
    providerId: true,
    category: true,
    modelKey: true,
    name: true,
    isEnabled: true,
    pricing: { select: { id: true } },
  },
  orderBy: [{ category: 'asc' }, { providerId: 'asc' }, { createdAt: 'asc' }],
})

const labelOf = (model) => `[${model.category}] ${model.modelKey} @ ${model.providerId}`

const toDisable = []
const skipped = []
for (const model of models) {
  const label = labelOf(model)
  if (model.pricing) {
    skipped.push({ label, reason: '已配价，保持启用' })
    continue
  }
  if (!model.isEnabled) {
    skipped.push({ label, reason: '未配价但已禁用，无需改动' })
    continue
  }
  toDisable.push({ id: model.id, label })
}

console.log(`扫描模型 ${models.length} 个${dryRun ? '（dry-run，不写库）' : ''}`)
console.log(`\n== 停用（未配价） ${toDisable.length} 个 ==`)
for (const item of toDisable) console.log(`  - ${item.label}`)
console.log(`\n== 跳过 ${skipped.length} 个 ==`)
for (const item of skipped) console.log(`  · ${item.label} —— ${item.reason}`)

if (dryRun) {
  console.log(`\n[dry-run] 将要禁用 ${toDisable.length} 个模型；去掉 --dry-run 才会真正写库。`)
} else if (toDisable.length) {
  const result = await prisma.aiModel.updateMany({
    where: { id: { in: toDisable.map((item) => item.id) } },
    data: { isEnabled: false },
  })
  console.log(`\n已禁用 ${result.count} 个模型（isEnabled=false）。`)
} else {
  console.log('\n没有需要禁用的模型（已是最新状态）。')
}

// 复核：打印最终仍启用的模型，方便与目录接口比对
const stillEnabled = await prisma.aiModel.findMany({
  where: { isEnabled: true },
  select: { providerId: true, category: true, modelKey: true },
  orderBy: [{ category: 'asc' }, { providerId: 'asc' }],
})
console.log(`\n== 最终仍启用的模型 ${stillEnabled.length} 个${dryRun ? '（dry-run：未写库，此处是当前状态）' : ''} ==`)
for (const model of stillEnabled) console.log(`  ✓ ${labelOf(model)}`)

await prisma.$disconnect()
