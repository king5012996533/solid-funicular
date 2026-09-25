/**
 * 制片 Agent「思考预算分档」的纯逻辑验证（2026-09-26）
 *
 * 要钉死的事：
 *   1. **分档函数**：给定一轮用户输入 → 期望档位（闲聊最快、成片生产认真想、小活/问答走默认）；
 *   2. **升档**：本轮出现工具调用时升**一档**、封顶、不复位（同一轮内不来回抖动）；
 *   3. **会话缓存键**：会话 id + 画布 id，缺一退回另一个（不串台）；
 *   4. **档位 → 上游字段**：只认模型能力声明里配过的档位，没配就不注入（保持改动前行为）。
 *
 * 这些判断都不报错、也不改返回形状，退化时只会「悄悄变慢/变贵」，typecheck 与 e2e 都抓不住。
 * 末尾有**反证**：若实现退回「只按关键词匹配意图」，含成片名词的疑问句会被判成成片生产，
 * 第一条断言会因此失败。
 */

import {
  CANVAS_AGENT_PRODUCTION_NOUN_PATTERN,
  buildCanvasAgentProviderSessionId,
  classifyCanvasAgentThinkingIntent,
  escalateCanvasAgentThinkingLevel,
  resolveCanvasAgentReasoningFields,
  resolveCanvasAgentThinkingLevel,
} from '../server/generation-tasks/canvas-agent-thinking'

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

console.log('\n【1】分档函数：按本轮用户输入给档位（≥8 条样本）')
{
  // 闲聊 / 寒暄 / 能力询问 → minimal（最快）
  check('「你好」→ minimal（寒暄）', resolveCanvasAgentThinkingLevel('你好'), 'minimal')
  check('「你能做什么？」→ minimal（能力询问）', resolveCanvasAgentThinkingLevel('你能做什么？'), 'minimal')
  check('「嗯」→ minimal（极短碎片）', resolveCanvasAgentThinkingLevel('嗯'), 'minimal')

  // 问答 / 小活 → low（默认）
  check('「这个画布上有几个节点？」→ low（问答）', resolveCanvasAgentThinkingLevel('这个画布上有几个节点？'), 'low')
  check('「给这个节点出一张图」→ low（小活）', resolveCanvasAgentThinkingLevel('给这个节点出一张图'), 'low')
  check('「帮我把这个视频节点的提示词改一下」→ low（小活，含「视频」也算改一个点）', resolveCanvasAgentThinkingLevel('帮我把这个视频节点的提示词改一下'), 'low')
  check('「把分镜图重新生成一下」→ low（小活，不套整条链路）', resolveCanvasAgentThinkingLevel('把分镜图重新生成一下'), 'low')

  // 成片生产 → medium（认真想）
  check('「帮我做个 30 秒咖啡广告」→ medium（成片）', resolveCanvasAgentThinkingLevel('帮我做个 30 秒咖啡广告'), 'medium')
  check('「写一版 60 秒的品牌宣传片，先出分镜」→ medium（成片）', resolveCanvasAgentThinkingLevel('写一版 60 秒的品牌宣传片，先出分镜'), 'medium')

  // 空输入不该炸，退回默认低档
  check('空串 → low', resolveCanvasAgentThinkingLevel('   '), 'low')
}

console.log('\n【2】意图分类（比档位更细，供日志与将来调整）')
{
  check('寒暄 → chitchat', classifyCanvasAgentThinkingIntent('你好'), 'chitchat')
  check('问答 → qa', classifyCanvasAgentThinkingIntent('这个画布上有几个节点？'), 'qa')
  check('小活 → small_op', classifyCanvasAgentThinkingIntent('给这个节点出一张图'), 'small_op')
  check('成片 → production', classifyCanvasAgentThinkingIntent('帮我做个 30 秒咖啡广告'), 'production')
}

console.log('\n【3】升档：本轮出现工具调用 → 只升一档、封顶、不降')
{
  check('minimal + 工具调用 → low', escalateCanvasAgentThinkingLevel('minimal', true), 'low')
  check('low + 工具调用 → medium', escalateCanvasAgentThinkingLevel('low', true), 'medium')
  check('medium + 工具调用 → medium（封顶，不再往上）', escalateCanvasAgentThinkingLevel('medium', true), 'medium')
  check('没有工具调用 → 保持原档', escalateCanvasAgentThinkingLevel('low', false), 'low')
  // 反复调用不抖：升档后再升仍是同一档（调用方只需应用一次，这里证明函数本身也幂等）
  check('重复升档不抖动（升到 medium 后仍是 medium）', escalateCanvasAgentThinkingLevel(escalateCanvasAgentThinkingLevel('low', true), true), 'medium')
}

console.log('\n【4】会话缓存键：会话 id + 画布 id（缺一则退回另一个，不串台）')
{
  check('两者都有 → 用 : 连接', buildCanvasAgentProviderSessionId('sess-1', 'canvas-A'), 'sess-1:canvas-A')
  check('没有画布 id → 退回会话 id', buildCanvasAgentProviderSessionId('sess-1', ''), 'sess-1')
  check('没有会话 id → 退回画布 id', buildCanvasAgentProviderSessionId('', 'canvas-A'), 'canvas-A')
  check('都没有 → 空串', buildCanvasAgentProviderSessionId('', ''), '')
  check('带空格 → 去掉', buildCanvasAgentProviderSessionId('  sess-1  ', '  canvas-A  '), 'sess-1:canvas-A')
}

console.log('\n【5】档位 → 上游思考字段：复用模型能力声明里已配的档位注入')
{
  const capabilityJson = {
    reasoning: {
      supported: true,
      options: [
        { key: 'low', label: '低', injection: { type: 'set', field: 'reasoning_effort', value: 'low' } },
        { key: 'medium', label: '中', injection: { type: 'set', field: 'reasoning_effort', value: 'medium' } },
      ],
    },
  }
  const fields = resolveCanvasAgentReasoningFields(capabilityJson)
  check('配了 low → 注入 reasoning_effort:low', fields.low, { reasoning_effort: 'low' })
  check('配了 medium → 注入 reasoning_effort:medium', fields.medium, { reasoning_effort: 'medium' })
  // 声明里没有 minimal 键：就近落到最省的一档（low），而不是干脆不注入 —— 否则闲聊仍走长思考
  check('没配 minimal → 就近落到最省的 low', fields.minimal, { reasoning_effort: 'low' })
  check('模型没声明能力 → 一律不注入（行为与改动前一致）', resolveCanvasAgentReasoningFields(null), {})

  // 完全不认识的 key（运营自定义档位名）：minimal/low 落第一档、medium 落最后一档
  const customKeys = {
    reasoning: {
      supported: true,
      options: [
        { key: 'standard', label: '标准', injection: { type: 'set', field: 'thinking', value: 'standard' } },
        { key: 'extended', label: '扩展', injection: { type: 'set', field: 'thinking', value: 'extended' } },
      ],
    },
  }
  const customFields = resolveCanvasAgentReasoningFields(customKeys)
  check('自定义 key：minimal → 第一档 standard', customFields.minimal, { thinking: 'standard' })
  check('自定义 key：low → 第一档 standard', customFields.low, { thinking: 'standard' })
  check('自定义 key：medium → 最后一档 extended', customFields.medium, { thinking: 'extended' })
}

console.log('\n【6】反证：若实现只按关键词匹配意图，含成片名词的疑问句会被误判成成片生产')
{
  const questionAboutProduction = '你刚才做的那条广告片是什么风格？'

  // 新实现（当前）：疑问句优先 → qa → low；这是「问过去做过的东西」，不是委托。
  check('新实现：含成片名词的疑问句 → low', resolveCanvasAgentThinkingLevel(questionAboutProduction), 'low')

  // 旧实现（若只测成片名词）：该句确实命中成片名词「广告片」，于是会被判成 medium。
  const naiveProductionHit = CANVAS_AGENT_PRODUCTION_NOUN_PATTERN.test(questionAboutProduction)
  check('反证成立：该句确实命中成片名词（只按关键词匹配就会误判成 medium）', naiveProductionHit, true)
  check(
    '反证成立：若实现退回「只测关键词」，第一条断言（→ low）会失败',
    naiveProductionHit === (resolveCanvasAgentThinkingLevel(questionAboutProduction) === 'medium'),
    false,
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
