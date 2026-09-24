/**
 * 严格验证「流水线锁的快照是侧写，不动用户当前画布，且内容与当前版本一致」。
 *
 * 为什么要查库而不是看接口：workflow 详情接口不返回 currentVersionId，
 * 拿它比较等于 1 === 1 的假验证 —— 上一版就是这么写的，看着全绿其实没验到东西。
 *
 * 跑法：npx tsx --env-file=.env.development scripts/verify-pipeline-lock-db.mjs
 */
import { prisma } from '../server/db/prisma.ts'

const API = 'http://localhost:5409'

// 管理员密码从环境变量读：写进仓库等于把「用户名 + 密码」两半一起交出去。
const adminPassword = String(process.env.DEV_ADMIN_PASSWORD || '').trim()
if (!adminPassword) {
  console.error('缺少 DEV_ADMIN_PASSWORD 环境变量：本脚本要用管理员密码登录本地服务，请先设置（不要把密码写进仓库）。')
  process.exit(1)
}

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ methodType: 'ADMIN_PASSWORD', target: 'admin', password: adminPassword }),
})
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')

const workflow = await prisma.workflowDefinition.findFirst({ orderBy: { updatedAt: 'desc' }, select: { id: true, userId: true, currentVersionId: true } })
if (!workflow) { console.error('没有画布'); process.exit(1) }

const snapshotState = async () => {
  const row = await prisma.workflowDefinition.findUnique({
    where: { id: workflow.id },
    select: { currentVersionId: true, currentVersion: { select: { id: true, nodesJson: true, edgesJson: true } } },
  })
  return {
    currentVersionId: row?.currentVersionId || '',
    nodes: JSON.stringify(row?.currentVersion?.nodesJson ?? null),
    edges: JSON.stringify(row?.currentVersion?.edgesJson ?? null),
  }
}

const before = await snapshotState()
console.log(`画布 ${workflow.id}`)
console.log(`取锁前：currentVersionId=${before.currentVersionId}，节点数据 ${before.nodes.length} 字节`)

const res = await fetch(`${API}/api/workflows/${workflow.id}/pipeline-lock`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ label: '侧写验证' }),
})
const body = await res.json()
const lock = body?.data
console.log(`取锁：HTTP ${res.status}，快照 id=${lock?.snapshotVersionId}`)

const after = await snapshotState()
const snapshot = lock?.snapshotVersionId
  ? await prisma.workflowDefinitionVersion.findUnique({ where: { id: lock.snapshotVersionId }, select: { nodesJson: true, edgesJson: true, versionName: true, status: true } })
  : null

const results = [
  ['currentVersionId 未被改动（用户看到的画布没变）', before.currentVersionId === after.currentVersionId && after.currentVersionId !== ''],
  ['当前版本的节点/连线数据也没被动过', before.nodes === after.nodes && before.edges === after.edges],
  ['快照内容与当前版本一致（真的是同一份状态）', Boolean(snapshot) && JSON.stringify(snapshot.nodesJson ?? null) === before.nodes && JSON.stringify(snapshot.edgesJson ?? null) === before.edges],
  ['快照是 DRAFT 状态（不会顶替当前版本）', snapshot?.status === 'DRAFT'],
]

// 收尾：放锁
if (lock?.token) {
  await fetch(`${API}/api/workflows/${workflow.id}/pipeline-lock/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ token: lock.token }),
  })
}

console.log('\n== 判定 ==')
for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
await prisma.$disconnect()
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
