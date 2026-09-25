/**
 * 「无 id 时该进哪张画布」的决策验证（A 的纯逻辑）。
 *
 * 这条决策是「下次回来接着上次画」的入口，也是「重复打开不再新建草稿」的根：
 * 只有它说 seed-blank，画布页才会走到自动保存的 createWorkflowDefinition。
 * 文件末尾是**反证**：若把「有最近画布」也判成 seed-blank，用例会失败 ——
 * 而修复前正是这样：无 id 什么都不载入、接着播种示例数据，于是每次打开都多一张草稿。
 */

import { decideInitialCanvasEntry } from '../src/views/workflow/config/canvas-entry'

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

console.log('\n【1】URL 显式带 id：优先载入它（分享链接 / 直接打开某张画布）')
check(
  '带 route id 且也有最近画布 → 用 route id',
  decideInitialCanvasEntry({ routeWorkflowId: 'wf-route', recentCanvasId: 'wf-recent' }),
  { action: 'load', workflowId: 'wf-route' },
)

console.log('\n【2】无 route id：回到该用户最近更新的那张画布')
check(
  '有最近画布 → 载入它（这是「回来的路」）',
  decideInitialCanvasEntry({ recentCanvasId: 'wf-recent' }),
  { action: 'load', workflowId: 'wf-recent' },
)
check(
  'id 两边的空白会被裁掉',
  decideInitialCanvasEntry({ recentCanvasId: '  wf-recent  ' }),
  { action: 'load', workflowId: 'wf-recent' },
)

console.log('\n【3】一张画布都没有：此时才播种空白画布')
check('都没有 → seed-blank', decideInitialCanvasEntry({}), { action: 'seed-blank' })
check(
  '空串 / 纯空白等于没有',
  decideInitialCanvasEntry({ routeWorkflowId: '   ', recentCanvasId: '  ' }),
  { action: 'seed-blank' },
)

console.log('\n【4】反证：有最近画布时绝不能走 seed-blank')
{
  // 修复前的判定等价于「无 route id 就 seed-blank」，结果每次打开都建草稿。
  // 这条断言专门盯住这个回归：只要有人把最近画布这一分支去掉，它立刻变红。
  const decision = decideInitialCanvasEntry({ recentCanvasId: 'wf-recent' })
  check('反证：有最近画布 → 不是 seed-blank', decision.action !== 'seed-blank', true)
  check(
    '反证：且必须给出要载入的 id',
    decision.action === 'load' ? decision.workflowId : '',
    'wf-recent',
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
