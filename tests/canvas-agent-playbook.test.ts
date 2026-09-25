/**
 * 画布 Agent 提示词瘦身（2026-09-26）
 *
 * system 提示每轮都要发 —— 包括「只回复一个数字」这种用不上流程的对话；一次实测里那种对话
 * 耗时 15~31 秒，几千字的「完整链路手册」是被怀疑的主因之一。这里把手册从 system 里搬出来，
 * 变成按需加载的服务端工具 `load_playbook`，并钉死三件事：
 *   1. 手册正文**一字未改地**搬进了 load_playbook（按小节标题 + 字数下界，防止以后被简写）；
 *   2. system 提示里**不再**有长流程正文，但指针与核心规则一条不少；
 *   3. 反证：若把手册正文塞回 system，本批的核心断言必然失败。
 *
 * 追加一批「对话优先」（2026-09-26）：实测里模型对「你好」这类闲聊的第一件事也是
 * get_canvas_overview —— 读画布在 system 里被写成了开场动作。这里把一刀改掉：
 *   1. system 里写明「一轮先回应用户、默认不读画布不调工具」，读画布降级为条件动作，
 *      并给出触发条件与「先单节点 → 概览 → 整张」的读取顺序；
 *   2. 读取类工具描述改成「按需读取」，不再写「可频繁调用」「先用 get_canvas_overview」；
 *   3. 反证：删掉「默认不读画布」这条规则，本批断言必然失败；字符数给上界断言防反弹。
 *
 * 为什么必须用测试钉：这类改动**不报错、形状不变、模型照样答得通** —— typecheck / 构建 / e2e
 * 都抓不住「手册被悄悄简写」或「system 又长回去了」，只有这里的断言能抓。
 */

import {
  CANVAS_AGENT_OUTPUT_CONTRACT,
  buildSystemPrompt,
} from '../server/generation-tasks/canvas-agent-executor'
import {
  CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK,
  CANVAS_AGENT_TOOL_DEFINITIONS,
  resolveCanvasAgentPlaybook,
} from '../src/shared/canvas-agent-tools'

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

/**
 * 手册里必须保留的关键小节（成片生产的质量全靠它）。
 * 用「小节标题」而不是零散句子：标题被删/被合并，说明流程被简写了。
 */
const REQUIRED_SECTIONS = [
  '## 第 1 步 · 需要时读画布',
  '## 第 2 步 · 拆剧本 → 分镜表',
  '## 第 3 步 · 定母版',
  '## 第 4 步 · 花钱前先要确认',
  '## 第 5 步 · 批量提交母版生成',
  '## 第 6 步 · 铺分镜节点',
  '## 第 7 步 · 把母版图挂给分镜',
  '## 第 8 步 · 出分镜图',
  '## 第 9 步 · 分镜视频',
  '## 第 9.5 步 · 批量生成前先预校验',
  '## 第 10 步 · 汇报',
]

/** system 里出现任意一个这个，就说明「长流程正文又回到了 system」 */
const PLAYBOOK_BODY_MARKER = '## 第 9.5 步 · 批量生成前先预校验'

/** 搬迁前 buildSystemPrompt 的实测字符数（用于量化瘦身；改 prompt 时同步更新） */
const SYSTEM_CHARS_BEFORE_EMPTY = 4474
const SYSTEM_CHARS_BEFORE_WITH_BRIEF = 4700
/** 上一批瘦身后的实测字符数（空上下文 2168）；本批「不反弹」的上界以它为基准（允许 +15%） */
const SYSTEM_CHARS_SLIMMED_EMPTY = 2168
/**
 * 输出契约（2026-09-26，产品要求）是**刻意加进 system 的固定结构说明**。
 * 下面的字符数断言一律先把契约长度扣掉，比的都是「契约之外」的部分 ——
 * 既保住「手册没回到 system、其余内容没反弹」的原意，又不至于每次产品要加契约
 * 都得先删掉等量规则。契约正文见 CANVAS_AGENT_OUTPUT_CONTRACT。
 */
const OUTPUT_CONTRACT_CHARS = CANVAS_AGENT_OUTPUT_CONTRACT.length

console.log('\n【1】手册被完整搬进 load_playbook（不是简写版）')
{
  const playbook = CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK
  for (const section of REQUIRED_SECTIONS) {
    check(`手册含小节「${section}」`, playbook.includes(section))
  }
  // 前提句也必须一起搬走：它是「仅当成片生产时才按这条链路走」的护栏
  check('手册保留「仅当成片生产时」的前提句', playbook.includes('仅当第 0 步判定为「成片生产」时'))
  // 字数下界：搬迁前实测 2011 字符；若被简写，这里会先炸
  check(`手册正文不短于 1900 字符（实测 ${playbook.length}）`, playbook.length >= 1900)

  check('resolveCanvasAgentPlaybook() 不传名 → 默认返回成片生产手册', resolveCanvasAgentPlaybook() === playbook)
  check('resolveCanvasAgentPlaybook("storyboard-production") → 返回手册', resolveCanvasAgentPlaybook('storyboard-production') === playbook)
  check('未知主题如实返回 null（调用方据此说明）', resolveCanvasAgentPlaybook('nope') === null)
}

console.log('\n【2】load_playbook 是纯服务端工具（不走浏览器桥）')
{
  const tool = CANVAS_AGENT_TOOL_DEFINITIONS.find((item) => item.name === 'load_playbook')
  check('工具定义存在', Boolean(tool))
  check('requiresClient 为 false（正文就在服务端，无需前端往返）', tool?.requiresClient === false)
  const description = String(tool?.description || '')
  check('描述点明「只在成片生产、动手前调一次」', description.includes('成片生产') && description.includes('调一次'))
  check('描述点明「已经调过就不要重复调」', description.includes('不要重复调'))
  check('入参带 name 且先只支持 storyboard-production', JSON.stringify(tool?.parameters?.properties?.name || {}).includes('storyboard-production'))
}

console.log('\n【3】system 提示瘦身：不再含长流程正文，但指针与核心规则都在')
{
  const summary = '1. 用户偏好 / 已确定的设定：统一 21:9 画幅；水墨国风'
  const system = buildSystemPrompt({ brief: '画布有 2 个节点', summary })

  for (const section of REQUIRED_SECTIONS) {
    check(`system 不含流程小节「${section}」`, !system.includes(section))
  }
  // 指针：判定为成片生产时先调 load_playbook
  check('system 保留指向 load_playbook 的指针', system.includes('load_playbook'))
  // 核心规则逐条仍在
  check('核心规则：信息优先级段仍在（会话事实以对话历史/摘要为准）', system.includes('# 信息优先级') && system.includes('只以对话历史为准'))
  check('核心规则：提问只走 ask_user', system.includes('ask_user'))
  check('核心规则：正文里提问=结束这一轮', system.includes('正文里提问等于这一轮结束'))
  check('核心规则：付费动作必须先 request_confirmation', system.includes('request_confirmation') && system.includes('必须先取得同意'))
  check('核心规则：生成类提交即回执、不要轮询', system.includes('提交即回执') && system.includes('不要用读取工具反复轮询'))
  check('核心规则：摘要也要用于回答会话事实', system.includes('# 会话摘要') || system.includes('会话摘要（较早内容）'))

  // 瘦身量化：搬迁前 system 实测 4474（空 brief/summary）~ 4700 字符（带 brief/summary），
  // 现在同条件为 2168 ~ 2394。断言「比搬迁前至少短 2000 字符」：手册一旦回到 system 必然失败。
  const systemEmpty = buildSystemPrompt({ brief: '', summary: '' })
  check(
    `空上下文：扣掉契约后比搬迁前（${SYSTEM_CHARS_BEFORE_EMPTY}）至少短 2000 字符（现在 ${systemEmpty.length}，扣契约 ${systemEmpty.length - OUTPUT_CONTRACT_CHARS}）`,
    systemEmpty.length - OUTPUT_CONTRACT_CHARS < SYSTEM_CHARS_BEFORE_EMPTY - 2000,
  )
  check(
    `带画布/摘要：扣掉契约后比搬迁前（${SYSTEM_CHARS_BEFORE_WITH_BRIEF}）至少短 2000 字符（现在 ${system.length}，扣契约 ${system.length - OUTPUT_CONTRACT_CHARS}）`,
    system.length - OUTPUT_CONTRACT_CHARS < SYSTEM_CHARS_BEFORE_WITH_BRIEF - 2000,
  )
  // 手册一旦回到 system，这个绝对阈值会先炸
  check(`system 扣掉契约后仍在 3000 字符以内（现在 ${system.length}，扣契约 ${system.length - OUTPUT_CONTRACT_CHARS}）`, system.length - OUTPUT_CONTRACT_CHARS < 3000)
}

console.log('\n【4】反证：把手册正文塞回 system，本批「system 不含长流程正文」的断言必然失败')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  const systemHasPlaybookBody = (text: string) => text.includes(PLAYBOOK_BODY_MARKER)

  // 新实现（当前）：system 里看不到手册正文
  check('新实现：system 里没有手册正文', systemHasPlaybookBody(system) === false)
  // 旧实现（复原事故形态）：把手册拼回 system
  const legacySystem = `${CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK}\n${system}`
  check('旧实现：system 里混进了手册正文（正是要消灭的形态）', systemHasPlaybookBody(legacySystem) === true)
  check(
    '反证成立：若实现退回「手册放 system」，核心断言会失败',
    systemHasPlaybookBody(legacySystem) !== systemHasPlaybookBody(system),
  )
}

console.log('\n【5】对话优先：一轮先回应用户，读画布是按需动作（不再当开场第一步）')
{
  const system = buildSystemPrompt({ brief: '画布有 2 个节点', summary: '' })

  check('system 写明「一轮的第一件事是回应用户」', system.includes('一轮的第一件事是回应用户'))
  check('system 写明闲聊/问答「默认不读画布、不调任何工具」', system.includes('默认不读画布、不调任何工具'))
  check('system 写明「读画布是按需动作，不是开场动作」', system.includes('读画布是按需动作，不是开场动作'))
  check('触发条件①：用户明确指向画布或节点', system.includes('用户明确指向画布或节点'))
  check('触发条件②：动作必须知道画布现状', system.includes('必须知道画布现状'))
  check('读取优先级：get_canvas_node 排在 get_canvas_overview 之前',
    system.indexOf('get_canvas_node') !== -1 && system.indexOf('get_canvas_node') < system.indexOf('get_canvas_overview'))
  check('system 不再把读画布写成「第 1 步 · 读画布」', !system.includes('第 1 步 · 读画布'))
  check('system 不再以「先 get_canvas_overview」开场', !system.includes('先 get_canvas_overview'))
  check('system 写明要动手先给「执行建议」', system.includes('执行建议') && system.includes('再动手'))
  check('信息优先级规则仍在（本批未动）', system.startsWith('# 信息优先级'))
  check('手册第 1 步已改成条件动作「需要时读画布」',
    CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK.includes('## 第 1 步 · 需要时读画布'))
}

console.log('\n【6】读取类工具描述改为「按需读取」，不再诱导每轮先扫画布')
{
  for (const name of ['get_canvas_overview', 'get_canvas_node', 'get_canvas_state']) {
    const tool = CANVAS_AGENT_TOOL_DEFINITIONS.find((item) => item.name === name)
    const description = String(tool?.description || '')
    check(`${name} 描述含「按需读取」`, description.includes('按需读取'))
    check(`${name} 描述不再写「可频繁调用」`, !description.includes('可频繁调用'))
  }
  const overview = CANVAS_AGENT_TOOL_DEFINITIONS.find((item) => item.name === 'get_canvas_overview')
  check('概览描述保留「不含提示词」（工具层单测依赖）', String(overview?.description || '').includes('不含提示词'))
  const state = CANVAS_AGENT_TOOL_DEFINITIONS.find((item) => item.name === 'get_canvas_state')
  check('整张读描述仍指向 overview/单节点（工具层单测依赖）',
    /get_canvas_overview/.test(String(state?.description)) && /get_canvas_node/.test(String(state?.description)))
  const remove = CANVAS_AGENT_TOOL_DEFINITIONS.find((item) => item.name === 'remove_node')
  check('删除节点不再写「先用 get_canvas_overview」', !String(remove?.description || '').includes('先用 get_canvas_overview'))
}

console.log('\n【7】system 字符数没有明显反弹（上界断言）')
{
  const systemEmpty = buildSystemPrompt({ brief: '', summary: '' })
  const upperBound = Math.round(SYSTEM_CHARS_SLIMMED_EMPTY * 1.15)
  check(
    `空上下文 system 扣掉契约后 ≤ 瘦身后基准 +15%（${systemEmpty.length - OUTPUT_CONTRACT_CHARS} ≤ ${upperBound}，基准 ${SYSTEM_CHARS_SLIMMED_EMPTY}）`,
    systemEmpty.length - OUTPUT_CONTRACT_CHARS <= upperBound,
  )
}

console.log('\n【8】反证：删掉「默认不读画布」的对话优先规则，本批核心断言必然失败')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  const hasConversationFirst = (text: string) => text.includes('默认不读画布、不调任何工具')

  check('新实现：system 含对话优先规则', hasConversationFirst(system) === true)
  // 旧实现（病灶形态）：模型没有「默认不读画布」这条，就会退回「上来先扫画布」
  const legacySystem = system.replace('默认不读画布、不调任何工具', '')
  check('旧实现：system 丢掉了对话优先规则（正是病灶）', hasConversationFirst(legacySystem) === false)
  check('反证成立：若删掉这条规则，核心断言会失败',
    hasConversationFirst(legacySystem) !== hasConversationFirst(system))
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
