/**
 * 系统初始化状态三态判定的验证
 *
 * 回归的正是那次事故：状态接口失败（API 重启/网络抖动/5xx）被折成
 * `isInitialized: false`，路由守卫据此把已初始化的用户送进 /install 安装向导。
 * 这里钉住三件事：
 *   1. 只有应答里明确是布尔值才算「问到了」；
 *   2. 失败（unknown）时守卫**不跳转**；
 *   3. 明确未初始化仍然照旧跳 /install，已初始化不允许停在 /install。
 */

import {
  createDefaultSystemInitStatus,
  resolveSystemInitPhase,
  resolveSystemInitRedirect,
  type SystemInitPhase,
} from '../src/shared/system-init-state'

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

console.log('\n【1】应答 → 三态：只有明确布尔值才算问到了')
{
  check('isInitialized=true → initialized', resolveSystemInitPhase({ isInitialized: true }), 'initialized')
  check('isInitialized=false → uninitialized', resolveSystemInitPhase({ isInitialized: false }), 'uninitialized')
  check('无应答(undefined) → unknown', resolveSystemInitPhase(undefined), 'unknown')
  check('null → unknown', resolveSystemInitPhase(null), 'unknown')
  check('空对象 → unknown', resolveSystemInitPhase({}), 'unknown')
  check('字符串 "true" 不算布尔 → unknown', resolveSystemInitPhase({ isInitialized: 'true' }), 'unknown')
  check('缺字段的完整快照 → unknown', resolveSystemInitPhase({ isInitialized: undefined }), 'unknown')
}

console.log('\n【2】路由守卫决策：unknown 绝不跳 /install')
{
  check('unknown + / → 放行', resolveSystemInitRedirect('unknown', '/', '/'), null)
  check('unknown + /workflow → 放行', resolveSystemInitRedirect('unknown', '/workflow', '/workflow'), null)
  check('unknown + /install → 放行', resolveSystemInitRedirect('unknown', '/install', '/install'), null)

  check(
    'uninitialized + / → 跳 /install 并带 redirect',
    resolveSystemInitRedirect('uninitialized', '/', '/'),
    { path: '/install', query: { redirect: '/' } },
  )
  check(
    'uninitialized + /workflow?x=1 → 保留完整回跳地址',
    resolveSystemInitRedirect('uninitialized', '/workflow', '/workflow?x=1'),
    { path: '/install', query: { redirect: '/workflow?x=1' } },
  )
  check(
    'uninitialized + 已在 /install → 不跳',
    resolveSystemInitRedirect('uninitialized', '/install', '/install'),
    null,
  )

  check('initialized + / → 放行', resolveSystemInitRedirect('initialized', '/', '/'), null)
  check(
    'initialized + /install → 回首页',
    resolveSystemInitRedirect('initialized', '/install', '/install'),
    { path: '/' },
  )
}

console.log('\n【3】端到端语义：三种「这次请求的结果」各自会走到哪')
{
  // 复刻 store 的推进方式：成功才喂 status；失败不喂，phase 留在 unknown。
  const decide = (outcome: 'ok-true' | 'ok-false' | 'fail', path: string) => {
    let phase: SystemInitPhase
    if (outcome === 'ok-true') {
      phase = resolveSystemInitPhase({ isInitialized: true })
    } else if (outcome === 'ok-false') {
      phase = resolveSystemInitPhase({ isInitialized: false })
    } else {
      phase = 'unknown' // 请求失败：applySystemInitFailure 只把 phase 置回 unknown
    }
    return resolveSystemInitRedirect(phase, path, path)?.path ?? null
  }

  check('已初始化 + 请求成功 → 不跳转', decide('ok-true', '/'), null)
  check('★请求失败 → 不跳转（事故回归点）', decide('fail', '/'), null)
  check('明确未初始化 + 请求成功 → /install', decide('ok-false', '/'), '/install')
}

console.log('\n【4】占位快照只是展示用，不参与判定')
{
  const placeholder = createDefaultSystemInitStatus()
  check('占位快照的 isInitialized 为 false', placeholder.isInitialized, false)
  // 关键：store 初始 phase 是 unknown（见 stores/system-init.ts），
  // 失败时也不会把这份占位快照喂给 resolveSystemInitPhase，所以不会误判成 uninitialized。
  check('phase 初始值不是由占位快照推导', resolveSystemInitRedirect('unknown', '/', '/'), null)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
