/**
 * 证明「服务端读的是本地库」，而不是隧道那份 VPS 数据。
 *
 * 两边数据一模一样，光看内容分不出来。所以往**本地库**塞一条带唯一标记的记录，
 * 再通过**服务端的 HTTP 接口**去查：查得到 → 服务端确实连的是本地库。
 * 跑完删掉标记记录，不留痕。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/verify-local-db-wiring.mjs
 */
import { prisma } from '../server/db/prisma.ts'

const MARKER = `local-db-wiring-${Date.now()}`
const API = 'http://localhost:5409'

const anchor = await prisma.generationRecord.findFirst({ orderBy: { createdAt: 'desc' }, select: { userId: true, sessionId: true } })
if (!anchor) {
  console.error('库里没有可借用的用户/会话')
  process.exit(1)
}

const marker = await prisma.generationRecord.create({
  data: {
    userId: anchor.userId,
    sessionId: anchor.sessionId,
    type: 'IMAGE',
    status: 'COMPLETED',
    prompt: MARKER,
  },
})
console.log(`已在本地库写入标记记录：${marker.id}（prompt=${MARKER}）`)

try {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ methodType: 'ADMIN_PASSWORD', target: 'admin', password: 'DevLocal-2026' }),
  })
  const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')

  const res = await fetch(`${API}/api/admin/generation-records?keyword=${encodeURIComponent(MARKER)}&page=1&pageSize=5`, {
    headers: { Cookie: cookie },
  })
  const body = await res.json()
  const items = body?.data?.items || body?.data?.list || []
  const found = items.some((item) => item.id === marker.id)
  console.log(`服务端查这条标记：${found ? '✅ 查到了 —— 服务端确实连的是本地库' : '❌ 没查到 —— 服务端还在连别处（隧道？）'}`)
  process.exitCode = found ? 0 : 1
} finally {
  await prisma.generationRecord.delete({ where: { id: marker.id } })
  console.log('已删除标记记录')
  await prisma.$disconnect()
}
