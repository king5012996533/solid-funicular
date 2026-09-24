/** 验「读定价表算钱」这条路：试点模型应算出 6 分（而旧路径是 0）。 */
import { prisma } from '../server/db/prisma.ts'
import { resolveModelPricingCost } from '../server/marketing-center/service.ts'

const result = await resolveModelPricingCost({
  providerId: 'p-sceneflow-ggk',
  modelKey: 'gpt-image-2',
  endpointType: 'image',
  params: { kind: 'image', count: 1 },
})
console.log('新路径（读 model_pricing）：', JSON.stringify(result))

const ten = await resolveModelPricingCost({
  providerId: 'p-sceneflow-ggk',
  modelKey: 'gpt-image-2',
  endpointType: 'image',
  params: { kind: 'image', count: 10 },
})
console.log('一次 10 张（按次计费应仍是 6）：', JSON.stringify(ten))

// 对照：没配定价的模型应**拒绝**（不再按草案价兜底）
const other = await resolveModelPricingCost({
  providerId: 'p-sceneflow-ggk',
  modelKey: 'gpt-image-2.5-flare',
  endpointType: 'image',
  params: { kind: 'image', count: 1 },
})
console.log('未配价模型（应拒绝、不给假价）：', JSON.stringify(other))

const results = [
  ['试点模型算出 6 分且不走兜底', result.pointCost === 6 && result.usingDraft === false && result.refuse === false],
  ['一次 10 张仍是 6 分（按次计费不被乘 10）', ten.pointCost === 6],
  ['未配价模型被拒绝（refuse）且不给假价', other.refuse === true && other.pointCost === 0],
]
console.log('\n== 判定 ==')
for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
await prisma.$disconnect()
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
