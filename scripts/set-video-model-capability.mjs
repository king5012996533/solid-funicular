/**
 * 把 Seedance 2.5（GenVideo 渠道）的**上游契约声明**写进库（幂等，可重复执行）。
 *
 * 为什么需要它：capabilityJson 决定两件事 —— 前端能选哪些画幅/时长，服务端发什么字段给上游。
 * 原来库里只有 `ratios: ["16:9","9:16"]`，于是一半画幅在画布上根本选不到；
 * 而且没有任何地方声明 mode / durationSeconds（字段名与固定值），上游把 `duration` 当未知字段忽略，
 * 一律按 2.0 出片 —— 我们卖的是 2.5（固定 30 秒）。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/set-video-model-capability.mjs
 * 声明内容见 scripts/lib/video-model-upstream-config.mjs（与单测同一份来源）。
 */
import { prisma } from '../server/db/prisma.ts'
import { resolveModelPricingCost } from '../server/marketing-center/service.ts'
import {
  VIDEO_MODEL_CAPABILITY,
  VIDEO_MODEL_DEFAULT_PARAMS,
  VIDEO_MODEL_ID,
  VIDEO_PROVIDER_EXTRA_JSON,
  VIDEO_PROVIDER_ID,
} from './lib/video-model-upstream-config.mjs'

const DRY_RUN = process.argv.includes('--dry-run')

const model = await prisma.aiModel.findUnique({
  where: { id: VIDEO_MODEL_ID },
  select: { id: true, modelKey: true, providerId: true, capabilityJson: true, defaultParamsJson: true },
})
if (!model) {
  console.error(`找不到模型 ${VIDEO_MODEL_ID}`)
  process.exit(1)
}

const provider = await prisma.aiProvider.findUnique({
  where: { id: VIDEO_PROVIDER_ID },
  select: { id: true, code: true, extraJson: true, videoEndpoint: true },
})
if (!provider) {
  console.error(`找不到厂商 ${VIDEO_PROVIDER_ID}`)
  process.exit(1)
}

console.log('改前 capabilityJson:', JSON.stringify(model.capabilityJson))
console.log('改前 provider.extraJson:', JSON.stringify(provider.extraJson))

if (DRY_RUN) {
  console.log('\n--dry-run：不写入。将要写入的 capabilityJson:')
  console.log(JSON.stringify(VIDEO_MODEL_CAPABILITY, null, 2))
  console.log('将要写入的 provider.extraJson:')
  console.log(JSON.stringify(VIDEO_PROVIDER_EXTRA_JSON, null, 2))
  await prisma.$disconnect()
  process.exit(0)
}

await prisma.aiModel.update({
  where: { id: VIDEO_MODEL_ID },
  data: {
    capabilityJson: VIDEO_MODEL_CAPABILITY,
    defaultParamsJson: VIDEO_MODEL_DEFAULT_PARAMS,
  },
})
await prisma.aiProvider.update({
  where: { id: VIDEO_PROVIDER_ID },
  data: { extraJson: VIDEO_PROVIDER_EXTRA_JSON },
})

const after = await prisma.aiModel.findUnique({
  where: { id: VIDEO_MODEL_ID },
  select: { capabilityJson: true, modelKey: true, providerId: true },
})
console.log('\n改后 capabilityJson:', JSON.stringify(after.capabilityJson))
const ratios = after.capabilityJson?.params?.ratio?.options || []
console.log(`画幅档位：${ratios.length} 种 → ${ratios.map((item) => item.key).join(' / ')}`)
const durations = after.capabilityJson?.params?.duration?.options || []
console.log(`时长档位：${durations.map((item) => item.key).join(' / ')} 秒`)
console.log('建单契约：', JSON.stringify(after.capabilityJson?.createParams))

// 顺带复核扣费口径没被这次改动带偏（定价 60 分/条是用户定的，这里只读不写）
const cost = await resolveModelPricingCost({
  providerId: after.providerId,
  modelKey: after.modelKey,
  endpointType: 'video',
  params: { kind: 'video', seconds: 30, count: 1 },
})
console.log('定价解析器复核（应仍为 60 分/条）：', JSON.stringify(cost))

await prisma.$disconnect()
process.exit(ratios.length === 6 && cost.pointCost === 60 ? 0 : 1)
