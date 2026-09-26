/**
 * 画布 Agent「不参与任何积分计算」（纯逻辑验证，2026-09-26）
 *
 * 产品决策（原话）：不要让它去算积分 —— 积分是我们**提前前置**的（点生成即预扣），
 * Agent 只需告诉用户「生成过程要预扣积分」，不够就**直接拦下**，跟人手动在画布上点生成一样。
 *
 * 与决策冲突的三处（本批一起修）：
 *   ① 工具 schema 的 costPoints 描述写着「不确定就填可靠上界，不要留空」→ **是我们要求模型算钱**；
 *   ② 确认卡直接把 confirmRequest.costPoints 渲染成「预计消耗 N 积分」→ 用户看到的是模型编的数字；
 *   ③ 输出契约还在说「积分数字只能引用服务端数」—— 留了「引用」的口子，实测模型心算低估 3 倍
 *      （卡片写 2 分、实际扣 12 分）。
 *
 * 这里钉死四件事：
 *   1. schema 的 costPoints 不再要求填写/估算，且明确「不要自己计算」；
 *   2. system 提示含硬规则「不要计算或报出任何积分数字」+ 预扣三要素；
 *   3. 确认卡的降级文案是固定原文，且「模型自报数字进不了显示」在结构上成立；
 *   4. 反证：删掉硬规则 / 退回旧描述，对应断言必然失败。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK,
  findCanvasAgentTool,
} from '../src/shared/canvas-agent-tools'
import {
  CANVAS_AGENT_OUTPUT_CONTRACT,
  buildSystemPrompt,
} from '../server/generation-tasks/canvas-agent-executor'
import {
  AGENT_CONFIRM_PREDEDUCT_NOTICE,
  collectConfirmationNodeIds,
  resolveAgentConfirmCostDisplay,
} from '../src/components/canana/agent-confirm-cost'

let passed = 0
let failed = 0

function check(label: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HARD_RULE = '不要计算或报出任何积分数字'

console.log('\n【1】工具 schema：不再要求模型算钱，costPoints 明确「不要自己计算」')
{
  const tool = findCanvasAgentTool('request_confirmation')
  const properties = (tool?.parameters?.properties || {}) as Record<string, { description?: string }>
  const cost = properties.costPoints
  const costDesc = String(cost?.description || '')

  check('costPoints 字段仍保留（兼容既有调用方与旧对话）', Boolean(cost))
  check('costPoints 描述含「不要自己计算」', costDesc.includes('不要自己计算'))
  check('costPoints 描述说明留空即可', costDesc.includes('留空'))
  check('costPoints 描述不再要求填「可靠上界」', !costDesc.includes('可靠上界'))
  check('costPoints 描述不再要求「不要留空」', !costDesc.includes('不要留空'))
  check('costPoints 不在必填项里', !(tool?.parameters?.required || []).includes('costPoints'))
  check('工具主描述不再要求写「预计消耗多少积分」', !String(tool?.description || '').includes('预计消耗多少积分'))
  check('工具主描述点明「不要自己计算积分」', String(tool?.description || '').includes('不要自己计算积分'))
}

console.log('\n【2】system 提示：硬规则 + 预扣三要素')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  check(`system 含硬规则「${HARD_RULE}」`, system.includes(HARD_RULE))
  check('三要素①：会预扣积分', system.includes('会预扣积分'))
  check('三要素②：余额不足服务端会拦下', system.includes('余额不足服务端会拦下'))
  check('三要素③：失败自动退还', system.includes('失败自动退还'))
  check('system 不再教模型算「预计消耗多少积分」', !system.includes('预计消耗多少积分'))
  // 输出契约里 💰 一节只允许列服务端数字；手里没有服务端数字就走固定写法
  check('契约只允许列「服务端给的数字」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('只列服务端给的数字'))
  check('契约降级写法「预扣积分（以实际扣费为准）」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('预扣积分（以实际扣费为准）'))
  check('契约保留「未提交节点不扣费、不会自动重试」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('未提交节点不扣费、不会自动重试'))
  check('契约不再留「只能引用服务端数」的旧口子', !CANVAS_AGENT_OUTPUT_CONTRACT.includes('不许自己口算'))
  // 手册第 4 步（花钱前要确认）也不该再让模型估钱
  check('手册第 4 步不再要求「预计消耗多少积分」', !CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK.includes('预计消耗多少积分'))
  check('手册第 4 步改为「会预扣积分」', CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK.includes('会预扣积分'))
}

// 批次 2 在契约里加了一段「决策口径」后空上下文为 2958（批次 1 基线 2702，仍在 +10% 内）
console.log('\n【3】system 长度仍在量级内（空上下文 2702，允许 ±10%）')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  check(
    `空上下文 system ∈ [2432, 2972]（现在 ${system.length}）`,
    system.length >= 2432 && system.length <= 2972,
  )
}

console.log('\n【4】确认卡：数字只认服务端，降级文案固定')
{
  check('降级文案原文正确', AGENT_CONFIRM_PREDEDUCT_NOTICE === '本操作会「预扣」积分；余额不足会被服务端拦下，失败将自动退还。')

  const withServer = resolveAgentConfirmCostDisplay({ estimated: 12, available: 100 })
  check('有服务端估算 → 显示服务端数字', withServer.estimatedPoints === 12)
  check('显示当时余额（服务端给得到才显示）', withServer.balanceText === '当前可用积分 100')
  check('有估算时也显示预扣说明', withServer.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE)

  const degraded = resolveAgentConfirmCostDisplay({})
  check('拿不到服务端估算 → 不显示任何数字', degraded.estimatedPoints === null)
  check('降级时显示预扣说明', degraded.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE)
  check('拿不到余额 → 不显示余额行', degraded.balanceText === null)

  // 模型自报的数字根本进不了这个显示函数（入参里没有 costPoints 这个位置）
  const modelOnly = resolveAgentConfirmCostDisplay({ costPoints: 2 } as never)
  check('模型自报 costPoints 进不了显示（结构上不成立）', modelOnly.estimatedPoints === null)
}

console.log('\n【5】目标节点解析：优先结构化 nodeIds，只认画布上真实节点')
{
  check(
    '结构化 nodeIds 优先且按序返回',
    JSON.stringify(collectConfirmationNodeIds({ nodeIds: ['node_1', 'node_2'], knownNodeIds: ['node_1', 'node_2'] }))
      === JSON.stringify(['node_1', 'node_2']),
  )
  check(
    '编造的 id 不参与估算（避免算出无关数字）',
    collectConfirmationNodeIds({ nodeIds: ['ghost'], knownNodeIds: ['node_1'] }).length === 0,
  )
  check(
    '缺结构化字段时从 items 里扫描已知节点 id',
    JSON.stringify(collectConfirmationNodeIds({ items: ['生成 node_7 与 node_8'], knownNodeIds: ['node_7', 'node_8'] }))
      === JSON.stringify(['node_7', 'node_8']),
  )
}

console.log('\n【6】组件不再用模型给的 costPoints 渲染，改用服务端估算 + 降级文案')
{
  const rightPanel = readFileSync(path.join(ROOT_DIR, 'src/components/canana/RightPanel.vue'), 'utf8')
  check('组件里不再引用 costPoints 字段', !rightPanel.includes('costPoints'))
  check('确认卡不再直接渲染 confirmRequest.costPoints', !rightPanel.includes('confirmRequest.costPoints'))
  check('确认卡引用降级文案常量', rightPanel.includes('AGENT_CONFIRM_PREDEDUCT_NOTICE'))
  check(
    '确认卡调服务端估算与余额接口',
    rightPanel.includes('requestPointsEstimate') && rightPanel.includes('requestPointsBalance'),
  )
}

console.log('\n【7】反证：退回旧描述 / 删掉硬规则，对应断言必然失败')
{
  const requiresNoSelfCalc = (desc: string) => desc.includes('不要自己计算')
  const tool = findCanvasAgentTool('request_confirmation')
  const costDesc = String(
    ((tool?.parameters?.properties || {}) as Record<string, { description?: string }>).costPoints?.description || '',
  )
  check('新实现：costPoints 描述禁止自算', requiresNoSelfCalc(costDesc) === true)
  check(
    '旧实现：旧描述（填可靠上界）不禁止自算 —— 正是要消灭的形态',
    requiresNoSelfCalc('预计消耗的积分总数（不确定就填可靠上界，不要留空）') === false,
  )
  check(
    '反证成立：退回旧描述会让【1】的核心断言失败',
    requiresNoSelfCalc('预计消耗的积分总数（不确定就填可靠上界，不要留空）') !== requiresNoSelfCalc(costDesc),
  )

  const reportsNoPoints = (text: string) => text.includes(HARD_RULE)
  const system = buildSystemPrompt({ brief: '', summary: '' })
  check('新实现：system 含硬规则', reportsNoPoints(system) === true)
  const legacySystem = system.replace(HARD_RULE, '')
  check('旧实现：删掉硬规则后断言不再成立', reportsNoPoints(legacySystem) === false)
  check(
    '反证成立：硬规则一旦缺失，【2】的核心断言失败',
    reportsNoPoints(legacySystem) !== reportsNoPoints(system),
  )

  const usesModelCost = (src: string) => src.includes('confirmRequest.costPoints')
  check('旧实现：旧确认卡确实直接渲染模型自报数字', usesModelCost('<div v-if="confirmRequest.costPoints">预计消耗 {{ confirmRequest.costPoints }} 积分</div>') === true)
  check(
    '反证成立：组件若退回直接渲染 costPoints，【6】的核心断言失败',
    usesModelCost('<div v-if="confirmRequest.costPoints">预计消耗 {{ confirmRequest.costPoints }} 积分</div>') !== usesModelCost(
      readFileSync(path.join(ROOT_DIR, 'src/components/canana/RightPanel.vue'), 'utf8'),
    ),
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
