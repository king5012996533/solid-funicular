const DEFAULT_REDIS_PREFIX = 'canana'
const DEFAULT_REDIS_ENV = process.env.NODE_ENV || 'development'
const DEFAULT_REDIS_HOST = '127.0.0.1'
const DEFAULT_REDIS_PORT = 6379
const DEFAULT_REDIS_DATABASE = 0
const DEFAULT_CACHE_TTL_SECONDS = 60
const DEFAULT_TASK_RUNTIME_TTL_SECONDS = 30 * 60
const DEFAULT_TASK_SNAPSHOT_TTL_SECONDS = 30 * 60
const DEFAULT_TASK_ABORT_TTL_SECONDS = 5 * 60
/**
 * 执行锁 TTL。续期间隔由它推导（`ttl / 3`，见 task-runtime-governor），所以调它等于同时调两件事。
 *
 * 为什么是 5 分钟而不是 30 秒：
 *   续期靠 setInterval 触发，而它**在进程被冻结时不会跑**。笔记本进入 Deep Idle
 *   （合盖/息屏）时进程会被挂起，Redis 的 TTL 却按真实时间流逝 —— 醒来后第一次续期
 *   发现锁键已经没了，返回 ownership_lost，而 ownership_lost 是**立即中断**任务。
 *   2026-09-21 实测到两次：两个任务分别在运行 780 秒 / 940 秒后被中断，
 *   失败时间 00:50:55 与 01:04:33 与系统日志里的 DarkWake 事件（00:50:45 / 01:04:33）**逐秒对上**。
 *   而图生图单张实测要 54~334 秒，30 秒的 TTL 完全不够扛一次息屏。
 *
 * 代价：worker 真的死掉时，别的 worker 要多等一个 TTL 才能接手。这个应用的任务本来就是
 * 分钟级、由用户手动触发，多等 5 分钟可以接受，比"生成到一半被判死"好得多。
 * 注意这只是缓解：如果机器睡过去十几分钟，锁照样会过期 —— 开发机上跑长任务建议配 caffeinate。
 */
const DEFAULT_TASK_LOCK_TTL_MS = 300_000
const DEFAULT_TASK_IDEMPOTENCY_TTL_SECONDS = 10 * 60
const DEFAULT_TASK_CONCURRENCY_TTL_SECONDS = 30 * 60
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60
const DEFAULT_TASK_SUBMIT_RATE_LIMIT = 6
const DEFAULT_TASK_USER_CONCURRENCY_LIMIT = 3
const DEFAULT_TASK_PROVIDER_CONCURRENCY_LIMIT = 8
const DEFAULT_TASK_SKILL_CONCURRENCY_LIMIT = 4
const DEFAULT_AUTH_VERIFICATION_RATE_LIMIT = 5
const DEFAULT_AUTH_LOGIN_RATE_LIMIT = 10

const normalizeBoolean = (value: string, defaultValue: boolean) => {
  const normalizedValue = String(value || '').trim().toLowerCase()
  if (!normalizedValue) {
    return defaultValue
  }

  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false
  }

  return defaultValue
}

/**
 * 把环境变量解析成整数，**未设置或非法时用默认值**。
 *
 * 这里踩过一个影响面很大的坑（2026-09-21 修）：
 *   调用方一律写 `process.env.X || ''`，于是环境变量未设置时传进来的是**空字符串**。
 *   而 `Number('')` 等于 **0**（不是 NaN），`Number.isFinite(0)` 为真 ——
 *   于是"未设置"被当成了"显式配了 0"，最后 `Math.max(minValue, 0)` 返回 1。
 *   结果是**所有没在 .env 里显式配置的 Redis 参数都变成了 1**：
 *     · taskLockTtlMs 变成 1 毫秒 → 执行锁瞬间过期 → 续期永远 ownership_lost
 *       → **任何耗时超过 5 秒的生成任务都会被中断**（这就是本库长期出不了图的原因：
 *          秒回的认证错误能活下来，真正开始生成的任务活不过 5 秒）
 *     · 各类缓存 TTL 变成 1 秒、并发上限与限流阈值全变成 1
 *
 * 所以必须先判空字符串再判数值。空字符串是"没配"，不是"配了 0"。
 */
export const normalizeInteger = (value: string, defaultValue: number, minValue = 1) => {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return defaultValue
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return defaultValue
  }

  return Math.max(minValue, Math.floor(parsed))
}

const normalizeOptionalInteger = (value: string, defaultValue: number, minValue = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return defaultValue
  }

  return Math.max(minValue, Math.floor(parsed))
}

const buildRedisUrlFromFields = (input: {
  host: string
  port: number
  password: string
  database: number
}) => {
  const encodedPassword = input.password ? `:${encodeURIComponent(input.password)}@` : ''
  return `redis://${encodedPassword}${input.host}:${input.port}/${input.database}`
}

const rawRedisUrl = String(process.env.REDIS_URL || '').trim()
const redisHost = String(process.env.REDIS_HOST || DEFAULT_REDIS_HOST).trim() || DEFAULT_REDIS_HOST
const redisPort = normalizeOptionalInteger(process.env.REDIS_PORT || '', DEFAULT_REDIS_PORT, 1)
const redisPassword = String(process.env.REDIS_PASSWORD || '').trim()
const redisDatabase = normalizeOptionalInteger(process.env.REDIS_DATABASE || '', DEFAULT_REDIS_DATABASE, 0)
const resolvedRedisUrl = rawRedisUrl || buildRedisUrlFromFields({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  database: redisDatabase,
})

// Redis 统一运行时配置，避免各模块重复读取环境变量。
export const REDIS_CONFIG = {
  enabled: normalizeBoolean(process.env.REDIS_ENABLED || '', Boolean(rawRedisUrl || redisHost)),
  url: resolvedRedisUrl,
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  database: redisDatabase,
  prefix: String(process.env.REDIS_PREFIX || DEFAULT_REDIS_PREFIX).trim() || DEFAULT_REDIS_PREFIX,
  env: String(process.env.REDIS_ENV || DEFAULT_REDIS_ENV).trim() || DEFAULT_REDIS_ENV,
  defaultTtlSeconds: normalizeInteger(process.env.REDIS_DEFAULT_TTL_SECONDS || '', DEFAULT_CACHE_TTL_SECONDS),
  taskRuntimeTtlSeconds: normalizeInteger(process.env.REDIS_TASK_RUNTIME_TTL_SECONDS || '', DEFAULT_TASK_RUNTIME_TTL_SECONDS),
  taskSnapshotTtlSeconds: normalizeInteger(process.env.REDIS_TASK_SNAPSHOT_TTL_SECONDS || '', DEFAULT_TASK_SNAPSHOT_TTL_SECONDS),
  taskAbortTtlSeconds: normalizeInteger(process.env.REDIS_TASK_ABORT_TTL_SECONDS || '', DEFAULT_TASK_ABORT_TTL_SECONDS),
  taskLockTtlMs: normalizeInteger(process.env.REDIS_TASK_LOCK_TTL_MS || '', DEFAULT_TASK_LOCK_TTL_MS),
  taskIdempotencyTtlSeconds: normalizeInteger(process.env.REDIS_TASK_IDEMPOTENCY_TTL_SECONDS || '', DEFAULT_TASK_IDEMPOTENCY_TTL_SECONDS),
  taskConcurrencyTtlSeconds: normalizeInteger(process.env.REDIS_TASK_CONCURRENCY_TTL_SECONDS || '', DEFAULT_TASK_CONCURRENCY_TTL_SECONDS),
  rateLimitWindowSeconds: normalizeInteger(process.env.REDIS_RATE_LIMIT_WINDOW_SECONDS || '', DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
  taskSubmitRateLimit: normalizeInteger(process.env.REDIS_TASK_SUBMIT_RATE_LIMIT || '', DEFAULT_TASK_SUBMIT_RATE_LIMIT),
  taskUserConcurrencyLimit: normalizeInteger(process.env.REDIS_TASK_USER_CONCURRENCY_LIMIT || '', DEFAULT_TASK_USER_CONCURRENCY_LIMIT),
  taskProviderConcurrencyLimit: normalizeInteger(process.env.REDIS_TASK_PROVIDER_CONCURRENCY_LIMIT || '', DEFAULT_TASK_PROVIDER_CONCURRENCY_LIMIT),
  taskSkillConcurrencyLimit: normalizeInteger(process.env.REDIS_TASK_SKILL_CONCURRENCY_LIMIT || '', DEFAULT_TASK_SKILL_CONCURRENCY_LIMIT),
  authVerificationRateLimit: normalizeInteger(process.env.REDIS_AUTH_VERIFICATION_RATE_LIMIT || '', DEFAULT_AUTH_VERIFICATION_RATE_LIMIT),
  authLoginRateLimit: normalizeInteger(process.env.REDIS_AUTH_LOGIN_RATE_LIMIT || '', DEFAULT_AUTH_LOGIN_RATE_LIMIT),
  instanceId: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
}

export const isRedisEnabled = () => Boolean(REDIS_CONFIG.enabled && REDIS_CONFIG.url)
