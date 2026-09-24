/**
 * 写入视频模型的正式定价（用户定价：上游 5 积分/条 → 我们卖 60 积分/条）。
 *
 * 依据（实测出来的口径）：Seedance 2.5 @ p-sceneflow-genvideo-2-5 是**按条**计费 ——
 * 上游建单响应里直接回 `points: 5`，与时长无关；旧项目对 genvideo 也是按条固定价。
 * 所以这里用 perTask，而不是 perSecond（按秒会让长视频每条都赔）。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/set-video-pricing.mjs
 */
import { prisma } from '../server/db/prisma.ts'
import { resolveModelPricingCost } from '../server/marketing-center/service.ts'

const MODEL_ID = process.argv[2] || 'm-sceneflow-genvideo-2-5-0'
const PRICE_POINTS = 60

const priceJson = {
  matchMode: 'none',
  tiers: [{ resolutionLabel: '每条', price: { perTask: PRICE_POINTS } }],
}

const model = await prisma.aiModel.findUnique({ where: { id: MODEL_ID }, select: { id: true, modelKey: true, category: true, providerId: true } })
if (!model) {
  console.error(`找不到模型 ${MODEL_ID}`)
  process.exit(1)
}

await prisma.modelPricing.upsert({
  where: { modelId: model.id },
  create: { modelId: model.id, type: model.category, priceJson, usingDraft: false },
  update: { priceJson, type: model.category, usingDraft: false },
})
console.log(`已写入定价：${model.modelKey} @ ${model.providerId} → perTask ${PRICE_POINTS} 分`)

// 用解析器复核（这条路径就是扣费与预估共用的那条）
const cost = await resolveModelPricingCost({
  providerId: model.providerId,
  modelKey: model.modelKey,
  endpointType: 'video',
  params: { kind: 'video', seconds: 10, count: 1 },
})
console.log('解析器复核：', JSON.stringify(cost))
console.log(cost.pointCost === PRICE_POINTS && cost.usingDraft === false
  ? `\n✅ 扣费路径已按 ${PRICE_POINTS} 分计（成本 5 → 售价 ${PRICE_POINTS}，倍率 ${(PRICE_POINTS / 5).toFixed(1)}x）`
  : `\n❌ 与预期不符：${JSON.stringify(cost)}`)
await prisma.$disconnect()
process.exit(cost.pointCost === PRICE_POINTS ? 0 : 1)
