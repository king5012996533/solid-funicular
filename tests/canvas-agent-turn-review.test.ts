/**
 * 交付前自检（finishTurn）纯逻辑验证，2026-09-26
 *
 * 要钉死四件最容易静默出错的事（都不报错、形状不变，只能靠断言）：
 *   ① 交付成立（声明 8、实际 8）→ 收口；不成立（声明 8、实际 5）→ 续跑，且指令**点名缺口**；
 *   ② 生产动作失败 → 也算不成立（续跑或如实汇报）；
 *   ③ **续跑次数有上限**：到顶必须收口（无条件的 continue 是无限循环烧钱）；
 *   ④ 不在「收尾回合」以外干预：还在调工具的回合就算有缺口也不插话。
 *
 * 另加：判定所依据的「交付事实」全部由真实回执推导（不采信模型自报数字）。
 * 文件末尾有反证：去掉次数上限，同一场景会永远 continue —— 断言会失败。
 */

import {
  CANVAS_AGENT_DELIVERY_TOOLS,
  CANVAS_AGENT_MAX_SELF_CHECKS,
  buildCanvasAgentSelfCheckInstruction,
  decideCanvasAgentSelfCheck,
  summarizeCanvasAgentDelivery,
  type CanvasAgentDeliveryFacts,
  type CanvasAgentSelfCheckDecision,
} from '../server/generation-tasks/canvas-agent-turn-review'
import type { CanvasAgentConsoleEvent } from '../server/generation-tasks/canvas-agent-console-state'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message)
}

/** 一条 request_confirmation 事件：`declaredTarget` 就是「声明要做 N 个」的出处 */
const confirmEvent = (total: number, unit = '个镜头'): CanvasAgentConsoleEvent => ({
  type: 'tool_end',
  toolName: 'request_confirmation',
  callId: `confirm-${total}`,
  ok: true,
  declaredTarget: { total, unit },
})

/** 一条 generate 回执：`created` 是真正建出来的节点 id（自检的「实际交付数」） */
const generateEvent = (createdCount: number, ok = true): CanvasAgentConsoleEvent => ({
  type: 'tool_end',
  toolName: 'generate',
  callId: `gen-${createdCount}-${ok}`,
  ok,
  resultText: JSON.stringify({
    created: Array.from({ length: createdCount }, (_, index) => `node_${index + 1}`),
    submitted: createdCount,
    total: createdCount,
  }),
})

const facts = (input: Partial<CanvasAgentDeliveryFacts> = {}): CanvasAgentDeliveryFacts => ({
  deliveredCount: 0,
  failedDeliveryCount: 0,
  failedDeliveryTools: [],
  ...input,
})

const decide = (input: Partial<Parameters<typeof decideCanvasAgentSelfCheck>[0]> = {}): CanvasAgentSelfCheckDecision =>
  decideCanvasAgentSelfCheck({
    stopReason: 'stop',
    hasToolCalls: false,
    toolResultCount: 0,
    hasReportText: true,
    facts: facts(),
    selfCheckCount: 0,
    maxSelfChecks: CANVAS_AGENT_MAX_SELF_CHECKS,
    ...input,
  })

console.log('\n【1】交付事实由真实回执推导（不采信模型自报）')
{
  const allEight = summarizeCanvasAgentDelivery([confirmEvent(8), generateEvent(8)])
  check('声明 8、建了 8 → delivered=8 / declared=8', {
    declaredTotal: allEight.declaredTotal,
    deliveredCount: allEight.deliveredCount,
    unit: allEight.declaredUnit,
  }, { declaredTotal: 8, deliveredCount: 8, unit: '个镜头' })

  const partial = summarizeCanvasAgentDelivery([confirmEvent(8), generateEvent(5)])
  check('声明 8、只建了 5 → delivered=5', partial.deliveredCount, 5)

  const failedGen = summarizeCanvasAgentDelivery([confirmEvent(8), generateEvent(0, false)])
  check('generate 失败 → 记入失败生产动作（并点名工具）', {
    deliveredCount: failedGen.deliveredCount,
    failedDeliveryCount: failedGen.failedDeliveryCount,
    failedDeliveryTools: failedGen.failedDeliveryTools,
  }, { deliveredCount: 0, failedDeliveryCount: 1, failedDeliveryTools: ['generate'] })

  // 读画布 / 预校验失败不算「交付不成立」——拿它们触发自检只会白烧一轮钱
  const readFailure = summarizeCanvasAgentDelivery([
    { type: 'tool_end', toolName: 'get_canvas_overview', callId: 'r1', ok: false, resultText: '' },
    { type: 'tool_end', toolName: 'preflight_check', callId: 'p1', ok: false, resultText: '' },
  ])
  check('读/预校验失败不进失败生产动作', readFailure.failedDeliveryCount, 0)
}

console.log('\n【2】自检判定：成立收口 / 不成立续跑且点名缺口')
{
  const fulfilled = decide({ facts: facts({ declaredTotal: 8, deliveredCount: 8, declaredUnit: '个镜头' }) })
  check('声明 8、实际 8 → end', fulfilled.action, 'end')
  check('  且原因为 fulfilled', fulfilled.reason, 'fulfilled')

  const gap = decide({ facts: facts({ declaredTotal: 8, deliveredCount: 5, declaredUnit: '个镜头' }) })
  check('声明 8、实际 5 → continue', gap.action, 'continue')
  check('  缺口结构化：差 3', gap.gap, {
    declaredTotal: 8, deliveredCount: 5, unit: '个镜头', shortfall: 3, failedDeliveryCount: 0,
  })
  assert(
    typeof gap.instruction === 'string'
      && gap.instruction.includes('8') && gap.instruction.includes('5') && gap.instruction.includes('还差 3'),
    '指令必须点名「声明 8 / 实际 5 / 还差 3」',
  )
  assert(/不要(把没做的说成已做|粉饰)/.test(gap.instruction || ''), '指令必须要求如实、不许粉饰')
  assert(/request_confirmation/.test(gap.instruction || ''), '指令必须说明花钱仍走 request_confirmation（自检不产生额外付费动作）')

  const failedOnly = decide({ facts: facts({ failedDeliveryCount: 1, failedDeliveryTools: ['generate'] }) })
  check('有生产动作失败 → continue', failedOnly.action, 'continue')
  assert(/失败/.test(failedOnly.instruction || '') && /generate/.test(failedOnly.instruction || ''), '指令要点名失败的动作')
}

console.log('\n【3】只在收尾回合自检（中途不插话）')
{
  check('本轮有工具调用 → 不干预（end/in_progress）', decide({
    hasToolCalls: true,
    facts: facts({ declaredTotal: 8, deliveredCount: 2, declaredUnit: '个镜头' }),
  }), { action: 'end', reason: 'in_progress' })

  check('本轮有工具结果 → 不干预', decide({
    toolResultCount: 2,
    facts: facts({ declaredTotal: 8, deliveredCount: 2, declaredUnit: '个镜头' }),
  }).reason, 'in_progress')

  check('本轮没有可见文本 → 不干预', decide({ hasReportText: false }).reason, 'in_progress')

  check('上游 error → 不干预', decide({ stopReason: 'error' }).reason, 'error')
  check('用户 aborted → 不干预', decide({ stopReason: 'aborted' }).reason, 'error')
}

console.log('\n【4】次数上限：到顶必须收口（不许无限续跑）')
{
  const gapFacts = facts({ declaredTotal: 8, deliveredCount: 5, declaredUnit: '个镜头' })

  check('第 1 次自检（count=0 → 上限 2）→ continue', decide({ facts: gapFacts, selfCheckCount: 0 }).action, 'continue')
  check('第 2 次自检（count=1）→ continue', decide({ facts: gapFacts, selfCheckCount: 1 }).action, 'continue')

  const capped = decide({ facts: gapFacts, selfCheckCount: CANVAS_AGENT_MAX_SELF_CHECKS })
  check('第 3 次（count=上限）→ end', capped.action, 'end')
  check('  且标记 capped', capped.capped, true)
  check('  缺口照实带出（不粉饰）', capped.gap?.shortfall, 3)
  check('  到顶不再给指令', capped.instruction, undefined)
}

console.log('\n【反证】去掉次数上限 → 同一缺口场景永远 continue（正是要防的无限循环）')
{
  const gapFacts = facts({ declaredTotal: 8, deliveredCount: 5, declaredUnit: '个镜头' })

  // 复刻「没有上限」的形态：maxSelfChecks = Infinity。交付数不会自己变好（模型没补），所以会一直 continue。
  const run = (maxSelfChecks: number, iterations: number) => {
    let action: string = 'continue'
    let count = 0
    for (let i = 0; i < iterations; i += 1) {
      const decision = decide({ facts: gapFacts, selfCheckCount: count, maxSelfChecks })
      action = decision.action
      if (action === 'end') break
      count += 1
    }
    return { action, count }
  }

  const unbounded = run(Number.POSITIVE_INFINITY, 1000)
  assert(
    unbounded.action === 'continue' && unbounded.count === 1000,
    '无上限时应跑满 1000 次仍不结束（反证：这就是无限循环）',
  )

  const bounded = run(CANVAS_AGENT_MAX_SELF_CHECKS, 1000)
  assert(
    bounded.action === 'end' && bounded.count === CANVAS_AGENT_MAX_SELF_CHECKS,
    `有上限时应在第 ${CANVAS_AGENT_MAX_SELF_CHECKS} 次收口，实际 ${JSON.stringify(bounded)}`,
  )
  assert(
    unbounded.action !== bounded.action,
    '反证成立：有无上限结论不同，次数上限的断言是灵敏的',
  )
}

console.log('\n【5】指令与清单的两条硬约束')
{
  check('生产动作清单含收敛后的唯一入口 generate', CANVAS_AGENT_DELIVERY_TOOLS.has('generate'), true)
  check('默认上限是 2（不是 0、也不是无穷）', CANVAS_AGENT_MAX_SELF_CHECKS, 2)
  assert(
    buildCanvasAgentSelfCheckInstruction(
      { declaredTotal: 0, deliveredCount: 0, unit: '项', shortfall: 0, failedDeliveryCount: 1 },
      facts({ failedDeliveryCount: 1, failedDeliveryTools: ['generate'] }),
    ).startsWith('【交付前自检】'),
    '指令要有固定抬头，便于转录里一眼认出',
  )
}

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
