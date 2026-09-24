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
    /**
     * 影子库（`prisma migrate dev` 用它演练迁移）。
     *
     * 不指定的话 Prisma 会**临时创建一个** —— 而应用账号是「只有业务库权限」的最小权限账号，
     * 建库会被拒（实测 P3014 / P1010）。.env 里本来就声明了 SHADOW_DATABASE_URL，
     * 指向预建好的影子库，这里接上即可，也不用为了迁移把 CREATE 权限开给应用账号。
     */
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
})
