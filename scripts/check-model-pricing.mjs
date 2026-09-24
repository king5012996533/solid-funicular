/** 定价存在 defaultParamsJson 里（readModelBillingPower 读的是它）——看看到底配了没有。 */
import { prisma } from '../server/db/prisma.ts'
const models = await prisma.aiModel.findMany({
  where: { category: 'IMAGE' },
  select: { modelKey: true, defaultParamsJson: true, providerId: true },
  take: 6,
})
for (const m of models) {
  const params = m.defaultParamsJson && typeof m.defaultParamsJson === 'object' ? m.defaultParamsJson : {}
  const billing = params.billingPower ?? params.pointCost ?? params.billing ?? '(未配置)'
  console.log(`${String(m.modelKey).padEnd(22)} billingPower=${JSON.stringify(billing)}`)
}
await prisma.$disconnect()
