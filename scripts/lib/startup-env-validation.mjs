/**
 * 生产启动的环境变量校验（启动即失败，不静默降级）。
 *
 * 背景：`npm start` 以前在缺 key 变量时照常往下走 ——
 *   · 没有 `.env.production` 时，"使用当前进程环境变量"，带着残留的开发变量去
 *     `prisma migrate deploy`，等于把迁移打到开发库；
 *   · `PROVIDER_CONFIG_SECRET` / `STORAGE_CONFIG_SECRET` 缺失时回落到仓库里的
 *     公开默认值（`crypto.ts` 的 DEFAULT_SECRET），库里已加密的厂商 key
 *     等于可被任何拿到仓库的人离线解密。
 * 所以生产启动前必须先把这几个变量校验掉，缺就报错退出，绝不继续连库。
 */

/** 生产环境必须显式提供的变量（缺一即中止启动）。 */
export const PRODUCTION_REQUIRED_ENV_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PROVIDER_CONFIG_SECRET',
  'STORAGE_CONFIG_SECRET',
]

/**
 * 仓库内置的默认密钥 / 模板占位值。
 * 这些值随源码公开，出现在生产环境就等于没有加密。
 */
export const FORBIDDEN_CONFIG_SECRET_VALUES = new Set([
  'canana-vue-provider-config-secret',
  'canana-vue-storage-config-secret',
  'please-change-this-provider-secret',
  'please-change-this-storage-secret',
])

const isBlank = (value) => !String(value ?? '').trim()

/**
 * 是否处于生产运行时（与服务端 server/shared/startup-env.ts 保持同一判定口径）。
 * 除 NODE_ENV=production 外，也认生产启动脚本设置的 ENV_FILE=.env.production。
 */
export const isProductionRuntime = (env = process.env) => {
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return true
  }

  return String(env.ENV_FILE || '').trim() === '.env.production'
}

/**
 * 收集生产环境变量的问题清单（空数组表示通过）。
 * 独立于 `assertProductionEnv` 导出，便于单测直接断言规则。
 */
export const collectProductionEnvProblems = (env = process.env) => {
  const problems = []

  for (const key of PRODUCTION_REQUIRED_ENV_KEYS) {
    if (isBlank(env[key])) {
      problems.push(`缺少 ${key}`)
    }
  }

  for (const key of ['PROVIDER_CONFIG_SECRET', 'STORAGE_CONFIG_SECRET']) {
    const value = String(env[key] ?? '').trim()
    if (value && FORBIDDEN_CONFIG_SECRET_VALUES.has(value)) {
      problems.push(`${key} 仍是仓库内置默认值，生产环境禁止使用（请生成随机密钥替换）`)
    }
  }

  return problems
}

/**
 * 解析配置加密密钥：按 envKeys 顺序取第一个非空值。
 * 生产运行时取不到、或取到仓库默认值时直接抛错；只有开发环境才允许回落。
 * （与服务端 server/shared/startup-env.ts 保持同一口径。）
 */
export const resolveConfigSecret = (envKeys, developmentFallback, env = process.env) => {
  for (const key of envKeys) {
    const value = String(env[key] ?? '').trim()
    if (!value) {
      continue
    }

    if (FORBIDDEN_CONFIG_SECRET_VALUES.has(value) && isProductionRuntime(env)) {
      throw new Error(
        `${key} 仍是仓库内置默认值，生产环境禁止使用；请生成随机密钥后重新配置（并重新录入受影响的密钥）。`,
      )
    }

    return value
  }

  if (isProductionRuntime(env)) {
    throw new Error(
      `缺少 ${envKeys.join(' / ')}，生产环境禁止回落到内置默认密钥；请在环境中配置随机密钥。`,
    )
  }

  return developmentFallback
}

/**
 * 生产启动前断言环境变量完整；不通过时抛出带完整清单的错误。
 * 调用方应在执行 `prisma migrate deploy` 之前调用它。
 */
export const assertProductionEnv = (env = process.env) => {
  const problems = collectProductionEnvProblems(env)
  if (problems.length === 0) {
    return
  }

  const message = [
    '生产环境变量校验未通过，已中止启动（不会连接数据库）：',
    ...problems.map((problem) => `  - ${problem}`),
    '',
    '请检查 .env.production（或容器 env_file / CI Secrets）后重试。',
  ].join('\n')

  throw new Error(message)
}
