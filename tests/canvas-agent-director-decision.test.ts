/**
 * 导演控制台批次 2 —— 导演决策卡（纯逻辑验证，2026-09-26）
 *
 * 产品背景：确认卡与提问卡的机制一直是好的（弹卡 → 等待 → 回执 → 同一轮继续），
 * 但提问卡的文案与载荷是「客服式」的：标题写「需要你补充一点信息」，选项是纯字符串，
 * 用户点了哪串字、模型就只能看到那串字。产品的要求是升级成**导演决策点**：
 *   · 卡片头部 🎬 导演决策点，模型先给一句情境（已完成什么 / 卡在哪两个方向）；
 *   · 选项 = 代号 + 名称 + 2~3 条特点（如 `A 电影写实 · 克制 / 留白 / 长镜头`）；
 *   · 回执必须把**代号 + 名称 + 特点**都回给模型 —— 只回一个字母不算知道用户选了什么。
 *
 * 为什么要用测试钉：
 *   · 选项解析要在「对象」与「旧纯字符串」两种形状下都不崩（旧对话/旧调用还在跑）；
 *   · 回执是模型唯一的判断依据，缺特点等于让模型「按一个字母继续往下做」；
 *   · 决策口径只写在 system 里，删掉不报错、模型照样答得通，typecheck / 构建抓不住。
 *
 * 末尾有反证：把回执退回「只回一个字母」、把契约删掉，对应断言必然失败。
 */

import {
  buildAgentAskUserReceipt,
  formatAgentAskUserOption,
  normalizeAgentAskUserOptions,
  type NormalizedAgentAskUserOption,
} from '../src/shared/canvas-agent-tools'
import {
  CANVAS_AGENT_OUTPUT_CONTRACT,
  buildSystemPrompt,
} from '../server/generation-tasks/canvas-agent-executor'

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

/** 视觉方向的两个方案：批次 2 需求里点名的形状 */
const DIRECTOR_OPTIONS: NormalizedAgentAskUserOption[] = [
  { key: 'A', label: '电影写实', notes: ['克制', '留白', '长镜头'] },
  { key: 'B', label: '商业电影', notes: ['强冲突', '快节奏'] },
]

console.log('\n【1】选项解析：对象与旧纯字符串都能归一')
{
  const fromObjects = normalizeAgentAskUserOptions([
    { key: 'A', label: '电影写实', notes: ['克制', '留白', '长镜头'] },
    { key: 'B', label: '商业电影', notes: ['强冲突', '快节奏'] },
  ])
  check('对象选项解析出 2 个', fromObjects.length === 2)
  check('代号保留', fromObjects[0].key === 'A' && fromObjects[1].key === 'B')
  check('名称保留', fromObjects[0].label === '电影写实' && fromObjects[1].label === '商业电影')
  check('特点保留为数组', JSON.stringify(fromObjects[0].notes) === JSON.stringify(['克制', '留白', '长镜头']))

  // 旧对话 / 旧调用：options 就是字符串数组
  const legacy = normalizeAgentAskUserOptions(['电影写实', '商业电影'])
  check('旧纯字符串也能解析出 2 个', legacy.length === 2)
  check('旧字符串按位置补代号 A/B', legacy[0].key === 'A' && legacy[1].key === 'B')
  check('旧字符串原文当名称', legacy[0].label === '电影写实')
  check('旧字符串没有特点（空数组，不崩）', Array.isArray(legacy[0].notes) && legacy[0].notes.length === 0)

  // 混写
  const mixed = normalizeAgentAskUserOptions([{ label: '电影写实' }, '商业电影'])
  check('混写：对象补代号 A、字符串补代号 B', mixed[0].key === 'A' && mixed[1].key === 'B')

  // 特点给成字符串（模型常见写法：「克制 / 留白 / 长镜头」）
  const stringNotes = normalizeAgentAskUserOptions([
    { key: 'A', label: '电影写实', notes: '克制 / 留白 / 长镜头' },
  ])
  check('notes 字符串按分隔符拆成 3 条', stringNotes[0].notes.length === 3 && stringNotes[0].notes[0] === '克制')

  check('非数组输入返回空数组（不抛错）',
    normalizeAgentAskUserOptions(undefined).length === 0 && normalizeAgentAskUserOptions('A').length === 0)
}

console.log('\n【2】非法选项降级不崩（缺 key / 缺 label / 空白）')
{
  const degraded = normalizeAgentAskUserOptions([
    { key: 'A' },                         // 缺 label → 用 key 当名称
    { label: '只有名称' },                 // 缺 key → 按位置补
    123,                                  // 非对象非字符串 → 降级成名称
    { notes: ['没有名称也没有代号'] },      // key/label 都缺 → 丢弃
    { key: '', label: '   ' },             // 空白 → 丢弃
  ])
  check('丢弃无效项后剩 3 个', degraded.length === 3)
  check('缺 label 的用 key 当名称', degraded[0].key === 'A' && degraded[0].label === 'A')
  check('缺 key 的按位置补代号', degraded[1].label === '只有名称' && degraded[1].key === 'B')
  check('数字选项降级为名称', degraded[2].label === '123')
  check('特点超上限时截到 3 条', normalizeAgentAskUserOptions([
    { key: 'A', label: 'X', notes: ['1', '2', '3', '4', '5'] },
  ])[0].notes.length === 3)
}

console.log('\n【3】回执载荷：代号 + 名称 + 特点都回给模型')
{
  const questions = [{ question: '视觉方向选哪个？', options: DIRECTOR_OPTIONS }]
  const receipt = buildAgentAskUserReceipt(questions, [{ optionKey: 'A' }])
  check('answered=true', receipt.answered === true)
  check('回执条数=1', receipt.answers.length === 1)
  const answer = receipt.answers[0]
  check('answer 含代号 A', answer.answer.includes('A'))
  check('answer 含名称 电影写实', answer.answer.includes('电影写实'))
  check('answer 含全部特点', ['克制', '留白', '长镜头'].every((note) => answer.answer.includes(note)))
  check('choice 带代号', answer.choice?.key === 'A')
  check('choice 带名称', answer.choice?.label === '电影写实')
  check('choice.notes 是全部特点',
    JSON.stringify(answer.choice?.notes) === JSON.stringify(['克制', '留白', '长镜头']))
  check('格式化行 =「A 电影写实 · 克制 / 留白 / 长镜头」',
    formatAgentAskUserOption(DIRECTOR_OPTIONS[0]) === 'A 电影写实 · 克制 / 留白 / 长镜头')
}

console.log('\n【4】多问题映射 / 自由输入 / 旧字符串选项')
{
  const questions = [
    { question: '视觉方向？', options: DIRECTOR_OPTIONS },
    { question: '画幅？', options: normalizeAgentAskUserOptions(['16:9', '9:16']) },
    { question: '还有什么补充？' },
  ]
  const receipt = buildAgentAskUserReceipt(questions, [
    { optionKey: 'B' },
    { optionKey: 'B' },
    { text: '别用慢镜头' },
  ])
  check('多问题条数=3', receipt.answers.length === 3)
  check('第 1 问独立映射到 B 商业电影', receipt.answers[0].choice?.label === '商业电影')
  check('第 2 问旧字符串选项回执完整',
    receipt.answers[1].choice?.key === 'B' && receipt.answers[1].choice?.label === '9:16')
  check('第 3 问自由输入回原话、无 choice',
    receipt.answers[2].answer === '别用慢镜头' && receipt.answers[2].choice === undefined)

  const free = buildAgentAskUserReceipt([questions[0]], [{ optionKey: '', text: '用纪录片风格' }])
  check('自由输入不带 choice', free.answers[0].choice === undefined && free.answers[0].answer === '用纪录片风格')

  const blank = buildAgentAskUserReceipt([questions[0]], undefined)
  check('完全没作答时不崩（答案为空串）', blank.answers[0].answer === '' && blank.answers[0].choice === undefined)

  const stale = buildAgentAskUserReceipt([questions[0]], [{ optionKey: 'Z' }])
  check('失效代号降级为空答案、不带 choice',
    stale.answers[0].answer === '' && stale.answers[0].choice === undefined)
}

console.log('\n【5】system 含决策口径，且旧客服腔只作为「禁止」的负面样例')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  check('契约含「导演决策点」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('导演决策点'))
  check('契约含「最多 2 个方案」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('最多 2 个方案'))
  check('契约含「代号 + 名称 + 2~3 条特点」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('代号 + 名称 + 2~3 条特点'))
  check('契约含「闲聊式追问不算决策点」', CANVAS_AGENT_OUTPUT_CONTRACT.includes('闲聊式追问不算决策点'))
  check('system 含决策口径', system.includes('导演决策点') && system.includes('最多 2 个方案'))
  check('system 没有旧卡片标题「需要你补充一点信息」', !system.includes('需要你补充一点信息'))

  // 客服腔只允许以「禁止「…」这类客服腔」的形式出现（作为负面样例），不能当成引导语
  const banned = '需要补充一点信息'
  const occurrences = system.split(banned).length - 1
  check('客服腔最多出现一次', occurrences <= 1)
  // 允许 markdown 的 ** 加粗符号夹在「禁止」与样例之间
  check('该次出现被「禁止…」框住', occurrences === 0 || /禁止[^\n]{0,8}需要补充一点信息/.test(system))
  check('system 明确写「客服腔」', system.includes('客服腔'))
}

console.log('\n【6】system 字符数给了上界（别把之前的瘦身成果吃回去）')
{
  const systemEmpty = buildSystemPrompt({ brief: '', summary: '' })
  /**
   * 批次 2 在契约里加了一段决策口径（约 166 字符），上界随之抬到 2972（批次 1 基线 2702 的 +10%）。
   * 这道界够容纳决策口径，又拦得住「以后又往里塞长文」。
   */
  check(
    `空上下文 system ≤ 2972 字符（现在 ${systemEmpty.length}）`,
    systemEmpty.length <= 2972,
  )
  check(`契约长度有界（现在 ${CANVAS_AGENT_OUTPUT_CONTRACT.length} 字符）`, CANVAS_AGENT_OUTPUT_CONTRACT.length <= 1100)
}

console.log('\n【7】反证：回执退回「只回一个字母」/ 删掉契约，核心断言必然失败')
{
  const questions = [{ question: '视觉方向选哪个？', options: DIRECTOR_OPTIONS }]

  /** 回执是否完整：代号 + 名称 + 至少一条特点，三者齐备才算模型「知道选了什么」 */
  const hasChoiceDetail = (receipt: { answers: Array<{ choice?: { key?: string; label?: string; notes?: string[] } }> }) => {
    const choice = receipt.answers[0]?.choice
    return Boolean(choice && choice.key && choice.label && (choice.notes?.length || 0) > 0)
  }

  const good = buildAgentAskUserReceipt(questions, [{ optionKey: 'A' }])
  const legacyOnlyKey = { answered: true, answers: [{ question: questions[0].question, answer: 'A' }] }
  check('新实现：回执含代号+名称+特点', hasChoiceDetail(good) === true)
  check('旧实现（只回一个字母）：断言不成立（正是要防的形态）', hasChoiceDetail(legacyOnlyKey) === false)
  check('反证成立：缺特点会让【3】的核心断言失败', hasChoiceDetail(legacyOnlyKey) !== hasChoiceDetail(good))

  const system = buildSystemPrompt({ brief: '', summary: '' })
  check('新实现：system 逐字含输出契约（决策口径因此在场）', system.includes(CANVAS_AGENT_OUTPUT_CONTRACT))

  // 反证落在契约本身：system 是契约的逐字载体，契约里没有这段，system 里就没有
  const contractHasDecision = (text: string) => text.includes('导演决策点') && text.includes('最多 2 个方案')
  check('新实现：契约含决策口径', contractHasDecision(CANVAS_AGENT_OUTPUT_CONTRACT) === true)
  const legacyContract = CANVAS_AGENT_OUTPUT_CONTRACT
    .split('\n')
    .filter((line) => !line.includes('决策口径'))
    .join('\n')
  check('旧实现：删掉决策口径那段后契约不再含它', contractHasDecision(legacyContract) === false)
  check('反证成立：契约缺失会让【5】的核心断言失败',
    contractHasDecision(legacyContract) !== contractHasDecision(CANVAS_AGENT_OUTPUT_CONTRACT))
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
