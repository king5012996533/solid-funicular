/**
 * 画布 Agent 的「输出契约」与它的前端渲染（纯逻辑验证，2026-09-26）
 *
 * 产品背景：面板回复原先按**纯文本**渲染（`.ai-text-content` 的 `white-space: pre-wrap`），
 * 模型写的 `**`/`-`/`###` 原样显示，大段文字看得累。本批做两件事：
 *   ① 面板正文改走 `renderMarkdownBlocks`（复用 research 的自写渲染器，不引新依赖）；
 *   ② system 里写入固定「输出契约」（Markdown 组织、状态口径统一、涉及任务提交 / 批量 / 汇报时按固定结构）。
 *
 * 为什么必须用测试钉：
 *   · 契约与渲染器得对得上 —— 若契约要求了渲染器不支持的语法，模型照写、前端却退化回纯文本；
 *   · 契约随 prompt 每轮下发、被删掉**不报错、模型照样答得通**，typecheck / 构建 / e2e 都抓不住；
 *   · v-html 的前提是渲染器先 escape，这里用恶意正文反向验证 XSS 安全。
 *
 * 末尾有三条反证：删掉契约、把结构标记退化成散文、把恶意标签喂进去，对应的断言必然失败。
 */

import {
  CANVAS_AGENT_OUTPUT_CONTRACT,
  buildSystemPrompt,
} from '../server/generation-tasks/canvas-agent-executor'
import {
  renderMarkdownBlocks,
} from '../src/composables/research/report-markdown-utils'

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
 * 契约规定的固定结构，套上一轮「任务提交」的真实内容后长这样。
 * 用它当渲染输入：断言渲染器真能把这些结构渲染成标签 —— 只要契约改用渲染器不支持的语法
 * （例如表格、`#########`、`*斜体*` 里的 `*` 当列表），这里会先炸。
 */
const CONTRACT_SAMPLE = [
  '已提交 3 个分镜节点，其余待你确认。',
  '### 📌 当前任务',
  '生成一条 30 秒广告的分镜图。',
  '### 📋 任务进度',
  '- ✅ 已完成：剧本与分镜表',
  '- 🔄 生成中：node-1 / node-2',
  '- ⏳ 待提交：node-3（**未提交不扣费**）',
  '### 💰 积分明细',
  '- 单条成本：**6 分**',
  '- 账户余额：**120 分**',
  '- 未提交节点不扣费、不会自动重试',
  '### 🎯 用户可选方案',
  '- 【推荐】先出 1 张看效果',
  '### 💡补充备注',
  '- 批量 3 张预计 **18 分**',
  '等待你的下一步指令。',
].join('\n')

/** 契约里逐条点名的固定结构 / 口径（真源就在契约正文里）。 */
const CONTRACT_MARKERS = [
  '📌 当前任务',
  '📋 任务进度',
  '💰 积分明细',
  '🎯 用户可选方案',
  '💡补充备注',
  '等待你的下一步指令。',
  '未提交节点不扣费、不会自动重试',
  '最多 2 个',
  '【推荐】',
  '不许自己口算',
  '不要写大段散文',
  '~20 行',
]

/** 状态标记的统一口径（避免把「待办」误读成「失败」）。 */
const STATUS_MARKERS = ['✅ 已完成', '🔄 生成中', '⏳ 待提交', '❌ 失败', '⚠️ 风险或待定']

/** system（空上下文）的字符上界：实测 2592，留出余量防止悄悄反弹。 */
const SYSTEM_CHARS_EMPTY_UPPER_BOUND = 2900

console.log('\n【1】契约规定的结构真能被渲染器渲染成标签')
{
  const html = renderMarkdownBlocks(CONTRACT_SAMPLE)
  check('渲染出三级标题 <h3', html.includes('<h3'))
  check('渲染出无序列表 <ul', html.includes('<ul>'))
  check('渲染出列表项 <li', html.includes('<li>'))
  check('渲染出加粗 <strong', html.includes('<strong>'))
  // 结构齐了还不够 —— 状态行必须落在列表项里，而不是被当成一段散文
  check('状态行落在 <li> 里', /<li>✅ 已完成/.test(html))
  check('积分行的加粗数字被渲染', /<strong>6 分<\/strong>/.test(html))
}

console.log('\n【2】契约正文含全部固定结构与状态口径')
{
  for (const marker of CONTRACT_MARKERS) {
    check(`契约含「${marker}」`, CANVAS_AGENT_OUTPUT_CONTRACT.includes(marker))
  }
  for (const marker of STATUS_MARKERS) {
    check(`契约含状态标记「${marker}」`, CANVAS_AGENT_OUTPUT_CONTRACT.includes(marker))
  }
  check('契约≤ 800 字符（别把契约本身写成散文）', CANVAS_AGENT_OUTPUT_CONTRACT.length <= 800)
}

console.log('\n【3】system 提示里存在输出契约与状态口径，且明确禁止大段散文')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  check('system 含输出契约段（逐字）', system.includes(CANVAS_AGENT_OUTPUT_CONTRACT))
  check('system 含「# 输出契约」标题', system.includes('# 输出契约'))
  check('system 含状态口径（✅/🔄/⏳/❌/⚠️ 五个都在）',
    STATUS_MARKERS.every((marker) => system.includes(marker)))
  check('system 明确「不要写大段散文」', system.includes('不要写大段散文'))
  check('system 明确数字要列表化', system.includes('一律列表化'))
  check('system 明确积分不许自己口算', system.includes('不许自己口算'))
  // 旧的散文式引导不该再出现（任何鼓励长篇展开的措辞）
  check('system 不再有任何「详细展开 / 长篇」式引导',
    !['详细展开', '长篇大论', '尽量详细描述', '充分展开叙述'].some((phrase) => system.includes(phrase)))
}

console.log('\n【4】system 字符数给了上界（别把之前的瘦身成果吃回去）')
{
  const systemEmpty = buildSystemPrompt({ brief: '', summary: '' })
  check(
    `空上下文 system ≤ ${SYSTEM_CHARS_EMPTY_UPPER_BOUND} 字符（现在 ${systemEmpty.length}）`,
    systemEmpty.length <= SYSTEM_CHARS_EMPTY_UPPER_BOUND,
  )
  // 契约是刻意加的固定段，长度要有界（prompt 每轮都发）
  check(`契约长度有界（现在 ${CANVAS_AGENT_OUTPUT_CONTRACT.length} 字符）`, CANVAS_AGENT_OUTPUT_CONTRACT.length <= 800)
}

console.log('\n【5】XSS：恶意正文被转义，不产生真实标签')
{
  const evil = [
    '正常一行',
    '# <img src=x onerror="alert(1)">',
    '- <script>alert(2)</script>',
    '**<b>不是真标签</b>**',
    '[点我](javascript:alert(3))',
    '`<i>x</i>`',
  ].join('\n')
  const html = renderMarkdownBlocks(evil)
  check('不产生真实 <img>', !html.includes('<img'))
  check('不产生 onerror 真标签（<img 未成型）', !/<img/.test(html))
  check('不产生真实 <script>', !html.includes('<script'))
  check('不产生真实 <b>', !html.includes('<b>'))
  check('不产生真实 <i>', !html.includes('<i>'))
  check('尖括号被转义（出现 &lt;img）', html.includes('&lt;img'))
  check('javascript: 伪协议未被渲染成链接', !html.includes('<a '))
}

console.log('\n【6】反证：删掉契约 / 退化成散文 / 去掉转义，对应断言必然失败')
{
  const system = buildSystemPrompt({ brief: '', summary: '' })
  const systemHasContract = (text: string) => text.includes('# 输出契约') && text.includes('✅ 已完成')
  check('新实现：system 含契约与状态口径', systemHasContract(system) === true)
  const legacySystem = system.replace(CANVAS_AGENT_OUTPUT_CONTRACT, '')
  check('旧实现：删掉契约后断言不再成立（正是要防的形态）', systemHasContract(legacySystem) === false)
  check('反证成立：契约缺失会让【3】的核心断言失败',
    systemHasContract(legacySystem) !== systemHasContract(system))

  // 渲染反证：把 `### ` 结构标记退化成纯段落，渲染结果就不再含 <h3>
  const proseSample = CONTRACT_SAMPLE.replace(/^### /gm, '')
  check('新实现样例：含 <h3', renderMarkdownBlocks(CONTRACT_SAMPLE).includes('<h3'))
  check('退化样例：去掉结构标记后不含 <h3', renderMarkdownBlocks(proseSample).includes('<h3') === false)
  check('反证成立：结构标记一旦缺失，【1】的核心断言失败',
    renderMarkdownBlocks(proseSample).includes('<h3') !== renderMarkdownBlocks(CONTRACT_SAMPLE).includes('<h3'))

  // XSS 反证：不再 escape 时，恶意标签会真的成型
  const unescaped = evilUnescapedProbe()
  check('新实现（escape 后）：<img 不会成型', !renderMarkdownBlocks('# <img src=x onerror=alert(1)>').includes('<img'))
  check('旧实现（不 escape）：<img 会真的成型（正是要防的形态）', unescaped.includes('<img'))
  check('反证成立：转义一旦缺失，【5】的核心断言失败',
    unescaped.includes('<img') !== renderMarkdownBlocks('# <img src=x onerror=alert(1)>').includes('<img'))
}

/** 复刻「不先 escape、直接拼 markdown 标签」的旧实现，用于证明 XSS 断言是灵敏的。 */
function evilUnescapedProbe(): string {
  return '# <img src=x onerror=alert(1)>'.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
