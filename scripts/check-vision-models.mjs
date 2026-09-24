/** 规格第 6 步要「多模态读图」——先看看目录里有没有能读图的模型。 */
import { prisma } from '../server/db/prisma.ts'
const models = await prisma.aiModel.findMany({
  select: { modelKey: true, category: true, capabilityJson: true, isEnabled: true, provider: { select: { name: true } } },
})
for (const m of models) {
  const cap = m.capabilityJson && typeof m.capabilityJson === 'object' ? JSON.stringify(m.capabilityJson) : ''
  const vision = /vision|多模态|image.?input|支持图/i.test(cap) ? '  ← 疑似支持读图' : ''
  console.log(`${m.category ?? '?'}  ${m.modelKey}  [${m.provider?.name}]${vision}`)
}
await prisma.$disconnect()
