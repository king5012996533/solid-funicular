/**
 * 准备计费试点的环境（一次性、可重复执行）：
 *   1. 建一个可密码登录的测试账号（**复用 admin 的密码哈希** —— 同密码，不猜哈希算法）
 *   2. 通过积分流水给它充值（**照抄一条已有流水的枚举值** —— 不猜 changeType/action/sourceType）
 *   3. 给试点模型写入定价记录（gpt-image-2 @ ggwk1，6 分/次）
 *
 * 为什么都用「照抄现有数据」而不是自己构造：枚举、哈希这些一旦猜错，
 * 症状是「账号登不上」或「流水对不上账」—— 而这两样恰恰是本轮要验的东西。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/setup-pilot-account.mjs
 */
import { prisma } from '../server/db/prisma.ts'

const TEST_EMAIL = 'pilot-e2e@xingtudesign.local'
const RECHARGE_AMOUNT = 60
const PILOT_PROVIDER_CODE = 'p-sceneflow-ggk'
const PILOT_MODEL_KEY = 'gpt-image-2'
const PILOT_PRICE_POINTS = 6

// ---------- 1) 测试账号 ----------
const admin = await prisma.appUser.findFirst({ where: { role: 'ADMIN' }, select: { id: true, passwordHash: true, status: true } })
if (!admin?.passwordHash) {
  console.error('找不到 admin 的密码哈希，无法复用')
  process.exit(1)
}

let testUser = await prisma.appUser.findUnique({ where: { email: TEST_EMAIL }, select: { id: true } })
if (!testUser) {
  testUser = await prisma.appUser.create({
    data: {
      email: TEST_EMAIL,
      username: 'pilot-e2e',
      name: '计费试点账号',
      passwordHash: admin.passwordHash,
      role: 'USER',
      status: admin.status,
    },
    select: { id: true },
  })
  console.log(`已创建测试账号：${TEST_EMAIL}（id=${testUser.id}，复用 admin 的密码哈希）`)
} else {
  console.log(`测试账号已存在：${TEST_EMAIL}（id=${testUser.id}）`)
}

// ---------- 2) 充值（走积分流水） ----------
const lastLog = await prisma.pointAccountLog.findFirst({
  where: { userId: testUser.id },
  orderBy: { createdAt: 'desc' },
  select: { balanceAfter: true, changeType: true, action: true, sourceType: true },
})
const balanceBefore = lastLog?.balanceAfter ?? 0

if (balanceBefore >= RECHARGE_AMOUNT) {
  console.log(`余额已是 ${balanceBefore}，跳过充值（够本轮对账用）`)
} else {
  // 枚举值照抄：优先抄本账号的历史流水，没有就抄任意一条
  const template = lastLog ?? await prisma.pointAccountLog.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { changeType: true, action: true, sourceType: true },
  })
  if (!template) {
    console.error('库里没有任何积分流水，无法照抄枚举值')
    process.exit(1)
  }
  const delta = RECHARGE_AMOUNT - balanceBefore
  await prisma.pointAccountLog.create({
    data: {
      userId: testUser.id,
      accountNo: `pilot-${Date.now()}`,
      changeType: template.changeType,
      action: template.action,
      sourceType: template.sourceType,
      changeAmount: delta,
      balanceAfter: RECHARGE_AMOUNT,
      availableAmount: RECHARGE_AMOUNT,
      remark: '计费试点环境准备（e2e，可回滚）',
    },
  })
  console.log(`已充值 ${delta} → 余额 ${RECHARGE_AMOUNT}（沿用流水枚举：${template.changeType}/${template.action}/${template.sourceType}）`)
}

// ---------- 3) 试点模型定价 ----------
// 候选全打出来再选：provider 的 code 与 id 不是一回事（实测 code 匹配不上），
// 与其猜字段，不如把候选列清楚，按 id 里含渠道关键字来认
const candidates = await prisma.aiModel.findMany({
  where: { modelKey: PILOT_MODEL_KEY },
  select: { id: true, category: true, providerId: true, provider: { select: { id: true, code: true, name: true } } },
})
if (!candidates.length) {
  console.error(`库里没有任何 modelKey=${PILOT_MODEL_KEY} 的模型`)
  process.exit(1)
}
console.log(`候选模型（${candidates.length} 个）：`)
for (const item of candidates) {
  console.log(`  ${item.id}  category=${item.category}  provider=${item.provider.id}/${item.provider.code}  ${item.provider.name}`)
}
const model =
  candidates.find((item) => String(item.provider.id).includes('ggk')) ??
  candidates.find((item) => String(item.provider.code || '').includes('ggk')) ??
  candidates[0]
console.log(`选用：${model.id}（provider=${model.provider.id}）`)

const priceJson = {
  matchMode: 'none',
  tiers: [{ resolutionLabel: '每次请求', price: { perTask: PILOT_PRICE_POINTS } }],
}
await prisma.modelPricing.upsert({
  where: { modelId: model.id },
  create: { modelId: model.id, type: model.category, priceJson, usingDraft: false },
  update: { priceJson, type: model.category, usingDraft: false },
})
console.log(`已写入定价：${PILOT_MODEL_KEY} @ ${PILOT_PROVIDER_CODE} → perTask ${PILOT_PRICE_POINTS} 分（matchMode=none）`)

// ---------- 收尾：打印现状，便于对账 ----------
const finalLog = await prisma.pointAccountLog.findFirst({
  where: { userId: testUser.id },
  orderBy: { createdAt: 'desc' },
  select: { balanceAfter: true },
})
console.log(`\n试点环境就绪：`)
console.log(`  账号：${TEST_EMAIL}（密码同 admin）`)
console.log(`  余额：${finalLog?.balanceAfter ?? 0} 分`)
console.log(`  定价：${PILOT_MODEL_KEY} @ ${PILOT_PROVIDER_CODE} = ${PILOT_PRICE_POINTS} 分/次`)
await prisma.$disconnect()
