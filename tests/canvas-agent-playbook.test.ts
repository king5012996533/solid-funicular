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
 * 为什么必须用测试钉：这类改动**不报错、形状不变、模型照样答得通** —— typecheck / 构建 / e2e
 * 都抓不住「手册被悄悄简写」或「system 又长回去了」，只有这里的断言能抓。
 */

import {
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
  '## 第 1 步 · 读画布',
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
    `空上下文：system 比搬迁前（${SYSTEM_CHARS_BEFORE_EMPTY}）至少短 2000 字符（现在 ${systemEmpty.length}）`,
    systemEmpty.length < SYSTEM_CHARS_BEFORE_EMPTY - 2000,
  )
  check(
    `带画布/摘要：system 比搬迁前（${SYSTEM_CHARS_BEFORE_WITH_BRIEF}）至少短 2000 字符（现在 ${system.length}）`,
    system.length < SYSTEM_CHARS_BEFORE_WITH_BRIEF - 2000,
  )
  // 手册一旦回到 system，这个绝对阈值会先炸
  check(`system 已瘦身到 3000 字符以内（现在 ${system.length}）`, system.length < 3000)
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

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
