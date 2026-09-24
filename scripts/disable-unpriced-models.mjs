/**
 * 按「有没有 model_pricing 记录」批量下架模型（**只管图片 / 视频**）。
 *
 * 背景（2026-09-25 修正）：图片 / 视频的扣费与预估只认 `model_pricing` 表。没有定价记录的
 * 模型之前会走代码里的草案兜底价（`perImage: 6`）—— 视频类按 6 分扣就是明显倒贴。现已把
 * 「未配价」改成拒绝生成（见 src/shared/model-pricing-rules.ts），同时把这类模型下架
 * （`isEnabled=false`），让它们不出现在画布 / 首页的模型选择与目录接口里。
 *
 * **口径修正**：`model_pricing` 只描述图片 / 视频的计价，**对话模型根本不在那张表里** ——
 * chat 的计费走 chat 端点计费。上一版脚本按字面「所有无 model_pricing 记录的 ai_model」
 * 执行，把 `gpt-5.6-terra` / `deepseek-*` 这些对话模型一起禁用了，目录接口的 chat 直接变空，
 * 画布 Agent 与首页助手全部瘫痪。所以现在：
 *   · 默认**只处理 `category ∈ {IMAGE, VIDEO}`**；
 *   · 要连带处理对话模型，必须显式加 `--include-chat`；
 *   · 写库前有一条**防御性断言**：目标集合里出现任何 CHAT 模型就直接报错退出（除非显式
 *     `--include-chat`），绝不静默禁用对话模型。
 *
 * 幂等：已经是禁用状态的未配价模型会被跳过（不重复写库），可安全重复执行。
 *
 * 跑法（WSL 无 node，走 cmd.exe）：
 *   cd /mnt/c/Users/Administrator/solid-funicular
 *   # 只看将要做什么、不写库（会打印每个模型「停用 / 跳过及原因」）：
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs --dry-run"
 *   # 真正下架未配价的图 / 视频模型：
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs"
 *   # 对话模型被误禁用时，按类别恢复（打印恢复了哪些）：
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs --restore-chat"
 *   # 断言自检：证明「目标里混入 CHAT 会报错、纯图/视频不会」：
 *   cmd.exe /c "npx tsx --env-file=.env.development scripts/disable-unpriced-models.mjs --self-test"
 */
import { prisma } from '../server/db/prisma.ts'

/** 只看 model_pricing 的类别。CHAT 不在其中（对话计费不走这张表）。 */
const PRICED_CATEGORIES = ['IMAGE', 'VIDEO']

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const includeChat = args.has('--include-chat')
const restoreChat = args.has('--restore-chat')
const selfTest = args.has('--self-test')

const labelOf = (model) => `[${model.category}] ${model.modelKey} @ ${model.providerId}`

/**
 * 防御性断言：目标集合里出现 CHAT 一律报错退出（除非显式 --include-chat）。
 *
 * 为什么必须硬拦：这次线上回归的根源就是「没有 model_pricing 记录」被当成「该下架」，
 * 而对话模型天然没有 model_pricing 记录。断言放在写库之前，任何筛选逻辑走偏都会在
 * 真正禁用对话模型之前炸掉，而不是安静地把 Agent 打死。
 */
const assertNoChatInTargets = (targets, { allowChat = false } = {}) => {
  const chatTargets = targets.filter((item) => item.category === 'CHAT')
  if (!chatTargets.length) return
  if (allowChat) {
    console.warn(`[警告] --include-chat 已显式放行 ${chatTargets.length} 个对话模型：${chatTargets.map(labelOf).join('、')}`)
    return
  }
  throw new Error(
    `防御断言失败：目标集合里出现 ${chatTargets.length} 个 CHAT 模型（${chatTargets.map(labelOf).join('、')}）。`
    + 'model_pricing 只描述图片/视频计价，对话模型走 chat 端点计费 —— 禁用它们会直接打死画布 Agent 与首页助手。'
    + '若确实要处理对话模型，请显式加 --include-chat。',
  )
}

// ---------- 自检：证明断言真的会拦 ----------
if (selfTest) {
  const cases = [
    {
      name: '目标里混入 CHAT 且未加 --include-chat → 应报错',
      targets: [{ category: 'CHAT', modelKey: 'gpt-5.6-terra', providerId: 'p-sceneflow-ggwk1' }],
      allowChat: false,
      expectThrow: true,
    },
    {
      name: '目标只有 IMAGE / VIDEO → 应通过',
      targets: [
        { category: 'IMAGE', modelKey: 'gpt-image-2.5-flare', providerId: 'p-sceneflow-ggk' },
        { category: 'VIDEO', modelKey: 'H3', providerId: 'p-sceneflow-h3' },
      ],
      allowChat: false,
      expectThrow: false,
    },
    {
      name: '目标里混入 CHAT 但显式 --include-chat → 应放行（只告警）',
      targets: [{ category: 'CHAT', modelKey: 'gpt-5.6-terra', providerId: 'p-sceneflow-ggwk1' }],
      allowChat: true,
      expectThrow: false,
    },
  ]

  let failed = 0
  for (const item of cases) {
    let threw = false
    try {
      assertNoChatInTargets(item.targets, { allowChat: item.allowChat })
    } catch {
      threw = true
    }
    const ok = threw === item.expectThrow
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${item.name}（实际：${threw ? '报错' : '通过'}）`)
  }
  console.log(failed ? `\n自检失败 ${failed} 项。` : '\n自检通过：混入 CHAT 会报错，纯图/视频不会。')
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}

// ---------- 恢复对话模型（专治本次回归：chat 被误禁用） ----------
if (restoreChat) {
  const chatModels = await prisma.aiModel.findMany({
    where: { category: 'CHAT' },
    select: {
      id: true,
      providerId: true,
      category: true,
      modelKey: true,
      name: true,
      isEnabled: true,
      provider: { select: { name: true, isEnabled: true, defaultChatModel: true } },
    },
    orderBy: [{ providerId: 'asc' }, { createdAt: 'asc' }],
  })

  const toEnable = chatModels.filter((model) => !model.isEnabled)
  console.log(`对话模型共 ${chatModels.length} 个${dryRun ? '（dry-run，不写库）' : ''}，当前被禁用的 ${toEnable.length} 个。`)
  console.log(`\n== 恢复（置 isEnabled=true） ${toEnable.length} 个 ==`)
  for (const model of toEnable) {
    console.log(`  - ${labelOf(model)} | ${model.name} | 厂商 ${model.provider?.name || '?'}（${model.provider?.isEnabled ? '厂商启用' : '厂商本身禁用'}）${model.provider?.defaultChatModel === model.modelKey ? ' | 该厂商默认对话模型' : ''}`)
  }
  for (const model of chatModels.filter((item) => item.isEnabled)) {
    console.log(`  · ${labelOf(model)} —— 已是启用状态，无需改动`)
  }

  if (dryRun) {
    console.log(`\n[dry-run] 将要恢复 ${toEnable.length} 个对话模型；去掉 --dry-run 才会真正写库。`)
  } else if (toEnable.length) {
    const result = await prisma.aiModel.updateMany({
      where: { id: { in: toEnable.map((model) => model.id) } },
      data: { isEnabled: true },
    })
    console.log(`\n已恢复 ${result.count} 个对话模型（isEnabled=true）。`)
  } else {
    console.log('\n没有需要恢复的对话模型（已是最新状态）。')
  }

  const stillDisabled = await prisma.aiModel.findMany({
    where: { category: 'CHAT', isEnabled: false },
    select: { providerId: true, category: true, modelKey: true },
  })
  console.log(`\n== 复核：仍被禁用的对话模型 ${stillDisabled.length} 个${dryRun ? '（dry-run：未写库，此处是当前状态）' : ''} ==`)

  await prisma.$disconnect()
  process.exit(0)
}

// ---------- 默认：下架「未配价」的图片 / 视频模型 ----------
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

const targetCategories = includeChat ? [...PRICED_CATEGORIES, 'CHAT'] : PRICED_CATEGORIES

const toDisable = []
const skipped = []
for (const model of models) {
  const label = labelOf(model)
  if (!targetCategories.includes(model.category)) {
    skipped.push({ label, reason: `${model.category} 不在口径内（model_pricing 只描述图片/视频计价；要处理需显式 --include-chat）` })
    continue
  }
  if (model.pricing) {
    skipped.push({ label, reason: '已配价，保持启用' })
    continue
  }
  if (!model.isEnabled) {
    skipped.push({ label, reason: '未配价但已禁用，无需改动' })
    continue
  }
  toDisable.push({ id: model.id, category: model.category, modelKey: model.modelKey, providerId: model.providerId, label })
}

// 写库前的最后一道闸：目标集合里绝不能出现 CHAT（默认口径下）。
assertNoChatInTargets(toDisable, { allowChat: includeChat })

const countByCategory = (items) => PRICED_CATEGORIES
  .concat(includeChat ? ['CHAT'] : [])
  .map((category) => `${category} ${items.filter((item) => item.category === category).length}`)
  .join(' / ')

console.log(`口径：${includeChat ? 'IMAGE / VIDEO / CHAT（显式 --include-chat）' : 'IMAGE / VIDEO'}${dryRun ? '（dry-run，不写库）' : ''}`)
console.log(`扫描模型 ${models.length} 个`)
console.log(`\n== 停用（未配价） ${toDisable.length} 个 —— ${countByCategory(toDisable)} ==`)
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

// 复核：打印最终仍启用的模型，方便与目录接口比对（对话模型应全部在列）。
const stillEnabled = await prisma.aiModel.findMany({
  where: { isEnabled: true },
  select: { providerId: true, category: true, modelKey: true },
  orderBy: [{ category: 'asc' }, { providerId: 'asc' }],
})
console.log(`\n== 最终仍启用的模型 ${stillEnabled.length} 个${dryRun ? '（dry-run：未写库，此处是当前状态）' : ''} ==`)
for (const model of stillEnabled) console.log(`  ✓ ${labelOf(model)}`)

await prisma.$disconnect()
