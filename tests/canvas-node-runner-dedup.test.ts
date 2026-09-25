/**
 * 画布节点执行去重单测（2026-09-25）
 *
 * 起因：一个「30 秒咖啡广告」会话里，三张母版各被提交了两次（同一句提示词建了两张单、
 * 扣了两次费）。证据显示是**两条触发路径各提交一次**：
 *   1. 模型用 run_nodes 批量跑 [node_1,node_2,node_3]；
 *   2. 随后它从 get_canvas_state 看不到「已经跑过」的证据，又对同样几个节点补了 run_node。
 * runNodeById 是这两条路径唯一的汇合点，去重必须钉在这里 —— 所以这批用例直接驱动真实模块。
 *
 * 跑法：npx tsx tests/canvas-node-runner-dedup.test.ts
 */
import {
  registerNodeRunner,
  unregisterNodeRunner,
  beginAgentRunRound,
  runNodeById,
} from '../src/views/workflow/composables/useCanvasNodeRunner'

let passed = 0
let failed = 0

const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn()
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

// 用例 1：同一轮里先批量触发过，再单个触发同一节点 → 第二次被挡下、真正执行只有一次
await check('同轮内 run_nodes 之后再 run_node 同一节点：只执行一次', async () => {
  beginAgentRunRound()
  let calls = 0
  registerNodeRunner('dedup-node-1', () => {
    calls += 1
  })
  const first = await runNodeById('dedup-node-1')
  const second = await runNodeById('dedup-node-1')
  assert(first.ok, '第一次应成功')
  assert(!second.ok, '第二次应被去重挡下')
  assert(/本轮已经触发过/.test(second.reason || ''), `去重原因应可读：${second.reason}`)
  assert(calls === 1, `真正执行次数应为 1，实际 ${calls}`)
  unregisterNodeRunner('dedup-node-1')
})

// 用例 2：并发重复触发同一节点（两条路径同时到达）→ 只执行一次
await check('并发重复触发同一节点：只执行一次', async () => {
  beginAgentRunRound()
  let calls = 0
  let release!: () => void
  registerNodeRunner('dedup-node-2', () => new Promise<void>((resolve) => {
    calls += 1
    release = resolve
  }))
  const pendingFirst = runNodeById('dedup-node-2')
  const second = await runNodeById('dedup-node-2')
  assert(!second.ok, '并发第二次应被挡下')
  assert(/正在生成中/.test(second.reason || ''), `并发去重原因应可读：${second.reason}`)
  release()
  const first = await pendingFirst
  assert(first.ok, '第一次最终应成功')
  assert(calls === 1, `并发只应执行一次，实际 ${calls}`)
  unregisterNodeRunner('dedup-node-2')
})

// 用例 3：失败的节点本轮仍允许重试（失败不占位）
await check('失败的节点本轮仍可重试', async () => {
  beginAgentRunRound()
  let calls = 0
  registerNodeRunner('dedup-node-3', () => {
    calls += 1
    if (calls === 1) throw new Error('上游拒绝：模型暂不可用')
  })
  const bad = await runNodeById('dedup-node-3')
  assert(!bad.ok && bad.reason === '上游拒绝：模型暂不可用', `失败原因要原样带回：${bad.reason}`)
  const retry = await runNodeById('dedup-node-3')
  assert(retry.ok && calls === 2, '失败后本轮应允许重试')
  unregisterNodeRunner('dedup-node-3')
})

// 用例 4：新开一轮后去重状态清空，同一节点可再次执行
await check('新一轮重置后同一节点可再次执行', async () => {
  beginAgentRunRound()
  let calls = 0
  registerNodeRunner('dedup-node-4', () => {
    calls += 1
  })
  await runNodeById('dedup-node-4')
  const blocked = await runNodeById('dedup-node-4')
  assert(!blocked.ok, '同轮第二次应被挡')
  beginAgentRunRound()
  const again = await runNodeById('dedup-node-4')
  assert(again.ok, '新开一轮后应可再次执行')
  assert(calls === 2, `跨轮应能各执行一次，实际 ${calls}`)
  unregisterNodeRunner('dedup-node-4')
})

// 用例 5：未挂载的节点如实给可读原因（不是静默成功）
await check('未挂载的节点给可读原因', async () => {
  beginAgentRunRound()
  const res = await runNodeById('never-mounted')
  assert(!res.ok && /未挂载/.test(res.reason || ''), `未挂载要可读：${res.reason}`)
})

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
