/** 列出本地库里的厂商与模型（含打桩的 mock），用来挑一个不花钱的模型做端到端验证。 */
import { prisma } from '../server/db/prisma.ts'

const providers = await prisma.aiProvider.findMany({
  select: {
    id: true,
    code: true,
    name: true,
    isEnabled: true,
    baseUrl: true,
    models: { select: { category: true, modelKey: true, name: true, isEnabled: true } },
  },
  orderBy: { sortOrder: 'asc' },
})

console.log(`providers: ${providers.length}`)
for (const provider of providers) {
  console.log(`[${provider.isEnabled ? 'on' : 'off'}] ${provider.id} | ${provider.name} | ${provider.baseUrl}`)
  for (const model of provider.models) {
    console.log(`    [${model.isEnabled ? 'on' : 'off'}] ${model.category} | ${model.modelKey} | ${model.name}`)
  }
}
await prisma.$disconnect()
