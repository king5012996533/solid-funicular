/**
 * 「挂参考图」参数解析单测（2026-09-25）
 *
 * 起因：一整批 8 张分镜图在两秒内全部 FAILED，服务端报 "Failed to parse URL from node_2"
 * —— 模型把**节点 id** 当图片地址传了进来（attach_reference_images 的 images:[node_1,node_2,...]）。
 * 这个解析函数负责把节点 id 翻译成该节点的出图地址，翻译不了的如实挑出来。
 *
 * 跑法：npx tsx tests/attach-reference-refs.test.ts
 */
import { resolveAttachedReferences } from '../src/views/workflow/composables/resolveAttachedReferences'

let passed = 0
let failed = 0
const check = (name: string, fn: () => void) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : error}`)
  }
}
const assert = (cond: unknown, message: string) => {
  if (!cond) throw new Error(message)
}

const lookup = (map: Record<string, { exists: boolean; imageUrl: string }>) => (id: string) =>
  map[id] || { exists: false, imageUrl: '' }

check('节点 id 会被翻译成该节点的出图地址', () => {
  const res = resolveAttachedReferences(['node_1', 'node_2'], lookup({
    node_1: { exists: true, imageUrl: '/uploads/generated/image/a.png' },
    node_2: { exists: true, imageUrl: '/uploads/generated/image/b.png' },
  }))
  assert(res.unresolved.length === 0, `不该有未解析项：${res.unresolved.join('；')}`)
  assert(res.resolved.join(',') === '/uploads/generated/image/a.png,/uploads/generated/image/b.png',
    `解析结果不对：${res.resolved.join(',')}`)
})

check('图片地址原样保留（绝对 / 站内 / data:image）', () => {
  const res = resolveAttachedReferences(
    ['https://cdn.example.com/x.png', '/uploads/generated/image/c.png', 'data:image/png;base64,AAAA'],
    lookup({}),
  )
  assert(res.unresolved.length === 0, `不该有未解析项：${res.unresolved.join('；')}`)
  assert(res.resolved.length === 3, `应保留 3 项，实际 ${res.resolved.length}`)
})

check('节点 id 存在但还没有出图 → 明确说清是哪一项、为什么没用上', () => {
  const res = resolveAttachedReferences(['node_9'], lookup({ node_9: { exists: true, imageUrl: '' } }))
  assert(res.resolved.length === 0, '不该解析出地址')
  assert(res.unresolved.length === 1 && /还没有出图/.test(res.unresolved[0]), `原因应可读：${res.unresolved.join('；')}`)
})

check('既不是节点也不是地址的裸字符串 → 被挑出来（这正是 "node_2" 事故的入口）', () => {
  const res = resolveAttachedReferences(['node_2'], lookup({}))
  assert(res.resolved.length === 0, '不该解析出地址')
  assert(res.unresolved.length === 1 && /既不是/.test(res.unresolved[0]), `原因应可读：${res.unresolved.join('；')}`)
})

check('重复项去重（同一地址只保留一次）', () => {
  const res = resolveAttachedReferences(['node_1', 'node_1'], lookup({
    node_1: { exists: true, imageUrl: '/uploads/generated/image/a.png' },
  }))
  assert(res.resolved.length === 1, `应去重为 1，实际 ${res.resolved.length}`)
})

check('混合输入：好的留下、坏的挑出', () => {
  const res = resolveAttachedReferences(
    ['node_1', 'garbage', '/uploads/generated/image/c.png'],
    lookup({ node_1: { exists: true, imageUrl: '/uploads/generated/image/a.png' } }),
  )
  assert(res.resolved.length === 2, `应解析 2 项，实际 ${res.resolved.length}`)
  assert(res.unresolved.length === 1 && /garbage/.test(res.unresolved[0]), `应挑出 garbage：${res.unresolved.join('；')}`)
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
