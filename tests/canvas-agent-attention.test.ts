/**
 * 制片 Agent 的注意力归属（纯逻辑验证，2026-09-26）
 *
 * 要钉死的是「回答会话事实时该信谁」这条规则，以及「画布现状放在哪里」这个承载位置。
 * 这类改动**不报错、形状不变、模型照样答得通**，只是答错来源 —— typecheck / 构建 / e2e 都抓不住，
 * 只能靠这里的断言（文件末尾有反证）。
 *
 * 真机事故（同一会话同一画布 cmuhdcz010000jk92aicdlxlo 的三轮实测）：
 *   1. 用户说「记住两条设定：统一 21:9、水墨国风」，模型回「记住了」；
 *   2. 关页重开后再问「我刚才让你记住的两条设定是什么」，模型回的是画布上的
 *      「金毛寻回犬在草地上快乐奔跑……用文本输入驱动文生图节点生成画面」；
 *   3. 再问「刚才让你记住的**画幅比例**是多少？只回答那个数字」，模型回「16:9」（应为 21:9）。
 * 旁证：服务端 canvas_agent:session_restored {messageCount:2,dialogMessageCount:2} 说明历史拿到了；
 * 同一模型写的压缩摘要写对「统一使用 21:9 画幅；水墨国风」。信息与摘要都在，是「回答时该信谁」错了 ——
 * 16:9 与「金毛寻回犬」都来自画布，模型把 system 里的画布现状当成了用户设定。
 */

import {
  CANVAS_AGENT_STATE_NOTICE_LABEL,
  buildCanvasAgentCanvasStateNotice,
  buildCanvasAgentPrioritySection,
  buildPromptWithExecutionDemand,
  buildPromptWithHistory,
  buildSystemPrompt,
} from '../server/generation-tasks/canvas-agent-executor'

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

/**
 * 复刻真机事故里的画布现状：图片节点 ratio=16:9、文本节点是示例「金毛寻回犬」。
 * 用**唯一标记**（而不是「16:9」这种字面量）来做「内容在不在 system 里」的断言 ——
 * 优先级规则自身就带了「16:9」的示例，拿字面量断言会误判。
 */
const RATIO_MARKER = 'BRIEF_RATIO_169_MARKER'
const GOLDEN_MARKER = 'BRIEF_GOLDEN_RETRIEVER_MARKER'
const INCIDENT_BRIEF = [
  '当前画布有 2 个节点、1 条连线。',
  `- node-img [图片] "示例图" 模型=某文生图 尺寸=${RATIO_MARKER} 已出图`,
  `- node-text [文本] "示例提示词" 内容="${GOLDEN_MARKER} 在草地上快乐奔跑、摇着尾巴"`,
].join('\n')

console.log('\n【1】信息优先级规则存在，且在 system 提示最前（注意力最高位）')
{
  const priority = buildCanvasAgentPrioritySection()
  check('规则点名「会话事实以对话历史为准」', priority.includes('只以对话历史为准'), true)
  check('规则点名摘要也是历史来源', priority.includes('# 会话摘要'), true)
  check('规则点名画布现状只是状态快照、不是设定',
    priority.includes('状态快照') && priority.includes('用户的要求或设定'), true)
  check('规则写明冲突时如何处置（以历史为准并说明）', priority.includes('以对话历史为准') && priority.includes('说明你按哪条走'), true)
  check('规则把「用画布」限定在「没有会话历史可依据时」', priority.includes('没有会话历史可依据时'), true)

  const system = buildSystemPrompt({ brief: INCIDENT_BRIEF, summary: '统一使用 21:9 画幅；水墨国风' })
  check('优先级段确实在 system 提示最前', system.startsWith(priority), true)
  // 反证意味：若把优先级段挪到后面（例如挂在 # 纪律 里），这两条会失败
  check('system 提示第 0 个字符就是优先级标题', system.indexOf('# 信息优先级'), 0)
  check('system 提示里优先级段早于工作手册第 0 步', system.indexOf('# 信息优先级') < system.indexOf('# 第 0 步'), true)
}

console.log('\n【2】画布现状的承载位置：内容在用户消息附注里，system 里只有指针')
{
  const summary = '1. 用户偏好 / 已确定的设定：统一使用 21:9 画幅；水墨国风'
  const system = buildSystemPrompt({ brief: INCIDENT_BRIEF, summary })
  const userPrompt = buildPromptWithExecutionDemand('我刚才让你记住的画幅比例是多少？只回答那个数字', {
    canvasBrief: INCIDENT_BRIEF,
  })

  check('画布现状的**内容**不在 system 提示里（比例 marker 不出现）', system.includes(RATIO_MARKER), false)
  check('画布现状的**内容**不在 system 提示里（金毛 marker 不出现）', system.includes(GOLDEN_MARKER), false)
  check('system 里仍留一句指针（指向用户消息附注）', system.includes(CANVAS_AGENT_STATE_NOTICE_LABEL) && system.includes('# 画布现状'), true)
  check('摘要仍在 system 提示里（权威位，未被这次改动挤走）', system.includes('21:9'), true)

  check('画布现状的**内容**在用户消息里（比例 marker 看得到）', userPrompt.includes(RATIO_MARKER), true)
  check('画布现状带「仅供参考」标签', userPrompt.includes(CANVAS_AGENT_STATE_NOTICE_LABEL), true)
  check('附注显式声明「不是用户的要求或设定」', userPrompt.includes('**不是用户的要求或设定**'), true)
  check('用户消息里原话完整保留（历史没被附注挤掉）', userPrompt.startsWith('我刚才让你记住的画幅比例是多少？只回答那个数字'), true)
  check('附注排在执行要求之前（执行要求仍在用户消息最末，注意力最强处）',
    userPrompt.indexOf(CANVAS_AGENT_STATE_NOTICE_LABEL) < userPrompt.indexOf('【本轮执行要求】'), true)

  // fallback 路径（无转录可恢复）也走同一个拼装函数：画布现状同样在用户消息里
  const fallbackPrompt = buildPromptWithHistory('我刚才让你记住的画幅比例是多少？只回答那个数字', {
    canvasBrief: INCIDENT_BRIEF,
    history: [{ role: 'user', content: '记住两条设定：统一 21:9、水墨国风' }],
  })
  check('fallback 路径同样把画布现状放进用户消息', fallbackPrompt.includes(CANVAS_AGENT_STATE_NOTICE_LABEL) && fallbackPrompt.includes(RATIO_MARKER), true)
  check('fallback 路径的历史仍被并进用户消息', fallbackPrompt.includes('统一 21:9、水墨国风'), true)
}

console.log('\n【3】空画布现状不产生噪音（没有 brief 就不塞附注/指针）')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  const userPrompt = buildPromptWithExecutionDemand('你好', { canvasBrief: '' })
  // 注意：优先级规则里**本来就**会点名这个标签（规则要引用它），所以这里断言的是「指针段」与「附注」不存在
  check('空 brief 时 system 里没有「画布现状」指针段', system.includes('# 画布现状'), false)
  check('空 brief 时用户消息里没有附注', userPrompt.includes(CANVAS_AGENT_STATE_NOTICE_LABEL), false)
  check('优先级规则仍在（与有没有画布无关）', system.startsWith(buildCanvasAgentPrioritySection()), true)
  check('纯函数：空白 brief 返回空串', buildCanvasAgentCanvasStateNotice('   '), '')
}

console.log('\n【4】反证：若退回「画布现状放 system 权威位」，本批的核心断言必然失败')
{
  // 新实现（当前）：画布现状内容只在用户消息附注里
  const fixedSystem = buildSystemPrompt({ brief: INCIDENT_BRIEF, summary: '统一使用 21:9 画幅；水墨国风' })
  const fixedUserPrompt = buildPromptWithExecutionDemand('画幅比例是多少？只回答数字', { canvasBrief: INCIDENT_BRIEF })
  check('新实现：system 里看不到画布上的比例 marker', fixedSystem.includes(RATIO_MARKER), false)
  check('新实现：画布上的比例 marker 出现在用户消息里', fixedUserPrompt.includes(RATIO_MARKER), true)

  // 旧实现（事故形态）：把 brief 直接拼进 system 的 `# 当前画布摘要`
  const legacySystem = `${buildSystemPrompt({ brief: INCIDENT_BRIEF, summary: '统一使用 21:9 画幅；水墨国风' })}\n# 当前画布摘要\n${INCIDENT_BRIEF}`
  check('旧实现：system 里混进了画布上的比例 marker（正是事故形态）', legacySystem.includes(RATIO_MARKER), true)
  check(
    '反证成立：若实现退回「画布现状放 system」，新实现那条断言（system 不含 marker）会失败',
    legacySystem.includes(RATIO_MARKER) === fixedSystem.includes(RATIO_MARKER),
    false,
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
