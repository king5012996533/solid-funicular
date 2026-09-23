#!/usr/bin/env node
/**
 * 跨平台跑 Prisma 迁移：`node scripts/prisma-migrate.mjs .env.development`
 *
 * 为什么需要这层包装：原来的 npm 脚本写成 `ENV_FILE=.env.development prisma migrate deploy`，
 * 这是 Unix 的「命令前赋环境变量」语法 —— **Windows 的 cmd.exe 不认**，
 * `npm run dev` 在 Windows 上第一步就报「'ENV_FILE' 不是内部或外部命令」，
 * 服务端起不来（2026-09-23 实测）。这里改成在 Node 里设好环境变量再 spawn，三个平台都能跑。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envFile = process.argv[2] || '.env.development'
const extraArgs = process.argv.slice(3)

const child = spawn('npx', ['prisma', 'migrate', 'deploy', ...extraArgs], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ENV_FILE: envFile,
  },
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
