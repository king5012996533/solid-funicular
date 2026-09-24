import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Prisma CLI 加载顺序（找到第一个即停）：
 * 1. 显式指定的 ENV_FILE
 * 2. NODE_ENV=production → 只认 .env.production
 * 3. 否则 .env.development（本地默认）
 *
 * 注意生产分支**不能**回落到 .env.development：
 *   以前它是 ['.env.production', '.env.development']，于是缺 .env.production 时会
 *   静默加载开发环境变量去执行 `prisma migrate deploy` —— 等于把迁移打到开发库。
 *   现在生产找不到 .env.production 就用进程环境变量（容器场景：env 由 compose 注入），
 *   真缺 DATABASE_URL 时由启动脚本的校验直接失败。
 */
export const loadPrismaEnv = () => {
  const cwd = process.cwd();
  const explicitFile = String(process.env.ENV_FILE || "").trim();
  const candidates = explicitFile
    ? [explicitFile]
    : process.env.NODE_ENV === "production"
      ? [".env.production"]
      : [".env.development", ".env.production"];

  for (const file of candidates) {
    const envPath = path.resolve(cwd, file);
    if (existsSync(envPath)) {
      config({ path: envPath });
      return file;
    }
  }

  return null;
};
