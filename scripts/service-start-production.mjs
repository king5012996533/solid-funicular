/**
 * 独立后端服务包（dist-service）的生产启动入口。
 *
 * 由 scripts/build-server-service.mjs 复制到 dist-service 根目录，与
 * dist-service/startup-env-validation.mjs 一起运行（Dockerfile 里 PID 1 直接跑它）。
 *
 * 职责：
 *   1. 加载 .env.production（容器里通常没有该文件，env 由 compose env_file 注入）；
 *   2. 关键变量校验，缺失即失败 —— 不静默连开发库、不用仓库默认密钥；
 *   3. 执行 prisma migrate deploy；
 *   4. node 直启后端，并把 SIGTERM/SIGINT 转发过去做优雅停机。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config as loadEnvFile } from 'dotenv'
import { assertProductionEnv } from './startup-env-validation.mjs'

// 需要转发给后端进程的退出信号。
const FORWARD_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

// 执行子命令；默认收集输出，必要时再决定是否原样透传。
const runCommand = (command, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const outputChunks = []
    const errorChunks = []

    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: options.env ?? process.env,
    })

    child.stdout?.on('data', (chunk) => {
      outputChunks.push(chunk)
      if (options.forwardStdout) {
        process.stdout.write(chunk)
      }
    })

    child.stderr?.on('data', (chunk) => {
      errorChunks.push(chunk)
      if (options.forwardStderr) {
        process.stderr.write(chunk)
      }
    })

    child.on('error', reject)

    child.on('close', (code) => {
      const stdout = Buffer.concat(outputChunks).toString('utf8')
      const stderr = Buffer.concat(errorChunks).toString('utf8')

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(`${command} ${args.join(' ')} 执行失败，退出码: ${code}\n${stderr || stdout}`))
    })
  })
}

// 启动后端服务，并把退出信号转发给它（详见 scripts/start-production.mjs 的说明）。
const runServer = (command, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    })

    const handlers = new Map()
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler)
      }
      handlers.clear()
    }

    for (const signal of FORWARD_SIGNALS) {
      const handler = () => {
        console.info(`[start-production] 收到 ${signal}，转发给后端进程以优雅停机`)
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal)
          } catch {
            // 忽略：子进程可能刚好已退出。
          }
        }
      }
      handlers.set(signal, handler)
      process.on(signal, handler)
    }

    child.on('error', (error) => {
      cleanup()
      reject(error)
    })

    child.on('close', (code, signal) => {
      cleanup()
      if (signal || code === 0) {
        resolve()
        return
      }
      reject(new Error(`后端服务退出码: ${code}`))
    })
  })
}

// 判断生产环境配置文件是否存在。
const hasProductionEnvFile = async () => {
  try {
    await fs.access(path.resolve(process.cwd(), '.env.production'))
    return true
  } catch {
    return false
  }
}

// 从 Prisma migrate deploy 输出里提取核心信息。
const summarizePrismaMigrateOutput = (rawText) => {
  const normalizedText = String(rawText || '')

  const datasourceMatch = normalizedText.match(/Datasource "db": MySQL database "([^"]+)" at "([^"]+)"/)
  const migrationCountMatch = normalizedText.match(/(\d+)\s+migrations found in prisma\/migrations/i)
  const noPendingMatch = /No pending migrations to apply\./i.test(normalizedText)
  const appliedMatch = normalizedText.match(/Applying migration/i)

  return {
    databaseName: datasourceMatch?.[1] || '',
    databaseAddress: datasourceMatch?.[2] || '',
    migrationCount: migrationCountMatch?.[1] || '',
    statusText: noPendingMatch
      ? '没有待执行迁移'
      : appliedMatch
        ? '已执行迁移'
        : '迁移检查已完成',
  }
}

// 启动生产环境应用。
const start = async () => {
  const hasEnvFile = await hasProductionEnvFile()
  console.info('[start-production] 启动准备中')
  console.info(`[start-production] 环境文件: ${hasEnvFile ? '.env.production' : '未检测到 .env.production，使用当前进程环境变量'}`)

  if (hasEnvFile) {
    loadEnvFile({ path: path.resolve(process.cwd(), '.env.production') })
    process.env.ENV_FILE = '.env.production'
  }

  assertProductionEnv(process.env)
  console.info('[start-production] 环境变量校验通过')

  console.info('[start-production] 正在检查数据库迁移')
  const migrateResult = await runCommand('npx', ['prisma', 'migrate', 'deploy'])
  const migrationSummary = summarizePrismaMigrateOutput(`${migrateResult.stdout}\n${migrateResult.stderr}`)
  console.info(
    `[start-production] 数据库迁移检查完成: ${migrationSummary.databaseName || 'unknown'} @ ${migrationSummary.databaseAddress || 'unknown'} · `
    + `${migrationSummary.migrationCount || '0'} 个迁移 · ${migrationSummary.statusText}`,
  )

  const serverArgs = hasEnvFile
    ? ['--env-file=.env.production', 'server/index.js']
    : ['server/index.js']

  console.info('[start-production] 正在启动后端服务')
  await runServer('node', serverArgs)
}

start()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('[start-production] 启动失败', error)
    process.exit(1)
  })
