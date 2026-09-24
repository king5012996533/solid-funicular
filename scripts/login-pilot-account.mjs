/**
 * 用 EMAIL_CODE 登录试点账号并把会话 cookie 存下来（供后续对账用）。
 *
 * 为什么走验证码而不是密码：本项目 AuthMethodType 里**没有邮箱+密码**这一种
 * （只有 ADMIN_PASSWORD / PHONE_CODE / EMAIL_CODE / 三种 OAuth），
 * 所以带密码哈希的普通账号没有密码登录入口。dev 环境里验证码就存在库里，可以直接读出来用。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/login-pilot-account.mjs
 * 输出：把 cookie 写到 refund-e2e/pilot-cookie.txt（对账脚本读它）
 */
import fs from 'node:fs'
import { prisma } from '../server/db/prisma.ts'

const API = 'http://localhost:5409'
const EMAIL = 'pilot-e2e@xingtudesign.local'
const COOKIE_FILE = 'C:/Users/Administrator/refund-e2e/pilot-cookie.txt'

const sendRes = await fetch(`${API}/api/auth/verification-code`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ methodType: 'EMAIL_CODE', target: EMAIL }),
})
const sendBody = await sendRes.text()
console.log(`发码：HTTP ${sendRes.status} ${sendBody.slice(0, 200)}`)
if (!sendRes.ok) process.exit(1)

// dev 环境直接从库里取码（生产当然不能这么做，这里是测试账号）
const codeRow = await prisma.authVerificationCode.findFirst({
  where: { target: EMAIL },
  orderBy: { createdAt: 'desc' },
  select: { code: true, createdAt: true, methodType: true },
})
if (!codeRow) {
  console.error('库里没有该邮箱的验证码记录')
  process.exit(1)
}
console.log(`取到验证码：${codeRow.code}（methodType=${codeRow.methodType}，${codeRow.createdAt.toISOString()}）`)

const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ methodType: 'EMAIL_CODE', target: EMAIL, code: codeRow.code }),
})
const loginBody = await loginRes.text()
console.log(`登录：HTTP ${loginRes.status} ${loginBody.slice(0, 200)}`)
if (!loginRes.ok) process.exit(1)

const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
fs.writeFileSync(COOKIE_FILE, cookie, 'utf8')

const balanceRes = await fetch(`${API}/api/points/balance`, { headers: { Cookie: cookie } })
const balance = await balanceRes.json().catch(() => null)
console.log(`余额：HTTP ${balanceRes.status} ${JSON.stringify(balance)}`)
console.log(`cookie 已写入 ${COOKIE_FILE}`)

const ok = balance?.success === true && typeof balance?.available === 'number'
console.log(ok ? `\n✅ 试点账号可用（余额 ${balance.available} 分）` : '\n❌ 余额读取异常')
await prisma.$disconnect()
process.exit(ok ? 0 : 1)
