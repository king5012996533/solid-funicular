/**
 * 生产运行时的环境变量校验与密钥解析。
 *
 * 两个必须守住的边界：
 *   1. 生产启动时关键变量缺失 → 立即失败（由 start-production 脚本与 server/index.ts 共同调用）；
 *   2. 配置加密密钥在生产环境**禁止回落仓库内置默认值** —— 那些默认值随源码公开，
 *      一旦启用，库里的厂商 API Key / 对象存储密钥就等于明文（可被任何拿到仓库的人离线解密）。
 */

/** 生产环境必须显式提供的变量。 */
export const PRODUCTION_REQUIRED_ENV_KEYS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PROVIDER_CONFIG_SECRET",
  "STORAGE_CONFIG_SECRET",
] as const;

/** 仓库内置的默认密钥 / 模板占位值，生产环境一律禁止使用。 */
export const FORBIDDEN_CONFIG_SECRET_VALUES = new Set([
  "canana-vue-provider-config-secret",
  "canana-vue-storage-config-secret",
  "please-change-this-provider-secret",
  "please-change-this-storage-secret",
]);

/**
 * 是否处于生产运行时。
 * 除了 NODE_ENV=production，也认生产启动脚本设置的 ENV_FILE=.env.production ——
 * 否则有人只设置 ENV_FILE 时，密钥回落的保护会失效。
 */
export const isProductionRuntime = (env: NodeJS.ProcessEnv = process.env) => {
  if (
    String(env.NODE_ENV || "")
      .trim()
      .toLowerCase() === "production"
  ) {
    return true;
  }

  return String(env.ENV_FILE || "").trim() === ".env.production";
};

/** 收集生产环境变量的问题清单（空数组表示通过）。 */
export const collectProductionEnvProblems = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const problems: string[] = [];

  for (const key of PRODUCTION_REQUIRED_ENV_KEYS) {
    if (!String(env[key] ?? "").trim()) {
      problems.push(`缺少 ${key}`);
    }
  }

  for (const key of ["PROVIDER_CONFIG_SECRET", "STORAGE_CONFIG_SECRET"]) {
    const value = String(env[key] ?? "").trim();
    if (value && FORBIDDEN_CONFIG_SECRET_VALUES.has(value)) {
      problems.push(
        `${key} 仍是仓库内置默认值，生产环境禁止使用（请生成随机密钥替换）`,
      );
    }
  }

  return problems;
};

/**
 * 解析配置加密密钥：按 envKeys 顺序取第一个非空值。
 * 生产环境取不到、或取到的是仓库默认值时直接抛错；只有开发环境才允许回落。
 */
export const resolveConfigSecret = (
  envKeys: readonly string[],
  developmentFallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  for (const key of envKeys) {
    const value = String(env[key] ?? "").trim();
    if (!value) {
      continue;
    }

    if (FORBIDDEN_CONFIG_SECRET_VALUES.has(value) && isProductionRuntime(env)) {
      throw new Error(
        `${key} 仍是仓库内置默认值，生产环境禁止使用；请生成随机密钥后重新配置（并重新录入受影响的密钥）。`,
      );
    }

    return value;
  }

  if (isProductionRuntime(env)) {
    throw new Error(
      `缺少 ${envKeys.join(" / ")}，生产环境禁止回落到内置默认密钥；请在环境中配置随机密钥。`,
    );
  }

  return developmentFallback;
};

/**
 * 生产启动前断言环境变量完整；非生产环境不干预。
 * 不通过时抛出带完整清单的错误，由调用方记录并退出。
 */
export const assertProductionEnv = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (!isProductionRuntime(env)) {
    return;
  }

  const problems = collectProductionEnvProblems(env);
  if (problems.length === 0) {
    return;
  }

  throw new Error(
    [
      "生产环境变量校验未通过，已中止启动（不会连接数据库）：",
      ...problems.map((problem) => `  - ${problem}`),
      "",
      "请检查 .env.production（或容器 env_file / CI Secrets）后重试。",
    ].join("\n"),
  );
};
