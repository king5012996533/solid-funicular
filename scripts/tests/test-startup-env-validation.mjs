/**
 * 生产启动环境变量校验的回归测试。
 *
 * 钉住两条不能退的规则：
 *   1. 关键变量缺失 → 校验必须报出问题（start-production / server 据此失败退出）；
 *   2. 生产环境禁止回落仓库内置默认密钥（否则库里的厂商 key 等于明文）。
 *
 * 同时校验脚本侧的 .mjs 实现与服务端的 .ts 实现规则一致（两者都用于判断生产环境）。
 */
import {
  collectProductionEnvProblems,
  assertProductionEnv,
  resolveConfigSecret,
  isProductionRuntime,
  PRODUCTION_REQUIRED_ENV_KEYS,
} from '../lib/startup-env-validation.mjs'
import {
  collectProductionEnvProblems as collectServerProblems,
  resolveConfigSecret as resolveServerSecret,
  assertProductionEnv as assertServerEnv,
} from '../../server/shared/startup-env.ts'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed += 1
    console.log(`  ✅ ${label}`)
  } else {
    failed += 1
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

function throws(label, fn) {
  try {
    fn()
    failed += 1
    console.log(`  ❌ ${label}（本应抛错但没抛）`)
  } catch {
    passed += 1
    console.log(`  ✅ ${label}`)
  }
}

const completeEnv = {
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/canana_mind',
  JWT_SECRET: 'a-long-random-jwt-secret',
  PROVIDER_CONFIG_SECRET: 'a-long-random-provider-secret',
  STORAGE_CONFIG_SECRET: 'a-long-random-storage-secret',
}

console.log('\n【1】缺失关键变量必须被报出')
{
  const problems = collectProductionEnvProblems({})
  check('空环境报出全部 4 个必须项', problems.length, PRODUCTION_REQUIRED_ENV_KEYS.length)
  check('缺 DATABASE_URL 被点名', problems.some(p => p.includes('DATABASE_URL')), true)
  check('缺 JWT_SECRET 被点名', problems.some(p => p.includes('JWT_SECRET')), true)
  check('缺 PROVIDER_CONFIG_SECRET 被点名', problems.some(p => p.includes('PROVIDER_CONFIG_SECRET')), true)
  check('缺 STORAGE_CONFIG_SECRET 被点名', problems.some(p => p.includes('STORAGE_CONFIG_SECRET')), true)
}

console.log('\n【2】完整变量通过')
{
  check('完整环境无问题', collectProductionEnvProblems(completeEnv), [])
  check('空白字符串按缺失处理', collectProductionEnvProblems({ ...completeEnv, DATABASE_URL: '   ' }).length, 1)
}

console.log('\n【3】禁止仓库内置默认密钥')
{
  const problems = collectProductionEnvProblems({
    ...completeEnv,
    PROVIDER_CONFIG_SECRET: 'canana-vue-provider-config-secret',
  })
  check('provider 默认值被拦下', problems.some(p => p.includes('PROVIDER_CONFIG_SECRET')), true)

  const problems2 = collectProductionEnvProblems({
    ...completeEnv,
    STORAGE_CONFIG_SECRET: 'please-change-this-storage-secret',
  })
  check('storage 模板占位值被拦下', problems2.some(p => p.includes('STORAGE_CONFIG_SECRET')), true)
}

console.log('\n【4】assertProductionEnv 在生产运行时抛错')
{
  throws('ENV_FILE=.env.production 且变量缺失 → 抛错', () => assertProductionEnv({ ENV_FILE: '.env.production' }))
  throws('NODE_ENV=production 且用默认密钥 → 抛错', () => assertProductionEnv({
    ...completeEnv,
    NODE_ENV: 'production',
    PROVIDER_CONFIG_SECRET: 'canana-vue-provider-config-secret',
  }))
  // 服务端版只在生产运行时拦截；开发/测试环境不能因为缺变量就起不来。
  check('服务端版非生产环境不干预（空环境也不抛）', (() => {
    try { assertServerEnv({}); return 'ok' } catch { return 'threw' }
  })(), 'ok')
  throws('服务端版生产运行时缺变量 → 抛错', () => assertServerEnv({ NODE_ENV: 'production' }))
}

console.log('\n【5】resolveConfigSecret 禁止生产环境回落默认值')
{
  check('开发环境缺省回落默认值', resolveServerSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', {}), 'dev-default')
  check('配置了就用配置值', resolveServerSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', { PROVIDER_CONFIG_SECRET: 'real' }), 'real')
  throws('生产环境缺失 → 抛错', () => resolveServerSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', { NODE_ENV: 'production' }))
  throws('生产环境用默认值 → 抛错', () => resolveServerSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', {
    NODE_ENV: 'production',
    PROVIDER_CONFIG_SECRET: 'canana-vue-provider-config-secret',
  }))
  check('isProductionRuntime 认 ENV_FILE', isProductionRuntime({ ENV_FILE: '.env.production' }), true)
  check('isProductionRuntime 认 NODE_ENV', isProductionRuntime({ NODE_ENV: 'production' }), true)
  check('开发环境不是生产运行时', isProductionRuntime({ NODE_ENV: 'development' }), false)
}

console.log('\n【6】脚本版(.mjs) 与服务端版(.ts) 规则一致')
{
  const cases = [
    {},
    completeEnv,
    { ...completeEnv, PROVIDER_CONFIG_SECRET: 'canana-vue-provider-config-secret' },
    { DATABASE_URL: 'x' },
  ]
  for (const [index, env] of cases.entries()) {
    check(`第 ${index + 1} 组问题清单一致`, collectProductionEnvProblems(env), collectServerProblems(env))
  }

  check(
    '服务端版也拒绝生产回落默认密钥',
    (() => {
      try {
        resolveServerSecret(['STORAGE_CONFIG_SECRET'], 'dev-default', { ENV_FILE: '.env.production' })
        return 'no-throw'
      } catch {
        return 'threw'
      }
    })(),
    'threw',
  )

  // 两版 resolveConfigSecret 行为一致
  check(
    '脚本版 resolveConfigSecret 生产缺省也抛错',
    (() => {
      try {
        resolveConfigSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', { ENV_FILE: '.env.production' })
        return 'no-throw'
      } catch {
        return 'threw'
      }
    })(),
    'threw',
  )
  check(
    '脚本版开发环境回落默认值',
    resolveConfigSecret(['PROVIDER_CONFIG_SECRET'], 'dev-default', {}),
    'dev-default',
  )
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
