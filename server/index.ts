import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { AI_GATEWAY_MATCH_PATHS } from "./ai-gateway/constants";
import { handleAiGatewayRequest } from "./ai-gateway/request-handler";
import { isAuthPath } from "./auth/constants";
import { handleAuthRequest } from "./auth/request-handler";
import { isAssetItemsPath } from "./asset-items/constants";
import { handleAssetItemsRequest } from "./asset-items/request-handler";
import { isVideoProjectsPath } from "./video-projects/constants";
import { handleVideoProjectsRequest } from "./video-projects/request-handler";
import { isAdminUsersPath } from "./admin-users/constants";
import { handleAdminUsersRequest } from "./admin-users/request-handler";
import { isAdminGenerationSessionsPath } from "./admin-generation-sessions/constants";
import { handleAdminGenerationSessionsRequest } from "./admin-generation-sessions/request-handler";
import { isAdminGenerationRecordsPath } from "./admin-generation-records/constants";
import { handleAdminGenerationRecordsRequest } from "./admin-generation-records/request-handler";
import { isAdminAuditLogsPath } from "./admin-audit-logs/constants";
import { handleAdminAuditLogsRequest } from "./admin-audit-logs/request-handler";
import { isAdminConversationSettingsPath } from "./conversation-settings/constants";
import { handleAdminConversationSettingsRequest } from "./conversation-settings/request-handler";
import { isAdminDashboardPath } from "./admin-dashboard/constants";
import { handleAdminDashboardRequest } from "./admin-dashboard/request-handler";
import { isAdminMarketingPath } from "./admin-marketing/constants";
import { handleAdminMarketingRequest } from "./admin-marketing/request-handler";
import { isPointsPath } from "./points/constants";
import { handlePointsRequest } from "./points/request-handler";
import { isMarketingCenterPath } from "./marketing-center/constants";
import { handleMarketingCenterRequest } from "./marketing-center/request-handler";
import { isSystemConfigPath } from "./system-config/constants";
import { handleSystemConfigRequest } from "./system-config/request-handler";
import { isSystemInitPath } from "./system-init/constants";
import { handleSystemInitRequest } from "./system-init/request-handler";
import { isWorkflowDefinitionsPath } from "./workflow-definitions/constants";
import { handleWorkflowDefinitionsRequest } from "./workflow-definitions/request-handler";
import { isGenerationRecordsPath } from "./generation-records/constants";
import { handleGenerationRecordsRequest } from "./generation-records/request-handler";
import { isGenerationSessionsPath } from "./generation-sessions/constants";
import { handleGenerationSessionsRequest } from "./generation-sessions/request-handler";
import { isGenerationTasksPath } from "./generation-tasks/constants";
import { handleGenerationTasksRequest } from "./generation-tasks/request-handler";
import { PROVIDER_CONFIG_MATCH_PATHS } from "./provider-config/constants";
import { handleProviderConfigRequest } from "./provider-config/request-handler";
import { isStorageConfigsPath } from "./storage-config/constants";
import { handleStorageConfigRequest } from "./storage-config/request-handler";
import { isStorageUploadPath } from "./storage/constants";
import { handleStorageUploadRequest } from "./storage/request-handler";
import { getUploadsDir } from "./storage/service";
import { isSkillConfigPath } from "./skill-config/constants";
import { handleSkillConfigRequest } from "./skill-config/request-handler";
import { REDIS_CONFIG, isRedisEnabled } from "./redis";
import { pingRedis } from "./redis/health";
import { isPrismaConfigured, getPrismaClient } from "./db/prisma";
import { assertProductionEnv } from "./shared/startup-env";
import { writeScopedLog } from "./shared/logging";

// 后端服务默认监听端口。
const DEFAULT_SERVER_PORT = 5409;

// 前端构建产物默认目录。
const DEFAULT_STATIC_DIST_DIR = path.resolve(process.cwd(), "dist");

// 上传文件公开访问前缀。
const UPLOADS_PUBLIC_PATH_PREFIX = "/uploads/";

// 允许跨域访问的来源列表。
const DEFAULT_CORS_ALLOWED_ORIGINS = [
  "http://localhost:5010",
  "http://127.0.0.1:5010",
  "http://localhost:5011",
  "http://127.0.0.1:5011",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

// 读取服务端口配置。
const readServerPort = () => {
  // 读取环境变量中的端口配置。
  const rawPort = Number(process.env.SERVER_PORT || DEFAULT_SERVER_PORT);

  // 返回合法端口，否则回退默认值。
  return Number.isFinite(rawPort) && rawPort > 0
    ? rawPort
    : DEFAULT_SERVER_PORT;
};

// 读取静态资源目录配置。
const readStaticDistDir = () => {
  // 优先读取显式配置的静态目录。
  const configuredDir = String(process.env.STATIC_DIST_DIR || "").trim();

  // 未配置时回退到项目 dist 目录。
  return configuredDir ? path.resolve(configuredDir) : DEFAULT_STATIC_DIST_DIR;
};

// 读取允许跨域的来源配置。
const readAllowedOrigins = () => {
  // 读取逗号分隔的来源字符串。
  const rawOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  // 优先使用环境变量，否则使用本地开发默认值。
  return rawOrigins.length ? rawOrigins : DEFAULT_CORS_ALLOWED_ORIGINS;
};

// 读取前端运行时公开配置。
const readRuntimeClientConfig = () => ({
  VITE_API_BASE_URL: String(process.env.VITE_API_BASE_URL || "").trim(),
  VITE_PROVIDER_DEFAULT_BASE_URL: String(
    process.env.VITE_PROVIDER_DEFAULT_BASE_URL ||
      "https://api.chatfire.site/v1",
  ).trim(),
});

const resolveRedisStartupSummary = () => {
  if (!isRedisEnabled()) {
    return "未启用";
  }

  return `已启用 (${REDIS_CONFIG.host}:${REDIS_CONFIG.port}/${REDIS_CONFIG.database})`;
};

// 将运行时配置脚本注入到首页 HTML 中。
const injectRuntimeClientConfig = (html: string) => {
  const runtimeConfigScript = `<script>window.__CANANA_RUNTIME_CONFIG__=${JSON.stringify(readRuntimeClientConfig())}</script>`;

  // 优先注入到 head 尾部，保证主脚本执行前即可读取。
  if (html.includes("</head>")) {
    return html.replace("</head>", `${runtimeConfigScript}</head>`);
  }

  return `${runtimeConfigScript}${html}`;
};

// 判断当前路径是否命中 AI 网关。
const isAiGatewayPath = (requestPath: string) => {
  // 复用现有路径常量统一判断。
  return AI_GATEWAY_MATCH_PATHS.includes(
    requestPath as (typeof AI_GATEWAY_MATCH_PATHS)[number],
  );
};

// 判断当前路径是否命中厂商配置接口。
const isProviderConfigPath = (requestPath: string) => {
  // runtime 走精确匹配，models 兼容带 id 的子路径。
  return PROVIDER_CONFIG_MATCH_PATHS.some(
    (path) => requestPath === path || requestPath.startsWith(path + "/"),
  );
};

// 处理上传目录中的公开文件访问。
const handleUploadsRequest = async (
  req: any,
  res: any,
  requestPath: string,
) => {
  /**
   * 允许 GET 与 **HEAD**。
   *
   * 为什么必须支持 HEAD：画布 Agent 的 `preflight_check` 用 `fetch(url, { method: 'HEAD' })`
   * 判断参考图可达性。此前只放 GET，HEAD 会掉到「前端静态兜底」并返回 404，于是校验报告
   * 误报「参考图取不到」，Agent 据此认定**已经生成好的母版链接过期**、要求重跑（实测白花 60 积分）。
   * 同一地址实测：HEAD=404 / GET=200 —— 图一直都在。
   */
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  // 非上传资源路径直接跳过。
  if (!requestPath.startsWith(UPLOADS_PUBLIC_PATH_PREFIX)) {
    return false;
  }

  // 读取上传根目录。
  const uploadsDir = getUploadsDir();

  // 将公开路径转换成相对文件路径。
  const relativePath = decodeURIComponent(
    requestPath.slice(UPLOADS_PUBLIC_PATH_PREFIX.length),
  );

  // 计算真实文件路径。
  const filePath = path.resolve(uploadsDir, relativePath);

  // 防止目录穿越到上传目录之外。
  if (!filePath.startsWith(uploadsDir)) {
    return false;
  }

  // 文件不存在则返回未处理。
  if (!(await isFileExists(filePath))) {
    return false;
  }

  // 读取文件并返回。
  const fileBuffer = await fs.readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", getContentTypeByFilePath(filePath));
  // Content-Length 两个方法都给：HEAD 的规范就是「头部与 GET 一致、不带 body」
  res.setHeader("Content-Length", String(fileBuffer.byteLength));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  res.end(fileBuffer);
  return true;
};

// 根据文件后缀推导响应类型。
const getContentTypeByFilePath = (filePath: string) => {
  // 读取文件扩展名。
  const extname = path.extname(filePath).toLowerCase();

  // 返回常用静态资源的内容类型。
  switch (extname) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
};

// 判断目标文件是否存在且为普通文件。
const isFileExists = async (filePath: string) => {
  try {
    // 读取文件状态信息。
    const stat = await fs.stat(filePath);

    // 仅普通文件允许直接返回。
    return stat.isFile();
  } catch {
    // 不存在或无权限时按不存在处理。
    return false;
  }
};

// 处理静态资源与前端路由回退。
const handleStaticRequest = async (req: any, res: any, requestPath: string) => {
  // 仅允许 GET 请求读取静态资源。
  if (req.method !== "GET") {
    return false;
  }

  // 读取静态资源根目录。
  const staticDistDir = readStaticDistDir();

  // 将请求路径解码为真实文件路径片段。
  const decodedPath = decodeURIComponent(requestPath || "/");

  // 规范化请求路径，避免目录穿越。
  const normalizedPath = decodedPath === "/" ? "/index.html" : decodedPath;

  // 拼接静态资源目标文件。
  const candidateFilePath = path.resolve(staticDistDir, `.${normalizedPath}`);

  // 若目标文件不在静态目录内，则直接拒绝。
  if (!candidateFilePath.startsWith(staticDistDir)) {
    return false;
  }

  // 优先返回精确命中的静态文件。
  if (await isFileExists(candidateFilePath)) {
    const fileBuffer = await fs.readFile(candidateFilePath);
    const contentType = getContentTypeByFilePath(candidateFilePath);
    const responseBody = contentType.startsWith("text/html")
      ? injectRuntimeClientConfig(fileBuffer.toString("utf8"))
      : fileBuffer;
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.end(responseBody);
    return true;
  }

  // 非文件请求尝试回退到单页应用入口。
  const indexFilePath = path.resolve(staticDistDir, "index.html");
  if (await isFileExists(indexFilePath)) {
    const fileBuffer = await fs.readFile(indexFilePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(injectRuntimeClientConfig(fileBuffer.toString("utf8")));
    return true;
  }

  // 没有可用静态资源时返回未处理。
  return false;
};

// 为响应写入统一的跨域头。
const applyCorsHeaders = (req: any, res: any) => {
  // 读取浏览器发起请求时的来源。
  const requestOrigin = String(req.headers.origin || "");

  // 读取允许跨域的来源白名单。
  const allowedOrigins = readAllowedOrigins();

  // 判断当前来源是否在白名单中。
  const allowOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0];

  // 写入允许的来源。
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  // 声明允许携带的请求方法。
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );

  // 合并静态白名单与浏览器预检里声明的自定义请求头，避免上传等场景被预检拦截。
  const allowHeaderSet = new Set(
    [
      "Content-Type",
      "Authorization",
      "x-upstream-base-url",
      "x-upstream-endpoint",
      "x-upstream-api-key",
      "x-upstream-provider-id",
      "x-upstream-endpoint-type",
      "x-upstream-model-key",
      "x-upstream-method",
      "x-upload-filename",
      "x-upload-category",
    ].map((header) => header.toLowerCase()),
  );
  const requestedHeaders = String(
    req.headers["access-control-request-headers"] || "",
  )
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  requestedHeaders.forEach((header) => {
    allowHeaderSet.add(header);
  });
  res.setHeader(
    "Access-Control-Allow-Headers",
    Array.from(allowHeaderSet).join(","),
  );

  // 允许跨域请求携带 Cookie。
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // 告诉代理和浏览器当前响应会随 Origin 变化。
  res.setHeader("Vary", "Origin");
};

// 返回统一的 JSON 响应。
const sendJson = (res: any, statusCode: number, data: unknown) => {
  // 设置状态码。
  res.statusCode = statusCode;

  // 设置响应内容类型。
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // 输出 JSON 内容。
  res.end(JSON.stringify(data));
};

// 返回健康检查响应（liveness：只表示进程活着，不探依赖）。
const handleHealthRequest = (res: any) => {
  // 返回服务可用状态。
  sendJson(res, 200, {
    message: "ok",
    data: {
      status: "running",
    },
  });
};

// readiness 探测单个依赖的超时上限：避免数据库不可达时探测长时间挂住，
// 让编排层拿不到明确结果。可用 READINESS_PROBE_TIMEOUT_MS 覆盖。
const READINESS_PROBE_TIMEOUT_MS = (() => {
  const parsed = Number(
    String(process.env.READINESS_PROBE_TIMEOUT_MS || "").trim(),
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3_000;
})();

// 给探测操作加超时，超时按"不可用"处理。
const probeWithTimeout = async <T>(
  operation: PromiseLike<T>,
  timeoutMessage: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutMessage)),
          READINESS_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

// 探测数据库可用性（SELECT 1）。
const probeDatabase = async () => {
  if (!isPrismaConfigured()) {
    return { ok: false, message: "DATABASE_URL 未配置" };
  }

  try {
    await probeWithTimeout(
      getPrismaClient().$queryRaw`SELECT 1`,
      `数据库探测超时（${READINESS_PROBE_TIMEOUT_MS}ms）`,
    );
    return { ok: true, message: "ok" };
  } catch (error: any) {
    return { ok: false, message: error?.message || "数据库探测失败" };
  }
};

// 探测 Redis 可用性；未启用 Redis 时视为跳过（不判失败，应用支持无 Redis 降级）。
const probeRedis = async () => {
  try {
    const result = await probeWithTimeout(
      pingRedis(),
      `Redis 探测超时（${READINESS_PROBE_TIMEOUT_MS}ms）`,
    );
    if (!result.enabled) {
      return { enabled: false, ok: true, message: "未启用（跳过）" };
    }
    return { enabled: true, ok: result.ok, message: result.message };
  } catch (error: any) {
    return {
      enabled: true,
      ok: false,
      message: error?.message || "Redis 探测失败",
    };
  }
};

// 返回 readiness 响应：DB / Redis 任一不可用即 503，供编排层判断是否摘流量。
const handleReadinessRequest = async (res: any) => {
  const [database, redis] = await Promise.all([probeDatabase(), probeRedis()]);
  const isReady = database.ok && redis.ok;

  sendJson(res, isReady ? 200 : 503, {
    message: isReady ? "ok" : "依赖不可用",
    data: {
      status: isReady ? "ready" : "not_ready",
      checks: { database, redis },
    },
  });
};

interface RequestRouteStrategy {
  key: string;
  match: (requestPath: string) => boolean;
  handle: (
    req: any,
    res: any,
    requestPath: string,
  ) => Promise<boolean | void> | boolean | void;
}

// 服务端请求分发策略注册表。
const REQUEST_ROUTE_STRATEGIES: RequestRouteStrategy[] = [
  {
    key: "health",
    match: (requestPath) => requestPath === "/api/health",
    handle: async (_req, res) => {
      handleHealthRequest(res);
      return true;
    },
  },
  {
    key: "readiness",
    match: (requestPath) => requestPath === "/api/ready",
    handle: async (_req, res) => {
      await handleReadinessRequest(res);
      return true;
    },
  },
  {
    key: "ai-gateway",
    match: isAiGatewayPath,
    handle: async (req, res) => {
      await handleAiGatewayRequest(req, res);
      return true;
    },
  },
  {
    key: "auth",
    match: isAuthPath,
    handle: async (req, res) => {
      await handleAuthRequest(req, res);
      return true;
    },
  },
  {
    key: "provider-config",
    match: isProviderConfigPath,
    handle: async (req, res) => {
      await handleProviderConfigRequest(req, res);
      return true;
    },
  },
  {
    key: "skill-config",
    match: isSkillConfigPath,
    handle: async (req, res) => {
      await handleSkillConfigRequest(req, res);
      return true;
    },
  },
  {
    key: "storage-upload",
    match: isStorageUploadPath,
    handle: async (req, res) => {
      await handleStorageUploadRequest(req, res);
      return true;
    },
  },
  {
    key: "storage-config",
    match: isStorageConfigsPath,
    handle: async (req, res) => {
      await handleStorageConfigRequest(req, res);
      return true;
    },
  },
  {
    key: "generation-records",
    match: isGenerationRecordsPath,
    handle: async (req, res) => {
      await handleGenerationRecordsRequest(req, res);
      return true;
    },
  },
  {
    key: "generation-sessions",
    match: isGenerationSessionsPath,
    handle: async (req, res) => {
      await handleGenerationSessionsRequest(req, res);
      return true;
    },
  },
  {
    key: "generation-tasks",
    match: isGenerationTasksPath,
    handle: async (req, res) => {
      await handleGenerationTasksRequest(req, res);
      return true;
    },
  },
  {
    key: "asset-items",
    match: isAssetItemsPath,
    handle: async (req, res) => {
      await handleAssetItemsRequest(req, res);
      return true;
    },
  },
  {
    key: "video-projects",
    match: isVideoProjectsPath,
    handle: async (req, res) => {
      await handleVideoProjectsRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-dashboard",
    match: isAdminDashboardPath,
    handle: async (req, res) => {
      await handleAdminDashboardRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-users",
    match: isAdminUsersPath,
    handle: async (req, res) => {
      await handleAdminUsersRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-generation-sessions",
    match: isAdminGenerationSessionsPath,
    handle: async (req, res) => {
      await handleAdminGenerationSessionsRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-generation-records",
    match: isAdminGenerationRecordsPath,
    handle: async (req, res) => {
      await handleAdminGenerationRecordsRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-audit-logs",
    match: isAdminAuditLogsPath,
    handle: async (req, res) => {
      await handleAdminAuditLogsRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-conversation-settings",
    match: isAdminConversationSettingsPath,
    handle: async (req, res) => {
      await handleAdminConversationSettingsRequest(req, res);
      return true;
    },
  },
  {
    key: "admin-marketing",
    match: isAdminMarketingPath,
    handle: async (req, res) => {
      await handleAdminMarketingRequest(req, res);
      return true;
    },
  },
  {
    key: "points",
    match: isPointsPath,
    handle: async (req: any, res: any) => {
      await handlePointsRequest(req, res);
      return true;
    },
  },
  {
    key: "marketing-center",
    match: isMarketingCenterPath,
    handle: async (req, res) => {
      await handleMarketingCenterRequest(req, res);
      return true;
    },
  },
  {
    key: "system-init",
    match: isSystemInitPath,
    handle: async (req, res) => {
      await handleSystemInitRequest(req, res);
      return true;
    },
  },
  {
    key: "system-config",
    match: isSystemConfigPath,
    handle: async (req, res) => {
      await handleSystemConfigRequest(req, res);
      return true;
    },
  },
  {
    key: "workflow-definitions",
    match: isWorkflowDefinitionsPath,
    handle: async (req, res) => {
      await handleWorkflowDefinitionsRequest(req, res);
      return true;
    },
  },
  {
    key: "uploads-static",
    match: (requestPath) => requestPath.startsWith(UPLOADS_PUBLIC_PATH_PREFIX),
    handle: (req, res, requestPath) =>
      handleUploadsRequest(req, res, requestPath),
  },
  {
    key: "frontend-static",
    match: () => true,
    handle: (req, res, requestPath) =>
      handleStaticRequest(req, res, requestPath),
  },
];

// 将请求分发给对应的业务处理器。
const dispatchRequest = async (req: any, res: any) => {
  // 读取当前请求路径。
  const requestUrl = String(req.url || "");

  // 截取不带查询参数的路径部分。
  const requestPath = requestUrl.split("?")[0];

  // 按注册顺序执行路由策略，保证原有优先级不变。
  for (const strategy of REQUEST_ROUTE_STRATEGIES) {
    if (!strategy.match(requestPath)) {
      continue;
    }

    const handled = await strategy.handle(req, res, requestPath);
    if (handled !== false) {
      return;
    }
  }

  // 其余路径统一返回未找到。
  sendJson(res, 404, {
    message: "接口不存在",
    error: {
      type: "not_found",
      message: "接口不存在",
    },
  });
};

// 创建独立 Node 后端服务。
const server = createServer(async (req, res) => {
  // 先写入统一跨域头，保证前端跨域可访问。
  applyCorsHeaders(req, res);

  // 预检请求直接返回空响应即可。
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    // 分发业务请求到对应处理器。
    await dispatchRequest(req, res);
  } catch (error: any) {
    // 打印未捕获异常，便于排查服务端问题。
    writeScopedLog("error", "服务端", "请求处理失败", error);

    // 返回统一异常响应。
    sendJson(res, 500, {
      message: error?.message || "服务内部异常",
      error: {
        type: "server_error",
        message: error?.message || "服务内部异常",
      },
    });
  }
});

// 读取最终监听端口。
const serverPort = readServerPort();

// 进程级异常兜底：避免后台任务（runTaskInBackground）中嵌套异常冒泡导致进程崩溃，
// 进而切断所有正在订阅的 SSE 连接。仅记录日志，不退出进程。
process.on("unhandledRejection", (reason, promise) => {
  writeScopedLog("error", "服务端", "unhandledRejection", { reason, promise });
});
process.on("uncaughtException", (error) => {
  writeScopedLog("error", "服务端", "uncaughtException", error);
});

// 生产启动前校验关键环境变量；缺失或仍在使用仓库默认密钥时立即退出，
// 绝不带着残缺配置对外服务、也不静默回落默认密钥。
try {
  assertProductionEnv();
} catch (error: any) {
  writeScopedLog("error", "服务端", "生产环境变量校验失败，已中止启动", error);
  process.exit(1);
}

// 启动服务并输出日志。
server.listen(serverPort, "0.0.0.0", () => {
  const staticDistDir = readStaticDistDir();
  const uploadsDir = getUploadsDir();
  const allowedOrigins = readAllowedOrigins();

  // 输出启动概览，避免部署时只能看到一个端口日志。
  writeScopedLog("info", "服务端", "启动完成");
  writeScopedLog("info", "服务端", `服务地址: http://0.0.0.0:${serverPort}`);
  writeScopedLog("info", "服务端", `静态目录: ${staticDistDir}`);
  writeScopedLog("info", "服务端", `上传目录: ${uploadsDir}`);
  writeScopedLog("info", "服务端", `CORS 来源: ${allowedOrigins.join(", ")}`);
  writeScopedLog("info", "服务端", `Redis: ${resolveRedisStartupSummary()}`);
});

/**
 * 优雅停机：收到 SIGTERM/SIGINT/SIGHUP 后停止接受新连接，等待在途请求/连接收口；
 * 超过上限（GRACEFUL_SHUTDOWN_TIMEOUT_MS，默认 5 分钟）仍未结束则强制关闭并退出。
 * 之前没有这段逻辑，发布时 SIGTERM 直接导致进程被硬杀，在途生成任务
 * （图片单张实测 54~334 秒）会被整段切断。
 * SIGHUP 必须一并接管：start-production 会把它转发给后端进程，而 Node 的默认
 * 处置是直接终止（退出码 129），等于绕开整段收口逻辑把在途任务切断。
 */
const gracefulShutdownTimeoutMs = (() => {
  const parsed = Number(
    String(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || "").trim(),
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 300_000;
})();

let isShuttingDown = false;
let isShutdownFinalized = false;

// 完成收尾：断开数据库连接，然后退出进程。
const finalizeShutdown = async (reason: string) => {
  if (isShutdownFinalized) {
    return;
  }
  isShutdownFinalized = true;

  if (isPrismaConfigured()) {
    try {
      await getPrismaClient().$disconnect();
    } catch (error) {
      writeScopedLog("warn", "服务端", "停机时关闭数据库连接失败", error);
    }
  }

  writeScopedLog("info", "服务端", `停机完成（${reason}）`);
  process.exit(0);
};

// 触发优雅停机（只执行一次）。
const shutdown = (signal: string) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  writeScopedLog(
    "info",
    "服务端",
    `收到 ${signal}，开始优雅停机：停止接受新连接，等待在途任务/连接收口（上限 ${gracefulShutdownTimeoutMs}ms）`,
  );

  // 停止接受新连接；现有连接全部关闭后回调。
  server.close(() => {
    void finalizeShutdown("连接已全部关闭");
  });

  // 立即断开空闲 keep-alive 连接，避免它们拖住 server.close 的回调。
  server.closeIdleConnections();

  const timer = setTimeout(() => {
    writeScopedLog(
      "warn",
      "服务端",
      `优雅停机超时（${gracefulShutdownTimeoutMs}ms），强制关闭剩余连接`,
    );
    server.closeAllConnections();
    void finalizeShutdown("超时强制关闭");
  }, gracefulShutdownTimeoutMs);
  timer.unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
