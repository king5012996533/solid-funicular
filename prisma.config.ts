import { loadPrismaEnv } from './prisma/load-env'
import { defineConfig, env } from 'prisma/config'

loadPrismaEnv()

/**
 * `prisma generate` 不需要连库，可它也要读这份配置 —— 所以在没配 DATABASE_URL 的机器上
 * （新 clone、新服务器、CI），postinstall 里的 generate 会直接抛
 * `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`，
 * 第一步就卡死（2026-09-23 实测：全新 clone 上 pnpm install 直接失败）。
 * 只给 generate 一个占位地址（反正它不连），其余命令仍然要求真实 DATABASE_URL。
 */
const isGenerateOnly = process.argv.some((arg) => arg === 'generate' || arg.startsWith('generate'))

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL || (isGenerateOnly ? 'mysql://placeholder:placeholder@127.0.0.1:3306/placeholder' : env('DATABASE_URL')),
  },
})
